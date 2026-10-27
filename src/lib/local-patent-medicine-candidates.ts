import { readFileSync } from "node:fs";
import path from "node:path";
import localMedicineIndex from "../data/local-patent-medicine-index.json" with { type: "json" };
import { affirmedClinicalText, type AssistedNegationClauses } from "./clinical-polarity";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { affirmativeNegationFormsIn, governedSyndromeLabelAxes } from "./clinical-vocabulary";
import { buildFormulaAxisProfile, scoreFormulaAxes } from "./tcm-formula-axis-score";
import { formulaCounterEvidence } from "./formula-discrimination-guard";
import { matchingMedicineClinicalConcepts } from "./medicine-clinical-concepts";
import { catalogSharedComposition, executableFormulaCompilationReferences } from "./tcm-formula-provenance";
import { parseMedicationLabelUsage } from "./medication-label-usage";
import { getTcmHerbFunctionCategories, isKnownTcmHerbName } from "./tcm-knowledge";
import { textbookDistinctHerbKey } from "./herb-textbook-identity";

export type LocalPatentMedicineEntry = {
  name: string;
  specification: string;
  approvalNumber: string;
  manufacturer: string;
  category: string;
  url: string;
  indication: string;
  usage: string;
  adverseReaction: string;
  contraindication: string;
  precaution: string;
  children: string;
  elderly: string;
  pregnancyLactation: string;
  interaction: string;
  fingerprint: string;
};

export type LocalPatentMedicineCandidate = LocalPatentMedicineEntry & {
  id: string;
  matchedConcepts: string[];
  matchedPatientFacts: string[];
  score: number;
};

// This bounded bridge is deliberately narrower than free-text similarity. A label can enter the
// prompt only when its recorded indication and a current positive patient fact share the same
// controlled clinical concept. The model therefore cannot retrieve a medicine from a disease name
// alone when the patient explicitly denies the corresponding symptom.
const ENTRIES = (localMedicineIndex as { entries?: LocalPatentMedicineEntry[] }).entries || [];

/**
 * 处方类中成药说明书目录（2026-09-28，4,899 种，不含注射剂）。不参与病例检索的默认范围，
 * 只供规划器用于：院内有货的处方中成药进入候选；AI 提名的中成药核对说明书。
 *
 * 运行时按 process.cwd()/src/data 懒加载，不打进代码包：4.4MB 的 JSON 静态导入后，webpack 生产构建
 * 需要 3GB 以上的堆（3GB 实测堆溢出），本机与共享生产机都给不起。读法与原典出处索引相同，
 * standalone 产物的文件追踪会把它带进镜像。读不到就当没有（只影响院内有货的处方中成药补入与 AI 提名核对），并留一行日志。
 */
export const LOCAL_PRESCRIPTION_PATENT_MEDICINE_INDEX_FILE = "local-patent-medicine-rx-index.json";
let prescriptionPatentEntries: readonly LocalPatentMedicineEntry[] | undefined;

export function localPrescriptionPatentMedicineEntries(): readonly LocalPatentMedicineEntry[] {
  if (prescriptionPatentEntries) return prescriptionPatentEntries;
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(process.cwd(), "src", "data", LOCAL_PRESCRIPTION_PATENT_MEDICINE_INDEX_FILE), "utf8"),
    ) as { entries?: LocalPatentMedicineEntry[] };
    prescriptionPatentEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    console.warn("[tcm-cdss:knowledge] prescription patent medicine index unavailable", {
      reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    prescriptionPatentEntries = [];
  }
  return prescriptionPatentEntries;
}

/** 中成药名去掉剂型后缀后的基础方名，用作同方多剂型的去重键。 */
const PATENT_DOSAGE_FORM_SUFFIX = /(?:缓释|控释|肠溶)?(?:片|胶囊|颗粒|丸|口服液|合剂|液|冲剂|糖浆|散|膏|丹|栓|贴|酊|露|饮)$/;

export function patentMedicineBaseName(name: string): string {
  return String(name || "").normalize("NFKC").replace(/\s/g, "").replace(PATENT_DOSAGE_FORM_SUFFIX, "");
}

/** 本地说明书目录（非处方 + 处方）按药名查条目：全名优先，其次去剂型基础名。 */
export function findLocalPatentMedicineLabel(name: string): LocalPatentMedicineEntry | undefined {
  const raw = String(name || "").normalize("NFKC").replace(/\s/g, "");
  if (!raw) return undefined;
  const base = patentMedicineBaseName(raw);
  for (const entries of [ENTRIES, localPrescriptionPatentMedicineEntries()]) {
    const exact = entries.find((entry) => entry.name.normalize("NFKC").replace(/\s/g, "") === raw);
    if (exact) return exact;
  }
  if (base.length < 2) return undefined;
  for (const entries of [ENTRIES, localPrescriptionPatentMedicineEntries()]) {
    const sameBase = entries.find((entry) => patentMedicineBaseName(entry.name) === base);
    if (sameBase) return sameBase;
  }
  return undefined;
}

/**
 * 一段文字里点名的、本地说明书目录认得的成药与西药（2026-10-19，留出例 S145 注意事项凭空出现「不要再服连翘败毒丸」）。
 * 只认带剂型的写法（丸、片、胶囊、颗粒、口服液…）：全名或去剂型的基础名对上目录即算，从右往左逐位取最长；
 * 不带剂型的「当归」即便对得上「当归丸」的基础名也不算药名。目录按全名、基础名建一次索引。
 */
let labelledNameIndex: { full: Set<string>; base: Set<string> } | undefined;
function labelledNames(): { full: Set<string>; base: Set<string> } {
  if (labelledNameIndex) return labelledNameIndex;
  const full = new Set<string>();
  const base = new Set<string>();
  for (const entries of [ENTRIES, localPrescriptionPatentMedicineEntries()]) {
    for (const entry of entries) {
      const name = entry.name.normalize("NFKC").replace(/\s/g, "");
      full.add(name);
      const stem = patentMedicineBaseName(name);
      if (stem.length >= 2 && stem !== name) base.add(stem);
    }
  }
  labelledNameIndex = { full, base };
  return labelledNameIndex;
}
export function labelledMedicineNamesIn(text: string): string[] {
  const source = String(text || "").normalize("NFKC");
  const { full, base } = labelledNames();
  const found: string[] = [];
  for (let end = source.length; end >= 3; end -= 1) {
    if (!PATENT_DOSAGE_FORM_SUFFIX.test(source.slice(Math.max(0, end - 4), end))) continue;
    for (let length = Math.min(12, end); length >= 3; length -= 1) {
      const name = source.slice(end - length, end);
      if (!/^[\u4e00-\u9fffA-Za-z0-9]+$/u.test(name)) continue;
      // 结尾已是剂型（上面只在剂型处取结尾）；基础名索引只收两个字以上的。
      if (full.has(name) || base.has(patentMedicineBaseName(name))) {
        if (!found.includes(name)) found.unshift(name);
        end -= length - 1;
        break;
      }
    }
  }
  return found;
}

