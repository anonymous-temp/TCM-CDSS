// 10/20 第十轮 WP10-W（西医诊断稳定性）B3：病名核对两次一致才采信。
//
// 起因：第九轮代码对同一批 80 例病历（D 集子集）跑两次，西医主诊断名不同 14/80 = 18%；其中 4 例是病名核对这一次判 D、下一次不判
//（肺结核↔肺结核待查、急性肾盂肾炎↔尿路感染、梗阻性黄疸↔梗阻性黄疸待查、胃癌待查↔上消化道出血待查）。做法照 m03-patient-claim-check：
// 两次核对并行（第二次把输入的内容顺序整个颠倒，缓存键因此不同），两次都给出可采信的改名、类型相同、解析后的名称相同才改名。
//
//   1 agreedWesternNameCorrection（纯函数）：同类型同名称才一致；任一次不改 / 类型不同 / 名称不同都不改名；
//     D 类名称只是宽窄不同（哮喘待查/支气管哮喘待查、骨质疏松待查/绝经后骨质疏松症待查、颈椎病/颈椎病待查）取较弱的公共名称
//     （离线回放里甲方口径保护例 S114 因此丢过降级），与两次的先后无关；不相干的名称（心包炎待查/心包积液待查）仍不一致
//     保守合并：任一次说原名属急危重症则按急危重症；病程「远不到门槛」只有两次都这么说才算
//   2 端到端（fetch 桩）：两次都判同一个 D → 照旧降级（功能性消化不良半月 → 消化不良待查）；一次判 D 一次不判 → 不改（正反两个方向）；
//     两次名称不同 → 不改；类型不同 → 不改；红旗病例的既有口径不变（D 不采信、A 采信）
//   3 请求形状：第一次请求与单次时代逐字相同（缓存键、离线回放可对照）；第二次同一份说明、同一批字段、顺序颠倒；两次并行（并发 2）；
//     同一份病历再请求命中缓存（不再发请求）
//   4 开关：CDSS_WESTERN_NAME_CHECK_AGREEMENT=false 恢复单次（只发一次请求，只看第一次的结论）
//   5 遥测：western_name_evidence_check 带 agreement / firstPass / secondPass
//
// 反证（原地改一个字符串，记录追加到 ~/runlogs/r1018/work/r1022/counterproofs.txt，前缀 10/west）：
//   1.2/2.2 把 one_only 分支改成 correction: first ?? second ⇒ 变红
//   1.3/2.4 删掉类型比较 ⇒ 变红
//   1.4/2.3 删掉名称比较 ⇒ 变红
//   1.6/1.7/2.6 weakerCommonWesternName 恒返回 undefined ⇒ 变红；取较长的核心名（而不是较短的）⇒ 1.6 变红
//   2.1/3.x agreementRequired 恒为 false ⇒ 2.2 变红（单次时只看第一次）
//   3.2 第二次请求不颠倒内容顺序 ⇒ 变红
//   3.3 两次改成串行 await ⇒ 变红
//
// 跑法：cd 工作树 && node --max-old-space-size=1536 node_modules/.bin/jiti scripts/test-r1022-western.mjs（不进闸门，主控注册）
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.R1022_SRC || path.join(REPO, "src");
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
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message.slice(0, 600) : String(error)}`);
    process.exitCode = 1;
  }
};
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });

const checkMod = await jiti.import(path.join(SRC, "lib/western-name-evidence-check.server.ts"));
const memo = await jiti.import(path.join(SRC, "lib/small-task-memo.server.ts"));

const half = (name, extra = {}) => JSON.stringify({ westernDiagnosis: { primary: { name }, candidates: [{ name, likelihood: "高", keyEvidence: [], againstEvidence: [] }], differentials: [], ...extra } });
const nameOf = (content) => JSON.parse(content).westernDiagnosis.primary.name;
const RECORD = "主诉：上腹胀满半个月\n现病史：近半个月餐后上腹饱胀，嗳气，无呕吐、黑便，体重无明显变化。";
const dyspepsia = (extra = {}) => ({ verdict: "inconsistent", type: "D", quote: "餐后上腹饱胀", reason: "功能性消化不良需病程满6个月，病历仅半个月", supportedName: "消化不良待查", missingTest: "胃镜", ...extra });
const consistent = { verdict: "consistent", type: "" };

// ── 1 ── 纯函数：agreedWesternNameCorrection
const corr = (extra = {}) => ({ supportedName: "消化不良待查", quote: "餐后上腹饱胀", reason: "病程仅半个月", type: "D", ...extra });
{
  const agreed = checkMod.agreedWesternNameCorrection;
  await check("1.1 同类型同名称：一致，取第一次的引文与理由；名称按紧凑形式比较（空白不算不同）", () => {
    const out = agreed(corr({ quote: "第一次引文", reason: "第一次理由" }), corr({ supportedName: "消化不良 待查", quote: "第二次引文", reason: "第二次理由" }));
    assert.equal(out.agreement, "agreed");
    assert.equal(out.correction?.supportedName, "消化不良待查");
    assert.equal(out.correction?.quote, "第一次引文");
    assert.equal(out.correction?.reason, "第一次理由");
  });
  await check("1.2 只有一次给出改名（正反两个方向）：不改名，标 one_only；两次都不改：none", () => {
    assert.deepEqual(agreed(corr(), undefined), { agreement: "one_only" });
    assert.deepEqual(agreed(undefined, corr()), { agreement: "one_only" });
    assert.deepEqual(agreed(undefined, undefined), { agreement: "none" });
  });
  await check("1.3 类型不同（同一名称）：不改名，标 type_differs", () => {
    assert.deepEqual(agreed(corr({ type: "D" }), corr({ type: "C" })), { agreement: "type_differs" });
    assert.deepEqual(agreed(corr({ type: "A" }), corr({ type: "B" })), { agreement: "type_differs" });
  });
  await check("1.4 名称不同（同一类型）：不改名，标 name_differs（含「X待查」与「Y待查」）", () => {
    assert.deepEqual(agreed(corr({ supportedName: "消化不良待查" }), corr({ supportedName: "上腹痛待查" })), { agreement: "name_differs" });
    // 不相干的名称（不是字序子序列的关系）即使同属 D 也不一致
    assert.deepEqual(agreed(corr({ supportedName: "心包炎待查" }), corr({ supportedName: "心包积液待查" })), { agreement: "name_differs" });
    // 名称合并只给 D 类：A–C 的名称是病历所见指向的另一个病，宽窄不同就是不同的结论
    assert.deepEqual(agreed(corr({ type: "A", supportedName: "颈椎病" }), corr({ type: "A", supportedName: "颈椎病待查" })), { agreement: "name_differs" });
  });
  await check("1.5 保守合并：任一次说原名属急危重症则按急危重症；病程「远不到门槛」两次都说才算，否则按「未满」", () => {
    assert.equal(agreed(corr({ currentIsEmergency: true }), corr()).correction?.currentIsEmergency, true);
    assert.equal(agreed(corr(), corr({ currentIsEmergency: true })).correction?.currentIsEmergency, true);
    assert.equal(agreed(corr(), corr()).correction?.currentIsEmergency, undefined);
    const far = agreed(corr({ course: "far_below", courseNextCheck: "胃镜" }), corr({ course: "far_below" })).correction;
    assert.equal(far?.course, "far_below");
    assert.equal(far?.courseNextCheck, "胃镜");
    const unmet = agreed(corr({ course: "far_below", courseNextCheck: "胃镜" }), corr({ course: "unmet" })).correction;
    assert.equal(unmet?.course, "unmet");
    assert.equal(unmet?.courseNextCheck, "胃镜");
    // 一次判病程、另一次没判（理由里是缺检查）：不删原病名
    assert.equal(agreed(corr({ course: "far_below" }), corr()).correction?.course, "unmet");
    assert.equal(agreed(corr(), corr()).correction?.course, undefined);
  });
}

{
  const weaker = checkMod.weakerCommonWesternName;
  const agreed = checkMod.agreedWesternNameCorrection;
  await check("1.6 weakerCommonWesternName：同一个病说到不同宽度取较弱的公共名称（较短核心名；任一方带「待查」就带「待查」），与参数先后无关", () => {
    const table = [
      ["哮喘待查", "支气管哮喘待查", "哮喘待查"],
      ["骨质疏松待查", "绝经后骨质疏松症待查", "骨质疏松待查"],
      ["颈椎病", "颈椎病待查", "颈椎病待查"],
      ["颈椎病", "神经根型颈椎病待查", "颈椎病待查"],
      ["颈椎病", "神经根型颈椎病", "颈椎病"],
      ["肌萎缩待查", "脊髓性肌萎缩症待查", "肌萎缩待查"],
      ["重症肺炎", "肺炎待查", "肺炎待查"],
      ["尿潴留待查", "慢性尿潴留待查", "尿潴留待查"],
    ];
    for (const [a, b, expected] of table) {
      assert.equal(weaker(a, b), expected, `${a} / ${b}`);
      assert.equal(weaker(b, a), expected, `${b} / ${a}（顺序颠倒）`);
    }
    // 对照：不是字序子序列的关系、核心名短于 2 字，都不合并
    for (const [a, b] of [["心包炎待查", "心包积液待查"], ["上消化道出血待查", "下消化道出血待查"], ["甲状腺瘤", "甲状腺癌骨转移待查"], ["痛待查", "腹痛待查"]]) {
      assert.equal(weaker(a, b), undefined, `${a} / ${b}`);
    }
  });
  await check("1.7 D 类宽窄不同的两个名称：一致，标 agreed_merged，名称取较弱的公共名称，引文取第一次；顺序颠倒结果相同；开关关闭时回到只比字面", () => {
    const one = corr({ supportedName: "骨质疏松待查", quote: "第一次引文" });
    const two = corr({ supportedName: "绝经后骨质疏松症待查", quote: "第二次引文" });
    const out = agreed(one, two);
    assert.equal(out.agreement, "agreed_merged");
    assert.equal(out.correction?.supportedName, "骨质疏松待查");
    assert.equal(out.correction?.quote, "第一次引文");
    assert.equal(agreed(two, one).correction?.supportedName, "骨质疏松待查");
    // 对照：字面相同仍是 agreed，不是 agreed_merged
    assert.equal(agreed(one, corr({ supportedName: "骨质疏松待查" })).agreement, "agreed");
    process.env.CDSS_WESTERN_NAME_CHECK_NAME_MERGE = "false";
    try {
      assert.deepEqual(agreed(one, two), { agreement: "name_differs" });
    } finally {
      delete process.env.CDSS_WESTERN_NAME_CHECK_NAME_MERGE;
    }
  });
}

// ── 2/3/4/5 ── 端到端（fetch 桩）
{
  const savedFetch = globalThis.fetch;
  const savedInfo = console.info;
  const telemetry = [];
  console.info = (...args) => {
    if (args[0] === "[tcm-cdss:telemetry] western_name_evidence_check") telemetry.push(args[1]);
  };
  const seen = [];
  /** 按请求内容顺序答：forward（用户消息以 patient 开头）与 reversed（以 patient 结尾）各自的回答。 */
  const answerByOrder = (forward, reversed, delayMs = 0) => {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const userContent = String(body.messages?.[1]?.content || "");
      const order = userContent.startsWith('{"patient"') ? "forward" : "reversed";
      seen.push({ order, body, startedAt: Date.now() });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return completion(order === "forward" ? forward : reversed);
    };
  };
  const align = (name, extra = {}) => checkMod.alignWesternNameWithRecord(half(name), { recordText: RECORD, ...extra });
  try {
    await check("2.1 两次都判同一个 D：照旧降级成「消化不良待查」，原病名留在鉴别里；请求恰好两次（一正一反）", async () => {
      seen.length = 0;
      answerByOrder(dyspepsia(), dyspepsia({ quote: "近半个月餐后上腹饱胀" }));
      const out = await align("功能性消化不良");
      assert.equal(nameOf(out), "消化不良待查");
      // 病程半个月、远不到门槛的四分之一：原病名不再留在候选与鉴别里（既有口径，course: far_below）
      assert.ok(!JSON.parse(out).westernDiagnosis.differentials.some((item) => item.name === "功能性消化不良"));
      assert.deepEqual(seen.map((item) => item.order).sort(), ["forward", "reversed"]);
    });
    await check("2.2 第一次判 D、第二次不判（以及相反）：不改名——正反两个方向都要有（对照：2.1 两次都判才改）", async () => {
      answerByOrder(dyspepsia(), consistent);
      assert.equal(nameOf(await align("功能性消化不良")), "功能性消化不良");
      answerByOrder(consistent, dyspepsia());
      assert.equal(nameOf(await align("功能性消化不良")), "功能性消化不良");
      answerByOrder(consistent, consistent);
      assert.equal(nameOf(await align("功能性消化不良")), "功能性消化不良");
    });
    await check("2.3 两次都判 D 但名称不同：不改名", async () => {
      answerByOrder(dyspepsia({ supportedName: "消化不良待查" }), dyspepsia({ supportedName: "上腹痛待查" }));
      assert.equal(nameOf(await align("功能性消化不良")), "功能性消化不良");
    });
    await check("2.3b 两次都判 D、名称只是宽窄不同（消化不良待查 / 功能性消化不良待查）：改成较弱的公共名称「消化不良待查」，遥测标 agreed_merged", async () => {
      telemetry.length = 0;
      answerByOrder(dyspepsia({ supportedName: "消化不良待查" }), dyspepsia({ supportedName: "功能性消化不良待查" }));
      assert.equal(nameOf(await align("功能性消化不良")), "消化不良待查");
      assert.equal(telemetry.at(-1)?.agreement, "agreed_merged");
      // 对照：反过来（第一次说得更宽）结果相同；开关关闭时名称不同不改名
      answerByOrder(dyspepsia({ supportedName: "功能性消化不良待查" }), dyspepsia({ supportedName: "消化不良待查" }));
      assert.equal(nameOf(await align("功能性消化不良")), "消化不良待查");
      process.env.CDSS_WESTERN_NAME_CHECK_NAME_MERGE = "false";
      try {
        assert.equal(nameOf(await align("功能性消化不良")), "功能性消化不良");
      } finally {
        delete process.env.CDSS_WESTERN_NAME_CHECK_NAME_MERGE;
      }
    });
    await check("2.4 名称相同但类型不同（D 与 C）：不改名", async () => {
      answerByOrder(dyspepsia(), dyspepsia({ type: "C", reason: "指标只够较轻一层" }));
      assert.equal(nameOf(await align("功能性消化不良")), "功能性消化不良");
    });
    await check("2.5 红旗病例的既有口径不变：两次一致的 D 不采信；两次一致的 A（病历记录与病名相反）照常采信", async () => {
      answerByOrder(dyspepsia(), dyspepsia());
      assert.equal(nameOf(await align("功能性消化不良", { redFlag: true })), "功能性消化不良");
      const typeA = { verdict: "inconsistent", type: "A", quote: "无呕吐、黑便", reason: "病历记录无呕吐、黑便，不支持", supportedName: "消化不良待查" };
      answerByOrder(typeA, typeA);
      assert.equal(nameOf(await align("功能性消化不良", { redFlag: true })), "消化不良待查");
    });

    // 3 请求形状
    await check("3.1 第一次请求与单次时代逐字相同（用户消息以 patient 开头、字段 patient/record/diagnosisName 在前）", async () => {
      seen.length = 0;
      answerByOrder(consistent, consistent);
      await align("功能性消化不良");
      const forward = seen.find((item) => item.order === "forward").body.messages;
      const keys = Object.keys(JSON.parse(forward[1].content));
      assert.deepEqual(keys.slice(0, 3), ["patient", "record", "diagnosisName"]);
      assert.ok(keys.slice(3).every((key) => key === "criteria" || key === "listedDiagnoses"), keys.join());
      process.env.CDSS_WESTERN_NAME_CHECK_AGREEMENT = "false";
      try {
        seen.length = 0;
        await align("功能性消化不良");
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0].body.messages, forward, "单次开关下的唯一请求必须与两次一致时的第一次请求逐字相同");
      } finally {
        delete process.env.CDSS_WESTERN_NAME_CHECK_AGREEMENT;
      }
    });
    await check("3.2 第二次请求：同一份说明、同一批字段与取值，字段顺序颠倒、鉴别名单顺序颠倒（缓存键与第一次不同）", async () => {
      seen.length = 0;
      answerByOrder(consistent, consistent);
      const withListed = half("功能性消化不良", { differentials: [{ name: "胃食管反流病" }, { name: "慢性胃炎" }, { name: "消化性溃疡" }] });
      await checkMod.alignWesternNameWithRecord(withListed, { recordText: RECORD, patient: { sex: "男", age: 38 } });
      const forward = seen.find((item) => item.order === "forward").body.messages;
      const reversed = seen.find((item) => item.order === "reversed").body.messages;
      assert.equal(forward[0].content, reversed[0].content, "两次的系统说明必须相同");
      assert.notEqual(forward[1].content, reversed[1].content);
      const a = JSON.parse(forward[1].content);
      const b = JSON.parse(reversed[1].content);
      assert.deepEqual(Object.keys(b), [...Object.keys(a)].reverse());
      assert.deepEqual(a.listedDiagnoses, ["胃食管反流病", "慢性胃炎", "消化性溃疡"]);
      assert.deepEqual(b.listedDiagnoses, ["消化性溃疡", "慢性胃炎", "胃食管反流病"]);
      assert.equal(b.record, a.record);
      assert.equal(b.diagnosisName, a.diagnosisName);
      assert.deepEqual({ ...b, listedDiagnoses: undefined, patient: { ...b.patient } }, { ...a, listedDiagnoses: undefined, patient: { ...a.patient } });
      assert.deepEqual(b.patient, a.patient);
    });
    await check("3.3 两次并行：第二次请求在第一次返回之前就发出（并发 2，没有串行等待）", async () => {
      seen.length = 0;
      answerByOrder(consistent, consistent, 60);
      const started = Date.now();
      await align("功能性消化不良");
      const elapsed = Date.now() - started;
      assert.equal(seen.length, 2);
      assert.ok(Math.abs(seen[1].startedAt - seen[0].startedAt) < 40, `两次请求相隔 ${Math.abs(seen[1].startedAt - seen[0].startedAt)}ms，不是并行`);
      assert.ok(elapsed < 115, `总耗时 ${elapsed}ms，串行会 ≥120ms`);
    });
    await check("3.4 同一份病历再请求命中缓存：两次各自缓存，第二轮不再发请求", async () => {
      delete process.env.CDSS_SMALL_TASK_MEMO;
      memo.resetSmallTaskMemoForTests();
      try {
        seen.length = 0;
        answerByOrder(dyspepsia(), dyspepsia());
        const first = await align("功能性消化不良");
        assert.equal(seen.length, 2);
        const second = await align("功能性消化不良");
        assert.equal(seen.length, 2, "第二轮必须全部命中缓存");
        assert.equal(first, second);
        assert.equal(nameOf(second), "消化不良待查");
        // 对照：换一份病历不命中
        await checkMod.alignWesternNameWithRecord(half("功能性消化不良"), { recordText: `${RECORD}\n既往体健。` });
        assert.equal(seen.length, 4);
      } finally {
        process.env.CDSS_SMALL_TASK_MEMO = "false";
        memo.resetSmallTaskMemoForTests();
      }
    });

    // 4 开关
    await check("4.1 CDSS_WESTERN_NAME_CHECK_AGREEMENT=false 恢复单次：只发一次请求，只看第一次的结论（对照：默认下同样的回答不改名）", async () => {
      answerByOrder(dyspepsia(), consistent);
      assert.equal(nameOf(await align("功能性消化不良")), "功能性消化不良");
      process.env.CDSS_WESTERN_NAME_CHECK_AGREEMENT = "false";
      try {
        seen.length = 0;
        assert.equal(nameOf(await align("功能性消化不良")), "消化不良待查");
        assert.equal(seen.length, 1);
        assert.equal(seen[0].order, "forward");
      } finally {
        delete process.env.CDSS_WESTERN_NAME_CHECK_AGREEMENT;
      }
    });
    await check("4.2 CDSS_WESTERN_NAME_EVIDENCE_CHECK=false 照旧整关：一次请求都不发", async () => {
      process.env.CDSS_WESTERN_NAME_EVIDENCE_CHECK = "false";
      try {
        seen.length = 0;
        answerByOrder(dyspepsia(), dyspepsia());
        assert.equal(nameOf(await align("功能性消化不良")), "功能性消化不良");
        assert.equal(seen.length, 0);
      } finally {
        delete process.env.CDSS_WESTERN_NAME_EVIDENCE_CHECK;
      }
    });

    // 5 遥测
    await check("5.1 遥测带 agreement / firstPass / secondPass：一致、只一次、两次名称不同、单次开关各有取值", async () => {
      telemetry.length = 0;
      answerByOrder(dyspepsia(), dyspepsia());
      await align("功能性消化不良");
      answerByOrder(dyspepsia(), consistent);
      await align("功能性消化不良");
      answerByOrder(dyspepsia(), dyspepsia({ supportedName: "上腹痛待查" }));
      await align("功能性消化不良");
      process.env.CDSS_WESTERN_NAME_CHECK_AGREEMENT = "false";
      try {
        answerByOrder(dyspepsia(), consistent);
        await align("功能性消化不良");
      } finally {
        delete process.env.CDSS_WESTERN_NAME_CHECK_AGREEMENT;
      }
      assert.deepEqual(telemetry.map((item) => item.agreement), ["agreed", "one_only", "name_differs", "off"]);
      assert.deepEqual(telemetry.map((item) => item.applied), [true, false, false, true]);
      assert.equal(telemetry[0].firstPass, "D:消化不良待查");
      assert.equal(telemetry[0].secondPass, "D:消化不良待查");
      assert.equal(telemetry[1].secondPass, "-");
      assert.equal(telemetry[2].secondPass, "D:上腹痛待查");
    });
  } finally {
    globalThis.fetch = savedFetch;
    console.info = savedInfo;
  }
}

console.log(`test-r1022-western: ${cases} cases${process.exitCode ? " (FAILED)" : " ok"}`);
