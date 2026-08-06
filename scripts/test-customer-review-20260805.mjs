// 甲方《好医生&灵犀中医核对内容-2026-08-05》全条目回归。
//
// 这份套件的存在意义是：甲方每提一条，就在这里钉一条方向性判据，防止同一类问题复发。
// 每条注释写明「甲方原话 + 线上实测形态 + 判据为什么这么定」，后来人不必回头翻聊天记录。
//
// 覆盖口径说明：能在纯函数层判定的钉在这里；需要真实模型输出才能判定的（如辨病推理是否
// 言之有物、穴位推荐是否对证）在 regress-online-acceptance.mjs 的判定项里，两处不重复。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");

const wrap = (reasoning) =>
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
const unwrap = (content) =>
  JSON.parse(content.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/)[1]);

const failures = [];
const m03 = (overview, extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { primarySyndrome: "脾虚湿盛证", ...overview },
  pathogenesis: {
    summary: "",
    chain: [],
    natureDifferentiation: { items: ["气虚", "湿盛"], rootDeficiency: [], branchExcess: [] },
    ...(extra.pathogenesis || {}),
  },
  therapy: { overallPrinciple: "暂不锁定剂量级治法", overallMethod: "健脾益气，渗湿止泻", subTherapies: [] },
});
const normalized = (overview, extra) =>
  unwrap(summary.applyDeterministicTreatmentPrinciple(wrap(m03(overview, extra))));

// ─── 甲方 2.1 辨病推理格式错误 ────────────────────────────────────────────
// 原话:「患者以头痛为主要症状，符合中医头痛/头风病诊断标准，故诊断头痛/头风病」
// 两个形式问题:斜杠并列两个病名(辨病没落定)、推理是同义反复(读完不知凭什么判这个病)。
// 判据只管形式,不替模型编造依据——编造依据会造出病历里没有的事实,比不给依据更坏。
{
  const out = normalized({
    tcmDiseaseName: "头痛/头风病",
    tcmDiseaseRationale: "患者以头痛为主要症状，符合中医头痛/头风病诊断标准，故诊断头痛/头风病",
  });
  if (/[/／、|]/.test(out.overview.tcmDiseaseName)) {
    failures.push({ item: "2.1 病名并列", why: `病名必须单一,实际 ${out.overview.tcmDiseaseName}` });
  }
  if (out.overview.tcmDiseaseName !== "头痛") {
    failures.push({ item: "2.1 病名并列", why: `应取首个受治理病名「头痛」,实际 ${out.overview.tcmDiseaseName}` });
  }
  if (/符合.*诊断标准.*故诊断/.test(out.overview.tcmDiseaseRationale)) {
    failures.push({ item: "2.1 循环套话", why: "同义反复的辨病推理必须被标记,不得原样呈现" });
  }
}
{
  // 实质推理不得被误伤:有主症、病程形态、鉴别方向的推理必须原样保留。
  const substantive = "主症为大便时溏时泻、迁延反复，进食油腻则加重；病程迁延非急性暴泻，故归入泄泻，需与痢疾（里急后重、脓血便）相鉴别";
  const out = normalized({ tcmDiseaseName: "泄泻", tcmDiseaseRationale: substantive });
  if (out.overview.tcmDiseaseRationale !== substantive) {
    failures.push({ item: "2.1 误伤", why: "有实质内容的辨病推理不得被改写" });
  }
}

// ─── 甲方 3.2 总体病机展示错误 ───────────────────────────────────────────
// 原话截图:总体病机写着「病历已记录腹泻，排解不畅。」——病历事实 + 服务端极性模板,
// 不是病机。病机要回答「为什么会这样」,不是把主诉换个说法再说一遍。
{
  const restated = normalized({ overallPathogenesis: "病历已记录腹泻，排解不畅。" });
  if (/^病历已记录/.test(restated.overview.overallPathogenesis)) {
    failures.push({ item: "3.2 病机复述", why: "病历事实复述不得作为总体病机呈现" });
  }
  const symptomOnly = normalized({ overallPathogenesis: "头痛，反复发作" });
  if (symptomOnly.overview.overallPathogenesis === "头痛，反复发作") {
    failures.push({ item: "3.2 症状复述", why: "纯症状复述不含任何病机要素,不得作为总体病机" });
  }
  // 真病机必须原样保留——收紧不得变成把正确结论也抹掉。
  for (const real of ["脾失健运，湿浊内生，清浊不分，混杂而下", "风热外袭，卫表失和，肺气失宣"]) {
    const kept = normalized({ overallPathogenesis: real });
    if (kept.overview.overallPathogenesis !== real) {
      failures.push({ item: "3.2 误伤", why: `真病机被改写: ${real}` });
    }
  }
}

