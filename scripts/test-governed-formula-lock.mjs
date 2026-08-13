// 受控目录方名锁定回归(2026-08-05)。
//
// 甲方实测:自拟方占比 74%,医生几乎看不到一次「银翘散加减」这样的命名方结论。
// 线上 20 例语料逐例追下来,根因不是检索差、也不是核验严,而是**处置错**:
//
//   16/20 例系统的证候级检索本来就找到了正解方(肾阳虚→金匮肾气丸、脾虚湿盛→参苓白术散、
//   胃热炽盛→清胃散、风热犯表→银翘散、心脾两虚→归脾汤),且这些方全部通过了
//   identityLockEligible + positiveSufficiency 的确定性核验。
//   但它们只被写进 deferredFormulaSelection「仅供参考、不锁定、不进 M04」,
//   于是 M04 拿不到基准方,只能输出「本例辨证组方」。
//
// 补位有一条硬边界:**只在模型没选时补,不在模型选了但没过核验时顶替**。
// 曾试过在后一种情形也补位,20 例可锁定率 45%→80%,但换来一个致命错例(见第二节)。
// 最终口径 45%→60%,+3 例全部正确,零临床错误引入——这个取舍是实测定的,不是保守。
//
// 本套件钉四件事,每一件都是方向性的、不依赖具体方名:
//  1) 模型未选而系统检索到已核验方时必须锁定(否则 74% 自拟方复发);
//  2) 模型已就本例做出选择但未过核验时,不得用系统的方顶替(否则出现导赤散治阳黄一类错误);
//  3) 一条都不满足时仍走自拟方(fail-closed 不变);
//  4) 模型选对时原样保留,不得被系统候选顶掉。
// 锁定走的必须是与校验模型选择**同一道门**(identityLockEligible + positiveSufficiency
// + 目录级 lockEligible),任何放宽都会让不对证的方挂上方名,临床上比自拟方更坏。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const ind = await jiti.import("../src/lib/tcm-formula-indications.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");

const wrap = (reasoning) =>
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
const unwrap = (content) => {
  const m = content.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
  return m ? JSON.parse(m[1]) : null;
};

// 最小 M03 结论骨架。证候/病机/治法是检索的唯一输入——本层只读已签名结论,不读 caseState。
const m03 = ({ syndrome, pathogenesis, therapy, names, mode }) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: syndrome,
    overallPathogenesis: pathogenesis,
    recommendedFormulaNames: names,
    formulaSelectionMode: mode,
    recommendedFormulaDirection: names.length > 0 ? `${names[0]}加减` : "按已锁定病机与治法辨证组方",
  },
  pathogenesis: { summary: pathogenesis, chain: [], locationDifferentiation: { items: [] }, natureDifferentiation: { items: [] } },
  therapy: { overallMethod: therapy, overallPrinciple: therapy, subTherapies: [] },
  terminologyMappings: [],
});

const failures = [];
const run = (reasoning) => unwrap(ind.enforceRetrievedM03FormulaSelection(wrap(reasoning), []));

// ── 一、模型未给方名,系统检索到已核验方 ⇒ 必须锁定 ────────────────────
{
  const out = run(m03({
    syndrome: "风热犯表证",
    pathogenesis: "风热之邪犯于肺卫，卫表失和",
    therapy: "辛凉解表，清热解毒",
    names: [],
    mode: "self_devised",
  }));
  const locked = out?.overview?.recommendedFormulaNames || [];
  if (locked.length === 0) {
    failures.push({ case: "模型自拟+系统有已核验方", why: `应锁定系统候选,实际仍为空;mode=${out?.overview?.formulaSelectionMode}` });
  } else if (out.overview.formulaSelectionMode !== "single") {
    failures.push({ case: "模型自拟+系统有已核验方", why: `锁定后 mode 应为 single,实际 ${out.overview.formulaSelectionMode}` });
  } else if (out.overview.deferredFormulaSelection?.reason !== "system_retrieved_governed_lock") {
    failures.push({ case: "模型自拟+系统有已核验方", why: `来源留痕缺失,reason=${out.overview.deferredFormulaSelection?.reason}` });
  }
}

