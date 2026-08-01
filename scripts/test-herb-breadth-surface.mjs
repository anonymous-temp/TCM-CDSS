/**
 * Invariant: 扩大药味面只能放宽「伴随作用」，不能放宽「主要作用」「寒热极性」「毒性准入」。
 *
 * 需求11 要「中药味数尽可能多，合理且有依据」。做不到的原因不在提示词而在短名单：
 * 方向门禁把药味的**合并功用文本**当成它的身份，而合并功用文本是多条历史条文的并集，几乎每味
 * 经典药都顺带记载着一个高影响作用——当归「补血活血」、党参「清肺」、甘草「清热解毒」。于是
 * 心脾两虚（治法「补益心脾，养血安神」）病例里，归脾汤自己的当归、党参、甘草、龙眼肉被短名单
 * 全部剔除，医生一眼能看出名单是错的，模型也因此更容易走向自拟方。
 *
 * 解法是把一把尺子拆成两把，各自用在有效范围内：
 *   - 君药面 herbShortlistDirectionEligible：君药决定全方走向，继续用最严口径（含合并功用文本）。
 *   - 配伍面 herbCombinationDirectionEligible：臣佐使承担的是它被列入的那个方向，改用受治理身份
 *     口径（功能分类 ∪ 风险类目 ∪ 受治理映射），并新增「正向相关」这一条。
 * 寒热极性一票否决两面共用，一字未放宽。
 *
 * 本文件锁住这条放宽的四条边界，任何一条被越过都应当在这里失败，而不是在门诊里。
 */
import assert from "node:assert/strict";
import {
  herbCombinationDirectionEligible,
  herbShortlistDirectionEligible,
} from "../src/lib/diagnosis-stage-contract.ts";
import { buildPrescribePrompt } from "../src/lib/diagnosis-prompts.ts";
import { getTcmHerbGenerationSafetyProfile } from "../src/lib/tcm-knowledge.ts";

function priorFor(principle, directions) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: { primarySyndrome: "测试证候", tcmDiseaseName: "测试" },
    pathogenesis: {
      summary: "",
      chain: directions.map(([nodeId, direction]) => ({ nodeId, pathogenesis: "测试病机", therapyDirection: direction })),
      uncertainties: [],
    },
    therapy: { overallPrinciple: principle, overallMethod: principle, subTherapies: [] },
  };
}

const xinpi = priorFor("补益心脾、养血安神", [["P1", "补益心脾、养血安神"]]);
const jiangni = priorFor("和胃降逆", [["P1", "和胃降逆"]]);
const wenzhong = priorFor("温中散寒、健脾益气", [["P1", "温中散寒"]]);
const qingre = priorFor("清热泻火、解毒", [["P1", "清热泻火"]]);
const huoxue = priorFor("活血化瘀、通脉止痛", [["P1", "活血化瘀"]]);

// ── 1) 伴随作用不再误伤常用药：归脾汤自己的药味必须回到配伍面 ──────────────────
for (const herb of ["当归", "党参", "甘草", "龙眼肉"]) {
  assert.ok(
    herbCombinationDirectionEligible(herb, xinpi),
    `${herb} 是心脾两虚证的常规配伍药，被伴随作用误伤即为需求11 的直接病因`,
  );
}
// 乌药一类「温里作用只写在功用文本里」的药：配伍可用，但不得为君。
for (const herb of ["乌药", "九香虫", "刀豆", "土木香"]) {
  assert.ok(herbCombinationDirectionEligible(herb, jiangni), `${herb} 的理气方向已成立，可作配伍`);
  assert.ok(!herbShortlistDirectionEligible(herb, jiangni), `${herb} 的温里作用未在 M03 成立，不得为君`);
}

// ── 2) 主要作用未成立仍然一律挡下（放宽的只是伴随作用）──────────────────────────
const primaryActionBlocked = [
  ["大黄", xinpi, "攻下/泻下"],
  ["丹参", xinpi, "活血化瘀"],
  ["黄连", xinpi, "清热"],
  ["附子", xinpi, "温里"],
  ["麝香", xinpi, "开窍"],
  ["石菖蒲", xinpi, "开窍"],
  ["鳖甲", xinpi, "软坚散结"],
  ["大黄", jiangni, "攻下/泻下"],
  ["红豆蔻", qingre, "温里"],
  ["黄连", wenzhong, "清热"],
];
for (const [herb, prior, why] of primaryActionBlocked) {
  assert.ok(
    !herbCombinationDirectionEligible(herb, prior),
    `${herb} 的主要方向是${why}，该方向未在本例成立时不得进入任何药味面`,
  );
}