// ─── 甲方 4.1 治则未显示 ────────────────────────────────────────────────
// 原话:「治则未显示」。实为工程占位串「暂不锁定剂量级治法」直落到医生眼前,20 例 19 例命中。
{
  const out = normalized({});
  if (/暂不锁定剂量级治法/.test(out.therapy.overallPrinciple)) {
    failures.push({ item: "4.1 治则", why: "工程占位串不得作为治则呈现" });
  }
}

// ─── 甲方 7.1 方义分析 ─────────────────────────────────────────────────
// 原话:「方义分析是分析该药在方中所发挥作用，无需罗列所有功效，且生姜分析错误」。
// 线上实测(参苓白术散):人参写「大补元气，复脉固脱」、桔梗写「祛痰排脓，清利头目」——
// 前者与本方无关,后者在本方是载药上行、写反了。根因:知识库功效串被整段照抄,
// 而且串里还混着药类分类标签(补气药/补虚药)。
{
  const analysis = (herb, role, target, therapy) =>
    knowledge.getTcmHerbFunctionDisplayText(herb, role, target, therapy);

  const ginseng = analysis("人参", "君", "脾胃虚弱，运化失健", "健脾益气，渗湿止泻");
  if (/复脉固脱|安神益智/.test(ginseng)) {
    failures.push({ item: "7.1 罗列功效", why: `与本方无关的功效不得进入方义: ${ginseng}` });
  }
  if (!/补脾|益肺|益气/.test(ginseng)) {
    failures.push({ item: "7.1 相关功效丢失", why: `与本方治法相关的功效必须保留: ${ginseng}` });
  }
  const platycodon = analysis("桔梗", "佐", "引经载药", "健脾益气，渗湿止泻");
  if (/祛痰排脓|清利头目/.test(platycodon)) {
    failures.push({ item: "7.1 方义写反", why: `参苓白术散中桔梗非祛痰排脓: ${platycodon}` });
  }
  // 药类分类标签是分类学不是方义,任何药味都不得把它印出来
  for (const herb of ["人参", "麻黄", "薏苡仁", "白扁豆", "炙甘草"]) {
    const text = analysis(herb, "臣", "本例病机", "健脾益气");
    if (/(?:^|[，,；;])[^，,；;]*药(?:[，,；;]|$)/.test(text) && /(?:补气药|补虚药|解表药|发散风寒药|利水渗湿药|化痰止咳平喘药)/.test(text)) {
      failures.push({ item: "7.1 分类标签", why: `${herb} 方义混入药类标签: ${text}` });
    }
  }
  // 通用套话不得再出现——它等于什么都没说
  const filler = analysis("白扁豆", "臣", "脾虚湿盛，水湿内停", "健脾益气，渗湿止泻");
  if (/协同君药、加强主治方向|兼顾兼夹病机或制约峻烈|配伍定位：承接/.test(filler)) {
    failures.push({ item: "7.1 套话", why: `通用套话不得作为方义: ${filler}` });
  }

  // 7.1 的**反向守卫**：角色兜底句必须被合同层判为已接地。
  //
  // 上面几条钉的是「不许照印全部功效」，本条钉的是「照做之后不会把处方弄没」。
  // 二者缺一不可：曾有一版改动正是因为担心兜底句被判 function_ungrounded 拖垮整个候选，
  // 转而放宽 7.1 去照印全部功效——而放行正则一直都在，代价白付。
  // 用**导出的真实判据**断言，不在测试里重建副本。
  const { herbFunctionMatchesKnowledge } = await import("jiti").then(({ createJiti }) =>
    createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } })
      .import("../src/lib/diagnosis-stage-contract.ts"));
  for (const [herb, role] of [["桔梗", "佐"], ["白扁豆", "臣"], ["薏苡仁", "臣"]]) {
    const text = analysis(herb, role, "脾虚湿盛，水湿内停", "健脾益气，渗湿止泻");
    if (!herbFunctionMatchesKnowledge(herb, text, role, "脾虚湿盛，水湿内停")) {
      failures.push({
        item: "7.1 兜底句接地",
        why: `${herb} 的方义「${text}」被合同判为 function_ungrounded，整个候选会被驳回`,
      });
    }
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
}
assert.equal(
  failures.length, 0,
  `甲方 2026-08-05 核对条目回归失败 ${failures.length} 项。每条都对应一份线上实测缺陷,` +
  `失守即为该类问题复发。`,
);

console.log(JSON.stringify({
  "2.1_辨病推理格式": "pass",
  "3.2_总体病机不复述病历": "pass",
  "4.1_治则非占位串": "pass",
  "7.1_方义按本方作用": "pass",
  failures: 0,
}));