// ── 二、模型选了通不过核验的方 ⇒ 驳回它,且**不得**用系统的方顶替 ────────────
//
// 这条是实测逼出来的边界。曾让系统在这里也补位,20 例可锁定率 45%→80%,但湿热内蕴证(阳黄)
// 出现致命一例:模型选的是茵陈蒿汤(本例金标准方),因证候特征层的释义并集差异未过核验被驳回,
// 系统改锁了同样过核验的**导赤散**(清心利水养阴)。医生会照着抓药——把不对证的方挂上方名,
// 比输出自拟方坏得多。区别在于「模型有没有看着本例做过选择」:没选时系统补位只是增加信息,
// 选了但没过核验时换一个模型从未考虑过的方是越权。
{
  const bogus = "某某未收载经验方";
  const out = run(m03({
    syndrome: "风热犯表证",
    pathogenesis: "风热之邪犯于肺卫，卫表失和",
    therapy: "辛凉解表，清热解毒",
    names: [bogus],
    mode: "single",
  }));
  const locked = out?.overview?.recommendedFormulaNames || [];
  if (locked.includes(bogus)) {
    failures.push({ case: "模型选未核验方", why: "未核验的模型选择不得保留" });
  }
  if (locked.length > 0) {
    failures.push({
      case: "模型选未核验方",
      why: `模型已就本例做出选择时,系统不得用它从未考虑过的方顶替;实际锁了 ${JSON.stringify(locked)}`,
    });
  }
  if (out?.overview?.formulaSelectionMode !== "self_devised") {
    failures.push({ case: "模型选未核验方", why: `应降为自拟方,实际 ${out?.overview?.formulaSelectionMode}` });
  }
}

// ── 三、fail-closed:系统也检索不到已核验方时,仍走自拟方 ─────────────
{
  // 无法归一的描述性主证 + 无病机无治法 ⇒ 检索拿不到任何满足正向充分性的方。
  const out = run(m03({
    syndrome: "身体不适倾向",
    pathogenesis: "",
    therapy: "",
    names: [],
    mode: "self_devised",
  }));
  const locked = out?.overview?.recommendedFormulaNames || [];
  if (locked.length > 0) {
    failures.push({ case: "无已核验方", why: `无可锁方时不得凭空锁定,实际锁了 ${JSON.stringify(locked)}` });
  }
}

// ── 四、模型选的方本就通过核验 ⇒ 原样保留,不得被系统候选顶掉 ──────────
{
  const first = run(m03({
    syndrome: "风热犯表证", pathogenesis: "风热之邪犯于肺卫，卫表失和",
    therapy: "辛凉解表，清热解毒", names: [], mode: "self_devised",
  }));
  const systemPick = (first?.overview?.recommendedFormulaNames || [])[0];
  if (systemPick) {
    const out = run(m03({
      syndrome: "风热犯表证", pathogenesis: "风热之邪犯于肺卫，卫表失和",
      therapy: "辛凉解表，清热解毒", names: [systemPick], mode: "single",
    }));
    const locked = out?.overview?.recommendedFormulaNames || [];
    if (!locked.includes(systemPick)) {
      failures.push({ case: "模型选择已核验", why: `模型选对时必须原样保留,实际 ${JSON.stringify(locked)}` });
    }
  }
}

