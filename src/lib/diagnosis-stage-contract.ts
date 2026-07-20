import { decoctionRuleForHerb, decoctionRuleSatisfied } from "./herb-decoction-rules";
import tcmKnowledgeIdentitySource from "../data/tcm-knowledge.json";
import { findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit, getTcmHerbFunctionCategories, getTcmHerbFunctionDisplayText, getTcmHerbFunctionText, getTcmHerbGovernedHighImpactConcepts, getTcmHerbRiskProfile, isKnownTcmHerbName } from "./tcm-knowledge";
import { formulaStructureTarget } from "./herb-target-contract";
import { prescriptionRegimenContractIssue, prescriptionRegimenIssue } from "./prescription-regimen-contract";
import { executableFormulaCompilationReferences } from "./tcm-formula-provenance";
import { TCM_TREATMENT_PROJECT_CODES } from "./tcm-treatment-projects";
import { getM03TherapyLock, isExecutableM03TherapyText } from "./m03-therapy-lock";

type M03ReasoningLike = {
  stage?: unknown;
  overview?: {
    primarySyndrome?: unknown;
    primarySyndromeResolution?: unknown;
    primarySyndromeBasis?: unknown;
    primarySyndromeResolutionReason?: unknown;
    evidence?: { confidence?: unknown };
    overallPathogenesis?: unknown;
    recommendedFormulaDirection?: unknown;
    recommendedFormulaNames?: unknown;
    formulaSelectionMode?: unknown;
  };
  westernDiagnosis?: {
    primary?: {
      name?: unknown;
      supportingFacts?: unknown;
      evidence?: { evidenceLevel?: unknown; source?: unknown };
    };
  };
  pathogenesis?: {
    locationDifferentiation?: {
      items?: unknown;
      details?: Array<{ location?: unknown; basis?: unknown }>;
      resolution?: unknown;
      resolutionReason?: unknown;
      evidence?: { confidence?: unknown };
    };
    natureDifferentiation?: {
      items?: unknown;
      rootDeficiency?: unknown;
      branchExcess?: unknown;
      basis?: unknown;
      resolution?: unknown;
      resolutionReason?: unknown;
      evidence?: { confidence?: unknown };
    };
    symptomClusters?: Array<{ symptoms?: unknown; mechanism?: unknown }>;
    chain?: Array<{ nodeId?: unknown; patientFact?: unknown; syndromeEvidence?: unknown; pathogenesis?: unknown; therapyDirection?: unknown }>;
  };
  therapy?: { overallPrinciple?: unknown; overallMethod?: unknown };
  formula?: unknown;
};

const UNSTABLE_REASONING_MARKER = /(?:信息|资料|证据)(?:仍然?|尚)?(?:不足|不充分|欠充分|不全|缺失)|(?:尚|仍|现有)?不足以(?:支持|证实|形成|判断)|(?:尚待|有待|仍待|尚须|仍需|尚未|尚在|仍在)(?:进一步)?(?:验证|商榷|论证|决定|讨论)|(?:暂|尚|仍)?(?:不|未|无)(?:能|可|足以)?(?:形成|明确|明|定|定证|定论|确定|判断|提及|充分|清楚|清|详|辨明)|(?:有待|尚待|仍待|待|需|需要)(?:补充|进一步|继续|重新)?(?:确认|明确|补充|核实|核验|证实|验证|商榷|论证|决定|讨论|辨证|判断|生成|评估|复核|完善|厘清|查|定)|不生成|无法(?:形成|判断|定证|明确)|不能(?:形成|判断|定证)|难下定论|尚难|存疑|未知|不详/;
const GENERATED_PLACEHOLDER_MARKER = /^(?:由服务端(?:知识库)?生成|待生成|待补充|待确认)$/;
const CUSTOMER_DISPLAY_PLACEHOLDER = /(?:证据不足|待检索|待核验|检索失败|未配置|内部证据缺口|EVIDENCE_GAP)|^(?:暂未|尚未|仍未|未)(?:生成|形成|明确|获得|提供|记录|提及|完成)|^(?:待|需|需要)(?:生成|确认|补充|核实|核验|复核|完善|询问|评估)(?:相关|具体|本项|信息|资料|内容)?[。.]?$/;
const GENERIC_CORE_LABELS = /(?:当前|本例|该例|总体|整体|主要|核心|初步|考虑|中医|辨证|诊断|结论|证候|证型|病机|治疗|治法|治则|方向|患者|事实|症状|表现|证据|依据|支持|结果|内容|情况|意见|方案|具体|进一步|重新|仍然?|尚|需|需要|因|为|是|暂)/g;
const TCM_PATHOGENESIS_ANCHOR = /(?:气虚|气滞|气逆|气陷|气脱|气闭|气机不畅|血虚|血瘀|瘀血|血热|血寒|血脱|血燥|血不养|心血不足|肝血不足|阴虚|阳虚|心阴虚|肝阴虚|肺阴虚|肾阴虚|心阳虚|脾阳虚|肾阳虚|脾气虚|心气虚|肺气虚|肾气虚|阴盛|阳亢|阴阳两虚|阴不敛阳|阳不入阴|津亏|液亏|津伤|津液不足|精亏|神扰|神失所养|心神不宁|心火|肝郁|肝火|肝阳|脾虚|肺虚|肾虚|脾湿|痰湿|痰热|痰浊|湿热|寒湿|风寒|风热|风湿|燥热|实热|虚热|虚寒|实寒|郁火|食积|水饮|饮停|水湿|热毒|寒凝|经络不通|络阻|营卫不和|营卫失调|卫外不固|脾不统血|肾不纳气|肺失宣降|心肾不交|少阳枢机不利|脏腑失和|升降失常|气血失和|不荣则痛|不通则痛|化火|上扰|内阻|阻滞|亏虚|失养|失和|失司)/;
const TCM_THERAPY_ANCHOR = /(?:益气|补气|养血|活血|化瘀|滋阴|育阴|养阴|温阳|扶阳|清热|泻火|疏肝|解郁|理气|行气|降逆|化痰|祛痰|燥湿|利湿|祛湿|健脾|和胃|温中|散寒|通络|止痛|宁心|安神|镇惊|平肝|潜阳|熄风|息风|凉血|解毒|消食|导滞|攻下|通腑|润肠|固涩|敛汗|止血|止咳|平喘|宣肺|肃肺|开窍|醒神|扶正|培本|调和营卫|解表|和解|利水|通淋|升阳|补肾|温肾|健运|温经|散结|软坚|养心|清心|清肝|清肺|清胃|清胆|温补|补益|调经|回阳救逆|透邪外达|升清降浊|调畅气机|交通心肾)/;
const TCM_DISEASE_LABEL = /(?:眩晕病?|不寐|胸痹|心悸|头痛|胃脘痛|腹痛|咳嗽|喘证|泄泻|便秘|郁证|汗证|痹证|痿证|水肿|淋证|消渴|癃闭|胁痛|黄疸|中风|痫病|痴呆|颤证|耳鸣|鼻鼽)(?!待)/;
const NON_CLINICAL_PATHOGENESIS = /^(?:精神尚可|状态尚可|情况稳定|一般情况|继续观察|建议复查|完善检查)$/;
const NON_TCM_THERAPY = /^(?:观察|休息|复查|随访|转诊|急诊|对症|开窗通风|注意休息|继续观察|定期复查|完善检查|对症处理|一般处理|急诊处理|转诊评估)$/;
const CLINICAL_NEGATION = /(?:绝非|绝无|毫无|全无|断非|尚无|暂无|没有|阴性|排除|已除外|需除外|未排除|待排除|否认|否定|并非|并无|不认为是|不属|不属于|不存在|不能证实|未能证实|未获证实|未查见|未呈现|未见|未发现|未提示|未观察到|未显示|未证实|尚未证实|未检出|未检测到|未表明|未达到|未成立|未采用|未使用|未选择|未予|未考虑|未支持|未获支持|未得到支持|(?:尚|仍|现有)?不足以(?:支持|证实|形成|判断)|(?:依据|证据)(?:不足|薄弱)[^，,。；;]{0,12}(?:支持|证实)|缺乏[^，,。；;]{0,12}(?:依据|证据|支持)|缺少[^，,。；;]{0,12}(?:依据|证据|支持)|难以|难于|不支持|不符合|不考虑|不宜|不应|不建议|不推荐|不适用|不作为|不选择|不选用|不采取|不施用|不赞成|不认同|反对|非首选|拒用|禁用|禁止|禁忌|忌用|勿用|暂缓(?:治疗|处置|用药)|暂停(?:治疗|处置|用药)|避免|慎用|不可|不予|无需|不需|不主张|暂不|不成立|不采用|不使用|不用|停止(?:治疗|处置|用药)|停用|停服|撤除)/;

type TcmKnowledgeIdentitySource = {
  herbs?: Array<{ name?: string; aliases?: string[] }>;
  commonHerbs?: Array<{ name?: string }>;
};

function normalizedTcmHerbIdentityToken(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s（）()]/g, "")
    .replace(/(?:饮片|颗粒)$/g, "")
    .trim();
}

const tcmHerbCanonicalNameByToken = new Map<string, string>();
const tcmIdentitySource = tcmKnowledgeIdentitySource as TcmKnowledgeIdentitySource;
for (const item of tcmIdentitySource.herbs || []) {
  const name = String(item.name || "").trim();
  if (!name) continue;
  const baseName = name.replace(/[（(][^（）()]+[）)]/g, "").trim();
  const parentheticalAliases = Array.from(name.matchAll(/[（(]([^（）()]+)[）)]/g), (match) => match[1])
    .flatMap((value) => value.split(/[、，,；;\/]/).map((part) => part.trim()).filter(Boolean));
  for (const variant of [name, baseName, ...parentheticalAliases, ...(item.aliases || [])]) {
    const token = normalizedTcmHerbIdentityToken(variant);
    if (token && !tcmHerbCanonicalNameByToken.has(token)) tcmHerbCanonicalNameByToken.set(token, name);
  }
}
for (const item of tcmIdentitySource.commonHerbs || []) {
  const name = String(item.name || "").trim();
  const token = normalizedTcmHerbIdentityToken(name);
  if (token && !tcmHerbCanonicalNameByToken.has(token)) tcmHerbCanonicalNameByToken.set(token, name);
}

// These aliases are governed by the same local knowledge package as dose/function lookup. They
// include historical spellings and processed names that do not own an independent knowledge row.
const GOVERNED_TCM_HERB_IDENTITY_ALIASES: Readonly<Record<string, string>> = {
  桂圆肉: "龙眼肉",
  黄耆: "黄芪",
  炒白术: "白术",
  麸炒白术: "白术",
  炒酸枣仁: "酸枣仁",
  制远志: "远志",
  蜜炙黄芪: "黄芪",
  炙黄芪: "黄芪",
  蜜炙甘草: "甘草",
  炙甘草: "甘草",
  夜交藤: "首乌藤",
  丹皮: "牡丹皮",
  // 高频口语/俗名 → 药典规范名（目标名均已核验为知识库收载且有功能/剂量覆盖）：
  杏仁: "苦杏仁",
  元胡: "延胡索",
  双花: "金银花",
  山栀: "栀子",
  薏米: "薏苡仁",
  枣仁: "酸枣仁",
  仙灵脾: "淫羊藿",
  熟地: "熟地黄",
  枸杞: "枸杞子",
  浙贝: "浙贝母",
  川贝: "川贝母",
};

/** One prescription identity for spelling aliases and non-independent processed variants. */
export function canonicalTcmHerbIdentity(value: unknown): string {
  const token = normalizedTcmHerbIdentityToken(value);
  if (!token) return "";
  const governed = GOVERNED_TCM_HERB_IDENTITY_ALIASES[token];
  if (governed) {
    const governedToken = normalizedTcmHerbIdentityToken(governed);
    return tcmHerbCanonicalNameByToken.get(governedToken) || governedToken;
  }
  const direct = tcmHerbCanonicalNameByToken.get(token);
  if (direct) return direct;
  const withoutProcessing = token
    .replace(/^(?:蜜炙|麸炒|土炒|米炒|醋制|酒制|盐制|姜制|醋炒|酒炒|盐炒|姜炒|炒|炙|制|煅|炮|焦|生)/, "")
    .replace(/(?:炒炭|煅炭|炭)$/, "");
  return tcmHerbCanonicalNameByToken.get(withoutProcessing) || withoutProcessing || token.toLowerCase();
}

function concreteClinicalAnchor(value: string): string {
  return value
    .replace(GENERIC_CORE_LABELS, "")
    .replace(/[（）()【】\[\]：:；;，,。.!！?？、\s]+/g, "");
}

function confirmedClinicalPrefix(value: string): string {
  const normalized = value.trim().replace(/^[：:；;，,。.!！?？\s]+/, "");
  const markerIndex = normalized.search(UNSTABLE_REASONING_MARKER);
  return markerIndex < 0 ? normalized : normalized.slice(0, markerIndex);
}

function splitIntoClinicalClauses(normalized: string): string[] {
  return normalized
    .replace(/(?:而宜|而以|而属|但宜|改为|转为|转予|遂予|故予|继以|后考虑|后确立|后辨为|后以|但见|但有|但属|但为)/g, "；")
    .split(/[。；;\n]+/).flatMap((sentence) => {
      let inheritedNegation = "";
      const clinicalSentence = sentence.replace(
        /^(?:主诉|现病史|既往史|过敏史|用药史|问诊补充|四诊信息|舌象|脉象|面象|生命体征|辅助检查|患者回答|医生补充)\s*[：:]\s*/,
        "",
      );
      return clinicalSentence.split(/[，,、]+/).map((rawClause) => {
        let clause = rawClause.trim();
        if (!clause) return "";
        if (/^(?:但|而|仍|却|同时|另有|随后|继而|突发|新发|出现|伴有)/.test(clause)) {
          inheritedNegation = "";
          clause = clause.replace(/^(?:但|而|仍|却|同时|另有|随后|继而)/, "");
        }
        // “病历已记录否认A、B” is the deterministic transport rewrite of a charted denial (the
        // customer-output negation sanitizer). Without the transport prefix in this starter the
        // negation scope is lost at the 、 boundary and every later enumerated term reads affirmed.
        const explicitNegation = clause.match(/^(?:(?:当前|目前|现阶段|现有|本例|患者|临床|病历已记录)?)(绝无|全无|尚无|暂无|没有|否认|未见|未出现|不伴|并无|无)/)?.[1];
        if (explicitNegation) inheritedNegation = explicitNegation;
        else if (/^(?:有|见|伴|出现|主诉|自诉|症见|表现为|宜|应|可)/.test(clause) || /(?:为主|主导|为核心|明确为|证实为)/.test(clause)) inheritedNegation = "";
        else if (inheritedNegation) clause = `${inheritedNegation}${clause}`;
        return clause;
      }).filter(Boolean);
    });
}

// For MODEL reasoning text: truncate at the first unstable-reasoning hedge so only the confirmed prefix
// is treated as clinical fact.
function clinicalClauses(value: string): string[] {
  return splitIntoClinicalClauses(confirmedClinicalPrefix(value));
}

