// 10/19 第九轮 WP9-E（西医诊断准确率）：验收集 D 不合格 113 例的归因与修复断言。
// 归因与数字见 ~/runlogs/r1018/work/r1021/western/diagnosis.md。
//
//   1 病名核对 D 类的前置核对（decisive / meetsCriteria）：模型自己指出病历里已有够得上名称程度的依据时，D 不采信；
//     A–C、没有这两个字段（旧缓存、旧输出）的 D 照旧——保住甲方 10/17 的口径（缺铁性贫血只有血红蛋白→贫血，PCOS 不够两项→月经稀发）
//   2 端到端：模型回「D + meetsCriteria:true」时西医半原样返回；回「D + meetsCriteria:false」时照常改名；请求里带前置核对的说明与两个字段
//   3 诊断标准要点表：阿尔茨海默病按 NIA-AA 2011 可临床诊断（原条目取自 2024 年生物学定义，要求 PET/脑脊液）；其余条目不变
//   4 西医半提示词：粒度（按最特异的客观依据写最具体一层）与并发症/合并症必写（急危重诊断有依据不得省略），完整版与西医半版两处一致
//
// 反证（原地改一个字符串，记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 9/western）：
//   1.x 把 decisiveFindingVetoesD 里 meetsCriteria === true 的分支改成 false ⇒ 1.1/2.1 变红
//   1.3 把 parse 里的 type === "D" 否决条件改成 type !== "X" ⇒ 1.3（A 类被否决）变红
//   3.x 把表里阿尔茨海默病的 clinicallyDiagnosable 改回 false ⇒ 3.1 变红
//   4.x 把 m03-context-packets.ts 里“必须写进 name”改成“可以写进 name” ⇒ 4.1 变红
//
// 跑法：cd 工作树 && node --max-old-space-size=1536 node_modules/.bin/jiti scripts/test-r1021-western.mjs（不进闸门，主控注册）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.R1021_SRC || path.join(REPO, "src");
const jiti = createJiti(import.meta.url, {
  alias: { "@": SRC, "server-only": path.join(REPO, "node_modules/next/dist/compiled/server-only/empty.js") },
});
process.env.CDSS_WEB_SEARCH = "false";
process.env.CDSS_SMALL_TASK_MEMO = "false";
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
    process.exitCode = 1;
  }
};
const lib = (file) => jiti.import(path.join(SRC, "lib", file));
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });

const checkMod = await lib("western-name-evidence-check.server.ts");