// ── 五、治法对齐是**一条判据、三处消费** ────────────────────────────────
//
// 上面第 12-14 行那条边界("不在模型选了但没过核验时顶替")当初只堵住了一条路。
// 系统能把一张方摆到医生面前的路有三条,实测(阳黄例,签名主证「湿热内蕴证」,
// 治法「清热利湿退黄,通腑泄热」)三条里只有一条有治法对齐这道门:
//   ① 系统自锁 systemLockable         —— 有;
//   ② 校验模型自己选的方 allowed 集    —— 没有 ⇒ 模型选导赤散(清心利水养阴)被**原样锁定**;
//   ③ 修复轮候选 missedLockable…      —— 没有 ⇒ 作废茵陈蒿汤后,把导赤散标成
//      「已通过正向充分性核验……逐字抄写」喂回模型,反向指挥它改错。
// 也就是说:删掉对的方(茵陈蒿汤,本例金标准),再把错的方标成已核验推回去。
const YANGHUANG = {
  syndrome: "湿热内蕴证",
  pathogenesis: "湿热蕴结中焦，熏蒸肝胆，胆汁不循常道",
  therapy: "清热利湿退黄，通腑泄热",
};
{
  // ② 治法方向对立的方,模型自己选也不许锁。
  const out = run(m03({ ...YANGHUANG, names: ["导赤散"], mode: "single" }));
  const locked = out?.overview?.recommendedFormulaNames || [];
  if (locked.includes("导赤散")) {
    failures.push({
      case: "治法对立方经模型之手锁定",
      why: "导赤散功效「清心利水养阴」与签名治法「清热利湿退黄，通腑泄热」无受控治法交集，不得锁定",
    });
  }

  // ③ 修复轮候选同样要过这道门,否则等于指挥模型改成错方。
  const bare = m03({ ...YANGHUANG, names: [], mode: "self_devised" });
  const repairPicks = ind.missedLockableFormulaCandidates(bare);
  if (repairPicks.includes("导赤散")) {
    failures.push({
      case: "修复轮把治法对立方标成已核验",
      why: `修复提示词会让模型逐字抄写这些方名，实际候选 ${JSON.stringify(repairPicks)}`,
    });
  }

  // 数据缺失不得当成对立:目录里 2367/2910 条可锁方 functions 为空(茵陈蒿汤自己就是),
  // 若把「抽不出治法词」也判为不一致,挡掉的全是数据缺口而非临床错误。
  if (!ind.formulaTherapyAlignedWithSigned([], ind.signedTherapyMethodIds(bare))) {
    failures.push({ case: "治法对齐判据", why: "方剂 functions 为空时必须放行(数据缺口≠临床对立)" });
  }
  if (!ind.formulaTherapyAlignedWithSigned(["清热利湿退黄"], new Set())) {
    failures.push({ case: "治法对齐判据", why: "签名治法抽不出词时必须放行" });
  }
}
{
  // 作废不得静默:模型原选必须留在签名信封里,否则医生看到一张自拟方,
  // 既不知道系统本来锁的是什么,也不知道为什么撤——M04 剥名说明的兜底取的正是这里。
  const out = run(m03({ ...YANGHUANG, names: ["茵陈蒿汤"], mode: "single" }));
  const deferred = out?.overview?.deferredFormulaSelection;
  if ((out?.overview?.recommendedFormulaNames || []).length > 0) {
    failures.push({ case: "作废留痕", why: "留痕不得放宽锁定，names 仍须清空" });
  }
  if (out?.overview?.formulaSelectionMode !== "self_devised") {
    failures.push({ case: "作废留痕", why: `仍须降为自拟方，实际 ${out?.overview?.formulaSelectionMode}` });
  }
  if (!deferred || !(deferred.names || []).includes("茵陈蒿汤")) {
    failures.push({ case: "作废留痕", why: `模型原选未留痕，deferred=${JSON.stringify(deferred)}` });
  }
  if (deferred && !deferred.reason) {
    failures.push({ case: "作废留痕", why: "撤销原因必须写明，否则医生无从判断是临床否决还是目录缺口" });
  }
  // 留痕同时止住反向指挥:missedLockable 见到 deferred 即认作「系统自己的处置」而非模型遗漏。
  if (ind.missedLockableFormulaCandidates(out).length > 0) {
    failures.push({ case: "作废留痕", why: "已留痕的作废不得再被当成模型遗漏，触发修复轮改方" });
  }
}