// ── 3) 寒热极性一票否决：两面共用，配伍面不得成为绕过口 ──────────────────────────
assert.ok(!herbCombinationDirectionEligible("黄连", wenzhong), "温里病例不得混入清热药");
assert.ok(!herbCombinationDirectionEligible("干姜", qingre), "清热病例不得混入温里药");
assert.ok(!herbShortlistDirectionEligible("黄连", wenzhong), "君药面的极性否决不变");

// ── 4) 正向相关：与本例治法无关的药不得因「恰好没有高影响作用」而畅通 ────────────
// 麻黄的解表/止咳都不在高影响集内，此前君药面对它没有任何拦截手段。
assert.ok(!herbShortlistDirectionEligible("麻黄", xinpi), "与本例治法无关的药不得任君药");
assert.ok(!herbCombinationDirectionEligible("麻黄", xinpi), "与本例治法无关的药不得进配伍面");
assert.ok(herbShortlistDirectionEligible("丹参", huoxue), "活血方向成立时活血药照常可用，正向相关不是全面收紧");

// ── 5) 君药面必须是配伍面的子集 ─────────────────────────────────────────────────
// 够格当君药却不够格当佐药，是两把尺子互相矛盾的信号。这条不变量让「以后单独改一面」这种
// 局部修改无法悄悄制造出自相矛盾的两个名单。
const subsetProbe = ["当归", "党参", "甘草", "龙眼肉", "白术", "茯苓", "黄芪", "酸枣仁", "木香",
  "大黄", "丹参", "黄连", "附子", "麝香", "鳖甲", "石菖蒲", "麻黄", "乌药", "干姜", "红豆蔻", "陈皮", "佛手"];
for (const prior of [xinpi, jiangni, wenzhong, qingre, huoxue]) {
  for (const herb of subsetProbe) {
    if (!herbShortlistDirectionEligible(herb, prior)) continue;
    assert.ok(
      herbCombinationDirectionEligible(herb, prior),
      `${herb}：君药面通过而配伍面拒绝——两把尺子出现矛盾`,
    );
  }
}

// ── 6) 配伍面是广度备选面，毒性药与 HIGH 特殊人群限制药不得靠充实层次被顺手选中 ──
const prompt = buildPrescribePrompt({
  patient: {}, chiefComplaint: "入睡困难三月余", conversation: [], reasoningDiagnose: xinpi,
});
const combinationRows = prompt.split("\n").filter((line) => /^- .+方向（仅可作臣佐使配伍，不得为君）：/.test(line));
assert.ok(combinationRows.length > 0, "心脾两虚病例必须真的渲染出配伍面，否则本次放宽没有生效");
const combinationHerbNames = combinationRows
  .flatMap((row) => row.replace(/^- [^：]+：/, "").split("、"))
  .map((entry) => entry.replace(/\[.*$/, "").trim())
  .filter(Boolean);
for (const herb of combinationHerbNames) {
  const safety = getTcmHerbGenerationSafetyProfile(herb);
  assert.ok(!safety.isToxic, `配伍面出现毒性药 ${herb}：毒性药进方必须是医生的正向决定`);
  assert.ok(
    !safety.populationRules.some((rule) => rule.severity === "HIGH"),
    `配伍面出现 HIGH 特殊人群限制药 ${herb}：这类药不得靠凑层次被选中`,
  );
}
assert.ok(combinationHerbNames.includes("当归"), "当归必须真的出现在渲染后的配伍面上");
// 朱砂（有毒、药典限量 0.1–0.5g）此前是被 heat_clear 碰巧挡住的，属运气不是设计。
assert.ok(!prompt.includes("朱砂"), "普通失眠病例的药味面不得出现朱砂");

// ── 7) 两行的角色权限必须在提示词里写清楚，否则模型无从区分 ──────────────────────
assert.ok(prompt.includes("君臣佐使均可选"), "君药面标签必须存在");
assert.ok(prompt.includes("仅可作臣佐使配伍，不得为君"), "配伍面标签必须存在");
assert.ok(prompt.includes("两行的区别是角色权限"), "使用规则必须解释两行的差别");

console.log(JSON.stringify({
  suite: "herb-breadth-surface",
  combinationRows: combinationRows.length,
  combinationHerbs: combinationHerbNames.length,
  failures: 0,
}, null, 2));