/** 中成药说明书条目（按全名，再按去剂型基础名回退）；基准比对器据此判定「同类中成药」。 */
export function findLocalPatentMedicineEntry(name: string): LocalPatentMedicineEntry | undefined {
  const raw = String(name || "").normalize("NFKC").replace(/\s/g, "");
  if (!raw) return undefined;
  const base = patentMedicineBaseName(raw);
  return ENTRIES.find((entry) => entry.name.normalize("NFKC").replace(/\s/g, "") === raw)
    || (base.length >= 2 ? ENTRIES.find((entry) => patentMedicineBaseName(entry.name) === base) : undefined);
}

/**
 * 甲方评测(2026-08-03) 8.1：人参败毒胶囊(益气解表,适用气虚感冒)被推给无气虚证据的风寒表实证。
 * 类问题 = 说明书主治以特定**体质/虚证前提**为条件的成药，病例没有该前提证据时不得入选。
 * 确定性门：说明书功能主治命中前提模式(pattern)，而病例阳性事实+签名证候/病性/治法文本中
 * 找不到对应证据(evidence)时，直接排除该条目。证据判定只认已记录文本，不做推断。
 */
export const CONSTITUTION_PREREQUISITES: ReadonlyArray<{ label: string; pattern: RegExp; evidence: RegExp }> = [
  {
    label: "气虚",
    pattern: /(?:气虚|体虚|虚人|正虚|体弱)[^。；，]{0,8}(?:感冒|外感)|益气解表|扶正解表|补气解表/,
    evidence: /气虚|体虚|正虚|乏力|神疲|气短|懒言|自汗|易感冒|脉虚|脉弱|脉细弱|益气|补气|扶正/,
  },
  {
    label: "阴虚",
    pattern: /阴虚[^。；，]{0,8}(?:感冒|外感)|滋阴解表|养阴解表/,
    evidence: /阴虚|口干咽燥|干咳少痰|盗汗|五心烦热|舌红少苔|少津|脉细数|滋阴|养阴/,
  },
  {
    label: "阳虚",
    pattern: /阳虚[^。；，]{0,8}(?:感冒|外感)|助阳解表|温阳解表/,
    evidence: /阳虚|畏寒肢冷|四肢不温|小便清长|脉沉迟|温阳|助阳/,
  },
  {
    label: "血虚",
    pattern: /血虚[^。；，]{0,8}(?:感冒|外感)|养血解表/,
    evidence: /血虚|面色少华|面色萎黄|唇甲色淡|舌淡|脉细|养血|补血/,
  },
];

export function constitutionPrerequisiteMismatch(indication: string, caseEvidenceText: string): string | undefined {
  for (const rule of CONSTITUTION_PREREQUISITES) {
    if (rule.pattern.test(indication) && !rule.evidence.test(caseEvidenceText)) return rule.label;
  }
  return undefined;
}

/**
 * 该中成药是否为受控方剂目录中某个经典名方的成药剂型；是则返回该经典方名。
 * 既作临床性 tie-breaker（药典标准方优先于同证冷门厂牌药），也作同方多剂型的去重键
 * ——归脾丸／归脾合剂／归脾片／归脾液 全部归到「归脾汤」这一个键上。
 */
export function governedClassicFormulaName(name: string): string | undefined {
  const base = patentMedicineBaseName(name);
  if (base.length < 2) return undefined;
  for (const suffix of ["汤", "散", "丸", "饮", "煎"]) {
    const reference = executableFormulaCompilationReferences([`${base}${suffix}`])[0];
    if (reference) return reference.formulaName;
  }
  return undefined;
}