// ── 五、复合证候的确定性归一压过「等术语确认」(2026-08-13 线上实测：心悸案) ────────
//
// 主证候「心阳不振，水气凌心」首段可被 canonicalPrimarySyndromeId 确定性解析(与授予
// primarySyndromeIdentityConfirmed 的是同一个解析器)。此时即使语义映射层留下了 suggested
// 条目，撤销原因也必须是 governed_syndrome_relation_unverified(真实原因：受控关系缺口)，
// 不得写成 semantic_mapping_pending_clinician_confirmation——那会让医生等待一个不影响
// 正向充分性输入的确认。反向护栏：主证候真正无法归一时，原因必须仍是等确认。
{
  const suggestedMapping = [{
    namespace: "tcm_syndrome",
    fieldPath: "overview.primarySyndrome",
    status: "suggested",
    original: "心阳不振，水气凌心",
    canonical: "水气凌心",
  }];
  const base = m03({
    syndrome: "心阳不振，水气凌心",
    pathogenesis: "心阳不振，水饮内停，上凌于心",
    therapy: "温通心阳，化气行水",
    names: ["某某未收载经验方"],
    mode: "single",
  });
  const out = run({ ...base, terminologyMappings: suggestedMapping });
  const reason = out?.overview?.deferredFormulaSelection?.reason;
  if (reason !== "governed_syndrome_relation_unverified") {
    failures.push({
      case: "复合证候可确定性归一",
      why: `撤销原因应为 governed_syndrome_relation_unverified(真实原因)，实际 ${reason}——` +
        "医生会被引导去等待一个不改变结果的术语确认",
    });
  }
  if ((out?.overview?.recommendedFormulaNames || []).length > 0) {
    failures.push({ case: "复合证候可确定性归一", why: "未核验的模型选择仍不得保留(本节不放宽任何锁定纪律)" });
  }

  const unresolvable = m03({
    syndrome: "身体机能紊乱状态",
    pathogenesis: "机能紊乱",
    therapy: "调和",
    names: ["某某未收载经验方"],
    mode: "single",
  });
  const out2 = run({ ...unresolvable, terminologyMappings: [{ ...suggestedMapping[0], original: "身体机能紊乱状态" }] });
  const reason2 = out2?.overview?.deferredFormulaSelection?.reason;
  if (reason2 !== "semantic_mapping_pending_clinician_confirmation") {
    failures.push({
      case: "主证候确实无法归一",
      why: `此时等术语确认才是真原因，实际 ${reason2}——守卫不得把真需要确认的情形也改写掉`,
    });
  }
}

// ── 六、留痕的 reason 取值必须能过 ReasoningV2Schema（写入端 ↔ schema 耦合）─────────
//
// 2026-08-13 甲方 P0 追查发现：本模块写 `system_retrieved_governed_lock` 与
// `governed_syndrome_relation_unverified`，而 diagnosis-types 的 zod 枚举只收另外两个值，
// 于是 `.catch(undefined)` 在归一时**整条 deferredFormulaSelection 丢弃**——
// 2026-08 那轮「作废不等于抹掉」的留痕从未到达任何一个出口（医生页/Markdown/HIS 全取不到），
// 而内部指标按载荷统计，所以长期无人察觉。这是本仓库记录在案的「zod schema 与类型分叉」形状。
//
// 本判据把两端焊死：从**源码里抽出写入端实际使用的取值**，逐个真跑 schema。
// 任何一端单独改动都会让这里红。
{
  const ind_src = readFileSync(new URL("../src/lib/tcm-formula-indications.ts", import.meta.url), "utf8");
  const writtenReasons = [...ind_src.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(writtenReasons)];
  if (unique.length < 3) {
    failures.push({ case: "留痕取值抽取", why: `只抽到 ${unique.length} 个 reason 取值，正则或写入端结构已变` });
  }
  for (const reason of unique) {
    // 载荷必须**整体合法**：overview 带 .catch(DEFAULT_OVERVIEW)，任一顶层必填缺失都会
    // 让整段 overview 回落、deferred 一并消失——那时红的是夹具而不是产品，会误导后人。
    const payload = {
      schemaVersion: "tcm-cdss-reasoning-v2",
      stage: "diagnose",
      overview: {
        primarySyndrome: "胃阴虚证",
        overallPathogenesis: "胃阴亏虚，胃失濡养",
        overallTherapy: "养阴益胃",
        recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
        recommendedFormulaNames: [],
        formulaSelectionMode: "self_devised",
        deferredFormulaSelection: { direction: "益胃汤加减", names: ["益胃汤"], mode: "single", reason },
        evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" },
      },
      pathogenesis: { summary: "胃阴亏虚", chain: [] },
      therapy: { overallPrinciple: "养阴益胃", overallMethod: "养阴益胃", subTherapies: [] },
      formula: null,
      nonPharma: null,
      management: null,
      lineageAdaptation: null,
    };
    const parsed = types.ReasoningV2Schema.safeParse(payload);
    if (!parsed.success) {
      failures.push({
        case: "留痕过 schema（夹具）",
        why: `夹具本身过不了 schema（${JSON.stringify(parsed.error.issues[0]?.path)}）——先修夹具再判断产品`,
      });
      continue;
    }
    const kept = parsed.data?.overview?.deferredFormulaSelection;
    if (!kept) {
      failures.push({
        case: "留痕过 schema",
        why: `reason="${reason}" 是写入端实际使用的取值，却过不了 ReasoningV2Schema——` +
          `归一时整条 deferredFormulaSelection 会被静默丢弃，医生页/Markdown/HIS 一个都取不到。` +
          `请把该取值补进 diagnosis-types.ts 的 zod 枚举与 TS 联合类型（两处都要）。`,
      });
    }
  }
}