// For the CLINICAL RECORD (grounding context): search it in full. The record legitimately contains
// phrases like "无明显寒热/未见异常" that collide with UNSTABLE_REASONING_MARKER; applying the hedge
// truncation here would cut the record at that phrase and drop every later field (舌/脉/面象/既往史),
// making genuinely-recorded facts (面色少华、舌淡红) read as "ungrounded" — a false polarity rejection.
// 病历"脉象"字段常只填脉质(如"细弱")而不带"脉"字,但接地模式 /脉.../ 需要"脉"前缀,导致模型写的
// "脉细弱"被误判为未记录。整条仅由脉质字组成时补上"脉",让其能被病历"细弱"接地。为避免"虚弱""虚证"
// 之类被误当脉象,脉质集合刻意不含 虚/实/微。
function labelBarePulseClause(clause: string): string {
  return /^[浮沉迟数滑涩弦细弱濡缓紧洪结代促]{2,4}象?$/.test(clause) ? `脉${clause}` : clause;
}

function recordClauses(value: string): string[] {
  return splitIntoClinicalClauses(value).map(labelBarePulseClause);
}

function contextAffirmsTerm(value: string, pattern: RegExp): boolean {
  return recordClauses(value).some((clause) => !isNegatedClinicalClause(clause) && pattern.test(clause));
}

function contextNegatesTerm(value: string, pattern: RegExp): boolean {
  return recordClauses(value).some((clause) => isNegatedClinicalClause(clause) && pattern.test(clause));
}

function isNegatedClinicalClause(clause: string): boolean {
  return CLINICAL_NEGATION.test(clause) || /^(?:(?:当前|目前|现阶段|现有|本例|患者|临床|明确)?(?:无|非))(?:明显|相关|此类|任何|上述|该|此)?/.test(clause);
}

function hasAffirmedClinicalTerm(value: string, pattern: RegExp): boolean {
  return clinicalClauses(value).some((clause) => !isNegatedClinicalClause(clause) && pattern.test(clause));
}

function hasNegatedClinicalTerm(value: string, pattern: RegExp): boolean {
  return clinicalClauses(value).some((clause) => isNegatedClinicalClause(clause) && pattern.test(clause));
}

export function isUnstableM03CoreText(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return true;
  const normalized = value.trim().replace(/^[：:；;，,。.!！?？\s]+/, "");
  const markerIndex = normalized.search(UNSTABLE_REASONING_MARKER);
  if (markerIndex < 0) return concreteClinicalAnchor(normalized).length < 2;
  const prefix = normalized.slice(0, markerIndex);
  const namedDiseaseConclusion = TCM_DISEASE_LABEL.test(prefix) && concreteClinicalAnchor(prefix).length >= 2;
  const boundedUncertainty = /(?:兼证|次证|伴证)[^。；;]*$/.test(prefix) || /[。；;]\s*$/.test(prefix);
  const affirmedAnchors = clinicalClauses(prefix)
    .filter((clause) => !isNegatedClinicalClause(clause))
    .flatMap((clause) => clause.match(new RegExp(TCM_PATHOGENESIS_ANCHOR.source, "g")) || []);
  const multiAnchorConclusion = new Set(affirmedAnchors).size >= 2 && concreteClinicalAnchor(prefix).length >= 6;
  return (!boundedUncertainty && !multiAnchorConclusion && !namedDiseaseConclusion) || concreteClinicalAnchor(prefix).length < 2;
}

/** Customer-facing cards and exports share this check so placeholders cannot reappear on fallback paths. */
export function isDisplayableClinicalText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !CUSTOMER_DISPLAY_PLACEHOLDER.test(value.trim());
}

function hasSyndromeAnchor(value: unknown): boolean {
  if (isUnstableM03CoreText(value) || typeof value !== "string") return false;
  const hasNamedSyndrome = clinicalClauses(value).some((clause) =>
    !isNegatedClinicalClause(clause) &&
    concreteClinicalAnchor(clause).length >= 2 &&
    /[\u4e00-\u9fa5]{1,12}(?:证|候)(?!实|据|明|候)/.test(clause)
  );
  const hasSixChannelDisease = clinicalClauses(value).some((clause) =>
    !isNegatedClinicalClause(clause) && /(?:太阳病|阳明病|少阳病|太阴病|少阴病|厥阴病)/.test(clause)
  );
  return hasNamedSyndrome || hasSixChannelDisease ||
    hasAffirmedClinicalTerm(value, TCM_PATHOGENESIS_ANCHOR) ||
    clinicalClauses(value).some((clause) => !isNegatedClinicalClause(clause) && TCM_DISEASE_LABEL.test(clause));
}

export function stableM03SyndromeLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(/^[：:；;，,。.!！?？\s]+|[：:；;，,。.!！?？\s]+$/g, "");
  if (!isUnstableM03CoreText(normalized) && hasSyndromeAnchor(normalized)) return normalized;

  const confirmed = confirmedClinicalPrefix(normalized)
    .replace(/[（(][^）)]*$/, "")
    .replace(/[：:；;，,。.!！?？\s]+$/g, "")
    .trim();
  if (!confirmed) return undefined;
  const named = confirmed.match(/[\u4e00-\u9fa5]{2,12}(?:证|候)(?!实|据|明|候)/)?.[0]
    || confirmed.match(/(?:太阳病|阳明病|少阳病|太阴病|少阴病|厥阴病)/)?.[0];
  if (named && hasSyndromeAnchor(named)) return named;
  for (const clause of confirmed.split(/[，,、；;]/).map((item) => item.trim()).filter(Boolean)) {
    if (hasSyndromeAnchor(clause)) return clause;
    if (/^[\u4e00-\u9fa5]{2,12}$/.test(clause)) {
      const withSuffix = `${clause}证`;
      if (hasSyndromeAnchor(withSuffix)) return withSuffix;
    }
  }
  return undefined;
}

function hasPathogenesisAnchor(value: unknown): boolean {
  if (isUnstableM03CoreText(value) || typeof value !== "string") return false;
  return clinicalClauses(value).some((clause) => {
    if (isNegatedClinicalClause(clause)) return false;
    const concrete = concreteClinicalAnchor(clause);
    return hasAffirmedClinicalTerm(clause, TCM_PATHOGENESIS_ANCHOR) ||
      (concrete.length >= 4 && !NON_CLINICAL_PATHOGENESIS.test(concrete));
  });
}

function hasTherapyAnchor(value: unknown): boolean {
  if (isUnstableM03CoreText(value) || !isExecutableM03TherapyText(value)) return false;
  return clinicalClauses(value).some((clause) => {
    if (isNegatedClinicalClause(clause)) return false;
    const concrete = concreteClinicalAnchor(clause);
    return hasAffirmedClinicalTerm(clause, TCM_THERAPY_ANCHOR) ||
      (concrete.length >= 2 && !NON_TCM_THERAPY.test(concrete));
  });
}

export function m03ChainNodeDiagnostics(reasoning: M03ReasoningLike | null | undefined): Array<{
  patientFactStable: boolean;
  syndromeEvidenceStable: boolean;
  pathogenesisAnchored: boolean;
  therapyAnchored: boolean;
}> {
  return (reasoning?.pathogenesis?.chain || []).map((item) => ({
    patientFactStable: !isUnstableM03CoreText(item.patientFact),
    syndromeEvidenceStable: !isUnstableM03CoreText(item.syndromeEvidence),
    pathogenesisAnchored: hasPathogenesisAnchor(item.pathogenesis),
    therapyAnchored: hasTherapyAnchor(item.therapyDirection),
  }));
}

// === Objective vital measurements ===
// Shared by the grounding concept canonicalization below and the western-support classifier further
// down. Only labeled measurements or ℃/°C-marked values count, so free text cannot fabricate a
// reading; implausible values are discarded.
const FEVER_TEMPERATURE_CELSIUS = 37.2;
const TEMPERATURE_MEASUREMENT = /(?:体温|temperature)\s*"?\s*[:：]?\s*"?(3\d(?:\.\d+)?|4[0-2](?:\.\d+)?)"?(?!\d)\s*(?:℃|°C|度)?|\bT\s*"?\s*[:：]?\s*"?(3\d(?:\.\d+)?|4[0-2](?:\.\d+)?)"?(?!\d)\s*(?:℃|°C)?|(?<![\d.])(3\d(?:\.\d+)?|4[0-2](?:\.\d+)?)(?!\d)\s*(?:℃|°C)/gi;
const BLOOD_PRESSURE_MEASUREMENT = /(?:血压|BP)\s*"?\s*[:：]?\s*"?(\d{2,3})\s*[\/／]\s*(\d{2,3})"?(?!\d)\s*(?:mm\s*Hg|毫米汞柱)?|(?:生命体征|一般情况)\s*"?\s*[:：]\s*"?(?:BP\s*[:：]?\s*)?(\d{2,3})\s*[\/／]\s*(\d{2,3})"?(?!\d)(?:\s*(?:mm\s*Hg|毫米汞柱))?/gi;
const HEART_RATE_MEASUREMENT = /(?:心率|脉搏|HR)\s*"?\s*[:：]?\s*"?(\d{2,3})"?(?!\d)\s*(?:次\s*[\/／]?\s*分|次|bpm)?|\bP\s*"?\s*[:：]?\s*"?(\d{2,3})"?(?!\d)\s*(?:次\s*[\/／]?\s*分|次|bpm)/gi;
const RESPIRATORY_RATE_MEASUREMENT = /(?:呼吸|RR)\s*"?\s*[:：]?\s*"?(\d{1,2})"?(?!\d)\s*(?:次\s*[\/／]?\s*分|次)?|\bR\s*"?\s*[:：]?\s*"?(\d{1,2})"?(?!\d)\s*(?:次\s*[\/／]?\s*分|次)/gi;
const SPO2_MEASUREMENT = /(?:血氧(?:饱和度)?|氧饱和度|SpO2|SaO2)\s*"?\s*[:：]?\s*"?(\d{2,3})"?(?!\d)\s*%?/gi;

function measuredTemperatures(value: string): number[] {
  const temperatures: number[] = [];
  for (const match of value.normalize("NFKC").matchAll(TEMPERATURE_MEASUREMENT)) {
    const parsed = Number.parseFloat(match[1] || match[2] || match[3] || "");
    if (Number.isFinite(parsed) && parsed >= 34 && parsed <= 43) temperatures.push(parsed);
  }
  return temperatures;
}

function recordAffirmsFeverByTemperature(record: string): boolean {
  return measuredTemperatures(record).some((temperature) => temperature >= FEVER_TEMPERATURE_CELSIUS);
}

// === Grounding concept canonicalization ===
// A small, clinically unambiguous set of GROUNDED_FACT_GROUPS entries additionally carries a
// canonical concept key: equivalent surface forms inside one group (上腹隐痛/胃脘痛/腹痛) and one
// deterministic objective measurement (体温 ≥37.2℃ ⇒ 发热) ground the same concept, so a clinically
// correct abstraction is not spuriously rejected for lacking a literal regex hit. Concepts outside
// this table keep the literal surface requirement (fail-closed), and polarity mismatch still
// rejects. The normal-temperature negation yields to any affirmed literal clause: a charted fever
// history with a normal current reading is still an affirmed fever.
const FEVER_FACT_PATTERN = /发热|高热/;
const CHILLS_FACT_PATTERN = /寒战/;
const ABDOMINAL_PAIN_FACT_PATTERN = /腹痛/;
const FEVER_CONCEPT_SURFACE = /发热|高热|发烧/;
const CHILLS_CONCEPT_SURFACE = /寒战|寒颤|战栗/;
const ABDOMINAL_PAIN_CONCEPT_SURFACE = /腹痛|腹隐痛|胃脘痛|胃脘部隐痛|胃痛/;

type GroundedFactConcept = {
  key: "fever" | "chills" | "abdominal_pain";
  // The GROUNDED_FACT_GROUPS entry this concept canonicalizes (identity reference).
  group: RegExp;
  // All surface forms treated as the same clinical concept (anatomical/synonym equivalents).
  surface: RegExp;
  // Objective record evidence affirming the concept (measured temperature ≥37.2℃ affirms 发热).
  objectiveAffirm?: (record: string) => boolean;
  // Objective record evidence negating the concept; must yield to any affirmed literal clause.
  objectiveNegate?: (record: string) => boolean;
};

const GROUNDED_FACT_CONCEPTS: ReadonlyArray<GroundedFactConcept> = [
  {
    key: "fever",
    group: FEVER_FACT_PATTERN,
    surface: FEVER_CONCEPT_SURFACE,
    objectiveAffirm: recordAffirmsFeverByTemperature,
    objectiveNegate: (record) =>
      !contextAffirmsTerm(record, FEVER_CONCEPT_SURFACE) &&
      !recordAffirmsFeverByTemperature(record) &&
      measuredTemperatures(record).length > 0 &&
      measuredTemperatures(record).every((temperature) => temperature < FEVER_TEMPERATURE_CELSIUS),
  },
  { key: "chills", group: CHILLS_FACT_PATTERN, surface: CHILLS_CONCEPT_SURFACE },
  { key: "abdominal_pain", group: ABDOMINAL_PAIN_FACT_PATTERN, surface: ABDOMINAL_PAIN_CONCEPT_SURFACE },
];

function groundedFactConceptForGroup(pattern: RegExp): GroundedFactConcept | undefined {
  return GROUNDED_FACT_CONCEPTS.find((concept) => concept.group === pattern);
}

function groundedFactConceptsForText(value: string): GroundedFactConcept[] {
  return GROUNDED_FACT_CONCEPTS.filter((concept) => concept.surface.test(value));
}

function contextAffirmsGroundedConcept(context: string, concept: GroundedFactConcept): boolean {
  return contextAffirmsTerm(context, concept.surface) || Boolean(concept.objectiveAffirm?.(context));
}

function contextNegatesGroundedConcept(context: string, concept: GroundedFactConcept): boolean {
  return contextNegatesTerm(context, concept.surface) || Boolean(concept.objectiveNegate?.(context));
}

function sentenceAffirmsGroundedConcept(sentence: string, concept: GroundedFactConcept): boolean {
  return hasAffirmedClinicalTerm(sentence, concept.surface) || Boolean(concept.objectiveAffirm?.(sentence));
}

function sentenceNegatesGroundedConcept(sentence: string, concept: GroundedFactConcept): boolean {
  return hasNegatedClinicalTerm(sentence, concept.surface) || Boolean(concept.objectiveNegate?.(sentence));
}