// ── 1 ── decisive / meetsCriteria
const recordIda = "主诉：乏力、头晕3月\n现病史：近3月乏力、头晕，活动后心慌，月经量增多。辅助检查：血常规 血红蛋白98g/L。";
const recordLower = "主诉：吞咽不畅2年\n现病史：两年来咽下不畅，时轻时重，近年加重。食管造影见食管下端呈锥形狭窄。";
const verdict = (extra) => JSON.stringify({ verdict: "inconsistent", type: "D", quote: "血常规 血红蛋白98g/L", reason: "缺铁性贫血需铁代谢，病历只有血红蛋白", supportedName: "贫血", missingTest: "血清铁蛋白", ...extra });
{
  await check("1.1 前置核对自己写 meetsCriteria:true 的 D 不采信（食管造影见锥形狭窄的贲门失弛缓症不被换成「待查」）", () => {
    const content = JSON.stringify({ decisive: "食管造影见食管下端呈锥形狭窄", meetsCriteria: true, verdict: "inconsistent", type: "D", quote: "两年来咽下不畅", reason: "确诊需食管测压，病历只有造影", supportedName: "贲门失弛缓症待查", missingTest: "食管测压" });
    assert.equal(checkMod.parseWesternNameCorrection(content, recordLower, "贲门失弛缓症"), undefined);
    // meetsCriteria:true 单独就否决（decisive 为空串或不在病历里时也一样）；只靠 decisive 逐字命中的路径不能替它顶班
    for (const decisive of ["", "病历里没有的一句话"]) {
      assert.equal(checkMod.parseWesternNameCorrection(content.replace(/"decisive":"[^"]*"/u, `"decisive":"${decisive}"`), recordLower, "贲门失弛缓症"), undefined, decisive);
    }
    // 对照：同一个回答把 meetsCriteria 写成 false（依据确实不够）照常采信
    const accepted = checkMod.parseWesternNameCorrection(content.replace('"meetsCriteria":true', '"meetsCriteria":false'), recordLower, "贲门失弛缓症");
    assert.equal(accepted?.supportedName, "贲门失弛缓症待查");
  });
  await check("1.2 没写 meetsCriteria、但交出逐字在病历里的 decisive：同样否决；decisive 不在病历里、或不足 4 字：不否决（对照）", () => {
    assert.equal(checkMod.parseWesternNameCorrection(verdict({ decisive: "血常规 血红蛋白98g/L" }), recordIda, "缺铁性贫血"), undefined);
    assert.equal(checkMod.parseWesternNameCorrection(verdict({ decisive: "血清铁蛋白5ug/L" }), recordIda, "缺铁性贫血")?.supportedName, "贫血");
    assert.equal(checkMod.parseWesternNameCorrection(verdict({ decisive: "乏力" }), recordIda, "缺铁性贫血")?.supportedName, "贫血");
    assert.equal(checkMod.parseWesternNameCorrection(verdict({ decisive: "" }), recordIda, "缺铁性贫血")?.supportedName, "贫血");
  });
  await check("1.3 否决只管 D：A 类（已记录的检查所见与病名相反）meetsCriteria:true 仍采信；没有这两个字段的旧输出照旧采信（甲方 10/17 口径：缺铁性贫血只有血红蛋白→贫血）", () => {
    const typeA = JSON.stringify({ decisive: "血常规 血红蛋白98g/L", meetsCriteria: true, verdict: "inconsistent", type: "A", quote: "血常规 血红蛋白98g/L", reason: "血红蛋白98g/L，正常范围内不支持", supportedName: "贫血" });
    assert.equal(checkMod.parseWesternNameCorrection(typeA, recordIda, "缺铁性贫血")?.supportedName, "贫血");
    assert.equal(checkMod.parseWesternNameCorrection(verdict({}), recordIda, "缺铁性贫血")?.supportedName, "贫血");
  });
  await check("1.4 decisiveFindingVetoesD 的取值表（true 否决；false 不否决；缺省时看 decisive 是否逐字在病历里且≥4字）", () => {
    const veto = checkMod.decisiveFindingVetoesD;
    assert.equal(veto("", true, recordIda), true);
    assert.equal(veto("血红蛋白98g/L", false, recordIda), false);
    assert.equal(veto("血红蛋白98g/L", undefined, recordIda), true);
    assert.equal(veto("血红蛋白98g/L", "true", recordIda), true);
    assert.equal(veto("铁蛋白5", undefined, recordIda), false);
    assert.equal(veto(undefined, undefined, recordIda), false);
    assert.equal(veto("血红", undefined, recordIda), false);
  });
}

// ── 2 ── 端到端（fetch 桩）
{
  const half = (name) => JSON.stringify({ westernDiagnosis: { primary: { name }, candidates: [{ name, likelihood: "高", keyEvidence: [], againstEvidence: [] }], differentials: [] } });
  const nameOf = (content) => JSON.parse(content).westernDiagnosis.primary.name;
  const savedFetch = globalThis.fetch;
  try {
    const seen = [];
    const answer = (payload) => { globalThis.fetch = async (_url, init) => { seen.push(JSON.parse(String(init?.body || "{}"))); return completion(payload); }; };
    const record = recordLower;
    await check("2.1 模型回 D + meetsCriteria:true：西医半原样返回；回 meetsCriteria:false：照常改成「待查」（对照）", async () => {
      answer({ decisive: "食管造影见食管下端呈锥形狭窄", meetsCriteria: true, verdict: "inconsistent", type: "D", quote: "两年来咽下不畅", reason: "确诊需食管测压，病历只有造影", supportedName: "贲门失弛缓症待查", missingTest: "食管测压" });
      assert.equal(nameOf(await checkMod.alignWesternNameWithRecord(half("贲门失弛缓症"), { recordText: record })), "贲门失弛缓症");
      answer({ decisive: "", meetsCriteria: false, verdict: "inconsistent", type: "D", quote: "两年来咽下不畅", reason: "确诊需食管测压，病历没有食管检查", supportedName: "贲门失弛缓症待查", missingTest: "食管测压" });
      assert.equal(nameOf(await checkMod.alignWesternNameWithRecord(half("贲门失弛缓症"), { recordText: record })), "贲门失弛缓症待查");
    });
    await check("2.2 请求里有前置核对说明、两个字段在输出格式最前、max_tokens 够写（≥320）", async () => {
      seen.length = 0;
      answer({ verdict: "consistent", type: "" });
      await checkMod.alignWesternNameWithRecord(half("贲门失弛缓症"), { recordText: record });
      const system = String(seen.at(-1)?.messages?.[0]?.content || "");
      assert.ok(system.includes("D 的前置核对"), "缺前置核对说明");
      assert.ok(system.includes("诊断标准的全部条件都要数"), "缺全部条件说明（排除性诊断的排除、病程门槛）");
      assert.ok(system.includes('{"decisive":"…","meetsCriteria":true|false,"verdict"'), "输出格式里 decisive/meetsCriteria 不在最前");
      assert.ok(system.includes("患者自述的症状、病程、病史不算"), "decisive 没有排除症状（S058 功能性便秘把「排便困难2年」当 decisive 而漏掉 50 岁以上须结肠镜）");
      assert.ok(system.includes("表是公认标准的当前版本"), "缺受治理要点表的约束（缺铁性贫血等要点表里要求检查的病不能被典型表现顶替）");
      assert.ok(!system.includes("支气管哮喘凭反复发作的喘息"), "临床诊断示例里不应有要点表要求检查的支气管哮喘（与表矛盾）");
      assert.ok(system.includes("去掉这个限定"), "缺 D 类只去限定的说明");
      assert.ok(system.includes("不退到症状"), "缺「病名伴症状」的说明");
      assert.ok(Number(seen.at(-1)?.max_tokens) >= 320, `max_tokens ${seen.at(-1)?.max_tokens}`);
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// ── 3 ── 诊断标准要点表
{
  const table = JSON.parse(fs.readFileSync(path.join(SRC, "data/western-diagnostic-criteria.source.json"), "utf8"));
  const entry = (name) => table.entries.find((item) => item.name === name);
  await check("3.1 阿尔茨海默病：可临床诊断、不要求 PET/脑脊液；原文引自 PubMed 21514250 摘要；订正带改前内容与依据", () => {
    const ad = entry("阿尔茨海默病");
    assert.equal(ad.clinicallyDiagnosable, true);
    assert.deepEqual(ad.requiredTests, []);
    assert.ok(ad.quote.includes("The core clinical criteria for AD dementia will continue to be the cornerstone of the diagnosis in clinical practice"));
    assert.ok(ad.url.includes("pubmed.ncbi.nlm.nih.gov/21514250"));
    assert.equal(ad.reviewCorrection?.before?.clinicallyDiagnosable, false);
    assert.ok(ad.reviewCorrection.before.requiredTests.length >= 2 && ad.reviewCorrection.basis.length > 40);
  });
  // 2026-10-24 第十七轮加了新生儿败血症、婴儿败血症两行（135 → 137）。
  await check("3.2 对照：其余条目不变（条目数 137；缺铁性贫血、支气管哮喘、社区获得性肺炎仍要求检查，不可临床诊断）", () => {
    assert.equal(table.entries.length, 137);
    for (const name of ["缺铁性贫血", "支气管哮喘", "社区获得性肺炎", "多囊卵巢综合征"]) {
      assert.ok(entry(name), name);
      assert.ok(entry(name).requiredTests.length > 0 || entry(name).durationThreshold || entry(name).definingFeatures.length > 0, name);
    }
    assert.equal(entry("缺铁性贫血").clinicallyDiagnosable, false);
    assert.equal(entry("支气管哮喘").clinicallyDiagnosable, false);
  });
}

// ── 4 ── 提示词
{
  const packets = fs.readFileSync(path.join(SRC, "lib/m03-context-packets.ts"), "utf8");
  const prompts = fs.readFileSync(path.join(SRC, "lib/diagnosis-prompts.ts"), "utf8");
  const GRANULARITY = "按它能确立的最具体一层写：不停在它之上一层";
  // 第十轮（10/20 用户定）撤回「并发症必须写进 name」：r19j 的 D 集出现「急性心肌炎伴心力衰竭」「支气管肺炎合并心力衰竭」等无据并入。
  // 有客观依据的并发症改为 differentials 第一项并点明依据，急危重诊断仍不得省略。
  const COMPLICATION = "列为 differentials 的第一项并在 reason 里点明依据，不靠推测并入 name";
  await check("4.1 西医半提示词：粒度原则；有据的并发症/合并症列鉴别第一项、不并入病名（休克、DIC、多器官功能衰竭、急腹症有依据不得省略）", () => {
    assert.ok(packets.includes(GRANULARITY), "西医半缺粒度原则");
    assert.ok(packets.includes(COMPLICATION), "西医半缺并发症列鉴别第一项");
    assert.ok(!packets.includes("必须写进 name"), "西医半仍要求并发症写进病名");
    assert.ok(packets.includes("休克、DIC、多器官功能衰竭、急腹症这类急危重诊断有依据时不得省略"));
    // 单次出现：不是复制粘贴了两遍
    assert.equal(packets.split(GRANULARITY).length - 1, 1);
  });
  await check("4.2 完整版提示词（修复轮、兜底用）与西医半同口径", () => {
    assert.ok(prompts.includes("按它能确立的最具体一层写：不停在它之上一层"), "完整版缺粒度原则");
    assert.ok(prompts.includes("列为 differentials 的第一项并在 reason 里点明依据，不靠推测并入 primary.name"), "完整版缺并发症列鉴别第一项");
    assert.ok(!prompts.includes("必须写进 primary.name"), "完整版仍要求并发症写进病名");
  });
  await check("4.3 对照：提示词没有把「伴」写成无条件追加——并发症以「病历已有客观依据」为前提", () => {
    assert.ok(packets.includes("病历已有客观依据的并发症、合并症"));
    assert.ok(!packets.includes("所有并发症必须写进 name"));
  });
}

console.log(cases === 0 ? "no cases ran" : `test-r1021-western: ${cases} cases${process.exitCode ? " (with failures)" : " passed"}`);