// ── 七、撤销留痕不得因 formulaSelectionMode 写歪而丢失 ──────────────────────────
//
// 线上 P0 形态：模型给了方名却把 mode 写成 self_devised，撤销分支的 mode 白名单不命中，
// 于是**方名被清空、零留痕**（names=[]、self_devised、无 deferredFormulaSelection）。
// mode 只是留痕的呈现形态，撤销行为本身与它无关——按被撤方名个数保守推导即可。
for (const mode of ["single", "combined", "alternatives", "self_devised", "none", "", undefined]) {
  const base = m03({
    syndrome: "胃阴虚证",
    pathogenesis: "胃阴亏虚，胃失濡养",
    therapy: "养阴益胃，生津润燥",
    names: ["某某未收载经验方"],
    mode: "single",
  });
  base.overview.formulaSelectionMode = mode;
  const out = run(base);
  const deferred = out?.overview?.deferredFormulaSelection;
  if (!deferred || !(deferred.names || []).includes("某某未收载经验方")) {
    failures.push({
      case: `撤销留痕 mode=${String(mode)}`,
      why: `mode 写成 ${String(mode)} 时撤销未留痕（deferred=${JSON.stringify(deferred)}）——` +
        "医生看到自拟方却不知道系统撤了什么、为什么撤；这正是线上 P0 的形态",
    });
  }
  if (deferred && !["single", "combined", "alternatives"].includes(deferred.mode)) {
    failures.push({ case: `撤销留痕 mode=${String(mode)}`, why: `留痕 mode 取值 ${deferred.mode} 不在契约枚举内，会被 schema 丢弃` });
  }
  if ((out?.overview?.recommendedFormulaNames || []).length > 0) {
    failures.push({ case: `撤销留痕 mode=${String(mode)}`, why: "未核验方名仍不得保留（本节只补留痕，不放宽锁定纪律）" });
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
}
assert.equal(
  failures.length, 0,
  `受控目录方名锁定回归失败 ${failures.length} 项。锁定丢失 ⇒ 自拟方比例回升;` +
  `凭空锁定 ⇒ 不对证的方挂上方名(比自拟方更坏)。`,
);

console.log(JSON.stringify({
  modelSelfDevisedGetsGovernedLock: true,
  rejectedModelPickNotSubstituted: true,
  failClosedWhenNothingVerified: true,
  verifiedModelPickPreserved: true,
  failures: 0,
}));