function positiveCaseFacts(caseState: CaseState, assistedNegations?: AssistedNegationClauses): string[] {
  const reasoning = caseState.reasoningDiagnose;
  const positiveSymptoms = Object.entries(caseState.symptoms || {})
    .map(([key, value]) => {
      const positive = affirmedClinicalText(typeof value === "string" ? value : String(value ?? ""), "affirmed", assistedNegations);
      return positive ? `${key}：${positive}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  const sources = [
    caseState.chiefComplaint,
    ...positiveSymptoms,
    caseState.tongue,
    caseState.pulse,
    caseState.faceNote,
    ...caseState.conversation.filter((item) => item.role === "user").map((item) => item.content),
    reasoning?.westernDiagnosis?.primary?.name,
    ...(reasoning?.westernDiagnosis?.primary?.supportingFacts || []),
    reasoning?.overview?.primarySyndrome,
    ...(reasoning?.overview?.primarySyndromeBasis || []),
  ];
  return [...new Set(sources
    .map((value) => affirmedClinicalText(value, "affirmed", assistedNegations))
    .filter((value): value is string => Boolean(value)))];
}

/**
 * 中成药与已签名证候的**寒热方向对立**（甲方 2026-08-12 线上实测）。
 *
 * 实测形态：42 岁男性、已签名「风寒袭肺证」，候选 10 条里 6 条是清热方向——
 * 泻白糖浆（宣肺清热）排第 1、九味双解口服液（解表清热）、克感利咽口服液（疏风清热）、
 * 凉解感冒合剂（辛凉解表）、十味龙胆花胶囊（清热化痰）、儿感清口服液（解表清热）。
 * 候选链此前只有三道过滤——临床概念命中、体质虚证前提、经方鉴别反证——**没有任何一道看寒热方向**。
 * 而寒热对立的判据仓库里早就有（formula-syndrome-consistency 的 guard 模式），
 * 只接了汤方通路，从没被中成药通路调用过：又一次同一判据只接了一个出口。
 *
 * 判据取**治法段**而不是整段说明书：说明书的形状恒为「<治法>。用于<症状罗列>」，
 * 而症状段几乎必然同时含寒与热（「恶寒发热」四个字里两侧都有），整段取轴一律解成
 * 寒热混合、方向随即弃权——实测 10 条无一能判。切分点是说明书自身的结构（「用于/主治/
 * 适用于」），不是词表；轴的解析与对立判定全部复用既有的受治理内核，不新写任何规则。
 *
 * 三种情形一律**弃权**（不排除）：没有已签名证候、证候解不出轴、治法段解不出方向。
 * 数据缺口绝不当成「方向相反」——排除权只在方向确实对立时行使。
 */
/**
 * 说明书**自己写明**不适用于本例证型时排除（甲方 2026-08-13 线上实测）。
 *
 * 实测形态：白痰、遇冷加重、无热象的风寒例，候选里出现九味双解口服液，而它自己的
 * precaution 第 3 条原文就是「风寒感冒者不适用九味双解口服液」——候选与自身风险说明打架。
 * 数据一直都在（中成药索引的 contraindication / precaution 两栏是逐条抓取入库的），
 * 运行时从来没有任何一处读它做过判断：又一次「受治理数据已在仓库、运行时从未读它」。
 *
 * 与第四道（寒热方向对立）的分工：那道是从治法段**推导**方向，本道只认说明书里的
 * **显式排除句**，不做任何推导——因此它能覆盖第四道弃权的情形（如整段治法解不出轴），
 * 也不会引入新的误判来源。
 *
 * 判据只比**单一寒热极性**，两侧都解不出单一极性就弃权。为什么不比整个病性轴集合：
 * 受治理证候词表里 `风寒感冒` 这类**病名式**条目的 natures 是脏的——实测解出
 * ["cold","heat","phlegm","wind"]（`风热感冒` 同样带 cold）。按轴取交集会把风热病例
 * 也判成命中「风寒感冒者不适用」而误排，那比原缺陷更坏。极性取法：在词里找**能被受治理
 * 词表解析、且寒热只占一极**的最短片段（`风寒感冒` 内的 `风寒` ⇒ cold）。不写任何手工词表。
 *
 * 四处收紧，确保只在证据确凿时行使排除权：
 *  1) 句式必须是「<证型>者 + 不适用/禁服/禁用/忌服/不宜服用」这种**指名排除**；
 *     「慎用 / 在医师指导下服用」一律不算——那是用药提醒，不是排除。
 *  2) 被排除词必须解出**单一**寒热极性；解不出或寒热并存 ⇒ 弃权。
 *  3) 本例已签名证候同样必须解出单一寒热极性；否则弃权。
 *  4) 两侧极性**相同**才排除。「风寒感冒者不适用」× 已签名「风寒袭肺证」⇒ 同为寒 ⇒ 排除；
 *     × 已签名「风热犯肺证」⇒ 一寒一热 ⇒ 不排除。数据缺口绝不当成排除依据。
 */
function unambiguousThermalPole(label: string): "cold" | "heat" | undefined {
  const text = String(label || "").trim();
  if (!text) return undefined;
  const poles = new Set<"cold" | "heat">();
  // 在标签内找能被受治理词表解析的片段，只采信寒热单极的那些。短片段优先命中
  // （`风寒感冒` 里的 `风寒` 是干净的 cold；整串是脏的 cold+heat，因此被跳过）。
  for (let start = 0; start < text.length; start += 1) {
    for (let end = start + 2; end <= Math.min(text.length, start + 6); end += 1) {
      const natures = governedSyndromeLabelAxes(text.slice(start, end)).natures;
      if (natures.length === 0) continue;
      const cold = natures.includes("cold");
      const heat = natures.includes("heat");
      if (cold !== heat) poles.add(cold ? "cold" : "heat");
    }
  }
  return poles.size === 1 ? [...poles][0] : undefined;
}

function patentMedicineLabelExcludesSyndrome(labelWarnings: string, signedSyndrome: string): boolean {
  const warnings = String(labelWarnings || "").trim();
  if (!warnings) return false;
  const casePole = unambiguousThermalPole(signedSyndrome);
  if (!casePole) return false;
  // 句式锚点是**说明书自身的结构**（「…者不适用/禁服」），不是临床词表：被排除的证型名
  // 一律交给受治理词表解析，本正则不判断任何临床语义。
  const EXPLICIT_EXCLUSION = /([^；;。,，\d.]{2,12}?)者(?:不适用|禁服|禁用|忌服|不宜服用)/g;
  for (const match of warnings.matchAll(EXPLICIT_EXCLUSION)) {
    if (unambiguousThermalPole(match[1]) === casePole) return true;
  }
  return false;
}

function patentMedicineThermalOpposition(indication: string, signedSyndrome: string): boolean {
  const syndrome = String(signedSyndrome || "").trim();
  const text = String(indication || "").trim();
  if (!syndrome || !text) return false;
  const caseAxes = governedSyndromeLabelAxes(syndrome);
  if (caseAxes.natures.length === 0) return false;
  const treatmentPrincipleClause = text.split(/用于|主治|适用于/)[0] || "";
  const medicineAxes = governedSyndromeLabelAxes(treatmentPrincipleClause);
  if (medicineAxes.natures.length === 0) return false;
  const profile = buildFormulaAxisProfile({
    natureTags: medicineAxes.natures,
    locationTags: medicineAxes.locations,
    syndromeTags: [],
    indications: [text],
  });
  // 治法段本身就寒热并列（「解表散寒…清热」这类）时 thermal 为 null，属于解不出方向，弃权。
  if (profile.axisless || !profile.thermal) return false;
  const breakdown = scoreFormulaAxes(
    profile,
    { locations: new Set(caseAxes.locations), natures: new Set(caseAxes.natures) },
    { mode: "guard" },
  );
  return Boolean(breakdown.nature.thermalOpposition && breakdown.nature.caseThermal && breakdown.nature.formulaThermal);
}

export function retrieveLocalPatentMedicineCandidates(
  caseState: CaseState,
  limit = 10,
  assistedNegations?: AssistedNegationClauses,
  options: {
    /** 检索的说明书目录；缺省为本地非处方中成药索引（病例检索的默认范围，行为与此前相同）。 */
    entries?: readonly LocalPatentMedicineEntry[];
    /** 编号起点：规划器追加的候选用 501 起，避免与证据段里 001–010 的病例检索候选撞号。 */
    idOffset?: number;
    /**
     * 是否要求说明书适应证与本例阳性事实命中受控临床概念（缺省要求）。规划器核对 AI 提名的具体药品时
     * 传 false：药名已由模型点名，只需过下面同一套安全排除（体质前提、方剂鉴别反证、寒热对立、
     * 说明书自排除），适应证是否覆盖本例问题由调用方另行核对。
     */
    requireConceptMatch?: boolean;
  } = {},
): LocalPatentMedicineCandidate[] {
  const facts = positiveCaseFacts(caseState, assistedNegations);
  if (facts.length === 0) return [];
  // 体质前提证据面 = 阳性事实 + 签名证候/病性/治法文本（只认已记录内容）。
  const reasoning = caseState.reasoningDiagnose;
  const signedDirection = signedDirectionOf(reasoning);
  const constitutionEvidenceText = [
    ...facts,
    reasoning?.overview?.primarySyndrome,
    reasoning?.overview?.overallPathogenesis,
    ...(reasoning?.pathogenesis?.natureDifferentiation?.items || []),
    reasoning?.therapy?.overallPrinciple,
    reasoning?.therapy?.overallMethod,
  ].filter(Boolean).join("；");
  // 反证守卫的证据面 = 体质证据面 + 病历原文里出现的受治理**阴性形式阳性体征**词。
  // 「无汗」「不渴」这类词是证候的定义性指征,却会被极性层当否定剥掉(见 clinical-vocabulary
  // 的 affirmativeNegationFormsIn 注释);而反证守卫恰恰最需要它们——太阳伤寒与太阳中风的
  // 分界就是有汗/无汗。这里并入而不在极性层全局改判:守卫只有排除权,宁可多排除一个方向
  // 相反的候选,也不让「把否认读成阳性」的风险流向全系统结论。
  const rawCaseText = [
    caseState.chiefComplaint,
    ...Object.values(caseState.symptoms || {}).map((value) => (typeof value === "string" ? value : String(value ?? ""))),
    caseState.tongue,
    caseState.pulse,
    reasoning?.overview?.primarySyndrome,
    ...(reasoning?.overview?.primarySyndromeBasis || []),
  ].filter(Boolean).join("；");
  const counterEvidenceText = [constitutionEvidenceText, ...affirmativeNegationFormsIn(rawCaseText)].join("；");
  const semanticConceptIds = (caseState.reasoningDiagnose?.terminologyMappings || [])
    .filter((item) =>
      item.namespace === "medicine_clinical_concept" &&
      item.fieldPath.startsWith("retrieval.medicineClinicalConcept."))
    .map((item) => item.candidateId);
  const scored = (options.entries || ENTRIES).map((entry) => {
    const matched = matchingMedicineClinicalConcepts(facts.join("；"), entry.indication, semanticConceptIds);
    const matchedPatientFacts = facts.filter((fact) => matched.some((concept) => concept.casePattern.test(fact)));
    // 原实现在这里加一项 riskDetailScore：说明书的禁忌/注意/孕哺/相互作用四栏每填一栏 +0.05。
    // 本意是「文档更全的产品略微优先」，但临床概念词表粒度粗、并列极其常见，于是这个**非临床**
    // 代理指标事实上成了排序主键。实测（心脾两虚型不寐）：召回 10 条里 9 条并列 17.15，
    // 唯一的区分项就是这 0.05——归脾丸因说明书「禁忌：尚不明确」少算一栏，以 17.1 排在最后，
    // 输给了五味安神颗粒、参茯胶囊、灵芪加口服液等冷门厂牌药。药典标准方被文档完整度挤掉。
    //
    // 换成临床性 tie-breaker：该中成药是否为受控目录中某个经典名方的成药剂型
    // （归脾丸→归脾汤、逍遥丸→逍遥散、补中益气丸→补中益气汤）。权重仅 0.5，
    // 远小于证型轴 6–7 分，只在临床信号真正并列时起作用，不会盖过方证匹配本身。
    const classicFormula = governedClassicFormulaName(entry.name);
    return {
      ...entry,
      id: "",
      matchedConcepts: matched.map((concept) => concept.key),
      matchedPatientFacts: [...new Set(matchedPatientFacts)].slice(0, 3),
      score: matched.reduce((total, concept) => total + concept.weight, 0) + (classicFormula ? 0.5 : 0),
      classicFormula,
    };
  })
    .filter((entry) => options.requireConceptMatch === false || entry.matchedConcepts.length > 0)
    .filter((entry) => !constitutionPrerequisiteMismatch(entry.indication, constitutionEvidenceText))
    // 方剂鉴别反证排除(2026-08-04,甲方实测 #7:无汗、脉浮紧的风寒**表实**例仍推荐桂枝合剂)。
    //
    // 桂枝合剂 = 桂枝汤成药剂型,主治太阳中风**表虚有汗**;其说明书法定禁忌栏原文
    // 「表实无汗或温病发热、口渴者禁服」。数据一直都在——受治理鉴别图第 T14-001 条
    // 「桂枝汤 vs 麻黄汤:有汗/无汗、脉缓/脉紧」——只是从没有人拿它做过判断,
    // 它此前仅被送进提示词供模型参考,而模型并不受其约束。
    //
    // 这里对中成药选**排除**而非降权:候选表的职责就是只放该放的。把法定禁忌命中的药
    // 摆在医生面前,正是甲方指出的缺陷;这不违背 never-block 原则——它不中断任何流程,
    // 只是不推荐一个方向相反的选项。汤方通路则用降权+批注(见 tcm-formula-indications),
    // 因为汤方是医生加减化裁的底本,直接删会误伤异病同治与反治法。
    .filter((entry) => {
      const classicName = entry.classicFormula || patentMedicineBaseName(entry.name);
      if (!classicName) return true;
      return !formulaCounterEvidence(classicName, counterEvidenceText);
    })
    // 第四道：寒热方向对立即排除（见 patentMedicineThermalOpposition）。与上一道同一口径——
    // 候选表的职责是只放该放的；这不中断任何流程，只是不把一个方向相反的选项摆在医生面前。
    .filter((entry) => !patentMedicineThermalOpposition(entry.indication, reasoning?.overview?.primarySyndrome || ""))
    // 第五道：说明书**自己写明**排除本例证型时排除（见 patentMedicineLabelExcludesSyndrome）。
    .filter((entry) => !patentMedicineLabelExcludesSyndrome(
      [entry.contraindication, entry.precaution].filter(Boolean).join("；"),
      reasoning?.overview?.primarySyndrome || "",
    ))
    // 第六道（2026-10-19 第九轮）：内服成药的补泻、寒热方向与已签名证候**明确相反**时排除（补益药配纯实证、攻邪药配纯虚证、
    // 清热药配寒证、温热药配热证；虚实夹杂、寒热并见、读不出方向一律弃权，见 patentMedicineDirectionConflict）。
    // 放在检索层而不只在规划器里：M04 模型自己也从这份证据清单里挑中成药（M 集 RobustSDT-0088/0090 的胆清胶囊就是模型直接抄的），
    // 清单里有的它就可能选。第四道只读词表解出的寒热，「风寒湿痹证」在词表里寒热并存、读不出方向。
    .filter((entry) => {
      if (!signedDirection || !medicineIsInternalUse(entry.name, entry.usage)) return true;
      return !patentMedicineDirectionConflict({
        clause: medicineFunctionClause(entry.indication),
        herbs: () => patentMedicineCompositionIdentities(entry.name),
        indication: entry.indication,
      }, signedDirection);
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.matchedConcepts.length - left.matchedConcepts.length ||
      left.name.localeCompare(right.name));

  // 同方多剂型去重。归脾合剂／归脾液／归脾片／归脾丸 是同一基础方的四种剂型，此前各占一个名额，
  // 实测把 10 条候选中的 4 条吃掉，把真正不同的选择挤出列表。按基础方保留评分最高的一条。
  const byBaseFormula = new Map<string, (typeof scored)[number]>();
  for (const entry of scored) {
    const key = entry.classicFormula || patentMedicineBaseName(entry.name) || entry.name;
    if (!byBaseFormula.has(key)) byBaseFormula.set(key, entry);
  }
  const idOffset = Math.max(0, options.idOffset || 0);
  return [...byBaseFormula.values()]
    .slice(0, Math.max(0, limit))
    .map((entry, index) => ({ ...entry, id: `LOCAL-INST-${String(idOffset + index + 1).padStart(3, "0")}` }));
}

function compact(value: string, limit: number, fallback = "未载明"): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return (clean || fallback).slice(0, limit);
}

/**
 * 单条中成药说明书证据行。ID、指纹、药名、规格、适应证必须在同一行：证据净化按「同一条目」
 * 绑定这几项。规划器追加的候选（院内有货、AI 提名后核对到的）也用这一格式写进证据段。
 */
export function formatLocalPatentMedicineRecord(candidate: LocalPatentMedicineCandidate): string {
  return `- [${candidate.id}] 药名：${candidate.name}｜规格：${compact(candidate.specification, 120)}｜批准文号：${candidate.approvalNumber}｜生产企业：${candidate.manufacturer}｜适应证：${compact(candidate.indication, 360)}｜本例命中：${candidate.matchedConcepts.join("、")}｜事实：${candidate.matchedPatientFacts.join("；")}｜用法：${compact(candidate.usage, 220)}｜禁忌/注意：${compact([candidate.contraindication, candidate.precaution].filter(Boolean).join("；"), 360)}｜特殊人群：${compact([candidate.children, candidate.elderly, candidate.pregnancyLactation].filter(Boolean).join("；"), 260)}｜相互作用：${compact(candidate.interaction, 220)}｜条目指纹：${candidate.fingerprint}${/^https:\/\//i.test(candidate.url) ? `｜URL:${candidate.url}` : ""}`;
}

export function buildLocalPatentMedicineContext(
  caseState: CaseState,
  limit = 10,
  assistedNegations?: AssistedNegationClauses,
): string {
  const candidates = retrieveLocalPatentMedicineCandidates(caseState, limit, assistedNegations);
  if (candidates.length === 0) {
    return "【本地中成药说明书检索】本例当前阳性事实未命中本地非处方中成药说明书索引；不得据此自由生成中成药候选。";
  }
  return [
    "【本地中成药说明书检索（病例绑定候选；不是自动处方）】",
    // Keep each candidate on one evidence-record line: the sanitizer deliberately binds an ID,
    // fingerprint, medicine name, specification and indication within the same retrieved record.
    ...candidates.map(formatLocalPatentMedicineRecord),
    "选择纪律：只能复制上方同一条目的药名、规格、ID和指纹；适应证必须覆盖本例当前阳性问题。条目是候选边界，不替代医师辨证、说明书原文核验或药师审查；不得补写条目未载明的信息。",
  ].join("\n");
}

/**
 * 中成药的组成（2026-10-19 第九轮从 patent-medicine-duplication.server.ts 移来：重复判据与检索层的方向底线共用同一份成份读法）。
 */
const COMPOSITION_FILE = "local-patent-medicine-composition.json";
let compositionEntries: Record<string, { ingredients?: string[] }> | undefined;
function compositionTable(): Record<string, { ingredients?: string[] }> {
  if (compositionEntries) return compositionEntries;
  try {
    // 按 process.cwd()/src/data 懒加载，不打进代码包（与处方中成药说明书目录同一读法）。
    const parsed = JSON.parse(readFileSync(path.join(process.cwd(), "src", "data", COMPOSITION_FILE), "utf8")) as {
      entries?: Record<string, { ingredients?: string[] }>;
    };
    compositionEntries = parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
  } catch (error) {
    console.warn("[tcm-cdss:knowledge] patent medicine composition table unavailable", {
      reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    compositionEntries = {};
  }
  return compositionEntries;
}

/**
 * 说明书成份里的一味药 → 判重复用的药名键。知识库不认得的写法（「酒女贞子」「麸炒白术」）去掉开头一两个字后再试，
 * 余下部分是知识库认得的药名才算；仍认不得的（盐酸小檗碱、人参须）不计。
 */
function ingredientIdentity(raw: string): string | undefined {
  const token = String(raw || "").normalize("NFKC").replace(/\s+/g, "").replace(/^灸/, "炙");
  if (token.length < 2) return undefined;
  if (isKnownTcmHerbName(token)) return textbookDistinctHerbKey(token) || undefined;
  for (const cut of [1, 2]) {
    const rest = token.slice(cut);
    if (rest.length >= 2 && isKnownTcmHerbName(rest)) return textbookDistinctHerbKey(rest) || undefined;
  }
  return undefined;
}

/** 中成药的组成（判重复用的药名键，去重）。说明书成份优先，其次方剂目录；都查不到时为空。 */
export function patentMedicineCompositionIdentities(name: string): string[] {
  const clean = String(name || "").normalize("NFKC").replace(/\s+/g, "");
  if (!clean) return [];
  const table = compositionTable();
  const labelName = table[clean] ? clean : findLocalPatentMedicineLabel(clean)?.name;
  const ingredients = (labelName && table[labelName]?.ingredients) || [];
  const fromLabel = ingredients.map(ingredientIdentity).filter((item): item is string => Boolean(item));
  const identities = fromLabel.length > 0
    ? fromLabel
    : catalogSharedComposition(clean).map((item) => textbookDistinctHerbKey(item)).filter(Boolean);
  return [...new Set(identities)];
}


/**
 * ───────── 给药途径字样与「方向底线」所用的闭集（2026-10-19 第九轮 WP9-G；判据说明见 patent-medicine-duplication.server.ts） ─────────
 * 词表登记在本文件（见 test-clinical-vocabulary-single-source 的 ALLOWLIST：中成药剂型/给药途径是产品形态的封闭集合）。
 * 方向底线只在明确相反时用：补益药用于纯实证、攻邪药用于纯虚证、清热药用于寒证、温热药用于热证；
 * 虚实夹杂、寒热并见、说明书与成份都读不出方向时一律弃权。
 */

/**
 * 外用剂型（只用于注意事项措辞：外用药不说「服用」、不套口服间隔；也用于方向底线和重复判据区分内服与外用）。
 * 「奇正消痛贴」「红花油」「风油精」也是外用（2026-10-19 Claude 评审 H 集 H-tri-6369、2210：写成了「正在服用…间隔1小时」「已自服的红花油」）。
 * 原在 delivered-surface.ts，第九轮移到这里让检索层、重复判据、交付面共用同一份。
 */
export const TOPICAL_MEDICATION_FORM = /(?:乳膏|软膏|凝胶|乳胶剂|搽剂|擦剂|涂剂|洗剂|洗液|贴剂|贴膏|膏药|(?<!口)贴|栓|栓剂|滴眼液|滴耳液|滴鼻液|喷雾剂|气雾剂|酊|红花油|药油|油精|活络油)$/u;

/** 内服：用法字段不是外用，药名也不是外用剂型（栓剂经直肠吸收，算全身用药，不在这里排除）。 */
export function medicineIsInternalUse(name: string, usage: string): boolean {
  const route = parseMedicationLabelUsage(usage).route || "";
  const topicalName = TOPICAL_MEDICATION_FORM.test(name.trim()) && !/栓剂?$/u.test(name.trim());
  return !medicineRouteIsExternal(route) && !topicalName && !medicineRouteIsSensory(`${name} ${route}`);
}

/** 药名开头的「复方/加味/小儿」一类修饰，取药名主干时去掉。 */
export function productNameStem(baseName: string): string {
  return baseName.replace(/^(?:复方|加味|新|小儿|儿童|总)/u, "");
}

/** 用法字段写明是外用（贴、敷、涂、喷、搽、洗…）。 */
export function medicineRouteIsExternal(route: string): boolean {
  return /外用|外涂|外搽|涂|敷|贴|喷|搽|擦|洗|熏|撒布|患处|局部/u.test(route);
}

/** 五官局部用药（眼、耳、鼻）。 */
export function medicineRouteIsSensory(text: string): boolean {
  return /滴眼|眼用|眼膏|洗眼|滴耳|滴鼻|鼻用|鼻喷/u.test(text);
}

/** 说明书功能：适应证第一句里「用于/主治」之前的部分（「补气养阴，宁心益智。本品用于…」→「补气养阴，宁心益智」）。 */
export function medicineFunctionClause(indication: string): string {
  return String(indication || "").split(/[。；]\s*(?=本品|用于|主治|适用)|用于|主治|适用于/u)[0] || "";
}

/**
 * 按病原体或瘤种选药的药理分类（抗感染、抗寄生虫、抗肿瘤…）：同类不同药往往对应不同病原体（甲硝唑与克霉唑栓同属「咪唑衍生物」，
 * 一个治滴虫和厌氧菌、一个治念珠菌），不按药理类别合并，只在药名相同时才算重复。
 */
export function classIsPathogenSpecific(classPath: string): boolean {
  return /抗感染|抗寄生虫|抗肿瘤|抗菌|抗真菌|抗病毒/u.test(classPath);
}

/** 已签名的证名（主证、兼证）与治法：方向底线只读这两样。 */
/** decoctionThermal：本次汤剂按组成的寒温（medicineThermalByComposition 同一判据），证名与治法都不分寒热时用它定方向（编译时才有）。 */
export type SignedDirection = { names: string; method: string; decoctionThermal?: "cold" | "warm" };

/** 汤剂按组成的寒温：清热类药占三分之一以上且没有温里散寒类为 cold，反之为 warm，其余不定。 */
export function decoctionThermalByComposition(herbs: readonly string[]): "cold" | "warm" | undefined {
  return medicineThermalByComposition(herbs);
}

export function signedDirectionOf(prior: Pick<ClinicalReasoningResultV2, "overview" | "therapy"> | null | undefined): SignedDirection | undefined {
  const overview = prior?.overview;
  const names = [overview?.primarySyndrome, ...(Array.isArray(overview?.secondarySyndromes) ? overview.secondarySyndromes : [])]
    .map((value) => String(value || "").trim()).filter(Boolean).join("，");
  const method = String(prior?.therapy?.overallMethod || "").trim();
  return names || method ? { names, method } : undefined;
}

export type MedicineDirectionConflict = "tonic_for_excess" | "attack_for_deficiency" | "cold_for_cold_case" | "warm_for_heat_case" | "excess_indication_for_deficiency" | "deficiency_indication_for_excess";

const DEFICIENT_NAME = /虚|亏|不足|失养|不固|不摄|怯|衰|脱/u;
const EXCESS_NAME = /热|火|湿|痰|饮|瘀|滞|郁|积|毒|风|寒|燥|亢|扰|犯|乘|旺|束|蕴|阻|结|闭/u;
/** 治法里有补、润、养、固这类字样：证名再实也不是纯攻（风燥伤肺·润燥止咳用养阴药不算相反）。 */
const METHOD_HAS_TONIC = /补|益|养|滋|润|生津|固|扶|填|培|温阳|助阳|壮|健脾|健胃/u;
/** 治法里有攻邪字样（与诊断可见摘要里判「祛邪类动词」同一份动词）。 */
const METHOD_HAS_ATTACK = /清|泻|泄|疏|散|抑肝|抑木|化痰|化湿|化瘀|化饮|化浊|化积|祛|逐|活血|行气|理气|利水|利湿|利尿|通络|通腑|通便|通淋|通窍|消食|消积|消肿|攻|解表|解毒|解郁|平肝|潜阳|息风|熄风|降逆|降气|涤痰|破|软坚|燥湿|渗湿|宣肺|透疹|发汗|导滞|开窍|豁痰|止痛|镇惊/u;
/** 成药功能清单里的纯补、纯攻字样（比治法里的窄：只收一看就是补或一看就是攻的）。 */
const MEDICINE_TONIC = /补气|补血|补阴|补阳|补肾|补益|补虚|益气|益肾|益精|滋阴|养阴|养血|大补|温补|填精|固本|扶正|培元/u;
/**
 * 注意事项「不宜再服滋补类中成药」说的这一类：说明书功能里有补益字样（同上 MEDICINE_TONIC），或健脾、补脾、补中这类补脾胃的写法
 *（健脾丸「健脾开胃」——此前按「滋补」二字字面比对认不出它，同页又推荐健脾丸，2026-10-24 第十八轮基层病例 A042）。
 */
export function patentMedicineLabelIsTonic(indication: string): boolean {
  const clause = medicineFunctionClause(indication);
  return MEDICINE_TONIC.test(clause) || /健脾|补脾|补中/u.test(clause);
}
/** 注意事项里说的是补益一类中成药（滋补类、补益类、进补类…）。 */
export function tonicMedicineCategory(category: string): boolean {
  return /滋补|补益|进补|补养|温补|补虚/u.test(category);
}
const MEDICINE_ATTACK = /清热解毒|泻火|泻下|攻下|通腑|逐水|破血|活血|化瘀|祛瘀|散瘀|行气|理气|燥湿|化湿|祛湿|利湿|化痰|祛痰|消积|消食|导滞|解表|疏风/u;
const MEDICINE_COLD = /清热|泻火|凉血|泄热|解毒|清肝|清胃|清肺|清心|苦寒/u;
const MEDICINE_WARM = /温中|温肾|温阳|散寒|助阳|回阳|温经|温补|辛温|祛寒|驱寒/u;
const MEDICINE_RELEASE_EXTERIOR = /解表|发表|发汗|解肌|散风|疏风|宣肺/u;
const COLD_HERB_CATEGORIES: ReadonlySet<string> = new Set(["清热药", "清热泻火药", "清热解毒药", "清热燥湿药", "清热凉血药", "清虚热药"]);
const WARM_HERB_CATEGORIES: ReadonlySet<string> = new Set(["温里药", "补阳药", "发散风寒药", "祛风寒湿药", "温化寒痰药"]);

/** 成份里有没有补虚药（中药学分类「补虚药」）；甘草、大枣是调和之品，不计。 */
function compositionHasTonicHerb(herbs: readonly string[]): boolean {
  return herbs.some((herb) => herb !== "甘草" && herb !== "大枣" && getTcmHerbFunctionCategories(herb).includes("补虚药"));
}

/** 成药由成份里药味的中药学功效分类判寒热：寒药占三分之一以上而无温药，或反之；其余弃权。 */
function medicineThermalByComposition(herbs: readonly string[]): "cold" | "warm" | undefined {
  if (herbs.length === 0) return undefined;
  let cold = 0, warm = 0;
  for (const herb of herbs) {
    const categories = getTcmHerbFunctionCategories(herb);
    if (categories.some((category) => COLD_HERB_CATEGORIES.has(category))) cold += 1;
    if (categories.some((category) => WARM_HERB_CATEGORIES.has(category))) warm += 1;
  }
  const floor = Math.ceil(herbs.length / 3);
  if (cold >= 1 && warm === 0 && cold >= floor) return "cold";
  if (warm >= 1 && cold === 0 && warm >= floor) return "warm";
  return undefined;
}

/**
 * 内服成药（说明书功能 clause，成份 herbs 为药味身份名）与已签名证候是否明确相反；相反时返回原因码。
 * 调用方负责只对内服中成药调用（外用药治局部，不随整体证候走）。
 */
/**
 * 说明书「用于…」里明写的实证（实热、实火、实证、实寒）：功能短句只写「润肠通便」读不出补泻，适应证却写着「用于实热津亏便秘」
 *（润肠丸）。本例证名是纯虚证（阴虚秘）时它与证候虚实相反（2026-10-24 甲方 100 例 C014 中成药评审不合格）。只认带「实」字的写法。
 */
const INDICATION_EXCESS = /实(?:热|火|证|寒)/u;
const INDICATION_DEFICIENCY = /[阴阳气血精津]虚|两虚|亏虚|不足|虚弱|虚损|虚寒/u;

/** 说明书「用于」部分写的证：「X所致」的 X，否则第一个逗号前的一句（「阴虚血热，月经先期」→ 阴虚血热）；不像证名的返回空。 */
export function labelSyndromePhrase(usedFor: string): string {
  const text = String(usedFor || "").replace(/^[。；，,\s]*(?:本品)?(?:用于|主治|适用于)?/u, "");
  const caused = text.match(/^([^，,。；;]{2,10}?)(?:所致|引起|导致)/u)?.[1];
  const first = caused || (text.split(/[，,。；;]/u)[0] || "");
  return /[虚实热寒湿痰瘀郁滞火风燥毒亏损衰]|不足/u.test(first) && first.length <= 10 ? first : "";
}

/**
 * 中成药说明书「用于」部分是否说到本例的主要问题（2026-10-26 甲方测评：蛇串疮推荐穿黄清热胶囊——说明书写的是热毒所致急性上呼吸道感染、
 * 扁桃体炎、咽喉炎；龙血竭胶囊——跌打损伤、瘀血作痛；月经先期推荐乳癖康胶囊——乳腺增生，是由追问答出的乳房胀痛检索来的）。
 * 主要问题 = 主诉、中医病名、西医诊断、已签名的证。三条任一成立即算说到：
 *  · 受治理概念表（medicine-clinical-concepts，与检索同一份）在主要问题与「用于」部分之间有病证或问题概念相合；
 *  · 「用于」部分写着中医病名、西医诊断（去「待查」）或主诉里的症状；
 *  · 说明书写的证与本例的证有两个以上相同的字（肝胆湿热对肝经郁热，心脾两虚对心虚胆怯）。
 * 说明书查不到的返回 undefined（不判）。
 */
export function patentMedicineCoversMainProblem(indication: string, main: {
  chiefComplaint?: string; tcmDiseaseName?: string; westernName?: string; syndromes?: readonly string[];
}): boolean | undefined {
  if (!indication || !indication.trim()) return undefined;
  const clause = medicineFunctionClause(indication);
  const usedFor = indication.slice(clause.length) || indication;
  const syndromes = (main.syndromes || []).map((item) => String(item || "").replace(/证$/u, "").trim()).filter(Boolean);
  const western = String(main.westernName || "").replace(/待查$|待排$/u, "").trim();
  const disease = String(main.tcmDiseaseName || "").trim();
  const complaintTerms = String(main.chiefComplaint || "")
    .split(/[，,、；;。及和伴]/u)
    .map((item) => item.replace(/\d+[^，,、]*$|[半一二三四五六七八九十数]+(?:个)?(?:天|日|周|月|年)[余多]?$/u, "").trim())
    .filter((item) => item.length >= 2);
  const mainText = [main.chiefComplaint, disease, western, ...syndromes].filter(Boolean).join("，");
  const concepts = matchingMedicineClinicalConcepts(mainText, usedFor);
  if (concepts.some((concept) => concept.axis === "problem")) return true;
  if ([disease, western, ...complaintTerms, ...syndromes].some((term) => term && term.length >= 2 && usedFor.includes(term))) return true;
  const labelSyndrome = labelSyndromePhrase(usedFor);
  // 说明书在证之后点名了具体的病（乳腺增生、跌打损伤、急性上呼吸道感染…）、而上面没有一个对得上本例：只是证相近不够
  //（乳癖康胶囊「肝气郁结，气滞血瘀所致的乳腺增生」与肝郁血热的月经先期证相近，病不同）。只列症状的（六味地黄丸「肾阴亏损，
  // 头晕耳鸣，腰膝酸软…」）证相合即可。
  const labelItems = usedFor.replace(/^[。；，,\s]*(?:本品)?(?:用于|主治|适用于)?/u, "").split(/[，,、；;。]|所致的?|引起的?/u).map((item) => item.trim()).filter(Boolean);
  if (labelItems.some((item) => LABEL_SPECIFIC_DISEASE.test(item))) return false;
  if (concepts.some((concept) => concept.axis === "syndrome")) return true;
  if (labelSyndrome && syndromes.some((syndrome) => [...new Set(syndrome)].filter((character) => /[\u4e00-\u9fff]/u.test(character) && labelSyndrome.includes(character)).length >= 2)) return true;
  return false;
}

/** 说明书里的具体病名（不是症状）：以增生、炎、病、综合征、结节、瘤、癌、溃疡、感染、损伤、骨折、疮、疹、癣、痔、疝结尾，有限闭集。 */
const LABEL_SPECIFIC_DISEASE = /(?:增生|炎|病|综合征|结节|瘤|癌|溃疡|感染|损伤|骨折|(?<![生口])疮|疹|癣|痔|疝)$/u;

/** 说明书写的证与本例的证相合（用于把对证的中成药排在前面，见编译器）。 */
export function patentMedicineMatchesSignedSyndrome(indication: string, syndromes: readonly string[]): boolean {
  const clause = medicineFunctionClause(indication);
  const labelSyndrome = labelSyndromePhrase(indication.slice(clause.length) || indication);
  if (!labelSyndrome) return false;
  return syndromes.map((item) => String(item || "").replace(/证$/u, "")).some((syndrome) =>
    [...new Set(syndrome)].filter((character) => /[\u4e00-\u9fff]/u.test(character) && labelSyndrome.includes(character)).length >= 2);
}
export function patentMedicineDirectionConflict(
  medicine: { clause: string; herbs: readonly string[] | (() => readonly string[]); indication?: string },
  direction: SignedDirection,
): MedicineDirectionConflict | undefined {
  const { names, method } = direction;
  const { clause } = medicine;
  // 成份只在要用时才取（检索层对每个命中的条目都会调到这里，取成份要查说明书目录）。
  let herbList: readonly string[] | undefined;
  const herbs = (): readonly string[] => (herbList ??= typeof medicine.herbs === "function" ? medicine.herbs() : medicine.herbs);
  const caseDeficient = DEFICIENT_NAME.test(names);
  const caseExcess = EXCESS_NAME.test(names.replace(/[阴血气阳精津]虚[热火]?|虚[热火寒]/gu, ""));
  if (clause) {
    // 纯补：功能里一个攻邪字样都没有（「补肾壮骨，祛风蠲痹」是补攻并用，不算）。
    if (MEDICINE_TONIC.test(clause) && !METHOD_HAS_ATTACK.test(clause) &&
        caseExcess && !caseDeficient && method && !METHOD_HAS_TONIC.test(method)) return "tonic_for_excess";
    // 纯攻：功能是攻邪、没有补益字样，成份里（调和之品不计）也没有一味补虚药（参苓口服液：理脾消食，成份有太子参、白扁豆，不算纯攻）。
    if (MEDICINE_ATTACK.test(clause) && !MEDICINE_TONIC.test(clause) && !compositionHasTonicHerb(herbs()) &&
        caseDeficient && !caseExcess && method && !METHOD_HAS_ATTACK.test(method)) return "attack_for_deficiency";
  }
  const usedFor = medicine.indication ? medicine.indication.slice(clause.length) : "";
  if (usedFor && INDICATION_EXCESS.test(usedFor) && caseDeficient && !caseExcess) return "excess_indication_for_deficiency";
  // 说明书写的证是虚证（「用于阴虚血热，月经先期」）、本例是纯实证（肝郁血热、阳盛血热）：方向相反
  //（2026-10-26 甲方测评病历 10「固经丸适合阴虚血热，此病历为实热」）。说明书的证里另有与本例相同的邪实要素时
  //（加味逍遥丸「肝郁血虚」对肝郁血热，都有「郁」）不算相反。虚热、虚火（阴虚血热）是虚证的热象，不算邪实。
  const labelSyndrome = labelSyndromePhrase(usedFor);
  // 治法里本有补、润、养一类（风燥伤肺·润燥止咳）时不算相反，与上面纯补药的口径相同。
  if (labelSyndrome && INDICATION_DEFICIENCY.test(labelSyndrome) && caseExcess && !caseDeficient && method && !METHOD_HAS_TONIC.test(method)) {
    const labelExcess = [...labelSyndrome.replace(/[阴血气阳精津]虚(?:血|内)?[热火]/gu, "")].filter((character) => EXCESS_NAME.test(character));
    if (!labelExcess.some((character) => names.includes(character))) return "deficiency_indication_for_excess";
  }
  // 寒热：本例证名只有寒（或只有热），治法也没有反向字样。证名不分寒热（外感风邪证、风邪犯表证）时看已签名的治法：
  // 只有清热一边的按热、只有温散一边的按寒（第二十七轮接口回放：外感风邪证、治法疏风清热，汤剂黄芩栀子连翘黄连，推荐桂枝颗粒）。
  const neutralNames = !/寒/u.test(names) && !/热|火|暑/u.test(names);
  const caseColdOnly = (/寒/u.test(names) && !/热|火|暑/u.test(names) && !MEDICINE_COLD.test(method)) ||
    (neutralNames && MEDICINE_WARM.test(method) && !MEDICINE_COLD.test(method)) ||
    (neutralNames && !MEDICINE_WARM.test(method) && !MEDICINE_COLD.test(method) && direction.decoctionThermal === "warm");
  const caseHeatOnly = (/热|火|暑/u.test(names.replace(/虚热|虚火/gu, "")) && !/寒/u.test(names) && !MEDICINE_WARM.test(method)) ||
    (neutralNames && MEDICINE_COLD.test(method) && !MEDICINE_WARM.test(method)) ||
    (neutralNames && !MEDICINE_WARM.test(method) && !MEDICINE_COLD.test(method) && direction.decoctionThermal === "cold");
  if (!caseColdOnly && !caseHeatOnly) return undefined;
  // 功能里同时写着解表、散风（荆防败毒丸：清热散风，发表解肌）是表证用药，寒热不单凭一个「清热」定。
  const byClause = clause && MEDICINE_COLD.test(clause) && !MEDICINE_WARM.test(clause) && !MEDICINE_RELEASE_EXTERIOR.test(clause) ? "cold"
    : clause && MEDICINE_WARM.test(clause) && !MEDICINE_COLD.test(clause) ? "warm" : undefined;
  const thermal = byClause ?? (clause && (MEDICINE_COLD.test(clause) || MEDICINE_WARM.test(clause)) ? undefined : medicineThermalByComposition(herbs()));
  if (thermal === "cold" && caseColdOnly) return "cold_for_cold_case";
  if (thermal === "warm" && caseHeatOnly) return "warm_for_heat_case";
  return undefined;
}