const GROUNDED_FACT_GROUPS = [
  /胸痛|心前区痛|胸(?:骨后|前|部)[^。；，,]{0,12}(?:疼痛|痛)/, /胸闷/, /心悸|心慌|心跳不适/, /晕厥/, /意识丧失/, /头痛/, /头晕|眩晕/, /视物模糊/, FEVER_FACT_PATTERN, CHILLS_FACT_PATTERN, /咳嗽/, /气促/, /呼吸困难/,
  ABDOMINAL_PAIN_FACT_PATTERN, /恶心/, /呕吐/, /失眠|不寐|寐差|难以入睡|不易入睡|入睡(?:困难|时间延长|慢)|睡眠(?:逐渐|明显)?(?:不佳|欠佳|较差|变差|差)|睡不好|醒后(?:难以|不易|无法)?再(?:入)?睡|再入睡困难/, /早醒/, /多梦/, /乏力|疲乏|疲倦|疲惫|疲劳|困倦|倦怠|神疲|(?:白天|日间|身体|人)?(?:有点|很|较|明显|总觉得)累|(?:总|容易)累/, /健忘|记忆力(?:下降|减退)/, /食欲不振|食欲欠佳|食欲较差|胃口差|纳差|食少|纳少/, /盗汗|夜(?:里|间)(?:总|反复|经常)?(?:出汗|汗出)|睡(?:着|眠)(?:后|时)(?:总|反复|经常)?(?:出汗|汗出)/, /自汗/, /潮热/, /口苦/, /口渴|口干|咽干/, /便秘/, /腹泻/, /便溏|溏便|大便(?:溏薄|稀溏)|大便较稀/,
  /打鼾|鼾声/, /呼吸暂停/, /日间嗜睡/, /焦虑/, /烦躁/, /情绪低落|抑郁/, /耳鸣/, /耳聋/, /腰膝酸软|腰酸|膝软/, /畏寒|怕冷/, /肢冷|手足冷/, /夜尿|小便频数/,
  /舌(?:质)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|齿痕|边红|尖红)|苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)/,
  /脉(?:浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|实|虚|微|洪|结|代|促){1,4}/,
  /面色(?:苍白|少华|萎黄|淡白|潮红|晦暗|青紫)|眼周晦暗/,
  /大便(?:偏干|干结|溏薄|稀溏)|小便(?:正常|清长|黄赤)/,
  /肝功能|肾功能|甲状腺功能|甲功|血常规|血糖|心电图/,
];

function normalizedFactLiteral(value: string): string {
  return value
    .replace(/^(?:患者|病人|本例|现有病历|病历记录|可见|症见|主诉|自诉|伴有|出现)/, "")
    .split(/(?:提示|支持|反映|说明|考虑|符合|可见于|为.+依据)/)[0]
    .replace(/(?:明确|本次|目前|当前|已经|现|有)/g, "")
    .replace(/[（）()【】\[\]：:；;，,。.!！?？、\s]+/g, "");
}

function normalizedFactSupportText(value: string): string {
  return normalizedFactLiteral(value)
    .replace(/睡眠(?:逐渐|明显)?变差/g, "失眠加重")
    .replace(/(?:入睡困难|睡眠不佳|睡眠欠佳|睡眠较差|睡眠差|睡不好)/g, "失眠")
    .replace(/(?:工作压力增大|工作压力大|工作负担重)/g, "工作压力")
    .replace(/(?:明显加重|加剧)/g, "加重")
    .replace(/(?:逐渐|近期|近来|目前|当前|本次|长期|反复)/g, "");
}

function hasLiteralFactSupport(value: string, clinicalContext: string, requireSameClause: boolean): boolean {
  const contexts = requireSameClause ? clinicalContext.split(/[。；;\n]+/) : [clinicalContext];
  const factClauses = clinicalClauses(value)
    .map(normalizedFactSupportText)
    .filter((item) => item.length >= 2);
  if (factClauses.length === 0) return false;
  return factClauses.every((factText) => contexts.some((clause) => normalizedFactSupportText(clause).includes(factText)));
}

function ungroundedPatientFactReason(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  if (!clinicalContext) return undefined;
  for (const [chainIndex, item] of (reasoning.pathogenesis?.chain || []).entries()) {
    for (const [factIndex, fact] of [item.patientFact, item.syndromeEvidence].entries()) {
      if (typeof fact !== "string") continue;
      const matchedGroups = GROUNDED_FACT_GROUPS.filter((pattern) => pattern.test(fact));
      const matchedConcepts = groundedFactConceptsForText(fact);
      const groupMismatch = matchedGroups.some((pattern) => {
        const concept = groundedFactConceptForGroup(pattern);
        const factPattern = concept ? concept.surface : pattern;
        const factAffirmed = hasAffirmedClinicalTerm(fact, factPattern);
        const factNegated = hasNegatedClinicalTerm(fact, factPattern);
        const contextAffirms = concept ? contextAffirmsGroundedConcept(clinicalContext, concept) : contextAffirmsTerm(clinicalContext, pattern);
        const contextNegates = concept ? contextNegatesGroundedConcept(clinicalContext, concept) : contextNegatesTerm(clinicalContext, pattern);
        return (factAffirmed && !contextAffirms) || (factNegated && !contextNegates);
      });
      // Concepts matched only through their canonical surface (发烧/胃脘痛/上腹隐痛) take the same
      // polarity path as their base group instead of falling through to the literal check.
      const conceptMismatch = matchedConcepts.some((concept) => {
        if (matchedGroups.includes(concept.group)) return false;
        const factAffirmed = hasAffirmedClinicalTerm(fact, concept.surface);
        const factNegated = hasNegatedClinicalTerm(fact, concept.surface);
        return (factAffirmed && !contextAffirmsGroundedConcept(clinicalContext, concept)) ||
          (factNegated && !contextNegatesGroundedConcept(clinicalContext, concept));
      });
      if (groupMismatch || conceptMismatch) return `patient_fact_ungrounded_${chainIndex}_${factIndex}_polarity`;
      // Known concepts must preserve polarity and are deterministically replaced with chart source
      // clauses after validation. Unknown concepts still require literal source support here.
      if (factIndex === 1) continue;
      if (matchedGroups.length > 0 || matchedConcepts.length > 0) continue;
      if (!hasLiteralFactSupport(fact, clinicalContext, false)) {
        return `patient_fact_ungrounded_${chainIndex}_${factIndex}_literal`;
      }
    }
  }
  return undefined;
}

// Read-only companion to ungroundedPatientFactReason: names the specific negated/ungrounded term that
// tripped the polarity check so the retry can tell the model exactly what to remove. This never changes
// a rejection decision — it only turns an opaque reason code into an actionable correction.
export function describeM03GroundingConflict(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  if (!clinicalContext) return undefined;
  for (const [chainIndex, item] of (reasoning.pathogenesis?.chain || []).entries()) {
    const nodeId = typeof item.nodeId === "string" && item.nodeId.trim() ? item.nodeId.trim() : `第${chainIndex + 1}条`;
    for (const [factIndex, fact] of [item.patientFact, item.syndromeEvidence].entries()) {
      if (typeof fact !== "string") continue;
      const field = factIndex === 0 ? "patientFact" : "syndromeEvidence";
      for (const pattern of GROUNDED_FACT_GROUPS.filter((p) => p.test(fact))) {
        const concept = groundedFactConceptForGroup(pattern);
        const factPattern = concept ? concept.surface : pattern;
        const term = fact.match(factPattern)?.[0] || "该症状";
        const contextAffirms = concept ? contextAffirmsGroundedConcept(clinicalContext, concept) : contextAffirmsTerm(clinicalContext, pattern);
        const contextNegates = concept ? contextNegatesGroundedConcept(clinicalContext, concept) : contextNegatesTerm(clinicalContext, pattern);
        if (hasAffirmedClinicalTerm(fact, factPattern) && !contextAffirms) {
          return `病机链 ${nodeId} 的 ${field} 写入了病历并未阳性记录、甚至已明确否认的“${term}”。请删除该词，或改为病历中实际记录且极性一致的表现；证型典型但本例未记录的表现只能移入 pathogenesis.uncertainties。`;
        }
        if (hasNegatedClinicalTerm(fact, factPattern) && !contextNegates) {
          return `病机链 ${nodeId} 的 ${field} 把“${term}”写成阴性/否认，但病历并未这样记录。请只保留与病历原文极性一致的表述。`;
        }
      }
      // Surface-only concept matches (发烧/胃脘痛/上腹隐痛) get the same conflict description as
      // their canonical group so a rejection never arrives without an actionable correction.
      for (const concept of groundedFactConceptsForText(fact)) {
        if (concept.group.test(fact)) continue;
        const term = fact.match(concept.surface)?.[0] || "该症状";
        if (hasAffirmedClinicalTerm(fact, concept.surface) && !contextAffirmsGroundedConcept(clinicalContext, concept)) {
          return `病机链 ${nodeId} 的 ${field} 写入了病历并未阳性记录、甚至已明确否认的“${term}”。请删除该词，或改为病历中实际记录且极性一致的表现；证型典型但本例未记录的表现只能移入 pathogenesis.uncertainties。`;
        }
        if (hasNegatedClinicalTerm(fact, concept.surface) && !contextNegatesGroundedConcept(clinicalContext, concept)) {
          return `病机链 ${nodeId} 的 ${field} 把“${term}”写成阴性/否认，但病历并未这样记录。请只保留与病历原文极性一致的表述。`;
        }
      }
    }
  }
  return undefined;
}

export function patientFactSourceQuote(value: string, clinicalContext: string): string | undefined {
  const approximateSourceQuote = (): string | undefined => {
    const normalizedFact = normalizedFactSupportText(value);
    if (normalizedFact.length < 4) return undefined;
    const factBigrams = new Set(Array.from({ length: normalizedFact.length - 1 }, (_, index) => normalizedFact.slice(index, index + 2)));
    const factNumbers = normalizedFact.match(/\d+(?:\.\d+)?/g) || [];
    const factNegated = isNegatedClinicalClause(value);
    let best: { quote: string; score: number; overlap: number } | undefined;
    for (const sentence of clinicalContext.split(/[。；;\n]+/).map((item) => item.trim()).filter(Boolean)) {
      if (isNegatedClinicalClause(sentence) !== factNegated) continue;
      const normalizedSentence = normalizedFactSupportText(sentence);
      if (factNumbers.some((number) => !normalizedSentence.includes(number))) continue;
      const overlap = [...factBigrams].filter((token) => normalizedSentence.includes(token)).length;
      const score = factBigrams.size > 0 ? overlap / factBigrams.size : 0;
      if (overlap < 3 || score < 0.36) continue;
      if (!best || score > best.score || (score === best.score && overlap > best.overlap)) {
        best = { quote: sentence, score, overlap };
      }
    }
    return best?.quote;
  };
  const matchedGroups = GROUNDED_FACT_GROUPS.filter((pattern) => pattern.test(value));
  const surfaceOnlyConcepts = groundedFactConceptsForText(value).filter((concept) => !matchedGroups.includes(concept.group));
  if (matchedGroups.length === 0 && surfaceOnlyConcepts.length === 0) {
    if (hasLiteralFactSupport(value, clinicalContext, false)) return value.trim();
    return approximateSourceQuote();
  }
  const sourceSentences = clinicalContext.split(/[。；;\n]+/).map((item) => item.trim()).filter(Boolean);
  const selected: string[] = [];
  for (const pattern of matchedGroups) {
    // One chart sentence can legitimately mix polarities, for example "无发热、心悸，盗汗以
    // 入睡后为主". Resolve polarity per clinical concept rather than letting one negated concept
    // turn every other affirmed symptom in the same sentence into a negation.
    const concept = groundedFactConceptForGroup(pattern);
    const factPattern = concept ? concept.surface : pattern;
    const factIsNegated = hasNegatedClinicalTerm(value, factPattern);
    const source = sourceSentences.find((sentence) => {
      if (concept) {
        return factIsNegated ? sentenceNegatesGroundedConcept(sentence, concept) : sentenceAffirmsGroundedConcept(sentence, concept);
      }
      if (!pattern.test(sentence)) return false;
      return factIsNegated ? hasNegatedClinicalTerm(sentence, pattern) : hasAffirmedClinicalTerm(sentence, pattern);
    });
    if (!source) return approximateSourceQuote();
    if (!selected.includes(source)) selected.push(source);
  }
  // Canonical surface matches without a literal group hit (发烧/胃脘痛/上腹隐痛) quote the same
  // concept's chart sentence so the node is not silently dropped when a canonical match exists.
  for (const concept of surfaceOnlyConcepts) {
    const factIsNegated = hasNegatedClinicalTerm(value, concept.surface);
    const source = sourceSentences.find((sentence) =>
      factIsNegated ? sentenceNegatesGroundedConcept(sentence, concept) : sentenceAffirmsGroundedConcept(sentence, concept));
    if (!source) return approximateSourceQuote();
    if (!selected.includes(source)) selected.push(source);
  }
  return selected.join("；");
}

function isNeutralTongueOnlyFact(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const cleaned = value
    .replace(/(?:舌质?)?淡红/g, "")
    .replace(/苔薄白/g, "")
    .replace(/舌体适中|舌形正常|舌态自然|津液适中/g, "")
    .replace(/(?:患者|舌象|可见|见|为|呈|记录|本次|检查|观察)/g, "")
    .replace(/[（）()【】\[\]：:；;，,。.!！?？、\s]+/g, "");
  return cleaned.length === 0 && /舌淡红|舌质淡红|苔薄白|舌体适中/.test(value);
}

function visibleLabeledValue(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[：:]\\s*([^\\n]+)`));
  return match?.[1]?.trim() || "";
}

function containsKnownHerbDose(value: string): boolean {
  const normalizedValue = value.normalize("NFKC");
  const chineseNumber = String.raw`[零〇一二两三四五六七八九十百半]+(?:点[零〇一二两三四五六七八九十]+)?`;
  const numericDose = String.raw`(?:\d+(?:\.\d+)?|${chineseNumber})(?:余|多)?`;
  const dosePattern = new RegExp(`${numericDose}(?:\\s*(?:[-—~～至到±]|\\.{2,})\\s*${numericDose})?\\s*(?:mg|g|毫克|克|钱|两)(?!\\s*[\\/／]\\s*(?:L|升))`, "gi");
  for (const match of normalizedValue.matchAll(dosePattern)) {
    const before = normalizedValue.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0)
      .replace(/(?:(?:各|约|用量|剂量(?:为)?|每味|取|使用)\s*)+$/g, "")
      .replace(/[（(【\[][^）)】\]]{0,16}[）)】\]]\s*$/g, "")
      .replace(/[\s，,。；;：:、（）()【】\[\]]+$/g, "");
    for (let length = 1; length <= Math.min(8, before.length); length += 1) {
      if (isKnownTcmHerbName(before.slice(-length))) return true;
    }
  }
  return false;
}

function m03ContainsDoseLevelInstruction(value: unknown, key = ""): boolean {
  if (key === "patientFact" || key === "source" || key === "contractSignature") return false;
  if (typeof value === "string") {
    return containsKnownHerbDose(value) ||
      /(?:每日|每天|一日|日服)\s*(?:\d+|[一二两三四五六七八九十半]+)\s*剂|(?:连服\s*)?(?:\d+|[一二两三四五六七八九十半]+)\s*剂(?:后|内|分|，|,|。|；|;|$)|水煎(?:服)?|煎煮(?:\d+|[一二两三四五六七八九十]+)?次|早晚分服|分[一二两三四五六七八九十2]\s*次服/.test(value.normalize("NFKC"));
  }
  if (Array.isArray(value)) return value.some((item) => m03ContainsDoseLevelInstruction(item, key));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([childKey, child]) => m03ContainsDoseLevelInstruction(child, childKey));
}

type ClinicalResolutionValue = "resolved" | "bounded" | "unresolved";

function clinicalResolution(value: unknown): ClinicalResolutionValue | undefined {
  return value === "resolved" || value === "bounded" || value === "unresolved" ? value : undefined;
}

function nonEmptyStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : [])
    : [];
}

function hasResolutionReason(value: unknown): boolean {
  return typeof value === "string" && value.trim().length >= 4;
}

const TCM_ONLY_WESTERN_SUPPORT = /(?:舌(?:象|质|体|红|淡|紫|暗)|苔(?:薄|厚|白|黄|腻|燥|润)|脉象|脉(?:浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|实|虚|微|洪|结|代|促)|证候|证型|病机|治则|治法)/;
const HISTORICAL_SUPPORT = /(?:既往|曾经|多年病史|[^。；]{1,16}病史(?:$|[，,；;])|病史\d|术后|后遗症|恢复期|已缓解|已治愈|无新发|未再发|目前稳定|当前稳定)/;

// A multi-year duration without any current-episode cue is background history (2型糖尿病10年、
// 高血压5年余), not evidence of the current episode. A current cue (本次/加重/持续/仍…) keeps the
// entry discriminating.
const YEARS_DURATION_HISTORY = /(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半数几]+)\s*年(?:余|多)?(?:的)?(?:病史)?$/;
const CURRENT_EPISODE_CUE = /(?:本次|本轮|当前|目前|现在|今日|今天|今晨|今早|昨夜|昨晚|昨日|昨天|新发|再发|复发|又发|又有|加重|加剧|持续|仍|还在|以来)/;

function isHistoricalWesternSupportFact(value: string): boolean {
  const fact = value.trim();
  if (!fact) return false;
  if (HISTORICAL_SUPPORT.test(fact)) return true;
  return YEARS_DURATION_HISTORY.test(fact) && !CURRENT_EPISODE_CUE.test(fact);
}

const DEMOGRAPHIC_STATUS_WORD = /(?:汉族|回族|已婚|未婚|离异|丧偶|退休(?:人员|职工)?|职员|工人|农民|教师|学生|干部|个体户|无业(?:人员)?)/;
const DEMOGRAPHIC_CUE = /\d{1,3}\s*岁|年龄|男性?|女性?|职业|民族|婚姻|汉族|已婚|未婚|退休/;

// Pure demographics (age/sex/occupation/marital status), alone or combined, never discriminate a
// western diagnosis. The anchored legacy single-item forms are kept as a fast path.
function isDemographicWesternSupportFact(value: string): boolean {
  const fact = value.trim();
  if (!fact) return false;
  if (/^(?:患者)?(?:男|女|男性|女性|\d{1,3}岁|年龄\d{1,3}岁|职业[^。；]{1,30})$/.test(fact)) return true;
  if (!DEMOGRAPHIC_CUE.test(fact)) return false;
  const residual = fact
    .replace(/(?:患者|病人|一般情况|基本信息|人口学(?:资料|信息)?)\s*[:：]?/g, "")
    .replace(/年龄\s*[:：]?\s*\d{1,3}\s*岁?/g, "")
    .replace(/\d{1,3}\s*岁/g, "")
    .replace(/(?:职业|民族|婚姻(?:状况)?)\s*[:：]?\s*[一-龥]{1,8}/g, "")
    .replace(new RegExp(DEMOGRAPHIC_STATUS_WORD.source, "g"), "")
    .replace(/(?<![一-龥])(?:男|女)性?(?![一-龥])/g, "")
    .replace(/[\s，,、；;。.:："'（）()【】\[\]{}]+/g, "");
  return residual.length === 0;
}

type VitalMeasurement = { kind: "temperature" | "blood_pressure" | "heart_rate" | "respiratory_rate" | "spo2"; abnormal: boolean };

function vitalMeasurements(value: string): VitalMeasurement[] {
  const normalized = value.normalize("NFKC");
  const measurements: VitalMeasurement[] = [];
  for (const match of normalized.matchAll(BLOOD_PRESSURE_MEASUREMENT)) {
    const systolic = Number.parseInt(match[1] || match[3] || "", 10);
    const diastolic = Number.parseInt(match[2] || match[4] || "", 10);
    if (!Number.isFinite(systolic) || !Number.isFinite(diastolic) || systolic <= diastolic) continue;
    measurements.push({ kind: "blood_pressure", abnormal: !(systolic >= 90 && systolic <= 139 && diastolic >= 60 && diastolic <= 89) });
  }
  for (const match of normalized.matchAll(TEMPERATURE_MEASUREMENT)) {
    const temperature = Number.parseFloat(match[1] || match[2] || match[3] || "");
    if (!Number.isFinite(temperature) || temperature < 34 || temperature > 43) continue;
    // A temperature at or above the fever threshold is discriminating evidence, never padding.
    measurements.push({ kind: "temperature", abnormal: !(temperature >= 35 && temperature < FEVER_TEMPERATURE_CELSIUS) });
  }
  for (const match of normalized.matchAll(HEART_RATE_MEASUREMENT)) {
    const rate = Number.parseInt(match[1] || match[2] || "", 10);
    if (!Number.isFinite(rate) || rate < 30 || rate > 220) continue;
    measurements.push({ kind: "heart_rate", abnormal: !(rate >= 60 && rate <= 119) });
  }
  for (const match of normalized.matchAll(RESPIRATORY_RATE_MEASUREMENT)) {
    const rate = Number.parseInt(match[1] || match[2] || "", 10);
    if (!Number.isFinite(rate) || rate < 5 || rate > 40) continue;
    measurements.push({ kind: "respiratory_rate", abnormal: !(rate >= 12 && rate <= 24) });
  }
  for (const match of normalized.matchAll(SPO2_MEASUREMENT)) {
    const saturation = Number.parseInt(match[1] || "", 10);
    if (!Number.isFinite(saturation) || saturation < 50 || saturation > 100) continue;
    measurements.push({ kind: "spo2", abnormal: saturation < 95 });
  }
  return measurements;
}

function vitalMeasurementResidual(value: string): string {
  return value.normalize("NFKC")
    .replace(BLOOD_PRESSURE_MEASUREMENT, " ")
    .replace(TEMPERATURE_MEASUREMENT, " ")
    .replace(HEART_RATE_MEASUREMENT, " ")
    .replace(RESPIRATORY_RATE_MEASUREMENT, " ")
    .replace(SPO2_MEASUREMENT, " ")
    .replace(/(?:生命体征|一般情况|体温|血压|心率|脉搏|呼吸|血氧饱和度|血氧|氧饱和度)/g, "")
    .replace(/\b(?:HR|RR|BP|SpO2|SaO2|T|P|R)\b/gi, "")
    .replace(/(?:mm\s*Hg|毫米汞柱|℃|°C|度|次\s*[\/／]?\s*分|次|bpm|%)/gi, "")
    .replace(/[\s，,、；;。.:："'（）()【】\[\]{}]+/g, "");
}

// A fact made only of in-range vital-sign measurements (labeled or serialized, single or combined)
// is padding, not diagnostic support. Any abnormal measurement (BP 200/120, SpO2 90%, T ≥37.2℃) or
// any residual clinical content keeps the fact discriminating.
function isNormalVitalWesternSupportFact(value: string): boolean {
  const fact = value.trim();
  if (!fact) return false;
  if (/^(?:患者)?(?:生命体征|一般情况)(?:平稳|正常|无异常)$/.test(fact)) return true;
  const measurements = vitalMeasurements(fact);
  if (measurements.length === 0) return false;
  if (vitalMeasurementResidual(fact).length > 0) return false;
  return measurements.every((measurement) => !measurement.abnormal);
}

export function isNondiscriminatingWesternSupportingFact(value: string): boolean {
  const fact = value.trim();
  return TCM_ONLY_WESTERN_SUPPORT.test(fact) ||
    isDemographicWesternSupportFact(fact) ||
    isNormalVitalWesternSupportFact(fact);
}

/**
 * Apply the same per-fact polarity boundary used by the final M03 contract. Deterministic
 * patient-record projection calls this before it writes western supportingFacts, so a server-side
 * normalization pass cannot reintroduce a symptom that the chart explicitly negates.
 */
export function isWesternSupportingFactPolarityAligned(value: string, clinicalContext: string): boolean {
  const fact = value.trim();
  if (!fact) return false;
  if (!clinicalContext) return true;
  const groupConflict = GROUNDED_FACT_GROUPS.some((pattern) => {
    const concept = groundedFactConceptForGroup(pattern);
    const factPattern = concept ? concept.surface : pattern;
    if (!factPattern.test(fact)) return false;
    if (!hasAffirmedClinicalTerm(fact, factPattern)) return false;
    return concept ? contextNegatesGroundedConcept(clinicalContext, concept) : contextNegatesTerm(clinicalContext, pattern);
  });
  if (groupConflict) return false;
  return !groundedFactConceptsForText(fact).some((concept) =>
    !concept.group.test(fact) &&
    hasAffirmedClinicalTerm(fact, concept.surface) &&
    contextNegatesGroundedConcept(clinicalContext, concept));
}

function m03WesternSupportIssue(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  const rawFacts = reasoning.westernDiagnosis?.primary?.supportingFacts;
  const facts = Array.isArray(rawFacts)
    ? rawFacts.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  if (facts.length === 0) return "western_support_empty";
  if (facts.some((fact) => TCM_ONLY_WESTERN_SUPPORT.test(fact))) return "western_support_tcm_pollution";
  if (facts.some((fact) => isDemographicWesternSupportFact(fact))) return "western_support_demographic_padding";
  if (facts.some((fact) => isNormalVitalWesternSupportFact(fact))) return "western_support_normal_vital_padding";
  // Excluded categories (TCM findings, demographics, normal-range vitals) never count as
  // discriminating evidence, so they cannot dilute a background-only fact list past the
  // historical_only gate.
  const discriminating = facts.filter((fact) => !isNondiscriminatingWesternSupportingFact(fact));
  if (discriminating.length === 0) return "western_support_nondiscriminating";
  if (discriminating.every((fact) => isHistoricalWesternSupportFact(fact) || isNegatedClinicalClause(fact))) {
    return "western_support_historical_only";
  }
  if (clinicalContext && facts.some((fact) => !isWesternSupportingFactPolarityAligned(fact, clinicalContext))) {
    return "western_support_polarity_mismatch";
  }
  return undefined;
}

// Read-only companion to m03WesternSupportIssue. Keep the hard rejection intact, but identify the
// exact supporting fact and term whose polarity conflicts with the chart so the bounded LLM repair
// can remove that hallucination instead of repeating it from an opaque reason code.
export function describeM03WesternSupportConflict(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  if (!clinicalContext) return undefined;
  const rawFacts = reasoning.westernDiagnosis?.primary?.supportingFacts;
  const facts = Array.isArray(rawFacts)
    ? rawFacts.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  for (const fact of facts) {
    for (const pattern of GROUNDED_FACT_GROUPS.filter((candidate) => candidate.test(fact))) {
      const concept = groundedFactConceptForGroup(pattern);
      const factPattern = concept ? concept.surface : pattern;
      if (!hasAffirmedClinicalTerm(fact, factPattern)) continue;
      const conflict = concept ? contextNegatesGroundedConcept(clinicalContext, concept) : contextNegatesTerm(clinicalContext, pattern);
      if (!conflict) continue;
      const term = fact.match(factPattern)?.[0] || "该表现";
      return `westernDiagnosis.primary.supportingFacts 中的“${fact}”把病历已明确否认的“${term}”写成了阳性依据。请删除这条依据，或替换为病历当前语境中确有阳性记录、且能支持本次工作诊断的事实；不得把阴性事实反写成阳性。`;
    }
    for (const concept of groundedFactConceptsForText(fact)) {
      if (concept.group.test(fact)) continue;
      if (!hasAffirmedClinicalTerm(fact, concept.surface) || !contextNegatesGroundedConcept(clinicalContext, concept)) continue;
      const term = fact.match(concept.surface)?.[0] || "该表现";
      return `westernDiagnosis.primary.supportingFacts 中的“${fact}”把病历已明确否认的“${term}”写成了阳性依据。请删除这条依据，或替换为病历当前语境中确有阳性记录、且能支持本次工作诊断的事实；不得把阴性事实反写成阳性。`;
    }
  }
  return undefined;
}

/** Validate uncertainty state and source grounding without deciding clinical semantics locally. */
function m03ResolutionContractIssue(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  const overview = reasoning.overview;
  const syndrome = typeof overview?.primarySyndrome === "string" ? overview.primarySyndrome.trim() : "";
  const syndromeBasis = nonEmptyStringList(overview?.primarySyndromeBasis);
  const explicitSyndromeResolution = clinicalResolution(overview?.primarySyndromeResolution);
  const syndromeResolution = explicitSyndromeResolution || (syndrome ? "bounded" : "unresolved");
  if (syndromeResolution === "resolved") {
    if (!syndrome) return "primary_syndrome_resolved_without_value";
    if (syndromeBasis.length === 0) return "primary_syndrome_resolved_without_basis";
    if (clinicalContext && syndromeBasis.some((basis) => !patientFactSourceQuote(basis, clinicalContext))) {
      return "primary_syndrome_basis_ungrounded";
    }
  } else {
    if (explicitSyndromeResolution && !hasResolutionReason(overview?.primarySyndromeResolutionReason)) return "primary_syndrome_resolution_reason_missing";
    if (syndromeResolution === "bounded" && !syndrome) return "primary_syndrome_bounded_without_value";
    if (syndromeResolution === "unresolved" && overview?.evidence?.confidence !== "低") return "primary_syndrome_unresolved_confidence";
  }

  const location = reasoning.pathogenesis?.locationDifferentiation;
  const locationItems = nonEmptyStringList(location?.items);
  const explicitLocationResolution = clinicalResolution(location?.resolution);
  const locationResolution = explicitLocationResolution || (locationItems.length > 0 ? "bounded" : "unresolved");
  if (locationResolution === "unresolved") {
    if (locationItems.length > 0) return "location_unresolved_with_items";
    if (explicitLocationResolution && !hasResolutionReason(location?.resolutionReason)) return "location_resolution_reason_missing";
  } else {
    if (locationItems.length === 0) return `location_${locationResolution}_without_items`;
    if (locationResolution === "bounded" && explicitLocationResolution && !hasResolutionReason(location?.resolutionReason)) return "location_resolution_reason_missing";
    if (locationResolution === "resolved") {
      const details = Array.isArray(location?.details) ? location.details : [];
      if (details.length === 0) return "location_resolved_without_basis";
      if (clinicalContext && details.some((detail) => typeof detail.basis !== "string" || !patientFactSourceQuote(detail.basis, clinicalContext))) {
        return "location_resolved_basis_ungrounded";
      }
    }
  }

  const nature = reasoning.pathogenesis?.natureDifferentiation;
  const natureItems = [
    ...nonEmptyStringList(nature?.items),
    ...nonEmptyStringList(nature?.rootDeficiency),
    ...nonEmptyStringList(nature?.branchExcess),
  ];
  const explicitNatureResolution = clinicalResolution(nature?.resolution);
  const natureResolution = explicitNatureResolution || (natureItems.length > 0 ? "bounded" : "unresolved");
  if (natureResolution === "unresolved") {
    if (natureItems.length > 0) return "nature_unresolved_with_items";
    if (explicitNatureResolution && !hasResolutionReason(nature?.resolutionReason)) return "nature_resolution_reason_missing";
  } else {
    if (natureItems.length === 0) return `nature_${natureResolution}_without_items`;
    if (natureResolution === "bounded" && explicitNatureResolution && !hasResolutionReason(nature?.resolutionReason)) return "nature_resolution_reason_missing";
    if (natureResolution === "resolved") {
      if (typeof nature?.basis !== "string" || !nature.basis.trim()) return "nature_resolved_without_basis";
      if (clinicalContext && !patientFactSourceQuote(nature.basis, clinicalContext)) return "nature_resolved_basis_ungrounded";
    }
  }
  return undefined;
}

export function m03SemanticIssue(reasoning: M03ReasoningLike | null | undefined, clinicalContext = "", _visibleContent = ""): string | undefined {
  void _visibleContent;
  const hasCompleteChainItem = reasoning?.pathogenesis?.chain?.some((item) =>
    !isUnstableM03CoreText(item.patientFact) &&
    !isUnstableM03CoreText(item.syndromeEvidence) &&
    typeof item.pathogenesis === "string" && item.pathogenesis.trim().length >= 2 &&
    typeof item.therapyDirection === "string" && item.therapyDirection.trim().length >= 2
  );
  if (!reasoning || reasoning.stage !== "diagnose") return "stage";
  if (reasoning.formula != null) return "formula_not_null";
  if (m03ContainsDoseLevelInstruction(reasoning)) return "dose_level_content";
  const westernPrimary = reasoning.westernDiagnosis?.primary;
  if (
    typeof westernPrimary?.name !== "string" ||
    westernPrimary.name.trim().length < 2 ||
    /(?:基于主诉的)?现代医学诊断倾向|待生成|待明确|未知/.test(westernPrimary.name)
  ) return "western_diagnosis_unstable";
  if (/[\/／、]|(?:或|二者之一|待鉴别)/.test(westernPrimary.name)) return "western_primary_ambiguous";
  const westernSupportIssue = m03WesternSupportIssue(reasoning, clinicalContext);
  if (westernSupportIssue) return westernSupportIssue;
  if (!reasoning.pathogenesis?.chain?.length) return "chain_empty";
  if (!hasCompleteChainItem) return "chain_incomplete";
  if (reasoning.pathogenesis.chain.every((item) => isNeutralTongueOnlyFact(item.patientFact))) return "neutral_tongue_only";
  const resolutionIssue = m03ResolutionContractIssue(reasoning, clinicalContext);
  if (resolutionIssue) return resolutionIssue;
  // Semantic adequacy and clinical coherence are owned by the independent reviewer. This local
  // contract only rejects ungrounded patient facts and malformed resolution states; it does not
  // decide TCM syndrome, disease location, disease nature or therapy via finite keyword lists.
  if (clinicalContext) {
    const groundingIssue = ungroundedPatientFactReason(reasoning, clinicalContext);
    if (groundingIssue) return groundingIssue;
  }
  return undefined;
}

export function isStableM03Reasoning(reasoning: M03ReasoningLike | null | undefined, clinicalContext = "", visibleContent = ""): boolean {
  return m03SemanticIssue(reasoning, clinicalContext, visibleContent) == null;
}

type M04ReasoningLike = {
  stage?: unknown;
  overview?: { primarySyndrome?: unknown; overallPathogenesis?: unknown; recommendedFormulaDirection?: unknown };
  therapy?: { overallPrinciple?: unknown };
  formula?: {
    candidates?: Array<{
      name?: unknown;
      formulaNames?: unknown;
      constructionType?: unknown;
      modificationStatus?: unknown;
      therapyMatch?: unknown;
      herbs?: Array<{ name?: unknown; dose?: unknown; role?: unknown; prescriptionRole?: unknown; targetKind?: unknown; targetRef?: unknown; structureRole?: unknown; targetPathogenesis?: unknown; function?: unknown; decoctionRequirement?: unknown }>;
      decoction?: { doseCount?: unknown; method?: unknown; course?: unknown; followUpNode?: unknown };
    }>;
    modifications?: Array<{ trigger?: unknown; targetPathogenesis?: unknown; action?: unknown; doseOrHandling?: unknown; reason?: unknown; riskNote?: unknown }>;
  } | null;
  nonPharma?: {
    diet?: unknown;
    lifestyle?: unknown;
    emotion?: unknown;
    tcmTreatments?: Array<{ projectCode?: unknown; targetRef?: unknown; targetPathogenesis?: unknown; assessmentPositioning?: unknown; operatorRequirement?: unknown; requiredChecks?: unknown; availability?: unknown; riskLevel?: unknown; recommendationMode?: unknown; executable?: unknown; clinicianReviewRequired?: unknown }>;
    monitoring?: unknown;
  } | null;
};

type TcmTherapyConcept =
  | "qi_tonify" | "blood_nourish" | "calm_spirit" | "spleen_support"
  | "qi_regulate" | "heat_clear" | "phlegm_resolve" | "damp_resolve"
  | "yang_warm" | "yin_nourish" | "exterior_release" | "blood_move"
  | "purge" | "astringe" | "hemostasis" | "cough_relieve"
  | "food_resolve" | "wind_extinguish" | "orifice_open" | "mass_soften";

// The concept regexes below are the contract-side therapy vocabulary; the generator-side prompt
// mapping (THERAPY_HERB_CATEGORY_RULES in diagnosis-prompts.ts) and the knowledge-base function
// texts must map onto the SAME concepts or a clinically correct emperor fails the deterministic
// emperor-therapy alignment check. Keep the two sides aligned at class level: cover the standard
// synonym families the KB function texts actually use (凉散风热/疏散风热, 下气/宽中/除满, 消痰,
// 醒脾, 消积) and the KB CATEGORY labels that appear in category-only records (补阴药/补血药 —
// e.g. 麦冬/枸杞子 carry only ["补虚药","补阴药"], so without 补阴 the emperor-knowledge gate
// rejects the canonical 养阴 emperors the prompt shortlist itself recommends). 补虚药 stays
// unmapped: it spans 气血阴阳 and cannot be assigned one concept conservatively. Do NOT widen
// the HIGH_IMPACT concepts below (heat_clear, yang_warm, blood_move, purge, orifice_open,
// mass_soften) without auditing every herb whose function text would newly match — a wider
// high-impact regex turns into new fail-closed false positives.
const TCM_THERAPY_CONCEPTS: ReadonlyArray<[TcmTherapyConcept, RegExp]> = [
  ["qi_tonify", /补(?:中|脾|肺|肾)?气|益(?:中|脾|肺|肾)?气|大补元气|扶正|升阳|举陷|固表/],
  ["blood_nourish", /养(?:心|肝)?血|补(?:心|肝)?血|益血|生血|补血/],
  ["calm_spirit", /安神|宁心|宁神|养心|定志|镇惊|安魂|定魄/],
  ["spleen_support", /健脾|补脾|益脾|补益心脾|健运|运化/],
  ["qi_regulate", /理气|行气|疏肝|解郁|开郁|调畅气机|下气|降气|宽中|除满|消胀|除痞|行滞|破气|顺气|和胃|降逆|宽胸/],
  ["heat_clear", /清热|泻火|凉血|解毒|辛凉|清(?:肺|肝|心|胃|营|暑)|泄热/],
  ["phlegm_resolve", /化痰|祛痰|涤痰|豁痰|消痰/],
  ["damp_resolve", /利湿|渗湿|利水|祛湿|燥湿|化湿|醒脾|化寒湿|散寒湿|除湿/],
  ["yang_warm", /温阳|扶阳|回阳|散寒|辛温|温(?:中|肾|里|肺|经|化|补|通|养)|补阳/],
  ["yin_nourish", /滋阴|养阴|育阴|生津|增液|补阴/],
  ["exterior_release", /解表|祛风|疏风|疏散风邪|疏风散邪|发散风寒|发散风热|疏散风热|凉散风热|疏风散热|散风/],
  ["blood_move", /活血|化瘀|行瘀|破血|通经|(?:气血|血行|血脉)(?:运行|畅行|周行|流通)|调[和畅][^，。；;]{0,6}气血/],
  ["purge", /通便|泻下|攻下|逐水/],
  ["astringe", /收涩|敛汗|固涩|固精|止带/],
  ["hemostasis", /止血|凉血止血|化瘀止血/],
  ["cough_relieve", /止咳|平喘|宣肺|肃肺|降肺|开宣肺气|宣(?:通|畅|降)肺气/],
  ["food_resolve", /消食|导滞|健胃|消积/],
  ["wind_extinguish", /息风|止痉|平肝|潜阳/],
  ["orifice_open", /开窍|醒神/],
  ["mass_soften", /软坚|散结/],
];

function tcmTherapyConcepts(text: string): Set<TcmTherapyConcept> {
  return new Set(TCM_THERAPY_CONCEPTS.filter(([, pattern]) => pattern.test(text)).map(([concept]) => concept));
}

function affirmedTcmTherapyConcepts(text: string): Set<TcmTherapyConcept> {
  const concepts = new Set<TcmTherapyConcept>();
  for (const clause of clinicalClauses(text)) {
    if (isNegatedClinicalClause(clause)) continue;
    for (const concept of tcmTherapyConcepts(clause)) concepts.add(concept);
  }
  return concepts;
}

function affirmedTcmTherapyAnchors(text: string): Set<string> {
  return new Set(clinicalClauses(text)
    .filter((clause) => !isNegatedClinicalClause(clause))
    .flatMap((clause) => clause.match(new RegExp(TCM_THERAPY_ANCHOR.source, "g")) || []));
}

const HIGH_IMPACT_THERAPY_CONCEPTS = new Set<TcmTherapyConcept>([
  "heat_clear",
  "yang_warm",
  "blood_move",
  "purge",
  "orifice_open",
  "mass_soften",
]);

// Governed supplement for KB category-only records whose function text omits the herb's
// canonical pharmacopoeia direction (e.g. 柴胡's KB record is only "发散风热药；解表药", which
// would invert its primary clinical direction 疏肝解郁 for 逍遥散-type use). Same discipline as
// CONTROLLED_HERB_FUNCTION_TEXT in tcm-knowledge.ts: minimal, evidence-bound （药典2020), and
// applied ONLY when the KB record is empty or nothing but category labels.
const GOVERNED_HERB_FUNCTION_SUPPLEMENT: Readonly<Record<string, string>> = {
  柴胡: "疏散退热，疏肝解郁，升举阳气",
};

function isCategoryOnlyHerbKnowledge(name: string): boolean {
  const text = getTcmHerbFunctionText(name).trim();
  if (!text) return true;
  const categories = getTcmHerbFunctionCategories(name).join("；").trim();
  return Boolean(categories) && text === categories;
}

function herbKnowledgeFunctionText(name: string): string {
  const text = getTcmHerbFunctionText(name);
  if (!isCategoryOnlyHerbKnowledge(name)) return text;
  const supplement = GOVERNED_HERB_FUNCTION_SUPPLEMENT[name];
  return supplement ? [supplement, text].filter(Boolean).join("，") : text;
}

function herbTherapyConcepts(name: string): Set<TcmTherapyConcept> {
  return tcmTherapyConcepts([
    herbKnowledgeFunctionText(name),
    ...getTcmHerbFunctionCategories(name),
  ].join("；"));
}

function herbHighImpactConcepts(name: string, declaredFunction?: string): Set<TcmTherapyConcept> {
  const categoryConcepts = tcmTherapyConcepts(getTcmHerbFunctionCategories(name).join("；"));
  const fullFunctionConcepts = tcmTherapyConcepts(herbKnowledgeFunctionText(name));
  const riskConcepts = tcmTherapyConcepts(getTcmHerbRiskProfile(name));
  const intendedConcepts = declaredFunction?.trim()
    ? tcmTherapyConcepts(declaredFunction)
    : null;
  // A multi-action herb is governed by the action actually declared for this prescription. This
  // keeps secondary catalog effects from becoming false positives while still catching an
  // explicitly selected direction such as 乌药“温肾散寒”. A declared intent that carries no
  // therapy-direction vocabulary at all (e.g. 调和诸药/协调药性 for a 使药) claims no high-impact
  // action either: for category-covered herbs the primary actions stay governed through their
  // categories/risk/governed mapping, and only the unrelated secondary function-text actions are
  // dropped (this is what wrongly flagged 甘草“清热解毒” and 党参“清肺” on harmonizer rows).
  // Herbs with NO categories keep the full conservative expansion — their function text is the
  // only knowledge source. If the intended action is absent, retain the conservative
  // server-owned specialist mapping until the row is fully structured.
  const knowledgeConcepts = new Set([...categoryConcepts, ...fullFunctionConcepts, ...riskConcepts]);
  const intendedMatchesKnowledge = Boolean(intendedConcepts && [...intendedConcepts].some((concept) => knowledgeConcepts.has(concept)));
  const intendedKnowledgeConcepts = intendedConcepts && intendedMatchesKnowledge
    ? [...fullFunctionConcepts, ...riskConcepts].filter((concept) => intendedConcepts.has(concept))
    : intendedConcepts && intendedConcepts.size > 0
      ? [...fullFunctionConcepts, ...riskConcepts]
      : intendedConcepts
        ? (categoryConcepts.size > 0 ? [...riskConcepts] : [...fullFunctionConcepts, ...riskConcepts])
        : [...fullFunctionConcepts].filter((concept) => concept === "orifice_open" || concept === "mass_soften");
  const governedConcepts = getTcmHerbGovernedHighImpactConcepts(name)
    .filter((concept) => !intendedConcepts || !intendedMatchesKnowledge || intendedConcepts.has(concept));
  const opposingKnowledgeConcepts = intendedConcepts
    ? [...knowledgeConcepts].filter((knowledgeConcept) => OPPOSING_THERAPY_CONCEPTS.some(([left, right]) =>
        (knowledgeConcept === left && intendedConcepts.has(right)) ||
        (knowledgeConcept === right && intendedConcepts.has(left))))
    : [];
  return new Set([...categoryConcepts, ...intendedKnowledgeConcepts, ...governedConcepts, ...opposingKnowledgeConcepts]
    .filter((concept) => HIGH_IMPACT_THERAPY_CONCEPTS.has(concept)));
}

function requiredTherapyConcepts(prior: M03ReasoningLike | null | undefined): Set<TcmTherapyConcept> {
  const chain = prior?.pathogenesis?.chain || [];
  return affirmedTcmTherapyConcepts([
    prior?.therapy?.overallPrinciple,
    ...chain.map((node) => node.therapyDirection),
  ].map((value) => String(value || "").trim()).filter(Boolean).join("；"));
}

function primaryPathogenesisTherapyConcepts(prior: M03ReasoningLike | null | undefined): Set<TcmTherapyConcept> {
  const chain = prior?.pathogenesis?.chain || [];
  const primaryNode = chain.find((node, index) => String(node.nodeId || `P${index + 1}`) === "P1") || chain[0];
  return affirmedTcmTherapyConcepts([
    primaryNode?.therapyDirection,
    prior?.therapy?.overallPrinciple,
  ].map((value) => String(value || "").trim()).filter(Boolean).join("；"));
}

// Current-heat facts documented in the signed M03 payload's own grounded fields: verbatim chain
// anchors, syndrome basis, western supporting facts, resolution reasons and uncertainty notes all
// carry record fragments. When any affirmed (non-negated) clause documents heat polarity, a
// heat_clear high-impact herb counts as supported even when the M03 therapy vocabulary does not
// literally contain 清热 verbs (e.g. 平肝潜阳 for 肝阳上亢 with 舌红苔薄黄 in the record).
// Conservative scope: only heat_clear gets this documented-facts channel — it stays high-impact,
// undocumented usage still rejects, and the opposing-direction invariant below is unchanged.
const GROUNDED_HEAT_FACT_PATTERN = /舌红|舌绛|苔黄|苔燥|少津|口干|口苦|口渴|潮热|盗汗|心烦|烦躁|尿黄|小便黄|大便秘结|便秘|发热|面红|目赤|咽痛|牙龈肿痛|脉数/;

function priorDocumentedHeatFacts(prior: M03ReasoningLike | null | undefined): boolean {
  if (!prior) return false;
  const overview = prior.overview as { primarySyndromeBasis?: unknown } | undefined;
  const pathogenesis = prior.pathogenesis as {
    chain?: Array<{ patientFact?: unknown; syndromeEvidence?: unknown }>;
    uncertainties?: unknown;
    locationDifferentiation?: { resolutionReason?: unknown; basis?: unknown };
    natureDifferentiation?: { resolutionReason?: unknown; basis?: unknown };
  } | undefined;
  const westernPrimary = prior.westernDiagnosis?.primary as { supportingFacts?: unknown } | undefined;
  const uncertaintyTexts = (Array.isArray(pathogenesis?.uncertainties) ? pathogenesis!.uncertainties! : [])
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as { item?: unknown; reason?: unknown; affects?: unknown };
      return [row.item, row.reason, row.affects].filter((value): value is string => typeof value === "string");
    });
  const texts = [
    ...(pathogenesis?.chain || []).flatMap((node) => [node.patientFact, node.syndromeEvidence]),
    ...(Array.isArray(overview?.primarySyndromeBasis) ? overview!.primarySyndromeBasis! : [overview?.primarySyndromeBasis]),
    ...(Array.isArray(westernPrimary?.supportingFacts) ? westernPrimary!.supportingFacts! : []),
    pathogenesis?.locationDifferentiation?.resolutionReason,
    pathogenesis?.locationDifferentiation?.basis,
    pathogenesis?.natureDifferentiation?.resolutionReason,
    pathogenesis?.natureDifferentiation?.basis,
    ...uncertaintyTexts,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
  for (const clause of clinicalClauses(texts)) {
    if (isNegatedClinicalClause(clause)) continue;
    if (GROUNDED_HEAT_FACT_PATTERN.test(clause)) return true;
  }
  return false;
}

function unsupportedHighImpactHerbIssue(
  herbs: ReadonlyArray<{ name?: unknown; function?: unknown; prescriptionRole?: unknown; targetPathogenesis?: unknown }>,
  prior: M03ReasoningLike | null | undefined,
  allowGovernedFormulaBaseline = false,
  selectedFormulaNames: readonly string[] = [],
): string | undefined {
  const required = requiredTherapyConcepts(prior);
  const documentedHeatSupport = priorDocumentedHeatFacts(prior);
  const governedFormulaIngredients = allowGovernedFormulaBaseline
    ? new Set(executableFormulaCompilationReferences(
        selectedFormulaNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim())),
      ).flatMap((formula) => formula.ingredients))
    : new Set<string>();
  for (const [index, herb] of herbs.entries()) {
    const herbName = String(herb.name || "").trim();
    if (governedFormulaIngredients.has(herbName)) continue;
    const intendedUse = [herb.prescriptionRole, herb.targetPathogenesis]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map((value) => value.replace(/(?:^|；)\s*知识库功用[：:][\s\S]*$/, "").trim())
      .filter((value) => Boolean(value) && !GENERATED_PLACEHOLDER_MARKER.test(value))
      .join("；") || (typeof herb.function === "string" ? herb.function : undefined);
    const highImpact = herbHighImpactConcepts(herbName, intendedUse);
    // A declared secondary action (for example 乌药“理气止痛”) must not hide a server-known
    // high-impact action that directly opposes the M03-locked treatment direction. Compare the
    // full herb knowledge against the locked therapy as a separate invariant from declared
    // intent — EXCEPT when the declared intent carries no therapy-direction vocabulary at all
    // (the server-owned 调和诸药/协调药性 harmonizer role). A concept-free harmonizer declaration
    // claims nothing and cannot launder an opposing action; for category-covered herbs the
    // primary actions stay governed through categories/risk and only unrelated secondary
    // function-text actions (甘草“清热解毒”、党参“清肺”) are ignored. Concept-bearing
    // declarations keep the full-knowledge comparison, so 乌药-style laundering still rejects.
    const declaredConcepts = intendedUse ? tcmTherapyConcepts(intendedUse) : undefined;
    const opposingPool = declaredConcepts && declaredConcepts.size === 0 && tcmTherapyConcepts(getTcmHerbFunctionCategories(herbName).join("；")).size > 0
      ? new Set([...tcmTherapyConcepts(getTcmHerbFunctionCategories(herbName).join("；")), ...tcmTherapyConcepts(getTcmHerbRiskProfile(herbName))])
      : herbTherapyConcepts(herbName);
    const opposingLocked = [...opposingPool].filter((knowledgeConcept) =>
      HIGH_IMPACT_THERAPY_CONCEPTS.has(knowledgeConcept) &&
      OPPOSING_THERAPY_CONCEPTS.some(([left, right]) =>
        (knowledgeConcept === left && required.has(right)) ||
        (knowledgeConcept === right && required.has(left))))
    ;
    const unsupported = [...new Set([
      ...[...highImpact].filter((concept) =>
        !required.has(concept) && !(concept === "heat_clear" && documentedHeatSupport)),
      ...opposingLocked,
    ])];
    if (unsupported.length > 0) return `herb_${index}_unsupported_high_impact_${unsupported.join("_")}`;
  }
  return undefined;
}

export function highImpactHerbDirectionIssue(
  herbName: string,
  declaredFunction: string,
  prior: M03ReasoningLike | null | undefined,
): string | undefined {
  return unsupportedHighImpactHerbIssue([{ name: herbName, function: declaredFunction }], prior);
}

function setsIntersect<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return [...left].some((item) => right.has(item));
}

const OPPOSING_THERAPY_CONCEPTS: ReadonlyArray<readonly [TcmTherapyConcept, TcmTherapyConcept]> = [
  ["heat_clear", "yang_warm"],
];

function therapyMatchAligned(lockedTherapy: string, therapyMatch: string): boolean {
  const candidateLiteral = lockedClinicalText(therapyMatch);
  // The M04 compiler copies therapyMatch from the signed M03 overallPrinciple. The validator also
  // receives node directions appended to that principle; accept that exact inherited literal before
  // semantic extraction so a classical phrase outside the finite concept vocabulary cannot make the
  // server reject its own lock. Non-literal provider text still follows all polarity/concept checks.
  const lockedClauses = lockedTherapy
    .split(/[；;\n]+/)
    .map(lockedClinicalText)
    .filter(Boolean);
  if (candidateLiteral && lockedClauses.includes(candidateLiteral)) return true;
  const lockedConcepts = affirmedTcmTherapyConcepts(lockedTherapy);
  const candidateConcepts = affirmedTcmTherapyConcepts(therapyMatch);
  const polarityConflict = OPPOSING_THERAPY_CONCEPTS.some(([left, right]) =>
    (lockedConcepts.has(left) && !lockedConcepts.has(right) && candidateConcepts.has(right)) ||
    (lockedConcepts.has(right) && !lockedConcepts.has(left) && candidateConcepts.has(left))
  );
  if (polarityConflict) return false;
  if ([...candidateConcepts].some((concept) => !lockedConcepts.has(concept))) {
    return false;
  }
  if (setsIntersect(lockedConcepts, candidateConcepts)) return true;

  const lockedAnchors = affirmedTcmTherapyAnchors(lockedTherapy);
  if (lockedAnchors.size === 0 && lockedConcepts.size === 0) return false;
  return setsIntersect(lockedAnchors, affirmedTcmTherapyAnchors(therapyMatch));
}

export function isM04TherapyMatchAligned(lockedTherapy: string, therapyMatch: string): boolean {
  return therapyMatchAligned(lockedTherapy, therapyMatch);
}

/**
 * Verify a transparent self-devised fallback against server-owned herb knowledge, not provider
 * target labels. This is intentionally conservative and is used only after a completed targeted
 * classic-composition repair; ordinary self-devised M04 generation follows the full stage contract.
 */
export function transparentFormulaTherapyIssue(
  reasoning: M04ReasoningLike | null | undefined,
  prior: M03ReasoningLike | null | undefined,
): string | undefined {
  const candidate = reasoning?.formula?.candidates?.[0];
  if (!candidate || !prior || prior.stage !== "diagnose") return "transparent_therapy_contract_missing";
  const required = requiredTherapyConcepts(prior);
  if (required.size === 0) return "transparent_therapy_unresolved";

  const allHerbs = candidate.herbs || [];
  const highImpactIssue = unsupportedHighImpactHerbIssue(allHerbs, prior);
  if (highImpactIssue) return `transparent_therapy_${highImpactIssue}`;
  const therapeuticHerbs = allHerbs.filter((herb) => herb.targetKind !== "formula_structure");
  if (therapeuticHerbs.length === 0) return "transparent_therapy_herbs_missing";
  const herbConcepts = therapeuticHerbs.map((herb) => herbTherapyConcepts(String(herb.name || "")));
  if (herbConcepts.some((concepts) => concepts.size === 0)) return "transparent_therapy_herb_knowledge_missing";

  const coveredRequired = [...required].filter((concept) => herbConcepts.some((concepts) => concepts.has(concept)));
  const directlySupportingHerbs = herbConcepts.filter((concepts) => setsIntersect(concepts, required)).length;
  if (coveredRequired.length / required.size < 0.6) return "transparent_therapy_coverage";
  if (directlySupportingHerbs / therapeuticHerbs.length < 0.5) return "transparent_therapy_herb_support";

  return undefined;
}

const HERB_DOSE = /^(\d+(?:\.\d+)?)\s*(g|克|mg|毫克)$/i;

function normalizeChineseMethodNumbers(value: string): string {
  const replacements: Array<[string, string]> = [
    ["半小时", "30分钟"], ["一剂", "1剂"], ["一次", "1次"], ["二次", "2次"], ["两次", "2次"], ["三次", "3次"],
    ["四百毫升", "400毫升"], ["三百毫升", "300毫升"], ["五百毫升", "500毫升"], ["六百毫升", "600毫升"],
    ["早晚各温服1次", "早晚分服"], ["早晚各服1次", "早晚分服"],
  ];
  return replacements.reduce((next, [from, to]) => next.replaceAll(from, to), value);
}

function boundedNumber(value: string, pattern: RegExp, min: number, max: number): boolean {
  const match = normalizeChineseMethodNumbers(value).match(pattern);
  if (!match) return false;
  const number = Number(match[1]);
  return Number.isFinite(number) && number >= min && number <= max;
}

function decoctionMethodMissing(value: string): string[] {
  const normalized = normalizeChineseMethodNumbers(value);
  if (/(?:不应|无需|禁止|不得|不可|不宜|暂不|待确认|待核实|未知|不详)/.test(normalized)) return ["negated_or_unresolved"];
  const dailyDose = /(?:每日|每天)\s*1\s*剂|1\s*剂\s*[\/／]\s*日|日\s*1\s*剂/.test(normalized);
  const soak = boundedNumber(normalized, /(?:冷水|清水)?\s*浸泡\s*(?:约)?\s*(\d+)\s*(?:分钟|min)/i, 5, 120);
  const decoctionCount = boundedNumber(normalized, /煎(?:煮|取)?\s*(\d+)\s*次/, 1, 3) || /(?:一|二|两|三)煎/.test(normalized);
  const liquidVolume = boundedNumber(normalized, /(?:合并(?:两次)?(?:煎液|药液)|煎取(?:药液)?|滤取(?:药液)?|共?取药液)\s*(?:约)?\s*(\d+)\s*(?:mL|ml|毫升)/i, 50, 2000);
  const dividedAdministration = /早晚(?:分)?服|分服/.test(normalized) ||
    boundedNumber(normalized, /分\s*(\d+)\s*次(?:温)?服/, 1, 4) ||
    boundedNumber(normalized, /(?:每日|每天|一日)\s*(\d+)\s*次(?:温)?服/, 1, 4);
  return [
    dailyDose ? "" : "daily_dose",
    soak ? "" : "soak",
    decoctionCount ? "" : "decoction_count",
    liquidVolume ? "" : "final_volume",
    dividedAdministration ? "" : "divided_administration",
  ].filter(Boolean);
}

function hasCompleteDecoctionMethod(value: string): boolean {
  return decoctionMethodMissing(value).length === 0;
}

function normalizeComparableDose(value: string): string {
  const match = value.trim().match(HERB_DOSE);
  if (!match) return "";
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const unit = /^(?:mg|毫克)$/i.test(match[2]) ? "mg" : "g";
  const grams = unit === "mg" ? amount / 1000 : amount;
  if (grams < 0.001 || grams > 500) return "";
  return `${amount}${unit}`;
}

type VisibleHerbRow = { name: string; dose: string; text: string };

function visibleHerbRows(value: string): VisibleHerbRow[] {
  const lines = value.split("\n");
  const rows: VisibleHerbRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].trim();
    if (!header.startsWith("|") || !/药名/.test(header) || !/剂量/.test(header)) continue;
    const headerCells = header.split("|").slice(1, -1).map((cell) => cell.trim());
    const nameIndex = headerCells.findIndex((cell) => /药名/.test(cell));
    const doseIndex = headerCells.findIndex((cell) => /剂量/.test(cell));
    if (nameIndex < 0 || doseIndex < 0) continue;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex].trim();
      if (!line.startsWith("|")) break;
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length <= Math.max(nameIndex, doseIndex)) continue;
      const dose = normalizeComparableDose(cells[doseIndex].replace(/\*|`/g, ""));
      const name = cells[nameIndex].replace(/\*|`|\s/g, "");
      if (name && dose) rows.push({ name, dose, text: cells.join(" ") });
    }
  }
  return rows;
}

function lockedClinicalText(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/[（）()【】\[\]：:；;，,。.!！?？、\s]+/g, "")
    : "";
}

function governedFormulaNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (names.length !== value.length || names.length > 4) return undefined;
  return [...new Set(names)];
}

const PATHOGENESIS_CONCEPT_GROUPS = [
  /气虚|气亏|气不足|气弱|元气亏|气血两虚|心脾两虚/, /血虚|血亏|血不足|血少|血不养|气血两虚/, /阴虚|阴亏|阴液不足|津亏|津伤/, /阳虚|阳亏|阳气不足|阳气虚衰/,
  /脾虚|心脾两虚|脾气(?:虚|亏|不足|弱)|脾失健运|脾运(?:不健|失常|失司)|健运失司|运化失司/, /心脾两虚|心气(?:虚|亏|不足|弱)|心血(?:虚|亏|不足)|心失所养/,
  /神失所养|心神失养|心神不宁|神扰|神不守舍/, /肝郁|肝气郁结|气机不畅|气滞/, /血瘀|瘀血|络阻|血行不畅/,
  /痰湿|痰浊|湿困|湿阻/, /痰热|热扰|火扰/, /心肾不交|水火不济/, /肾虚|肾精亏|精亏/,
] as const;

function targetContradictionReason(
  target: string,
  prior: M03ReasoningLike,
  pathogenesisAnchors: string[],
  role: unknown,
): string | undefined {
  const coordinationTarget = /调和(?:诸药|药性|营卫|脾胃)|协调诸药|顾护(?:中焦|脾胃|胃气)|和中|和胃|护胃|引经|载药|缓和药性|制约(?:峻烈|毒性|滋腻)|防(?:止)?(?:补益药|补药|滋补药)?滋腻|醒脾防腻|防止壅滞|避免碍胃/;
  if (coordinationTarget.test(target)) return role === "佐" || role === "使" ? undefined : "coordination_role";
  const priorPathogenesis = [
    prior.overview?.primarySyndrome,
    prior.overview?.overallPathogenesis,
    prior.therapy?.overallPrinciple,
    ...(prior.pathogenesis?.chain || []).flatMap((item) => [item.pathogenesis, item.therapyDirection]),
  ].map((item) => String(item || "")).join("；");
  const targetPathogenesisGroups = PATHOGENESIS_CONCEPT_GROUPS
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => group.test(target));
  const supportedPathogenesisIndexes = new Set(
    targetPathogenesisGroups.filter(({ group }) => group.test(priorPathogenesis)).map(({ index }) => index),
  );
  const unsupportedPathogenesisGroups = targetPathogenesisGroups.filter(({ group, index }) => {
    if (group.test(priorPathogenesis)) return false;
    if (index === 0 && (supportedPathogenesisIndexes.has(4) || supportedPathogenesisIndexes.has(5))) return false;
    if (index === 1 && supportedPathogenesisIndexes.has(5)) return false;
    return true;
  });
  if (unsupportedPathogenesisGroups.length > 0) return `path_${unsupportedPathogenesisGroups.map(({ index }) => index).join("_")}`;
  if (targetPathogenesisGroups.length > 0) return undefined;
  const priorFacts = (prior.pathogenesis?.chain || [])
    .flatMap((item) => [item.patientFact, item.syndromeEvidence])
    .map((item) => String(item || ""))
    .join("；");
  const targetFactGroups = GROUNDED_FACT_GROUPS
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => group.test(target));
  const missingFactGroups = targetFactGroups.filter(({ group }) => !group.test(priorFacts));
  if (missingFactGroups.length > 0) return `fact_${missingFactGroups.map(({ index }) => index).join("_")}`;
  if (targetFactGroups.length > 0) return undefined;
  if (pathogenesisAnchors.some((anchor) => target.includes(anchor))) return undefined;
  const normalizedTarget = lockedClinicalText(target);
  const priorSupportedPhrases = [
    prior.overview?.overallPathogenesis,
    ...(prior.pathogenesis?.chain || []).flatMap((item) => [item.pathogenesis, item.syndromeEvidence, item.patientFact]),
  ].map(lockedClinicalText).filter((item) => item.length >= 4);
  if (normalizedTarget.length >= 4 && priorSupportedPhrases.some((phrase) => phrase.includes(normalizedTarget) || normalizedTarget.includes(phrase))) {
    return undefined;
  }
  const priorSyndrome = lockedClinicalText(prior.overview?.primarySyndrome);
  if (priorSyndrome && normalizedTarget && (priorSyndrome.includes(normalizedTarget) || normalizedTarget.includes(priorSyndrome))) return undefined;
  return "unrecognized";
}

function doseInGrams(dose: string): number | undefined {
  const normalized = dose.trim().match(HERB_DOSE);
  if (!normalized) return undefined;
  const amount = Number(normalized[1]);
  return /^(?:mg|毫克)$/i.test(normalized[2]) ? amount / 1000 : amount;
}

function dosePassesSafetySanityCeiling(name: string, dose: string): boolean {
  const grams = doseInGrams(dose);
  if (grams == null) return false;
  const limit = getTcmHerbDoseLimit(name);
  if (!Number.isFinite(grams) || grams <= 0 || grams > 500) return false;
  const historicalMax = limit?.max;
  // 本地逐药范围来自历史药典基线，只用于模型保守引导，不能冒充现行药典合规结论。
  // 医生工作台仅在达到明显异常的倍数级剂量时阻止结构化流转；逐味常规上限、毒性及特殊
  // 人群风险交给真实审方逐条提示并保留医生复核流程。模型原始候选仍由下方严格范围约束。
  const grossCeiling = historicalMax != null
    ? Math.min(500, Math.max(historicalMax * 4, historicalMax + 30))
    : 120;
  return grams <= grossCeiling;
}

function doseWithinConservativeModelLimit(name: string, dose: string, decoctionMethod: string): boolean {
  const grams = doseInGrams(dose);
  const limit = getTcmHerbDoseLimit(name);
  if (grams == null || limit?.min == null || limit.max == null) return false;
  const routeMatchedAlternatives = (limit.alternatives || []).filter((range) =>
    range.sourceType === "routeDose" &&
    /煎服|汤剂|另煎|另炖/.test(`${range.routeForm || ""}${range.method || ""}`) &&
    /煎|汤|剂/.test(decoctionMethod)
  );
  const governedRanges = [{ min: limit.min, max: limit.max }, ...routeMatchedAlternatives];
  return governedRanges.some((range) => grams >= range.min && grams <= range.max);
}

function herbFunctionMatchesKnowledge(name: string, claimedFunction: string, role = "", target = ""): boolean {
  const knowledgeText = herbKnowledgeFunctionText(name);
  if (/(?:美容|养颜|改善视力|减肥|抗癌|延年益寿|包治|根治)/.test(claimedFunction)) return false;
  const canonicalDisplay = getTcmHerbFunctionDisplayText(name, role, target);
  if (claimedFunction.trim() === canonicalDisplay.trim()) return true;
  if (!knowledgeText) return false;
  // M04 model output is canonicalized to this exact local knowledge text before it reaches the
  // contract. The canonical source must not be rejected merely because a textbook category uses a
  // label outside the heuristic concept groups below. Non-canonical workbench edits still require
  // semantic overlap and all downstream dose/decoction/risk checks remain active.
  if (claimedFunction.trim() === knowledgeText.trim()) return true;
  const functionConceptGroups = [
    /补(?:中|脾|肺|肾)?气|益(?:中|脾|肺|肾)?气|扶正|补中|补益|升阳|举陷|固表|托毒|生肌/,
    /养(?:心|肝)?血|补(?:心|肝)?血|益血/,
    /活血|化瘀|行瘀|和血/,
    /安神|宁心|宁神|养心|定志|镇惊|安魂|定魄/,
    /健脾|补脾|益脾|补益心脾|益心脾|健运/,
    /理气|行气|疏肝|解郁|开郁/, /清热|泻火|凉血/, /化痰|祛痰/, /利湿|渗湿|利水|祛湿/,
    /温阳|扶阳|散寒|温中|温肾/, /滋阴|养阴|育阴|生津/, /解表|祛风/, /止痛/, /止咳|平喘/,
    /消食|导滞/, /收涩|敛汗|固涩/, /止血/, /通便|泻下|攻下/,
  ];
  const claimedGroups = functionConceptGroups.filter((group) => group.test(claimedFunction));
  const highImpactGroups = [
    /清热|泻火|凉血/, /活血|化瘀|行瘀|破血/, /温阳|扶阳|回阳|散寒/, /攻下|泻下|通便/,
  ];
  const claimedHighImpact = highImpactGroups.filter((group) => group.test(claimedFunction));
  if (!claimedHighImpact.every((group) => group.test(knowledgeText))) return false;
  const riskProfile = getTcmHerbRiskProfile(name);
  if (/PURGATIVE_ATTACK|攻下|泻下药/.test(riskProfile) && !/(?:攻下|泻下|通便|清热|泻火|活血|化瘀)/.test(claimedFunction)) return false;
  if (/毒性|有毒|大毒/.test(riskProfile) && !/(?:有毒|毒性|峻烈|慎用)/.test(claimedFunction)) return false;
  return /[\u4e00-\u9fa5]{2,}/.test(claimedFunction) && claimedGroups.length > 0 && claimedGroups.some((group) => group.test(knowledgeText));
}

function crossStageReasoningIssue(
  reasoning: M04ReasoningLike,
  prior?: M03ReasoningLike | null,
  visibleContent = "",
  trustedWorkbenchEdit = false,
): string | undefined {
  void visibleContent;
  if (!prior) return undefined;
  const pairs: Array<[unknown, unknown, string]> = [
    [reasoning.overview?.primarySyndrome, prior.overview?.primarySyndrome, "primary_syndrome_drift"],
    [reasoning.overview?.overallPathogenesis, prior.overview?.overallPathogenesis, "pathogenesis_drift"],
    [reasoning.therapy?.overallPrinciple, prior.therapy?.overallPrinciple, "therapy_drift"],
  ];
  for (const [current, locked, issue] of pairs) {
    const currentText = lockedClinicalText(current);
    const lockedText = lockedClinicalText(locked);
    if (!currentText || !lockedText || currentText !== lockedText) return issue;
  }
  // Repeated Markdown summary labels are presentation-only and are rebuilt from the validated
  // structured object. Executable herb rows remain independently cross-checked below.
  const priorPathogenesis = [
    prior.overview?.overallPathogenesis,
    ...(prior.pathogenesis?.chain || []).map((item) => item.pathogenesis),
  ].map((item) => String(item || "")).join("；");
  const priorTherapy = getM03TherapyLock(prior).validationContext;
  const pathogenesisAnchors = priorPathogenesis.match(new RegExp(TCM_PATHOGENESIS_ANCHOR.source, "g")) || [];
  const priorNodes = (prior.pathogenesis?.chain || []).map((node, index) => ({
    id: typeof node.nodeId === "string" && /^P\d{1,2}$/.test(node.nodeId) ? node.nodeId : `P${index + 1}`,
    text: String(node.pathogenesis || node.syndromeEvidence || "").trim(),
  }));
  // A stable M03 always has at least one pathogenesis node. Older snapshots are re-run and signed
  // before M04, so there is no safe reason to fall back to free-text target matching here.
  const referenceContractEnabled = priorNodes.length > 0;
  for (const [candidateIndex, candidate] of (reasoning.formula?.candidates || []).entries()) {
    const therapyMatch = String(candidate.therapyMatch || "");
    if (!therapyMatchAligned(priorTherapy, therapyMatch)) {
      return `candidate_${candidateIndex}_therapy_unaligned`;
    }
    for (const [herbIndex, herb] of (candidate.herbs || []).entries()) {
      const target = String(herb.targetPathogenesis || "");
      if (referenceContractEnabled) {
        if (herb.targetKind === "pathogenesis_node") {
          const targetRef = String(herb.targetRef || "");
          const node = priorNodes.find((item) => item.id === targetRef);
          if (!node?.text) return `candidate_${candidateIndex}_herb_${herbIndex}_target_ref_invalid`;
          if (lockedClinicalText(target) !== lockedClinicalText(node.text)) return `candidate_${candidateIndex}_herb_${herbIndex}_target_ref_mismatch`;
          continue;
        }
        if (herb.targetKind === "formula_structure") {
          if (herb.targetRef !== "FORMULA_STRUCTURE") return `candidate_${candidateIndex}_herb_${herbIndex}_structure_ref_invalid`;
          if (herb.role !== "佐" && herb.role !== "使") return `candidate_${candidateIndex}_herb_${herbIndex}_structure_role_forbidden`;
          const expectedStructureTarget = formulaStructureTarget(herb.structureRole);
          if (!expectedStructureTarget) return `candidate_${candidateIndex}_herb_${herbIndex}_structure_type_invalid`;
          if (lockedClinicalText(target) !== lockedClinicalText(expectedStructureTarget)) return `candidate_${candidateIndex}_herb_${herbIndex}_structure_target_mismatch`;
          continue;
        }
        return `candidate_${candidateIndex}_herb_${herbIndex}_target_ref_missing`;
      }
      const contradiction = pathogenesisAnchors.length > 0
        ? targetContradictionReason(target, prior, pathogenesisAnchors, herb.role)
        : undefined;
      if (contradiction) {
        return `candidate_${candidateIndex}_herb_${herbIndex}_pathogenesis_unaligned_${contradiction}`;
      }
    }
    const emperorHerbs = (candidate.herbs || [])
      .map((herb, herbIndex) => ({ herb, herbIndex }))
      .filter(({ herb }) => herb.role === "君");
    if (emperorHerbs.length === 0) return `candidate_${candidateIndex}_emperor_missing`;
    if (emperorHerbs.length > 2) return `candidate_${candidateIndex}_emperor_excess`;
    const primaryTherapy = primaryPathogenesisTherapyConcepts(prior);
    const requiresDirectKnowledgeAlignment = !trustedWorkbenchEdit && (
      candidate.constructionType === "self_devised" ||
      candidate.constructionType === "single_herb" ||
      (Array.isArray(candidate.formulaNames) && candidate.formulaNames.length === 0)
    );
    for (const { herb, herbIndex } of emperorHerbs) {
      if (herb.targetKind !== "pathogenesis_node" || String(herb.targetRef || "") !== "P1") {
        return `candidate_${candidateIndex}_herb_${herbIndex}_emperor_not_primary`;
      }
      // A governed classic baseline may assign a traditional emperor role through its verified
      // formula identity. A generated/declassified composition has no such provenance, so every
      // emperor must independently demonstrate direct coverage from server-owned herb knowledge.
      if (requiresDirectKnowledgeAlignment && primaryTherapy.size > 0) {
        const knowledgeTherapy = herbTherapyConcepts(String(herb.name || ""));
        if (knowledgeTherapy.size === 0) return `candidate_${candidateIndex}_herb_${herbIndex}_emperor_knowledge_missing`;
        if (!setsIntersect(knowledgeTherapy, primaryTherapy)) {
          return `candidate_${candidateIndex}_herb_${herbIndex}_emperor_therapy_mismatch`;
        }
      }
    }
  }
  const candidate = reasoning.formula?.candidates?.[0];
  const workbenchEdited = trustedWorkbenchEdit && candidate?.constructionType === "self_devised" && candidate?.modificationStatus === "modified" && /医生编辑版/.test(String(candidate?.name || ""));
  const governedPriorNames = governedFormulaNames(prior.overview?.recommendedFormulaNames);
  const governedMode = prior.overview?.formulaSelectionMode;
  const governedContractEnabled = governedPriorNames != null &&
    ["single", "combined", "alternatives", "self_devised", "none"].includes(String(governedMode));
  if (governedContractEnabled && !workbenchEdited) {
    const candidateFormulaNames = governedFormulaNames(candidate?.formulaNames);
    if (candidateFormulaNames == null) return "formula_reference_missing";
    const candidateName = lockedClinicalText(candidate?.name);
    const declassifiedSelfDevised = candidateFormulaNames.length === 0 &&
      candidate?.constructionType === "self_devised" &&
      /^(?:本例辨证组方|辨证组方)(?:加减)?$/.test(String(candidate?.name || "").trim());
    if (declassifiedSelfDevised) return undefined;
    if (candidateFormulaNames.some((name) => !candidateName.includes(lockedClinicalText(name)))) {
      return "formula_reference_display_mismatch";
    }
    const aligned = governedMode === "alternatives"
      ? candidateFormulaNames.length === 1 && governedPriorNames.includes(candidateFormulaNames[0])
      : governedMode === "single" || governedMode === "combined"
        ? candidateFormulaNames.length === governedPriorNames.length && governedPriorNames.every((name) => candidateFormulaNames.includes(name))
        : governedMode === "self_devised" || governedMode === "none"
          ? candidateFormulaNames.length === 0
          : false;
    if (!aligned) return "formula_direction_drift";
  } else if (!workbenchEdited) return "formula_reference_contract_missing";
  return undefined;
}

function durationDays(value: string): number | undefined {
  const normalized = normalizeChineseMethodNumbers(value)
    .replaceAll("一周", "7天")
    .replaceAll("两周", "14天")
    .replaceAll("二周", "14天");
  const values = Array.from(normalized.matchAll(/(\d+)\s*(天|日|周)/g), (match) => {
    const amount = Number(match[1]);
    return match[2] === "周" ? amount * 7 : amount;
  }).filter(Number.isFinite);
  return values.length ? Math.max(...values) : undefined;
}

function followUpConsistent(course: string, followUpNode: string): boolean {
  const courseDays = durationDays(course);
  const followUpDays = durationDays(followUpNode);
  return courseDays == null || followUpDays == null || followUpDays <= courseDays + 2;
}

export function m04SemanticIssue(
  reasoning: M04ReasoningLike | null | undefined,
  visibleContent = "",
  priorReasoning?: M03ReasoningLike | null,
  isKnownHerbName?: (name: string) => boolean,
  serverOwnsDecoctionMethod = false,
  serverOwnsFollowUpNode = false,
  trustedWorkbenchEdit = false,
  auditedClinicalRisksAreAdvisory = false,
): string | undefined {
  const candidates = reasoning?.formula?.candidates;
  if (reasoning?.stage !== "prescribe") return "stage";
  const nonPharma = reasoning.nonPharma;
  if (
    !nonPharma ||
    typeof nonPharma.diet !== "string" || !nonPharma.diet.trim() ||
    typeof nonPharma.lifestyle !== "string" || !nonPharma.lifestyle.trim() ||
    typeof nonPharma.emotion !== "string" || !nonPharma.emotion.trim() ||
    !Array.isArray(nonPharma.monitoring) || nonPharma.monitoring.length === 0
  ) return "non_pharma_incomplete";
  const treatmentProjects = Array.isArray(nonPharma.tcmTreatments) ? nonPharma.tcmTreatments : [];
  const treatmentNodeIds = new Set((priorReasoning?.pathogenesis?.chain || [])
    .map((node, index) => String(node.nodeId || `P${index + 1}`)));
  const knownTreatmentCodes = new Set<string>(TCM_TREATMENT_PROJECT_CODES);
  if (treatmentProjects.length > 3) return "non_pharma_treatment_count";
  for (const [index, project] of treatmentProjects.entries()) {
    if (!knownTreatmentCodes.has(String(project.projectCode || ""))) return `non_pharma_treatment_${index}_code`;
    if (![project.targetRef, project.targetPathogenesis, project.assessmentPositioning, project.operatorRequirement]
      .every((value) => typeof value === "string" && value.trim())) return `non_pharma_treatment_${index}_incomplete`;
    if (!treatmentNodeIds.has(String(project.targetRef))) return `non_pharma_treatment_${index}_target_ref`;
    if (!Array.isArray(project.requiredChecks) || project.requiredChecks.length === 0) return `non_pharma_treatment_${index}_checks`;
    if (!["clinic_available", "referral_only"].includes(String(project.availability || ""))) return `non_pharma_treatment_${index}_availability`;
    if (!["low", "moderate", "specialist"].includes(String(project.riskLevel || ""))) return `non_pharma_treatment_${index}_risk`;
    if (!["clinician_assessment", "referral_assessment", "specialist_assessment_only"].includes(String(project.recommendationMode || ""))) return `non_pharma_treatment_${index}_mode`;
    if (project.executable !== false || project.clinicianReviewRequired !== true) return `non_pharma_treatment_${index}_execution_boundary`;
    if (project.riskLevel === "specialist" && project.recommendationMode !== "specialist_assessment_only") return `non_pharma_treatment_${index}_specialist_mode`;
  }
  const stageIssue = crossStageReasoningIssue(reasoning, priorReasoning, visibleContent, trustedWorkbenchEdit);
  if (stageIssue) return stageIssue;
  if (!Array.isArray(candidates) || candidates.length === 0) return "candidates_empty";
  if (candidates.length !== 1) return "candidate_count";
  const availableRows = visibleContent ? visibleHerbRows(visibleContent) : [];
  const visibleMethod = visibleContent ? visibleLabeledValue(visibleContent, "煎服法") : "";
  if (!serverOwnsDecoctionMethod && visibleContent && (!visibleMethod || !hasCompleteDecoctionMethod(visibleMethod))) {
    return `visible_method_incomplete_${visibleMethod ? decoctionMethodMissing(visibleMethod).join("_") : "missing"}`;
  }
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (typeof candidate.name !== "string" || !candidate.name.trim()) return `candidate_${candidateIndex}_name`;
    if (typeof candidate.therapyMatch !== "string" || !candidate.therapyMatch.trim()) return `candidate_${candidateIndex}_therapy_match`;
    if (!Array.isArray(candidate.herbs) || candidate.herbs.length === 0) return `candidate_${candidateIndex}_herbs_empty`;
    const normalizedHerbNames = candidate.herbs.map((herb) => canonicalTcmHerbIdentity(herb.name));
    if (new Set(normalizedHerbNames).size !== normalizedHerbNames.length) return `candidate_${candidateIndex}_duplicate_herb`;
    const pairConflict = !trustedWorkbenchEdit && !auditedClinicalRisksAreAdvisory
      ? findTcmHerbPairIncompatibilities(candidate.herbs.map((herb) => String(herb.name || "")))[0]
      : undefined;
    if (pairConflict) return `candidate_${candidateIndex}_high_risk_pair_incompatibility`;
    const highImpactIssue = priorReasoning && !trustedWorkbenchEdit && !auditedClinicalRisksAreAdvisory
      ? unsupportedHighImpactHerbIssue(
          candidate.herbs,
          priorReasoning,
          true,
          governedFormulaNames(candidate.formulaNames) || [],
        )
      : undefined;
    if (highImpactIssue) return `candidate_${candidateIndex}_${highImpactIssue}`;
    const doseCount = candidate.decoction?.doseCount;
    const course = candidate.decoction?.course;
    const regimenIssue = prescriptionRegimenIssue(doseCount, course);
    if (regimenIssue) return `candidate_${candidateIndex}_${regimenIssue}`;
    const validateCompleteRegimen = trustedWorkbenchEdit || (!serverOwnsDecoctionMethod && !serverOwnsFollowUpNode);
    if (!serverOwnsDecoctionMethod) {
      if (typeof candidate.decoction?.method !== "string") return `candidate_${candidateIndex}_method_incomplete_missing`;
      const methodMissing = decoctionMethodMissing(candidate.decoction.method.trim());
      if (methodMissing.length > 0) return `candidate_${candidateIndex}_method_incomplete_${methodMissing.join("_")}`;
    }
    if (typeof course !== "string" || UNSTABLE_REASONING_MARKER.test(course)) return `candidate_${candidateIndex}_course`;
    if (!serverOwnsFollowUpNode) {
      if (typeof candidate.decoction?.followUpNode !== "string" || !candidate.decoction.followUpNode.trim() || UNSTABLE_REASONING_MARKER.test(candidate.decoction.followUpNode)) return `candidate_${candidateIndex}_follow_up`;
      if (!followUpConsistent(course, candidate.decoction.followUpNode)) return `candidate_${candidateIndex}_follow_up_inconsistent`;
    }
    for (const [herbIndex, herb] of candidate.herbs.entries()) {
      if (typeof herb.name !== "string" || !herb.name.trim()) return `candidate_${candidateIndex}_herb_${herbIndex}_name`;
      if (isKnownHerbName && !isKnownHerbName(herb.name.trim())) return `candidate_${candidateIndex}_herb_${herbIndex}_unknown`;
      if (typeof herb.dose !== "string" || !normalizeComparableDose(herb.dose)) return `candidate_${candidateIndex}_herb_${herbIndex}_dose`;
      if (!dosePassesSafetySanityCeiling(herb.name.trim(), herb.dose)) return `candidate_${candidateIndex}_herb_${herbIndex}_dose_sanity_ceiling`;
      if (!trustedWorkbenchEdit && !doseWithinConservativeModelLimit(herb.name.trim(), herb.dose, String(candidate.decoction?.method || ""))) return `candidate_${candidateIndex}_herb_${herbIndex}_dose_outside_conservative_range`;
      if (typeof herb.role !== "string" || !herb.role.trim()) return `candidate_${candidateIndex}_herb_${herbIndex}_role`;
      if (typeof herb.prescriptionRole !== "string" || !herb.prescriptionRole.trim() || GENERATED_PLACEHOLDER_MARKER.test(herb.prescriptionRole.trim())) return `candidate_${candidateIndex}_herb_${herbIndex}_prescription_role`;
      if (typeof herb.targetPathogenesis !== "string" || !herb.targetPathogenesis.trim() || GENERATED_PLACEHOLDER_MARKER.test(herb.targetPathogenesis.trim())) return `candidate_${candidateIndex}_herb_${herbIndex}_target`;
      if (typeof herb.function !== "string" || !herb.function.trim()) return `candidate_${candidateIndex}_herb_${herbIndex}_function`;
      if (!herbFunctionMatchesKnowledge(herb.name.trim(), herb.function.trim(), String(herb.role || ""), String(herb.targetPathogenesis || ""))) return `candidate_${candidateIndex}_herb_${herbIndex}_function_ungrounded`;
      const declaredMethod = String(herb.decoctionRequirement || "");
      const decoctionRule = decoctionRuleForHerb(herb.name);
      if (decoctionRule?.prohibited.includes("同煎")) return `candidate_${candidateIndex}_herb_${herbIndex}_route_not_decoction`;
      if (!decoctionRuleSatisfied(herb.name, declaredMethod)) {
        return `candidate_${candidateIndex}_herb_${herbIndex}_decoction_missing_required`;
      }
      if (visibleContent) {
        const normalizedName = herb.name.replace(/\s/g, "");
        const normalizedDose = normalizeComparableDose(herb.dose);
        const rowIndex = availableRows.findIndex((row) => row.name === normalizedName && row.dose === normalizedDose);
        if (rowIndex < 0) return `candidate_${candidateIndex}_herb_${herbIndex}_visible_pair`;
        availableRows.splice(rowIndex, 1);
        // Processing/decoction display is rebuilt from the already validated structured herb row.
      }
    }
    // Keep herb-level and special-decoction errors first for stable, actionable UI messaging, then
    // apply the whole regimen contract before the candidate can leave M04, re-audit, or HIS.
    if (validateCompleteRegimen) {
      const completeRegimenIssue = prescriptionRegimenContractIssue(candidate.decoction);
      if (completeRegimenIssue) return `candidate_${candidateIndex}_${completeRegimenIssue}`;
    }
  }
  if (visibleContent && availableRows.length > 0) return "visible_extra_herb_rows";
  const prescribedHerbs = new Set(candidates.flatMap((candidate) => candidate.herbs || []).map((herb) => String(herb.name || "").replace(/\s/g, "")));
  for (const [modificationIndex, modification] of (reasoning.formula?.modifications || []).entries()) {
    if (![modification.trigger, modification.targetPathogenesis, modification.action, modification.reason]
      .every((value) => typeof value === "string" && value.trim())) {
      return `modification_${modificationIndex}_incomplete`;
    }
    if (typeof modification.doseOrHandling === "string" && modification.doseOrHandling.trim()) {
      return `modification_${modificationIndex}_unaudited_dose`;
    }
    const fields = [modification.trigger, modification.targetPathogenesis, modification.action, modification.doseOrHandling, modification.reason, modification.riskNote]
      .filter((value): value is string => typeof value === "string")
      .join("；")
      .replace(/\s/g, "");
    if (/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)(?:mg|g|毫克|克)(?![\/／](?:L|升))/i.test(fields)) {
      return `modification_${modificationIndex}_unaudited_dose`;
    }
    const action = typeof modification.action === "string" ? modification.action.trim().replace(/\s/g, "") : "";
    if (!/^(?:加|减|调整)/.test(action)) return `modification_${modificationIndex}_action`;
    const removal = action.match(/(?:^|时|则|可|建议)(?:减去|减量|减|去掉|去|删除|停用)([\u4e00-\u9fa5]{1,8})/);
    if (removal && !prescribedHerbs.has(removal[1])) return `modification_${modificationIndex}_missing_herb`;
    const addition = action.match(/(?:^|时|则|可|建议)(?:加入|加用|新增|加)([\u4e00-\u9fa5]{1,8})/);
    if (addition && isKnownHerbName && !isKnownHerbName(addition[1])) return `modification_${modificationIndex}_unknown_herb`;
    if (addition && priorReasoning) {
      const highImpactIssue = unsupportedHighImpactHerbIssue([{
        name: addition[1],
        function: [modification.reason, modification.targetPathogenesis]
          .filter((value): value is string => typeof value === "string")
          .join("；"),
      }], priorReasoning);
      if (highImpactIssue) return `modification_${modificationIndex}_${highImpactIssue}`;
    }
  }
  return undefined;
}

export function isCompleteM04Reasoning(
  reasoning: M04ReasoningLike | null | undefined,
  visibleContent = "",
  priorReasoning?: M03ReasoningLike | null,
  isKnownHerbName?: (name: string) => boolean,
): boolean {
  return m04SemanticIssue(reasoning, visibleContent, priorReasoning, isKnownHerbName) == null;
}
