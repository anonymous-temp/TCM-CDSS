import { decoctionRuleForHerb, decoctionRuleSatisfied } from "./herb-decoction-rules";
import { PULSE_FORCE_PATTERN_SOURCE, PULSE_QUALITY_PATTERN_SOURCE } from "./clinical-state";
import tcmKnowledgeIdentitySource from "../data/tcm-knowledge.json";
import { findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit, getTcmHerbFunctionCategories, getTcmHerbFunctionDisplayText, getTcmHerbFunctionText, getTcmHerbGenerationSafetyProfile, getTcmHerbGovernedHighImpactConcepts, getTcmHerbRiskProfile, isKnownTcmHerbName, isClinicianDoseHerb } from "./tcm-knowledge";
import { formulaStructureTarget } from "./herb-target-contract";
import { prescriptionRegimenContractIssue, prescriptionRegimenIssue } from "./prescription-regimen-contract";
import { executableFormulaCompilationReferences } from "./tcm-formula-provenance";
import { TCM_TREATMENT_PROJECT_CODES, tcmTreatmentProjectIsPointFree } from "./tcm-treatment-projects";
import { getM03TherapyLock, isExecutableM03TherapyText } from "./m03-therapy-lock";
import { isActionableFollowupSafetyNet } from "./followup-safety-net";
import { westernDifferentialIdentity } from "./clinical-terminology";
import { governedTcmLocationsInText, governedTreatmentPrinciplesInText, tcmDiagnosticDependencyContexts, treatmentPrinciplesInText, westernLabelContainsTcmSyndrome } from "./clinical-governance-tables";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { firstFormulaContraindicationIssue } from "./tcm-formula-contraindications";
import { missedLockableFormulaCandidates, namedFormulaPositiveSufficiencyIssue } from "./tcm-formula-indications";

type M03ReasoningLike = {
  stage?: unknown;
  overview?: {
    tcmDiseaseName?: unknown;
    primarySyndrome?: unknown;
    primarySyndromeResolution?: unknown;
    primarySyndromeBasis?: unknown;
    primarySyndromeResolutionReason?: unknown;
    tcmDiseaseRationale?: unknown;
    tcmDiagnosticRationale?: unknown;
    tcmDifferentials?: Array<{ syndrome?: unknown; reason?: unknown; distinguishingPoints?: unknown; nextCheck?: unknown }>;
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
      clinicalRationale?: unknown;
      evidence?: { evidenceLevel?: unknown; source?: unknown };
    };
    differentials?: Array<{ name?: unknown; reason?: unknown; distinguishingPoints?: unknown; nextCheck?: unknown }>;
  };
  pathogenesis?: {
    summary?: unknown;
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
    uncertainties?: Array<{ item?: unknown; reason?: unknown; affects?: unknown }>;
  };
  therapy?: {
    overallPrinciple?: unknown;
    overallMethod?: unknown;
    subTherapies?: Array<{ therapy?: unknown; targetPathogenesis?: unknown; priority?: unknown }>;
  };
  management?: { followupSafetyNet?: unknown } | null;
  formula?: unknown;
};

const UNSTABLE_REASONING_MARKER = /(?:待辨|待定|待明)|(?:信息|资料|证据)(?:仍然?|尚)?(?:不足|不充分|欠充分|不全|缺失)|(?:尚|仍|现有)?不足以(?:支持|证实|形成|判断)|(?:尚待|有待|仍待|尚须|仍需|尚未|尚在|仍在)(?:进一步)?(?:验证|商榷|论证|决定|讨论)|(?:暂|尚|仍)?(?:不|未|无)(?:能|可|足以)?(?:形成|明确|明(?!显)|定|定证|定论|确定|判断|提及|充分|清楚|清|详|辨明)|(?:有待|尚待|仍待|待|需|需要)(?:补充|进一步|继续|重新)?(?:确认|明确|补充|核实|核验|证实|验证|商榷|论证|决定|讨论|辨证|判断|生成|评估|复核|完善|厘清|查|定|鉴别|甄别)|不生成|无法(?:形成|判断|定证|明确)|不能(?:形成|判断|定证)|难下定论|尚难|存疑|未知|不详/;
const GENERATED_PLACEHOLDER_MARKER = /^(?:由服务端(?:知识库)?生成|待生成|待补充|待确认)$/;
const CUSTOMER_DISPLAY_PLACEHOLDER = /(?:证据不足|待检索|待核验|检索失败|未配置|内部证据缺口|EVIDENCE_GAP)|^(?:暂未|尚未|仍未|未)(?:生成|形成|明确|获得|提供|记录|提及|完成)|^(?:待|需|需要)(?:生成|确认|补充|核实|核验|复核|完善|询问|评估)(?:相关|具体|本项|信息|资料|内容)?[。.]?$/;
const GENERIC_CORE_LABELS = /(?:当前|本例|该例|总体|整体|主要|核心|初步|考虑|中医|辨证|诊断|结论|证候|证型|病机|治疗|治法|治则|方向|患者|事实|症状|表现|证据|依据|支持|结果|内容|情况|意见|方案|具体|进一步|重新|仍然?|尚|需|需要|因|为|是|暂)/g;
// 病机动词存在**动宾与主谓两种语序**，词表必须两边都收，否则同一个病机换个写法就锚不住。
// 实测（月经先期-血热，观测字段 pathogenesisUnanchored）：P2「热扰心神，热盛伤津」整条落空——
// 表里有主谓序的「神扰」「津伤」，却没有动宾序的「扰心神」「伤津」，于是 chain_incomplete 三连塌、
// M03 归零。补齐的是两个族而不是两个词：扰动族（扰心/扰神/扰动/内扰）与津伤族
//（伤津/伤阴/伤液/耗津/耗液/耗阴/耗气/灼津/灼阴/劫阴/化燥）。
// 本表只判「病机链节点是否落在辨证学措辞上」，不是安全门；扩它不放宽任何剂量或风险边界。
const TCM_PATHOGENESIS_ANCHOR = /(?:气虚|气滞|气逆|气陷|气脱|气闭|气机不畅|血虚|血瘀|瘀血|血热|血寒|血脱|血燥|血不养|心血不足|肝血不足|阴虚|阳虚|心阴虚|肝阴虚|肺阴虚|肾阴虚|心阳虚|脾阳虚|肾阳虚|脾气虚|心气虚|肺气虚|肾气虚|阴盛|阳亢|阴阳两虚|阴不敛阳|阳不入阴|津亏|液亏|津伤|津液不足|精亏|神扰|神失所养|心神不宁|心火|肝郁|肝气郁结|肝火|肝阳|脾虚|肺虚|肾虚|脾湿|痰湿|痰热|痰浊|湿热|寒湿|风寒|风热|风湿|燥热|实热|虚热|虚寒|实寒|郁火|食积|水饮|饮停|水湿|热毒|寒凝|湿困|湿阻|湿滞|困阻|困遏|阻遏|蒙蔽清窍|清窍被蒙|清阳不升|清窍不利|经络不通|络阻|营卫不和|营卫失调|卫外不固|脾不统血|肾不纳气|肺失宣降|心肾不交|少阳枢机不利|脏腑失和|升降失常|气血失和|不荣则痛|不通则痛|化火|上扰|内阻|阻滞|亏虚|失养|失和|失司|(?:胃|肺|胆|肾|脾|大肠|小肠|膀胱|三焦)[火热]|冲任|胞宫|血海|天癸|带脉|督脉|任脉|精室|迫血|动血|血不循经|血溢|伏热|邪热|热邪|火邪|热灼|燔灼|热入营血|热入血分|上攻|上炎|上冲|扰心|扰神|扰动|内扰|伤津|伤阴|伤液|耗津|耗液|耗阴|耗气|灼津|灼阴|劫阴|化燥|风邪|寒邪|暑邪|湿邪|燥邪|疫毒|秽浊|下陷|升举无力|统摄无权|固摄无力|失濡|失煦|失润|失充|失荣)/;
const TCM_THERAPY_ANCHOR = /(?:益气|补气|养血|活血|化瘀|滋阴|育阴|养阴|温阳|扶阳|清热|泻火|疏肝|解郁|理气|行气|降逆|化痰|祛痰|燥湿|利湿|祛湿|健脾|和胃|温中|散寒|通络|止痛|宁心|安神|镇惊|平肝|潜阳|熄风|息风|凉血|解毒|消食|导滞|攻下|通腑|润肠|固涩|敛汗|止血|止咳|平喘|宣肺|肃肺|开窍|醒神|扶正|培本|调和营卫|解表|和解|利水|通淋|升阳|补肾|温肾|健运|温经|散结|软坚|养心|清心|清肝|清肺|清胃|清胆|温补|补益|调经|回阳救逆|透邪外达|升清降浊|调畅气机|交通心肾|固冲|固经|固摄|摄血|止带|止崩|润燥|润肺|濡润|清燥|生津|增液)/;
const TCM_DISEASE_LABEL = /(?:眩晕病?|不寐|胸痹|心悸|头痛|胃脘痛|腹痛|咳嗽|喘证|泄泻|便秘|郁证|汗证|痹证|痿证|水肿|淋证|消渴|癃闭|胁痛|黄疸|中风|痫病|痴呆|颤证|耳鸣|鼻鼽)(?!待)/;
const CLINICAL_REASONING_CONNECTOR = /(?:提示|支持|符合|更符合|结合|考虑|因此|尚不支持|不足以|倾向于|病程|鉴别|排除)/;
// The TCM rationale is a derivation from 四诊 to 证候; its natural connectors extend beyond the
// Western set. Requiring only the 13 Western connectors rejected textbook-valid rationales such as
// "四诊合参…辨为心脾两虚证" / "综合舌脉…病机为脾虚失运" — which then forced repair loops and, on
// retry, degraded a correct 归脾汤 case to self_devised. Anti-restatement stays enforced by the
// downstream fact-reference + novel-concept + not-a-copy checks (tcm_diagnostic_rationale_restatement),
// so widening this pre-filter cannot let a pure syndrome-name restatement through.
const TCM_REASONING_CONNECTOR = /(?:提示|支持|符合|更符合|结合|考虑|因此|尚不支持|不足以|倾向于|病程|鉴别|排除|辨为|辨证|辨属|合参|归纳|综合|可见|均为|病机|所致|导致|引起|系因|乃)/;
const DIAGNOSTIC_INFERENCE_CONCEPTS = [
  "病程", "急性", "慢性", "时间窗", "严重度", "功能受损", "危险因素", "诊断标准", "鉴别",
  "排除", "不支持", "不足以", "机制", "病因", "病位", "病性", "证候", "气血", "阴阳", "脏腑",
  "失养", "失司", "失和", "阻滞", "痹阻", "不通", "郁结", "亏虚", "阴液", "虚热", "痰湿", "湿热", "血瘀", "气滞",
] as const;
const WESTERN_EXCLUSION_REASONING = /(?:但|尚不支持|不足以|不支持|排除|鉴别|未见|否认|缺乏|尚未|有待|仍需|需[^。；;\n]{0,12}(?:核实|检查|确认))/;
export const NATURE_MECHANISM_PHRASE = /(?:失和|失降|失运|失司|不利|不畅|不通|受阻|上逆|不降|不纳|失宣|失肃)/;
const CLINICAL_NEGATION = /(?:绝非|绝无|毫无|全无|断非|尚无|暂无|没有|阴性|排除|已除外|需除外|未排除|待排除|否认|否定|并非|并无|不认为是|不属|不属于|不存在|不能证实|未能证实|未获证实|未查见|未呈现|未见|未发现|未提示|未观察到|未显示|未证实|尚未证实|未检出|未检测到|未表明|未达到|未成立|未采用|未使用|未选择|未予|未考虑|未支持|未获支持|未得到支持|(?:尚|仍|现有)?不足以(?:支持|证实|形成|判断)|(?:依据|证据)(?:不足|薄弱)[^，,。；;]{0,12}(?:支持|证实)|缺乏[^，,。；;]{0,12}(?:依据|证据|支持)|缺少[^，,。；;]{0,12}(?:依据|证据|支持)|难以|难于|不支持|不符合|不考虑|不宜|不应|不建议|不推荐|不适用|不作为|不选择|不选用|不采取|不施用|不赞成|不认同|反对|非首选|拒用|禁用|禁止|禁忌|忌用|勿用|暂缓(?:治疗|处置|用药)|暂停(?:治疗|处置|用药)|避免|慎用|不可|不予|无需|不需|不主张|暂不|不成立|不采用|不使用|不用|停止(?:治疗|处置|用药)|停用|停服|撤除)/;

export function isAmbiguousM03WesternPrimaryLabel(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return /[\/／、?？]|(?:或|二者之一|待鉴别)/.test(value) ||
    /(?:待查|待排|疑似|可能性?)[：:][^。；\n]{1,80}|[：:(（][^。；\n]{1,80}(?:可能|倾向|待排|疑似)[)）]?$/.test(value);
}

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

/** One prescription identity, with T9 as the only alias/preparation resolver. */
export function canonicalTcmHerbIdentity(value: unknown): string {
  const token = normalizedTcmHerbIdentityToken(value);
  if (!token) return "";
  const governedIdentity = resolveGovernedTcmHerbIdentity(token);
  if (governedIdentity.status === "ambiguous") return token;
  if (governedIdentity.canonicalName) {
    const canonicalToken = normalizedTcmHerbIdentityToken(governedIdentity.canonicalName);
    return tcmHerbCanonicalNameByToken.get(canonicalToken) || governedIdentity.canonicalName;
  }
  const direct = tcmHerbCanonicalNameByToken.get(token);
  if (direct) return direct;
  return token.toLowerCase();
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
        // 固化否定式症状名：无汗/无痰/无力/无神/无苔/无华 等是四诊里的**症状名本身**，
        // 「无」是构词成分而不是作用于后续列举的否定运算符。把它们当运算符会让否定作用域
        // 泄漏到下一个从句——实测「恶寒发热，无汗，头身疼痛明显」中「头身疼痛」被重写成
        // 「无头身疼痛」，于是针对该痛证加的川芎被判方向未成立、整方作废；把「无汗」挪到
        // 句尾同一份病历就能通过，这种语序敏感本身就证明是缺陷而非策略。
        // 只豁免**整个从句就是该症状名**的情形；「无汗出而喘」「无恶寒」等仍按否定处理。
        const FIXED_NEGATIVE_SYMPTOM = /^(?:无汗|无痰|无力|无神|无苔|无华|无嗅觉|无味觉)$/;
        const explicitNegation = FIXED_NEGATIVE_SYMPTOM.test(clause)
          ? undefined
          : clause.match(/^(?:(?:当前|目前|现阶段|现有|本例|患者|临床|病历已记录)?)(绝无|全无|尚无|暂无|没有|否认|未见|未出现|不伴|并无|无)/)?.[1];
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
  // hedge 的**主语**必然落在截断点之前，被 confirmedClinicalPrefix 留在 confirmed 部分里：
  // 「风邪袭肺证，肺气虚尚待进一步辨证」截断后 prefix = 「风邪袭肺证，肺气虚」，而「肺气虚」
  // 正是那个待辨证的对象，不是已确立结论。把它计入 multiAnchor，就会让「一个已确立证 + 一个
  // 待定证」凑够两个锚，整串被判成稳定结论、标签不再截断到「风邪袭肺证」。
  // 因此发生截断时（markerIndex >= 0）丢弃 prefix 的最后一个从句；未发生截断时不受影响。
  const prefixClauses = clinicalClauses(prefix);
  const concludedClauses = prefixClauses.length > 1 ? prefixClauses.slice(0, -1) : prefixClauses;
  const affirmedAnchors = concludedClauses
    .filter((clause) => !isNegatedClinicalClause(clause))
    // 对冲式二选一从句（血热或肝火）的锚是备选不是结论，不计入 multiAnchor。
    .filter((clause) => !isHedgedAlternativeClause(clause, TCM_PATHOGENESIS_ANCHOR))
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

/**
 * 对冲式二选一从句：「可能为血热或肝火」在一个从句里命中两个不同的病机锚，但它是**备选枚举**
 * 不是结论——两个锚互为替代，谁都没被确立。原逻辑把两个锚都算成肯定结论，multiAnchor 判定
 * 反而给它加分（实测该句整体判为"已锚定"）。从句含「或」且命中 ≥2 个不同锚即视为对冲。
 * 病因层的「情志不遂或饮食不节」不受影响（那些词本来就不是病机锚）。
 */
function isHedgedAlternativeClause(clause: string, anchor: RegExp): boolean {
  if (!clause.includes("或")) return false;
  const hits = new Set(clause.match(new RegExp(anchor.source, "g")) || []);
  return hits.size >= 2;
}

// ─── 构词法锚定（枚举短语表的补充通道）──────────────────────────────────────────
//
// 上面两张锚点表是逐例累积的**固定短语枚举**，而中医病机与治法是**组合式构词**：
//   病机 = [病理要素] × [病机动作]   食滞胃脘 = 食 × 滞；痰气交阻 = 痰/气 × 阻
//   治法 = [治疗动作] × [作用对象]   清利肝胆湿热 = 清利 × 肝胆湿热；化湿泄浊 = 化 × 湿
// 枚举永远追不上组合：一次 40 组教科书写法的覆盖体检里，纯枚举漏掉 12 组，且漏的都是
// 已收词的另一种搭配（收了「食积」漏「食滞」、收了「清肝」漏「清利肝胆」、收了「气陷」
// 漏「中气下陷」）。逐词补下去，1 万份病历还会有几百个同样的漏。
//
// 因此在枚举通道之后追加构词通道：要素词与动作词各命中至少一个才算锚定。
// 两条边界保证它不会让空泛叙述蒙混：
//   · **必须同时**命中要素与动作——「患者近日不适」「情况较前变化」两侧皆空，照旧拒；
//   · 否定、对冲式二选一、占位语判定全部前置复用，与枚举通道同一口径。
// 枚举通道保持原样先行匹配，既有行为一字不变；构词通道只增加覆盖，不改变任何已有判定。
const TCM_PATHOGENESIS_ELEMENT = /(?:气|血|阴|阳|津|液|精|髓|痰|饮|湿|浊|瘀|热|火|寒|风|燥|暑|毒|食|水|营|卫|脏|腑|经|络|窍|神|心|肝|脾|肺|肾|胃|胆|肠|膀胱|三焦|胞宫|冲任)/;
const TCM_PATHOGENESIS_ACTION = /(?:虚|实|滞|逆|陷|脱|闭|结|阻|痹|困|蕴|蒙|扰|伤|耗|灼|亏|损|瘀|凝|停|泛|溢|越|亢|盛|衰|郁|滥|壅|遏|袭|犯|侵|乘|侮|夹|挟|交阻|互结|失职|失司|失和|失养|失濡|失煦|失润|失常|不固|不足|不利|不畅|不通|不荣|不纳|不摄|不升|不降|乏源|无权|无力|外泄|上炎|上攻|上冲|下注|下陷|内生|内蕴|内扰|妄行)/;
const TCM_THERAPY_ACTION = /(?:补|益|养|滋|填|温|清|泻|凉|散|解|疏|理|行|降|升|化|祛|利|渗|燥|通|开|宣|肃|敛|固|涩|摄|止|消|导|软|散结|活|破|镇|安|宁|潜|平|息|熄|和|调|扶|培|回|纳|引|透)/;
const TCM_THERAPY_OBJECT = /(?:气|血|阴|阳|津|液|精|髓|痰|饮|湿|浊|瘀|热|火|寒|风|燥|暑|毒|食|水|营|卫|表|里|中|神|窍|心|肝|脾|肺|肾|胃|胆|肠|膀胱|三焦|冲任|胞宫|经|络|筋|骨|痛|喘|咳|呕|汗|带|崩|经)/;

function hasCompositionalAnchor(clause: string, element: RegExp, action: RegExp): boolean {
  return element.test(clause) && action.test(clause);
}

function hasPathogenesisAnchor(value: unknown): boolean {
  if (isUnstableM03CoreText(value) || typeof value !== "string") return false;
  return clinicalClauses(value).some((clause) => {
    if (isNegatedClinicalClause(clause)) return false;
    if (isHedgedAlternativeClause(clause, TCM_PATHOGENESIS_ANCHOR)) return false;
    if (hasAffirmedClinicalTerm(clause, TCM_PATHOGENESIS_ANCHOR)) return true;
    return hasCompositionalAnchor(clause, TCM_PATHOGENESIS_ELEMENT, TCM_PATHOGENESIS_ACTION);
  });
}

function hasTherapyAnchor(value: unknown): boolean {
  if (isUnstableM03CoreText(value) || !isExecutableM03TherapyText(value)) return false;
  return clinicalClauses(value).some((clause) => {
    if (isNegatedClinicalClause(clause)) return false;
    if (isHedgedAlternativeClause(clause, TCM_THERAPY_ANCHOR)) return false;
    if (hasAffirmedClinicalTerm(clause, TCM_THERAPY_ANCHOR)) return true;
    return hasCompositionalAnchor(clause, TCM_THERAPY_ACTION, TCM_THERAPY_OBJECT);
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
// Clinical records commonly use cough as a verb (干咳、咳痰、咳几声) instead of the noun 咳嗽.
// Keep these surface forms in one grounding class so a semantically faithful reordered phrase can
// be rebound to the exact chart sentence instead of being dropped and emptying the whole M03 chain.
const COUGH_FACT_PATTERN = /咳嗽|干咳|咳痰|咳(?:了)?(?:一|两|几|三|四|五|\d+)\s*(?:口|声)|咳(?:出|着|起来|个不停)/;
const FEVER_CONCEPT_SURFACE = /发热|高热|发烧/;
const CHILLS_CONCEPT_SURFACE = /寒战|寒颤|战栗/;
const ABDOMINAL_PAIN_CONCEPT_SURFACE = /腹痛|腹隐痛|胃脘痛|胃脘部隐痛|胃痛|(?:肚子|小肚子|腹部|小腹|下腹|上腹|胃脘|胃部|肚脐周围)(?:(?!不|没|无|未)[^.。；;\n]){0,8}(?:疼|痛)/;

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
  /胸痛|心前区痛|胸(?:骨后|前|部)[^。；，,]{0,12}(?:疼痛|痛)/, /胸闷/, /心悸|心慌|心跳不适/, /晕厥/,
  /意识(?:丧失|异常|障碍)|神志(?:不清|改变|异常)|神志不省|昏迷|嗜睡|反应迟钝/,
  /抽搐|惊厥|癫痫发作/, /咯血|痰中带血/, /便血|黑便|柏油样便/, /呕血|吐血/,
  /黄疸|皮肤黄染|巩膜黄染/, /瘫痪|偏瘫|单瘫|偏侧无力/,
  /失语|言语不清|构音障碍/, /紫绀|发绀|口唇青紫/, /颈项强直|颈抵抗/,
  /头痛/, /头晕|眩晕/, /视物模糊/, FEVER_FACT_PATTERN, CHILLS_FACT_PATTERN, COUGH_FACT_PATTERN, /气促/, /呼吸困难/,
  ABDOMINAL_PAIN_FACT_PATTERN, /恶心/, /呕吐/, /失眠|不寐|寐差|难以入睡|不易入睡|入睡(?:困难|时间延长|慢)|睡眠(?:逐渐|明显)?(?:不佳|欠佳|较差|变差|差)|睡不好|醒后(?:难以|不易|无法)?再(?:入)?睡|再入睡困难|(?:(?:躺|上床|入睡|睡觉)[^。；;\n]{0,18})?(?:要|得|需|花)[^。；;\n]{0,10}(?:小时|分钟)[^。；;\n]{0,8}才(?:能)?睡着/, /早醒/, /多梦/, /乏力|疲乏|疲倦|疲惫|疲劳|困倦|倦怠|神疲|(?:白天|日间|身体|人)?(?:有点|很|较|明显|总觉得)累|(?:总|容易)累/, /健忘|记忆力(?:下降|减退)/, /食欲不振|食欲欠佳|食欲较差|胃口差|纳差|食少|纳少|食欲/, /盗汗|夜(?:里|间)(?:总|反复|经常)?(?:出汗|汗出)|睡(?:着|眠)(?:后|时)(?:总|反复|经常)?(?:出汗|汗出)/, /自汗/, /潮热/, /口苦/, /口渴|口干|咽干/, /便秘/, /腹泻/, /便溏|溏便|大便(?:溏薄|稀溏|较稀|性状|情况|不调|时干时稀)/,
  /打鼾|鼾声/, /呼吸暂停/, /日间嗜睡/, /焦虑/, /烦躁/, /情绪低落|抑郁/, /耳鸣/, /耳聋/, /腰膝酸软|腰酸|膝软/, /畏寒|怕冷/, /肢冷|手足冷/, /夜尿|小便频数/,
  /舌(?:质)?(?:淡|红|绛|紫|暗|胖|瘦|嫩|老|裂|齿痕|边红|尖红)|苔(?:薄|厚|白|黄|腻|燥|润|剥|少|无)/,
  new RegExp(`脉(?:${PULSE_QUALITY_PATTERN_SOURCE}){1,4}(?:${PULSE_FORCE_PATTERN_SOURCE})?`),
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
    // 比较级/程度副词不携带临床内容，两侧对称剥除：病历写「经量较前明显增多」，模型引用成
    // 「经量增多」是**同一个事实**的合理压缩，不是编造——实测这一类让唯一的妇科病例反复
    // patient_fact_ungrounded_*_literal（长枚举句里几乎必然发生副词重组）。
    // 否定词一律不碰（polarity 检查在前，剥副词不可能翻转极性）；「更」带前瞻限定，
    // 避免伤及「更年期」这类实义词。
    // 少许 是弱化量词，剥除后事实方向不变；大量/骤增 等告警性量词刻意**不**剥——
    // 病历写少许、模型写大量时必须仍然接地失败。
    .replace(/(?:较前|较上次|明显|显著|略有|稍有|少许|进一步|依然|仍然)/g, "")
    .replace(/更(?=[多少甚重差好轻])/g, "")
    .replace(/(?:逐渐|近期|近来|目前|当前|本次|长期|反复)/g, "");
}

function normalizedPolarityLiteral(value: string): string {
  return value
    .normalize("NFKC")
    .replace(
      /^(?:(?:当前|目前|现阶段|现有|本例|患者|病人|临床|明确|病历已记录|主诉|自诉|问诊补充)\s*)?(?:绝无|全无|尚无|暂无|没有|否认|未见|未出现|不伴|并无|无|非)?(?:任何|相关|上述|该|此类|明显)?/,
      "",
    )
    .replace(/^(?:伴有|伴|出现|有|见|症见|表现为)/, "")
    .split(/(?:提示|支持|反映|说明|考虑|符合|可见于|为.+依据)/)[0]
    .replace(/(?:明确|本次|目前|当前|已经|现)/g, "")
    .replace(/[（）()【】\[\]：:；;，,。.!！?？、\s]+/g, "");
}

function genericPolarityConflictTerm(value: string, clinicalContext: string): string | undefined {
  if (!value.trim() || !clinicalContext.trim()) return undefined;
  const affirmedRecordLiterals = recordClauses(clinicalContext)
    .filter((clause) => !isNegatedClinicalClause(clause))
    .map(normalizedPolarityLiteral)
    .filter((literal) => literal.length >= 2);
  const negatedRecordLiterals = recordClauses(clinicalContext)
    .filter(isNegatedClinicalClause)
    .map(normalizedPolarityLiteral)
    .filter((literal) => literal.length >= 2);

  for (const clause of clinicalClauses(value)) {
    if (isNegatedClinicalClause(clause)) continue;
    const literal = normalizedPolarityLiteral(clause);
    if (
      literal.length < 2 ||
      /^(?:异常|正常|不适|症状|表现|阳性|疼痛|病史|体征)$/.test(literal)
    ) continue;
    const negated = negatedRecordLiterals.find((recordLiteral) => recordLiteral.includes(literal));
    if (!negated) continue;
    // “头痛2个月；否认突发最剧烈头痛”这类记录同时有一般症状阳性和危险亚型阴性。
    // 只要病历另有同一逐字事实的阳性落点，就不把它误判成极性冲突。
    if (affirmedRecordLiterals.some((recordLiteral) => recordLiteral.includes(literal))) continue;
    return literal;
  }
  return undefined;
}

function isGenericPatientEvidencePolarityAligned(value: string, clinicalContext: string): boolean {
  return !genericPolarityConflictTerm(value, clinicalContext);
}

function hasLiteralFactSupport(value: string, clinicalContext: string, requireSameClause: boolean): boolean {
  const contexts = requireSameClause ? clinicalContext.split(/[。；;\n]+/) : [clinicalContext];
  const factClauses = clinicalClauses(value)
    .map(normalizedFactSupportText)
    .filter((item) => item.length >= 2);
  if (factClauses.length === 0) return false;
  return factClauses.every((factText) => contexts.some((clause) => normalizedFactSupportText(clause).includes(factText)));
}

function unrecognizedFactResidue(
  value: string,
  groups: readonly RegExp[],
  concepts: readonly GroundedFactConcept[],
): string {
  let residue = value;
  for (const pattern of groups) {
    residue = residue.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "");
  }
  for (const concept of concepts) {
    residue = residue.replace(
      new RegExp(concept.surface.source, concept.surface.flags.includes("g") ? concept.surface.flags : `${concept.surface.flags}g`),
      "",
    );
  }
  return normalizedFactSupportText(
    residue.replace(/(?:患者|本次|当前|目前|症见|表现为|伴有|伴|并有|以及|及|和|与|、)/g, ""),
  );
}

function ungroundedPatientFactReason(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  if (!clinicalContext) return undefined;
  for (const [chainIndex, item] of (reasoning.pathogenesis?.chain || []).entries()) {
    for (const [factIndex, fact] of [item.patientFact, item.syndromeEvidence].entries()) {
      if (typeof fact !== "string") continue;
      const matchedGroups = GROUNDED_FACT_GROUPS.filter((pattern) => pattern.test(fact));
      const matchedConcepts = groundedFactConceptsForText(fact);
      const genericConflict = genericPolarityConflictTerm(fact, clinicalContext);
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
      if (groupMismatch || conceptMismatch || genericConflict) return `patient_fact_ungrounded_${chainIndex}_${factIndex}_polarity`;
      // Validate every sub-clause, including syndromeEvidence. A known symptom in one part of the
      // field cannot grant source authority to an unrelated invented symptom in the same string.
      if (
        !hasLiteralFactSupport(fact, clinicalContext, false) &&
        (
          matchedGroups.length === 0 && matchedConcepts.length === 0 ||
          unrecognizedFactResidue(fact, matchedGroups, matchedConcepts).length >= 2
        )
      ) {
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
      const genericConflict = genericPolarityConflictTerm(fact, clinicalContext);
      if (genericConflict) {
        return `病机链 ${nodeId} 的 ${field} 把病历已明确否认的“${genericConflict}”写成了阳性依据。请删除该词，或替换为病历中确有阳性记录且极性一致的患者事实。`;
      }
    }
  }
  return undefined;
}

export function patientFactSourceQuote(value: string, clinicalContext: string): string | undefined {
  if (!isGenericPatientEvidencePolarityAligned(value, clinicalContext)) return undefined;
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

const M03_REGIMEN_INSTRUCTION =
  /(?:每日|每天|一日|日服)\s*(?:\d+|[一二两三四五六七八九十半]+)\s*剂|(?:连服\s*)?(?:\d+|[一二两三四五六七八九十半]+)\s*剂(?:后|内|分|，|,|。|；|;|$)|水煎(?:服)?|煎煮(?:\d+|[一二两三四五六七八九十]+)?次|早晚分服|分[一二两三四五六七八九十2]\s*次服/;

export function m03DoseLevelInstructionFindings(
  value: unknown,
  key = "",
  path = "$",
): Array<{ path: string; kind: "herb_dose" | "regimen" }> {
  if (key === "patientFact" || key === "source" || key === "contractSignature") return [];
  if (typeof value === "string") {
    const findings: Array<{ path: string; kind: "herb_dose" | "regimen" }> = [];
    if (containsKnownHerbDose(value)) findings.push({ path, kind: "herb_dose" });
    if (M03_REGIMEN_INSTRUCTION.test(value.normalize("NFKC"))) findings.push({ path, kind: "regimen" });
    return findings;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      m03DoseLevelInstructionFindings(item, key, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, child]) =>
    m03DoseLevelInstructionFindings(child, childKey, `${path}.${childKey}`));
}

function m03ContainsDoseLevelInstruction(value: unknown): boolean {
  return m03DoseLevelInstructionFindings(value).length > 0;
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

const TCM_ONLY_WESTERN_SUPPORT = new RegExp(
  `(?:舌(?:象|质|体|红|淡|紫|暗)|苔(?:薄|厚|白|黄|腻|燥|润)|脉象|脉(?:${PULSE_QUALITY_PATTERN_SOURCE})|证候|证型|病机|治则|治法)`,
);
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
    const contextAffirms = concept
      ? contextAffirmsGroundedConcept(clinicalContext, concept)
      : contextAffirmsTerm(clinicalContext, pattern);
    const contextNegates = concept
      ? contextNegatesGroundedConcept(clinicalContext, concept)
      : contextNegatesTerm(clinicalContext, pattern);
    // A chart can affirm a general symptom while explicitly denying a dangerous subtype, e.g.
    // “头痛2个月；否认突发最剧烈头痛”. That is not a polarity contradiction: the first clause
    // remains valid support and the second is rule-out context. Reject only when the record has
    // negated the concept without any affirmed occurrence.
    return contextNegates && !contextAffirms;
  });
  if (groupConflict || !isGenericPatientEvidencePolarityAligned(fact, clinicalContext)) return false;
  return !groundedFactConceptsForText(fact).some((concept) =>
    !concept.group.test(fact) &&
    hasAffirmedClinicalTerm(fact, concept.surface) &&
    contextNegatesGroundedConcept(clinicalContext, concept) &&
    !contextAffirmsGroundedConcept(clinicalContext, concept));
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
    const genericConflict = genericPolarityConflictTerm(fact, clinicalContext);
    if (genericConflict) {
      return `westernDiagnosis.primary.supportingFacts 中的“${fact}”把病历已明确否认的“${genericConflict}”写成了阳性依据。请删除这条依据，或替换为病历当前语境中确有阳性记录、且能支持本次工作诊断的事实；不得把阴性事实反写成阳性。`;
    }
  }
  return undefined;
}

/** Validate uncertainty state and source grounding without deciding clinical semantics locally. */
function m03ResolutionContractIssue(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  const overview = reasoning.overview;
  const syndrome = typeof overview?.primarySyndrome === "string" ? overview.primarySyndrome.trim() : "";
  const syndromeBasis = nonEmptyStringList(overview?.primarySyndromeBasis);
  if (clinicalContext && syndromeBasis.some((basis) => !isGenericPatientEvidencePolarityAligned(basis, clinicalContext))) {
    return "primary_syndrome_basis_polarity";
  }
  const symptomClusterFacts = (reasoning.pathogenesis?.symptomClusters || [])
    .flatMap((item) => nonEmptyStringList(item.symptoms));
  if (clinicalContext && symptomClusterFacts.some((fact) => !isGenericPatientEvidencePolarityAligned(fact, clinicalContext))) {
    return "symptom_cluster_polarity";
  }
  const keySweatingDiscriminators = syndromeBasis.flatMap((basis) =>
    basis.match(/无汗|自汗/g) || []);
  if (
    keySweatingDiscriminators.length > 0 &&
    !keySweatingDiscriminators.every((term) =>
      (reasoning.pathogenesis?.chain || []).some((item) =>
        [item.patientFact, item.syndromeEvidence].some((value) =>
          typeof value === "string" && value.includes(term))))
  ) {
    return "chain_key_discriminator_missing";
  }
  const explicitSyndromeResolution = clinicalResolution(overview?.primarySyndromeResolution);
  const syndromeResolution = explicitSyndromeResolution || (syndrome ? "bounded" : "unresolved");
  // A bounded/resolved primary syndrome is a clinical conclusion, not a place to append
  // “待辨/待定/资料不足” to a symptom list. Keep uncertainty in the resolution fields so
  // the repair loop can form the minimum finite-information conclusion instead of signing a
  // placeholder as if it were a diagnosis. An explicitly unresolved limited result remains valid.
  if (syndromeResolution !== "unresolved" && (UNSTABLE_REASONING_MARKER.test(syndrome) || isUnstableM03CoreText(syndrome))) {
    return "primary_syndrome_unstable";
  }
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

const M03_LOCATION_EVIDENCE_DIMENSIONS: ReadonlyArray<[string, RegExp]> = [
  ["tongue", /舌|苔/],
  ["pulse", /脉/],
  ["stool", /大便|排便|便秘|便溏|下利|泄泻/],
  ["urination", /小便|排尿|尿色|尿量|尿频|尿急/],
  ["thermal", /恶寒|恶热|怕冷|怕热|发热|寒热|手足(?:冷|热|温)|四肢(?:冷|热|温)/],
  ["sweating", /汗出|无汗|自汗|盗汗|大汗/],
  ["sleep", /睡眠|入睡|早醒|夜醒|失眠|不得眠|但欲寐/],
  ["appetite", /胃口|食欲|进食|纳差|不欲食/],
];

const M03_COLD_HEAT_EVIDENCE_DIMENSIONS: ReadonlyArray<[string, RegExp]> = [
  ["face_spirit", /面色|两颧|目(?:赤|眩|有神)|精神|神志/],
  ["breath", /口鼻气|呼出气|气息|口气|呼吸急促/],
  ["tongue", /舌|苔/],
  ["pulse", /脉/],
  ["chest_abdomen", /胸|腹|心下|喜按|拒按|按之|久按/],
  ["urination", /小便|排尿|尿色|尿量|尿频|尿急/],
  ["thirst", /口渴|不渴|欲饮|不欲饮|喜冷饮|喜热饮/],
  ["stool", /大便|排便|便秘|便溏|下利|泄泻|肛门灼热/],
  ["thermal", /恶寒|恶热|怕冷|怕热|发热|寒热|手足(?:冷|热|温)|四肢(?:冷|热|温)/],
  ["sweating", /汗出|无汗|自汗|盗汗|大汗/],
];

function evidenceDimensionCount(text: string, dimensions: ReadonlyArray<readonly [string, RegExp]>): number {
  return dimensions.filter(([, pattern]) => pattern.test(text)).length;
}

function m03SevenStageInferenceIssue(reasoning: M03ReasoningLike): string | undefined {
  const location = reasoning.pathogenesis?.locationDifferentiation;
  if (clinicalResolution(location?.resolution) === "resolved") {
    const locationBasis = (location?.details || [])
      .map((detail) => typeof detail.basis === "string" ? detail.basis.trim() : "")
      .filter(Boolean)
      .join("；");
    if (locationBasis && evidenceDimensionCount(locationBasis, M03_LOCATION_EVIDENCE_DIMENSIONS) < 2) {
      return "single_evidence_location";
    }
  }

  const nature = reasoning.pathogenesis?.natureDifferentiation;
  const natureResolution = clinicalResolution(nature?.resolution);
  const natureItems = [
    ...nonEmptyStringList(nature?.items),
    ...nonEmptyStringList(nature?.rootDeficiency),
    ...nonEmptyStringList(nature?.branchExcess),
  ].join("；");
  if (
    natureResolution === "resolved" &&
    /寒|热|火|温|凉/.test(natureItems) &&
    typeof nature?.basis === "string" &&
    evidenceDimensionCount(nature.basis, M03_COLD_HEAT_EVIDENCE_DIMENSIONS) < 2
  ) {
    return "nature_dimension_insufficient";
  }
  return undefined;
}

type M03PathogenesisConcept = {
  code: string;
  pattern: RegExp;
};

// `pathogenesis.summary` is a projection of the already-established syndrome/nature/chain,
// not a second reasoning surface. Keep this list limited to disease-nature conclusions whose
// silent introduction materially changes downstream treatment. The independent reviewer still
// owns clinical adequacy; this guard only rejects internal structural drift.
const M03_PATHOGENESIS_SUMMARY_CONCEPTS: readonly M03PathogenesisConcept[] = [
  { code: "phlegm_heat", pattern: /(?:痰热|热痰)/ },
  { code: "damp_heat", pattern: /(?:湿热|热湿)/ },
  { code: "cold_damp", pattern: /(?:寒湿|湿寒)/ },
  { code: "qi_deficiency", pattern: /(?:正气(?:略|稍|相对)?(?:虚|不足)|气虚|气亏|气不足|气弱|元气(?:亏|不足)|中气不足|气血两虚|气血不足)/ },
  { code: "blood_deficiency", pattern: /(?:血虚|血亏|血不足|气血两虚|气血不足|心血不足|肝血不足)/ },
  { code: "yin_deficiency", pattern: /(?:阴虚|阴亏|阴液不足|津(?:亏|伤|液不足)|津液不足|精亏)/ },
  { code: "yang_deficiency", pattern: /(?:阳虚|阳气不足|阳气亏虚|虚寒)/ },
  { code: "blood_stasis", pattern: /(?:血瘀|瘀血|瘀阻|瘀滞|血行不畅|络阻)/ },
  { code: "phlegm_damp", pattern: /(?:痰湿|湿痰|痰浊|湿浊|水湿)/ },
  { code: "heat_fire", pattern: /(?:心火|肝火|胃火|肺热|胃热|实热|虚热|郁火|火旺|火热|热证|热邪)/ },
  { code: "cold", pattern: /(?:实寒|寒证|寒邪|寒凝|里寒|外寒)/ },
  { code: "food_accumulation", pattern: /(?:食积|食滞|积食|饮食积滞|宿食)/ },
  { code: "fluid_retention", pattern: /(?:水饮|饮停|水液停聚|水液内停)/ },
];

function hasAssertedPathogenesisConcept(value: unknown, pattern: RegExp): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return value
    .split(/[，,。；;\n]+/)
    .some((clause) => pattern.test(clause) && !CLINICAL_NEGATION.test(clause) && !UNSTABLE_REASONING_MARKER.test(clause));
}

function m03PathogenesisSummaryConsistencyIssue(reasoning: M03ReasoningLike): string | undefined {
  const summary = reasoning.pathogenesis?.summary;
  if (typeof summary !== "string" || !summary.trim()) return undefined;
  const nature = reasoning.pathogenesis?.natureDifferentiation;
  const authoritativeCore = [
    reasoning.overview?.primarySyndrome,
    reasoning.overview?.overallPathogenesis,
    ...nonEmptyStringList(nature?.items),
    ...nonEmptyStringList(nature?.rootDeficiency),
    ...nonEmptyStringList(nature?.branchExcess),
    ...(reasoning.pathogenesis?.chain || []).map((item) => item.pathogenesis),
  ].filter((item): item is string => typeof item === "string" && Boolean(item.trim()));

  for (const concept of M03_PATHOGENESIS_SUMMARY_CONCEPTS) {
    if (
      hasAssertedPathogenesisConcept(summary, concept.pattern) &&
      !authoritativeCore.some((item) => hasAssertedPathogenesisConcept(item, concept.pattern))
    ) {
      return `pathogenesis_summary_${concept.code}_drift`;
    }
  }
  return undefined;
}

const UNCERTAINTY_RECORDED_ASSERTION = /(?:已|已经)(?:在(?:本次)?(?:病历|记录|资料)中?)?(?:明确)?(?:记录|记载|提供|确认|核实|采集|获知)|(?:病历|资料)(?:中)?(?:已|明确)(?:记录|记载|提供|确认)/;
const UNCERTAINTY_VAGUE_RECORDED_ASSERTION = /(?:该|上述|相关)(?:症状|情况|信息|资料|内容)?(?:已|已经)(?:在(?:本次)?(?:病历|记录|资料)中?)?(?:明确)?(?:记录|记载|提供|确认|核实|采集|获知)/;
const UNKNOWN_DOCUMENTATION_CLAUSE = /(?:本次|当前|目前)?(?:未取得(?:该|相关)?信息|未能确认|未提供|未记录|未询问|未采集|未提及|不详|未知|说不清|不清楚)/;
const UNCERTAINTY_DOCUMENTATION_AXES: ReadonlyArray<{
  item: RegExp;
  context: RegExp;
}> = [
  { item: /既往史|既往疾病|基础疾病|手术史/, context: /既往史|既往(?:患有|有|曾患|诊断|确诊)|(?:疾病|手术)史/ },
  { item: /用药史|当前用药|服药史|药物清单/, context: /用药史|当前用药|目前用药|现用药|(?:正在|长期|规律|目前|当前)[^。；;\n]{0,16}(?:服用|口服|使用)|否认[^。；;\n]{0,10}(?:服药|用药)|(?:无|未)[^。；;\n]{0,8}(?:服药|用药)/ },
  { item: /过敏史|过敏原|过敏反应/, context: /过敏史|对[^。；;\n]{1,20}过敏|(?:否认|无|未见)[^。；;\n]{0,10}过敏/ },
  { item: /舌象|舌质|舌苔/, context: /舌象|舌质|舌苔|舌(?:红|绛|淡|暗|紫|胖|瘦|有齿痕)/ },
  { item: /脉象|脉诊/, context: /脉象|脉(?:弦|细|数|迟|滑|涩|沉|浮|弱|洪|紧|缓|结|代)/ },
  { item: /生命体征|血压|体温|脉搏|心率|呼吸频率|血氧/, context: /生命体征|血压|体温|脉搏|心率|呼吸频率|血氧|SpO2/i },
];

function contextDocumentsUncertaintyAxis(clinicalContext: string, pattern: RegExp): boolean {
  return clinicalContext
    .split(/[，,。；;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => pattern.test(clause) && !UNKNOWN_DOCUMENTATION_CLAUSE.test(clause));
}

/**
 * An uncertainty row may describe a known fact plus a narrower unknown attribute, but it cannot
 * claim a governed chart field is already documented when that field is absent from the same
 * de-identified grounding corpus. Vague claims such as “该症状已在病历中明确记录” are also rejected:
 * they neither identify the known fact nor explain the uncertainty and can silently convert an
 * unknown history into a known one.
 */
function m03UncertaintyStateIssue(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  const uncertainties = reasoning.pathogenesis?.uncertainties;
  if (!Array.isArray(uncertainties)) return undefined;
  for (const row of uncertainties) {
    const item = typeof row?.item === "string" ? row.item.trim() : "";
    const reason = typeof row?.reason === "string" ? row.reason.trim() : "";
    if (!reason || !UNCERTAINTY_RECORDED_ASSERTION.test(reason)) continue;
    if (UNCERTAINTY_VAGUE_RECORDED_ASSERTION.test(reason)) return "uncertainty_state_mismatch";
    if (!clinicalContext) continue;
    const axes = UNCERTAINTY_DOCUMENTATION_AXES.filter((axis) => axis.item.test(item));
    if (axes.some((axis) => !contextDocumentsUncertaintyAxis(clinicalContext, axis.context))) {
      return "uncertainty_state_mismatch";
    }
  }
  return undefined;
}

const DIAGNOSIS_LABEL_ONLY = /^(?:[\p{Script=Han}A-Za-z0-9+\-]+(?:病|炎|癌|瘤|综合征|衰竭|不全)|高血压|糖尿病|房颤|心房颤动|湿疹|类风湿(?:关节炎)?|系统性红斑狼疮|SLE|RA)(?:病史)?(?:(?:已)?\d+(?:\.\d+)?年(?:余)?)?$/iu;

function isCurrentPositiveTcmAnchor(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/[\s，,。；;：:、（）()【】\[\]]+/g, "");
  if (!normalized || isNegatedClinicalClause(value) || isHistoricalWesternSupportFact(value)) return false;
  return !DIAGNOSIS_LABEL_ONLY.test(normalized);
}

function hasCurrentPositiveTcmAnchor(reasoning: M03ReasoningLike): boolean {
  const anchors = [
    ...nonEmptyStringList(reasoning.overview?.primarySyndromeBasis),
    ...(reasoning.pathogenesis?.chain || []).flatMap((item) => [item.patientFact, item.syndromeEvidence])
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim())),
  ];
  return anchors.some(isCurrentPositiveTcmAnchor);
}

const DIARRHEA_DURATION_CLAUSE = /(?:腹泻|腹瀉|拉肚子|稀便|稀水样|大便[^。；;\n]{0,12}稀|稀稀|吃[^。；;\n]{0,12}跑厕所)/i;
const CHRONIC_OR_FUNCTIONAL_DIARRHEA_LABEL = /(?:慢性[^，,。；;]{0,8}(?:腹泻|腹瀉)|(?:腹泻|腹瀉)[^，,。；;]{0,8}慢性|功能性腹泻)/i;

function chineseDurationNumber(value: string): number | undefined {
  const normalized = value.trim();
  if (/^半$/.test(normalized)) return 0.5;
  const direct: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (direct[normalized] != null) return direct[normalized];
  const tens = normalized.match(/^([一二两兩三四五六七八九]?)[十]([一二三四五六七八九]?)$/);
  if (!tens) return undefined;
  return (direct[tens[1]] || 1) * 10 + (direct[tens[2]] || 0);
}

function durationDaysFromClause(clause: string): number[] {
  const results: number[] = [];
  const durationPattern = /(\d+(?:\.\d+)?|半|[一二两兩三四五六七八九十]{1,3})\s*(?:个)?\s*(天|日|周|星期|个月|月|年)/g;
  for (const match of clause.matchAll(durationPattern)) {
    const value = /^\d/.test(match[1]) ? Number(match[1]) : chineseDurationNumber(match[1]);
    if (value == null || !Number.isFinite(value) || value <= 0) continue;
    const multiplier = /^(?:天|日)$/.test(match[2])
      ? 1
      : /^(?:周|星期)$/.test(match[2])
        ? 7
        : /^(?:个月|月)$/.test(match[2])
          ? 30
          : 365;
    results.push(value * multiplier);
  }
  return results;
}

/**
 * Reject only a definite temporal overstatement: an explicitly documented current diarrhoea
 * course shorter than four weeks cannot be labelled chronic or functional diarrhoea. Missing or
 * mixed-duration records stay with the independent reviewer instead of being guessed locally.
 */
export function m03WesternDurationIssue(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  const name = reasoning.westernDiagnosis?.primary?.name;
  if (typeof name !== "string" || !CHRONIC_OR_FUNCTIONAL_DIARRHEA_LABEL.test(name) || !clinicalContext) return undefined;
  const relevantDurations = clinicalContext
    .split(/[。；;\n]+/)
    .filter((clause) => DIARRHEA_DURATION_CLAUSE.test(clause) && !isHistoricalWesternSupportFact(clause))
    .flatMap(durationDaysFromClause);
  if (relevantDurations.length === 0 || relevantDurations.some((days) => days >= 28)) return undefined;
  return "western_primary_duration_mismatch";
}

export function narrativeFingerprint(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(GENERIC_CORE_LABELS, "").replace(/[\s，,。；;：:、（）()【】\[\]“”"'‘’]/g, "")
    : "";
}

function narrativeMostlyCopies(value: unknown, sources: readonly unknown[]): boolean {
  const narrative = narrativeFingerprint(value);
  if (narrative.length < 4) return false;
  const facts = sources.map(narrativeFingerprint).filter((item) => item.length >= 2);
  if (facts.some((fact) => fact === narrative || fact.includes(narrative))) return true;
  const copied = facts.reduce((total, fact) => total + (narrative.includes(fact) ? fact.length : 0), 0);
  return copied / narrative.length >= 0.85;
}

function rationaleReferencesSupportingFact(rationale: string, facts: readonly string[]): boolean {
  const normalizedRationale = normalizedFactSupportText(rationale);
  return facts.some((fact) => {
    const normalizedFact = normalizedFactSupportText(fact);
    if (normalizedFact.length >= 2 && normalizedRationale.includes(normalizedFact)) return true;
    const factConcepts = groundedFactConceptsForText(fact);
    const rationaleConcepts = groundedFactConceptsForText(rationale);
    return factConcepts.some((factConcept) =>
      rationaleConcepts.some((rationaleConcept) => rationaleConcept.group === factConcept.group));
  });
}

function rationaleHasNovelDiagnosticConcept(rationale: string, patientFacts: readonly string[]): boolean {
  return DIAGNOSTIC_INFERENCE_CONCEPTS.some((concept) =>
    rationale.includes(concept) && !patientFacts.some((fact) => fact.includes(concept)));
}

export function m03WesternClinicalRationaleIssue(
  reasoning: M03ReasoningLike | null | undefined,
): "western_clinical_rationale_missing" | "western_clinical_rationale_restatement" | undefined {
  const westernPrimary = reasoning?.westernDiagnosis?.primary;
  const westernRationale = typeof westernPrimary?.clinicalRationale === "string"
    ? westernPrimary.clinicalRationale.trim()
    : "";
  if (westernRationale.length < 8 || !CLINICAL_REASONING_CONNECTOR.test(westernRationale)) {
    return "western_clinical_rationale_missing";
  }
  const westernFacts = nonEmptyStringList(westernPrimary?.supportingFacts);
  if (
    narrativeMostlyCopies(westernRationale, westernFacts) ||
    !rationaleReferencesSupportingFact(westernRationale, westernFacts) ||
    !rationaleHasNovelDiagnosticConcept(westernRationale, westernFacts) ||
    !WESTERN_EXCLUSION_REASONING.test(westernRationale)
  ) {
    return "western_clinical_rationale_restatement";
  }
  return undefined;
}

const CLINICAL_INTENSITY_PAIRS: ReadonlyArray<[RegExp, RegExp, RegExp]> = [
  [/咳嗽|咳/, /声重|轻微|轻度|稍|略|有点|偶有/, /剧烈|严重|重度|频繁|持续不止/],
  [/头痛|腹痛|胸痛|疼痛/, /轻微|轻度|稍|略|有点|隐痛|偶有/, /剧烈|严重|重度|难以忍受|最剧烈/],
  [/恶心|呕吐/, /轻微|轻度|稍|略|有点|偶有/, /剧烈|严重|频繁|喷射性|持续不止/],
  [/头晕|眩晕/, /轻微|轻度|稍|略|有点|偶有/, /剧烈|严重|重度|无法站立/],
  [/气促|气短|呼吸困难/, /轻微|轻度|稍|略|有点|活动后/, /严重|重度|静息时|端坐呼吸/],
];

function m03ClinicalWordingFidelityIssue(reasoning: M03ReasoningLike, clinicalContext: string): string | undefined {
  if (!clinicalContext) return undefined;
  const analysisSurface = [
    ...nonEmptyStringList(reasoning.westernDiagnosis?.primary?.supportingFacts),
    reasoning.westernDiagnosis?.primary?.clinicalRationale,
    reasoning.overview?.tcmDiagnosticRationale,
    reasoning.overview?.overallPathogenesis,
    ...(reasoning.pathogenesis?.symptomClusters || []).flatMap((item) => [item.mechanism]),
    ...(reasoning.pathogenesis?.chain || []).flatMap((item) => [item.syndromeEvidence, item.pathogenesis]),
  ].filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join("；");

  for (const [symptom, lowerIntensity, higherIntensity] of CLINICAL_INTENSITY_PAIRS) {
    const recordHasLowerOnly = recordClauses(clinicalContext).some((clause) =>
      !isNegatedClinicalClause(clause) &&
      symptom.test(clause) &&
      lowerIntensity.test(clause) &&
      !higherIntensity.test(clause));
    const analysisUpgradesIntensity = clinicalClauses(analysisSurface).some((clause) =>
      !isNegatedClinicalClause(clause) && symptom.test(clause) && higherIntensity.test(clause));
    if (recordHasLowerOnly && analysisUpgradesIntensity) return "clinical_wording_intensity_mismatch";
  }

  const temperatures = measuredTemperatures(clinicalContext);
  const currentTemperatureNormal = temperatures.length > 0 &&
    temperatures.every((temperature) => temperature < FEVER_TEMPERATURE_CELSIUS);
  if (
    currentTemperatureNormal &&
    /(?:病历已记录|客观检查提示|测得|体温)(?:[^。；;\n]{0,8})(?:发热|升高|异常)/.test(analysisSurface) &&
    !/(?:自诉|主诉|病程中|曾有)[^。；;\n]{0,12}(?:发热|恶寒发热)[^。；;\n]{0,24}(?:当前|本次)[^。；;\n]{0,12}(?:体温正常|测温未升高|未见体温升高)/.test(analysisSurface)
  ) {
    return "clinical_wording_subjective_objective_mismatch";
  }
  return undefined;
}

function rationaleReferencesChartFact(rationale: string, clinicalContext: string): boolean {
  if (!clinicalContext) return false;
  if (GROUNDED_FACT_GROUPS.some((group) =>
    hasAffirmedClinicalTerm(rationale, group) && contextAffirmsTerm(clinicalContext, group))) {
    return true;
  }
  return groundedFactConceptsForText(rationale).some((concept) =>
    contextAffirmsGroundedConcept(clinicalContext, concept));
}

function m03PathogenesisAndTherapyStructureIssue(
  reasoning: M03ReasoningLike,
  clinicalContext: string,
): string | undefined {
  const chain = reasoning.pathogenesis?.chain || [];
  const overallPathogenesis = reasoning.overview?.overallPathogenesis;
  const factSurface = [
    ...nonEmptyStringList(reasoning.overview?.primarySyndromeBasis),
    ...nonEmptyStringList(reasoning.westernDiagnosis?.primary?.supportingFacts),
    ...chain.map((item) => item.patientFact),
    clinicalContext,
  ];
  if (narrativeMostlyCopies(overallPathogenesis, factSurface)) return "overall_pathogenesis_restates_facts";

  const nodePathogenesis = chain.map((item) => narrativeFingerprint(item.pathogenesis)).filter(Boolean);
  const nodeTherapies = chain.map((item) => narrativeFingerprint(item.therapyDirection)).filter(Boolean);
  if (chain.length > 1 && new Set(nodePathogenesis).size === 1) return "pathogenesis_nodes_duplicated";
  if (chain.length > 1 && new Set(nodeTherapies).size === 1) return "pathogenesis_therapy_directions_duplicated";

  const subTherapies = reasoning.therapy?.subTherapies || [];
  if (subTherapies.length === 0) return "sub_therapies_missing";
  if (chain.length > 1 && subTherapies.length < Math.min(2, chain.length)) return "sub_therapies_insufficient";
  const therapyTexts = subTherapies.map((item) => narrativeFingerprint(item.therapy)).filter(Boolean);
  const targets = subTherapies.map((item) => narrativeFingerprint(item.targetPathogenesis)).filter(Boolean);
  if (therapyTexts.length !== subTherapies.length || targets.length !== subTherapies.length) return "sub_therapy_incomplete";
  if (!subTherapies.some((item) => item.priority === "主要")) return "sub_therapy_primary_missing";
  if (therapyTexts.length > 1 && new Set(therapyTexts).size !== therapyTexts.length) return "sub_therapy_duplicated";
  if (targets.length > 1 && new Set(targets).size !== targets.length) return "sub_therapy_target_duplicated";
  const principlePolicies = treatmentPrinciplesInText(reasoning.therapy?.overallPrinciple)
    .map((entry) => entry.relationPolicy);
  if (principlePolicies.includes("requires_root_and_manifestation_targets") &&
    (subTherapies.length < 2 || new Set(targets).size < 2)) {
    return "treatment_principle_target_mismatch";
  }
  const overallMethod = narrativeFingerprint(reasoning.therapy?.overallMethod);
  // With one pathogenesis node, the sole concrete therapy is also the complete overall method;
  // equality is clinically expected and must not collapse an otherwise valid M03 result. Only a
  // multi-node plan is required to decompose the combined overall method into distinct directions.
  if (chain.length > 1 && overallMethod && therapyTexts.some((item) => item === overallMethod)) {
    return "sub_therapy_repeats_overall_method";
  }
  return undefined;
}

export function m03SemanticIssue(reasoning: M03ReasoningLike | null | undefined, clinicalContext = "", _visibleContent = ""): string | undefined {
  void _visibleContent;
  const chain = reasoning?.pathogenesis?.chain || [];
  const hasCompleteChain = chain.length > 0 && chain.every((item) =>
    !isUnstableM03CoreText(item.patientFact) &&
    !isUnstableM03CoreText(item.syndromeEvidence) &&
    hasPathogenesisAnchor(item.pathogenesis) &&
    hasTherapyAnchor(item.therapyDirection)
  );
  if (!reasoning || reasoning.stage !== "diagnose") return "stage";
  if (/(?:本次主诉及伴随症状变化|接诊时核实相关症状是否存在)/.test(JSON.stringify(reasoning))) {
    return "explanation_placeholder";
  }
  if (reasoning.formula != null) return "formula_not_null";
  if (m03ContainsDoseLevelInstruction(reasoning)) return "dose_level_content";
  // The pathogenesis chain is the load-bearing M03 inference structure. Report its absence before
  // secondary prose-quality findings so the repair loop restores the missing structure first.
  if (!chain.length) return "chain_empty";
  const westernPrimary = reasoning.westernDiagnosis?.primary;
  if (
    typeof westernPrimary?.name !== "string" ||
    westernPrimary.name.trim().length < 2 ||
    /(?:基于主诉的)?现代医学诊断倾向|待生成|待明确|未知/.test(westernPrimary.name)
  ) return "western_diagnosis_unstable";
  if (isAmbiguousM03WesternPrimaryLabel(westernPrimary.name)) return "western_primary_ambiguous";
  if (westernLabelContainsTcmSyndrome(westernPrimary.name)) return "western_primary_tcm_pollution";
  const westernDurationIssue = m03WesternDurationIssue(reasoning, clinicalContext);
  if (westernDurationIssue) return westernDurationIssue;
  const westernSupportIssue = m03WesternSupportIssue(reasoning, clinicalContext);
  if (westernSupportIssue) return westernSupportIssue;
  const wordingFidelityIssue = m03ClinicalWordingFidelityIssue(reasoning, clinicalContext);
  if (wordingFidelityIssue) return wordingFidelityIssue;
  const westernRationaleIssue = m03WesternClinicalRationaleIssue(reasoning);
  if (westernRationaleIssue) return westernRationaleIssue;
  const differentialIdentities = (reasoning.westernDiagnosis?.differentials || [])
    .map((item) => westernDifferentialIdentity(item.name))
    .filter(Boolean);
  if (new Set(differentialIdentities).size !== differentialIdentities.length) {
    return "western_differential_duplicate";
  }
  if ((reasoning.westernDiagnosis?.differentials || []).some((item) =>
    isAmbiguousM03WesternPrimaryLabel(item.name))) {
    return "western_differential_ambiguous";
  }
  if ((reasoning.westernDiagnosis?.differentials || []).some((item) =>
    typeof item.reason !== "string" || item.reason.trim().length < 4 ||
    typeof item.distinguishingPoints !== "string" || item.distinguishingPoints.trim().length < 4)) {
    return "western_differential_analysis_missing";
  }
  const coreTcmText = [
    reasoning.overview?.primarySyndrome,
    reasoning.overview?.overallPathogenesis,
    reasoning.therapy?.overallPrinciple,
    reasoning.therapy?.overallMethod,
    ...chain.flatMap((item) => [item.pathogenesis, item.therapyDirection]),
  ].filter((item): item is string => typeof item === "string").join("；");
  if (/(?:功能失调候|调护功能)/.test(coreTcmText)) return "generic_tcm_template";
  if (!hasCompleteChain) return "chain_incomplete";
  const tcmRationale = typeof reasoning.overview?.tcmDiagnosticRationale === "string"
    ? reasoning.overview.tcmDiagnosticRationale.trim()
    : "";
  if (tcmRationale.length < 8 || !TCM_REASONING_CONNECTOR.test(tcmRationale)) return "tcm_diagnostic_rationale_missing";
  if (tcmDiagnosticDependencyContexts(tcmRationale).length > 0) return "tcm_reasoning_diagnostic_dependency";
  const syndromeFacts = nonEmptyStringList(reasoning.overview?.primarySyndromeBasis);
  const chainPatientFacts = chain
    .map((item) => item.patientFact)
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  const tcmFacts = syndromeFacts.length > 0 ? syndromeFacts : chainPatientFacts;
  if (
    narrativeMostlyCopies(tcmRationale, tcmFacts) ||
    (
      !rationaleReferencesSupportingFact(tcmRationale, tcmFacts) &&
      !rationaleReferencesChartFact(tcmRationale, clinicalContext)
    ) ||
    !rationaleHasNovelDiagnosticConcept(tcmRationale, tcmFacts)
  ) return "tcm_diagnostic_rationale_restatement";
  const resolutionIssue = m03ResolutionContractIssue(reasoning, clinicalContext);
  if (resolutionIssue) return resolutionIssue;
  const sevenStageInferenceIssue = m03SevenStageInferenceIssue(reasoning);
  if (sevenStageInferenceIssue) return sevenStageInferenceIssue;
  const tcmDifferentials = reasoning.overview?.tcmDifferentials || [];
  if (tcmDifferentials.some((item) =>
    typeof item.syndrome !== "string" || item.syndrome.trim().length < 2 ||
    typeof item.reason !== "string" || item.reason.trim().length < 4 ||
    typeof item.distinguishingPoints !== "string" || item.distinguishingPoints.trim().length < 4)) {
    return "tcm_differential_analysis_missing";
  }
  const syndromeResolution = reasoning.overview?.primarySyndromeResolution;
  const hasStructuredDifferentialLimitation =
    typeof reasoning.overview?.primarySyndromeResolutionReason === "string" &&
    /(?:无法|不能|不足以|缺少|待补充)[^。；;\n]{0,24}(?:鉴别|区分|辨别)|(?:鉴别|区分|辨别)[^。；;\n]{0,24}(?:无法|不能|不足|缺少)/.test(
      reasoning.overview.primarySyndromeResolutionReason,
    );
  if ((syndromeResolution === "resolved" || syndromeResolution === "bounded") &&
    tcmDifferentials.length === 0 &&
    !hasStructuredDifferentialLimitation) {
    return "discrimination_missing";
  }
  const tcmReasoningSurface = [
    tcmRationale,
    reasoning.overview?.primarySyndromeResolutionReason,
    ...(reasoning.overview?.tcmDifferentials || []).flatMap((item) => [item.reason, item.distinguishingPoints, item.nextCheck]),
    reasoning.pathogenesis?.summary,
    ...(reasoning.pathogenesis?.locationDifferentiation?.details || []).flatMap((item) => [item.basis]),
    reasoning.pathogenesis?.locationDifferentiation?.resolutionReason,
    reasoning.pathogenesis?.natureDifferentiation?.basis,
    reasoning.pathogenesis?.natureDifferentiation?.resolutionReason,
    ...(reasoning.pathogenesis?.symptomClusters || []).flatMap((item) => [item.mechanism]),
    ...(reasoning.pathogenesis?.chain || []).flatMap((item) => [item.syndromeEvidence, item.pathogenesis, item.therapyDirection]),
    ...(reasoning.pathogenesis?.uncertainties || []).flatMap((item) => [item.item, item.reason, item.affects]),
  ].filter((item): item is string => typeof item === "string").join("；");
  if (tcmDiagnosticDependencyContexts(tcmReasoningSurface).length > 0) return "tcm_reasoning_diagnostic_dependency";
  const natureItems = nonEmptyStringList(reasoning.pathogenesis?.natureDifferentiation?.items);
  if (natureItems.some((item) => NATURE_MECHANISM_PHRASE.test(item))) return "nature_item_is_mechanism";
  const locationItems = nonEmptyStringList(reasoning.pathogenesis?.locationDifferentiation?.items);
  // T2/T3 are component taxonomies, not exhaustive diagnostic dictionaries. Exact aliases are
  // canonicalized before this check, while valid composites (for example 寒湿) and peripheral
  // sites (for example 咽喉/关节) remain subject to the independent clinical reviewer. Treating
  // every table miss as a hard contract violation caused clinically usable M03 results to collapse
  // after both model attempts, contradicting T2's explicit "未命中不等于术语错误" scope.
  const locationsNamedInReasoning = governedTcmLocationsInText([
    reasoning.overview?.primarySyndrome,
    reasoning.overview?.overallPathogenesis,
    ...chain.flatMap((item) => [item.syndromeEvidence, item.pathogenesis]),
  ].filter((item): item is string => typeof item === "string").join("；"));
  if (reasoning.pathogenesis?.locationDifferentiation && locationsNamedInReasoning.length > 0 && locationItems.length === 0) {
    return "location_classification_missing";
  }
  const principle = typeof reasoning.therapy?.overallPrinciple === "string" ? reasoning.therapy.overallPrinciple.trim() : "";
  const method = typeof reasoning.therapy?.overallMethod === "string" ? reasoning.therapy.overallMethod.trim() : "";
  if (!method) return "therapy_method_missing";
  if (!principle || governedTreatmentPrinciplesInText(principle).length === 0) return "therapy_principle_invalid";
  const normalizedPrinciple = principle.replace(/[\s，,。；;：:、]/g, "");
  const normalizedMethod = method.replace(/[\s，,。；;：:、]/g, "");
  if (normalizedPrinciple === normalizedMethod) return "therapy_principle_method_duplicate";
  const structureIssue = m03PathogenesisAndTherapyStructureIssue(reasoning, clinicalContext);
  if (structureIssue) return structureIssue;
  if (chain.every((item) => isNeutralTongueOnlyFact(item.patientFact))) return "neutral_tongue_only";
  const summaryConsistencyIssue = m03PathogenesisSummaryConsistencyIssue(reasoning);
  if (summaryConsistencyIssue) return summaryConsistencyIssue;
  const uncertaintyStateIssue = m03UncertaintyStateIssue(reasoning, clinicalContext);
  if (uncertaintyStateIssue) return uncertaintyStateIssue;
  if (clinicalContext && !hasCurrentPositiveTcmAnchor(reasoning)) return "tcm_syndrome_current_fact_missing";
  // Semantic adequacy and clinical coherence are owned by the independent reviewer. This local
  // contract only rejects ungrounded patient facts and malformed resolution states; it does not
  // decide TCM syndrome, disease location, disease nature or therapy via finite keyword lists.
  if (clinicalContext) {
    const groundingIssue = ungroundedPatientFactReason(reasoning, clinicalContext);
    if (groundingIssue) return groundingIssue;
  }
  if (!isActionableFollowupSafetyNet(reasoning.management?.followupSafetyNet)) {
    return "followup_safety_net_not_actionable";
  }
  // 需求3：辨病与辨证是两个判断，各自要有推理过程。此前二者共用 tcmDiagnosticRationale，
  // 病名归属的理由被证型推理挤掉——医生看到「不寐」却读不到为什么归入不寐而不是郁病或心悸。
  // 放在末尾且分级为 T2：缺一段辨病推理不影响结论可用性，应带批注受理而不是驳回整份 M03。
  const tcmDiseaseName = typeof reasoning.overview?.tcmDiseaseName === "string"
    ? reasoning.overview.tcmDiseaseName.trim()
    : "";
  if (tcmDiseaseName) {
    const diseaseRationale = typeof reasoning.overview?.tcmDiseaseRationale === "string"
      ? reasoning.overview.tcmDiseaseRationale.trim()
      : "";
    if (diseaseRationale.length < 8 || !TCM_REASONING_CONNECTOR.test(diseaseRationale)) {
      return "tcm_disease_rationale_missing";
    }
  }
  // 经典方优先是本产品的既定策略，也决定 M04 能否拿到可编译基准方。漏锁不由服务端代选——选方是
  // 临床决策，仍归模型与医生——但服务端有权指出：模型对自己签名的证候留空了方名，而受控目录中
  // 存在满足正向充分性且可锁定的候选。放在最后，是因为这属策略层问题，结构性缺陷应先修完。
  if (missedLockableFormulaCandidates(reasoning).length > 0) return "formula_selection_missed_lockable";
  return undefined;
}

/**
 * m03SemanticIssue 的 T1 子集，为“带批注受理”提供硬门禁。
 *
 * 为什么不能只看 m03SemanticIssue 的返回值：它命中第一个问题就短路返回。返回一个 T3 原因码，
 * 只证明排在它前面的检查通过了；排在它后面的 T1 检查根本没有执行。所以受理前必须把 T1 子集
 * 完整跑一遍。
 *
 * ★ 本函数的核心不变量（改动前必读）★
 * 分级过滤（isSafetyReason）只允许用于两类位置：
 *   1) 本函数体内直接判定的单点检查 —— 跳过它等于“继续往下执行”，不会遗漏任何后续检查；
 *   2) 已证明其全部产出码都不是 T1 的辅助函数 —— 目前仅 m03WesternClinicalRationaleIssue
 *      （返回类型在源码中收敛为 missing / restatement 两个非 T1 码）。
 * 其余多码辅助函数一律按“绝对否决”处理：只要返回非空就阻断受理，不看分级。
 * 原因：这些函数内部同样短路。例如 m03WesternSupportIssue 的顺序是
 *   empty(T1) → tcm_pollution → demographic_padding → normal_vital_padding → nondiscriminating
 *   → historical_only(T1) → polarity_mismatch(T1)；
 * 若按分级丢弃 demographic_padding，polarity_mismatch（把病历已否认的事实反写成阳性依据）
 * 就永远不会被执行到。m03ResolutionContractIssue（*_basis_ungrounded）与
 * m03SevenStageInferenceIssue（nature_dimension_insufficient）有同样的结构。
 *
 * 实现约束：本函数只调用 m03SemanticIssue 已经在用的同一批判定函数，不重写任何谓词——
 * 安全规则在本仓库只存在一份。isSafetyReason 由调用方注入（diagnosis-rejection-tiers 的
 * rejectionTier），使分级表保持唯一事实来源，且本文件不反向依赖它、不产生循环引用。
 * 默认谓词为 () => true（全部视为安全承重），漏注入时退化为完全等价于绝对否决，fail-closed。
 *
 * 维护要求：往 m03SemanticIssue 里新增任何安全承重检查时，必须同步加到这里。
 */
/**
 * M03 硬安全合同。调用方传入的 isSafetyReason 谓词**必须**生效：此前它被 `void` 掉，
 * 于是本函数把 tier 表明确判为非安全的码（chain_incomplete=T2）也当作硬安全项返回，
 * 而带批注受理的前提是 safetyIssue 为空 —— 两个判定源对同一个码给出相反结论，
 * 结果是整条受理路径成为死代码（实测线上从未触发过一次），凡是链节点措辞不稳的病例
 * 一律归零，医生拿不到任何辨证结果。
 *
 * 跳过非安全码后**继续检查后续项**，而不是就此返回 undefined —— 否则一个靠前的非安全码
 * 会掩盖它后面真正的安全项（如事实接地失败），那才是危险的放宽。
 */
export function m03SafetyContractIssue(
  reasoning: M03ReasoningLike | null | undefined,
  clinicalContext = "",
  isSafetyReason: (reason: string) => boolean = () => true,
): string | undefined {
  const skipped = new Set<string>();
  for (let guard = 0; guard <= 24; guard += 1) {
    const issue = m03HardContractIssue(reasoning, clinicalContext, skipped);
    if (!issue) return undefined;
    // 谓词只能放宽**文档质量类**的码，绝不能放宽硬安全集合：传入一个恶意或有缺陷的
    // 「全部非安全」谓词时，stage/formula_not_null/chain_empty/事实接地失败等仍必须绝对阻断。
    // 若内部再次给出已跳过的码，说明它不响应跳过——直接返回，宁可严格也不空转。
    if (m03NonWaivableSafetyCode(issue) || skipped.has(issue) || isSafetyReason(issue)) return issue;
    skipped.add(issue);
  }
  return undefined;
}

/**
 * 不可豁免的 M03 硬安全码。清单是白名单的补集写法：除了这里列出的文档质量类可由分级谓词
 * 放宽（目前只有 chain_incomplete——链存在、仅个别节点措辞不稳，带批注受理比整份归零更有价值），
 * 其余一律绝对阻断。新增检查项默认落进不可豁免侧（default-deny）。
 */
function m03NonWaivableSafetyCode(code: string): boolean {
  const WAIVABLE = new Set(["chain_incomplete"]);
  return !WAIVABLE.has(code);
}

function m03HardContractIssue(
  reasoning: M03ReasoningLike | null | undefined,
  clinicalContext: string,
  skipped: ReadonlySet<string>,
): string | undefined {
  const emit = (code: string): string | undefined => (skipped.has(code) ? undefined : code);
  if (!reasoning || reasoning.stage !== "diagnose") return "stage";
  const chain = reasoning.pathogenesis?.chain || [];
  if (reasoning.formula != null) { const e = emit("formula_not_null"); if (e) return e; }
  if (m03ContainsDoseLevelInstruction(reasoning)) { const e = emit("dose_level_content"); if (e) return e; }
  if (!chain.length) { const e = emit("chain_empty"); if (e) return e; }

  // Hard M03 safety is deliberately narrower than the full documentation-quality contract.
  // A Western evidence-list formatting defect, a missing optional location/nature classification,
  // or an incomplete differential paragraph must never erase a grounded TCM chain. What remains
  // load-bearing is: a real non-placeholder syndrome, a non-empty fact→mechanism→therapy chain,
  // exact chart grounding/polarity, and an actionable follow-up safety net.
  const syndrome = typeof reasoning.overview?.primarySyndrome === "string"
    ? reasoning.overview.primarySyndrome.trim()
    : "";
  if (!syndrome || isUnstableM03CoreText(syndrome)) { const e = emit("primary_syndrome_unstable"); if (e) return e; }
  const overallPathogenesis = typeof reasoning.overview?.overallPathogenesis === "string"
    ? reasoning.overview.overallPathogenesis.trim()
    : "";
  if (!overallPathogenesis || isUnstableM03CoreText(overallPathogenesis)) { const e = emit("overall_pathogenesis_unstable"); if (e) return e; }
  const overallMethod = typeof reasoning.therapy?.overallMethod === "string"
    ? reasoning.therapy.overallMethod.trim()
    : "";
  if (!overallMethod || isUnstableM03CoreText(overallMethod)) { const e = emit("therapy_method_missing"); if (e) return e; }
  if (chain.some((item) =>
    typeof item.patientFact !== "string" ||
    !item.patientFact.trim() ||
    typeof item.syndromeEvidence !== "string" ||
    !item.syndromeEvidence.trim() ||
    typeof item.pathogenesis !== "string" ||
    isUnstableM03CoreText(item.pathogenesis) ||
    typeof item.therapyDirection !== "string" ||
    isUnstableM03CoreText(item.therapyDirection)
  )) { const e = emit("chain_incomplete"); if (e) return e; }
  if (chain.every((item) => isNeutralTongueOnlyFact(item.patientFact))) { const e = emit("neutral_tongue_only"); if (e) return e; }
  if (clinicalContext && !hasCurrentPositiveTcmAnchor(reasoning)) { const e = emit("tcm_syndrome_current_fact_missing"); if (e) return e; }
  if (clinicalContext) {
    const groundingIssue = ungroundedPatientFactReason(reasoning, clinicalContext);
    if (groundingIssue) { const e = emit(groundingIssue); if (e) return e; }
  }
  if (!isActionableFollowupSafetyNet(reasoning.management?.followupSafetyNet)) { const e = emit("followup_safety_net_not_actionable"); if (e) return e; }
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
      herbs?: Array<{ name?: unknown; dose?: unknown; role?: unknown; prescriptionRole?: unknown; targetKind?: unknown; targetRef?: unknown; structureRole?: unknown; targetPathogenesis?: unknown; function?: unknown; isToxic?: unknown; decoctionRequirement?: unknown }>;
      decoction?: {
        doseCount?: unknown;
        dosesPerDay?: unknown;
        administrationTimesPerDay?: unknown;
        method?: unknown;
        course?: unknown;
        followUpNode?: unknown;
      };
    }>;
    modifications?: Array<{ trigger?: unknown; targetPathogenesis?: unknown; action?: unknown; doseOrHandling?: unknown; reason?: unknown; riskNote?: unknown }>;
  } | null;
  nonPharma?: {
    diet?: unknown;
    lifestyle?: unknown;
    emotion?: unknown;
    tcmTreatments?: Array<{ projectCode?: unknown; targetRef?: unknown; targetPathogenesis?: unknown; assessmentPositioning?: unknown; protocolStatus?: unknown; protocolGap?: unknown; treatmentContent?: unknown; suggestedSitesOrPoints?: unknown; scheduleSuggestion?: unknown; techniqueBoundary?: unknown; protocolSource?: unknown; operatorRequirement?: unknown; requiredChecks?: unknown; availability?: unknown; riskLevel?: unknown; recommendationMode?: unknown; executable?: unknown; clinicianReviewRequired?: unknown }>;
    // 刻意不声明 precautions：合同层不校验注意事项，声明它只会诱导后人在这里加驳回码。
  } | null;
};

function normalizedModificationTrigger(value: string): string {
  return value
    .replace(/^(?:患者|主诉|现病史|问诊补充|当前|目前)[：:\s]*/g, "")
    .replace(/[\s，,。；;：:、（）()【】\[\]“”"']/g, "")
    .trim();
}

function finalModificationTriggerGrounded(trigger: string, prior?: M03ReasoningLike | null): boolean {
  if (!prior) return false;
  if (/(?:^|[，,；;])\s*(?:若|如|当|一旦)|复诊时|接诊时核实|症状变化时|出现时|加重时|未缓解时|以后出现/.test(trigger)) return false;
  const normalizedTrigger = normalizedModificationTrigger(trigger);
  if (normalizedTrigger.length < 2) return false;
  const anchors = [
    ...nonEmptyStringList(prior.overview?.primarySyndromeBasis),
    ...nonEmptyStringList(prior.westernDiagnosis?.primary?.supportingFacts),
    ...(prior.pathogenesis?.chain || []).flatMap((node) => typeof node.patientFact === "string" ? [node.patientFact] : []),
  ];
  return anchors.some((anchor) => {
    const normalizedAnchor = normalizedModificationTrigger(anchor);
    return normalizedAnchor.length >= 2 && (
      normalizedTrigger.includes(normalizedAnchor) || normalizedAnchor.includes(normalizedTrigger)
    );
  });
}

type TcmTherapyConcept =
  | "qi_tonify" | "blood_nourish" | "calm_spirit" | "spleen_support"
  | "qi_regulate" | "heat_clear" | "phlegm_resolve" | "damp_resolve"
  | "yang_warm" | "yin_nourish" | "exterior_release" | "blood_move"
  | "purge" | "astringe" | "hemostasis" | "cough_relieve"
  | "food_resolve" | "wind_extinguish" | "orifice_open" | "mass_soften"
  | "menstrual_regulate";

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
  ["qi_tonify", /补(?:中|脾|肺|肾)?气|益(?:中|脾|肺|肾)?气|大补元气|扶正|升阳|举陷|固表|培[元本土]|补虚|益胃|扶脾|健胃|补火|补益法?(?![^，。；;]*(?:精|阴|血))|扶元|益火生土|提壶揭盖/],
  ["blood_nourish", /养(?:心|肝)?血|补(?:心|肝)?血|益血|生血|补血|和血|调营|养营|滋血|补益精血|理血/],
  ["calm_spirit", /安神|宁心|宁神|养心|定志|镇惊|安魂|定魄|重镇|清心除烦/],
  ["spleen_support", /健脾|补脾|益脾|补益心脾|健运|运化|运脾|醒脾|调理脾胃|调理肠胃|养胃和中|和中|抑肝扶脾|理脾/],
  ["qi_regulate", /理气|行气|疏肝|解郁|开郁|调畅气机|下气|降气|宽中|除满|消胀|除痞|行滞|破气|顺气|和胃|降逆|宽胸|调气|利气|宣通气机|辛开苦降|舒筋|宣痹|疏泄|和解|表里双解|平调寒热|寒温并用|开达膜原|交通心肾|逆流挽舟|开噤|通关|调和营卫|调和肝脾/],
  ["heat_clear", /清热|泻火|凉血|解毒|辛凉|清[泄泻宣透利](?!湿)|清(?:肺|肝|心|胃|营|暑|肠|胆|骨|金|气|血)|泄热|退热|除烦|降火|潜降虚火|泻[肺肝心胃肠胆火]|清化(?![^，。；;]{0,2}痰)|清解|气血双清|泻南补北|佐金平木/],
  ["phlegm_resolve", /化痰|祛痰|涤痰|豁痰|消痰|化饮|蠲饮|除痰|截疟|涌吐|吐法|催吐|消石/],
  ["damp_resolve", /利湿|渗湿|利水|祛湿|燥湿|化湿|化寒湿|散寒湿|除湿|分消|逐水|退黄|化浊|泄浊|利尿|通淋|渗利|淡渗|祛暑|清暑|开鬼门|洁净府|滑利窍道|宣通三焦/],
  // 同构：温补类动词与「阳」被脏腑名隔开（补肾壮阳、温补肾阳已可解析，补肾壮阳此前不能）。
  ["yang_warm", /温阳|扶阳|回阳|散寒|辛温|温(?:中|肾|里|肺|经|化|补|通|养)|补阳|[温补][补益]?[肾脾心]{1,2}阳|壮阳|益火|引火归[原元]|辛甘化阳|温脏|暖宫|温下/],
  // 「补益动词 + 脏腑 + 阴阳」是中医治法的高频构词，动词与「阴」被脏腑名隔开：
  // 滋补肾阴、滋养肝阴、滋补肝肾、补益肝肾、滋肾养肝。原正则只认紧邻的「滋阴/补阴」，
  // 这些写法一律解析为空集 —— 实测腰痛-肾阴虚：M03 治法「滋补肾阴，壮水制火」，
  // M04 的 requiredTherapyConcepts 为空，整方以 transparent_therapy_unresolved 作废、0 味。
  // 脏腑名用有限枚举而不是通配，避免把无关文本吞进来。
  ["yin_nourish", /滋阴|养阴|育阴|生津|增液|补阴|润燥|润肺|濡润|清燥|[滋养补][补养益]?[肝肾心肺胃脾]{1,2}阴|[滋补][补养益]?[肝肾心肺胃脾]{1,2}(?=[肝肾心肺胃脾])|补益[肝肾心肺脾][肝肾心肺脾]|滋[肝肾][养补][肝肾]|壮水|大补真阴|坚阴|酸甘化阴|金水相生|滋补[肾精]{1,2}|补[肾益]{1,2}精|益精|填精/],
  ["exterior_release", /解表|祛风|疏风|疏散风邪|疏风散邪|发散风寒|发散风热|疏散风热|凉散风热|疏风散热|散风|解肌|透疹|透表|发汗|疏解|辛散|求汗|轻宣|宣散|治风法/],
  // 通经(?!脉)：「通经」作为活血概念指通(月)经、通经络；而「温通经脉」是「温通 + 经脉」，
  // 表达的是温阳通脉，不是活血。两者只差一个「脉」字，方向却不同。少了这个否定前瞻，桂枝的
  // 药典功用句「温通经脉，助阳化气」会让它在**肾阳虚证（治法：温补肾阳，化气利水）**里被判
  // 「活血方向未成立」而驳回——桂枝正是金匮肾气丸的法定组成，M03 也确实锁了金匮肾气丸。
  // 实测驳回码：candidate_0_transparent_therapy_herb_4_unsupported_high_impact_yang_warm_blood_move。
  ["blood_move", /活血|化瘀|行瘀|破血|祛瘀|散瘀|消瘀|逐瘀|行血|化癥|消癥|破癥|通脉|通络|和络|通经(?!脉)|(?:气血|血行|血脉)(?:运行|畅行|周行|流通)|调[和畅][^，。；;]{0,6}气血/],
  ["purge", /通便|泻下|攻下|逐水|通腑|急下|消导法?|杀虫|驱蛔|安蛔|以毒攻毒/],
  // 固经/固冲/固摄/止崩 与 摄血：妇科调固类治法。这些动词上一轮已进 TCM_THERAPY_ANCHOR
  //（管 M03 病机链锚定），但概念表没同步——M03 治法「调理冲任，固经调冲」通过链锚定后，
  // M04 侧 requiredTherapyConcepts 解析为空集，每一版候选都被 transparent_therapy_unresolved
  // 整方驳回（实测 月经先期-血热 三连拒 0 味）。锚点表与概念表是同一词汇域的两张投影，
  // 扩一张必须同步另一张（test-therapy-vocabulary-sync 的 GYN_THERAPY_PHRASES 钉住本类）。
  ["astringe", /收涩|敛汗|固涩|固精|止带|固经|固冲|固摄|止崩|涩肠|涩精|固脱|固护|固脬|缩尿|止遗|敛[肺阴疮]|收敛/],
  ["hemostasis", /止血|凉血止血|化瘀止血|摄血/],
  ["cough_relieve", /止咳|平喘|宣肺|肃肺|降肺|开宣肺气|宣(?:通|畅|降)肺气|纳气|敛肺|降气|定喘/],
  ["food_resolve", /消食|导滞|健胃|消积|化积|消谷|运食/],
  ["wind_extinguish", /息风|熄风|止痉|解痉|平肝|潜阳|定痫|定惊|镇肝|柔肝/],
  ["orifice_open", /开窍|醒神/],
  ["mass_soften", /软坚|散结/],
  // 调经/调冲任：妇科月经病的核心治法方向（非高影响）。没有它，「调理冲任」类治法解析不出
  // 任何概念，M04 的方向覆盖与配伍正向相关全部失效；当归/香附/益母草等「调经」功用药也无法
  // 以该方向落实正向相关。
  ["menstrual_regulate", /调经|调冲任|理冲任|调理冲任|调摄冲任|安冲|调冲|安胎|通乳|种子|下胎|催生/],
];

function tcmTherapyConcepts(text: string): Set<TcmTherapyConcept> {
  return new Set(TCM_THERAPY_CONCEPTS.filter(([, pattern]) => pattern.test(text)).map(([concept]) => concept));
}

export function affirmedTcmTherapyConcepts(text: string): Set<TcmTherapyConcept> {
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

// 高影响门的**药侧触发**收窄口径。治法侧的方向声明判定（affirmedTcmTherapyConcepts）仍用
// TCM_THERAPY_CONCEPTS 全口径：治法写「润肠通便」时 purge 照常算已声明，麻子仁丸类不受影响；
// 君药方向覆盖（emperor_*）与配伍正向相关也不经本表，当归仍可按养血/和血方向入方。
//
// 收窄依据（对 695 味知识库全量审计，见 test-therapy-vocabulary-sync 的触发侧钉表）：
// - 润肠通便：润下类兼功（当归/桃仁/苦杏仁/肉苁蓉/黑芝麻/核桃仁/锁阳/亚麻子/罗汉果，仅此
//   9 味变化），不构成攻下身份；真攻下（大黄「泻下攻积」/芒硝/甘遂「逐水」/番泻叶）经
//   泻下|攻下|逐水 或「泻下药」分类照常触发。实测反例：心脾两虚锁定归脾汤后，方中当归被判
//   unsupported_high_impact_blood_move_purge，透明降级路径整方 0 味。
// - 补血活血/养血活血：和血类固定搭配（全量审计仅当归变化），不构成破血逐瘀身份；丹参
//   「活血祛瘀」、川芎「活血行气」的独立「活血」照常触发。
// 模型显式为该味声明了高影响方向时（intended 命中），收窄失效、门禁照常执行。
const HIGH_IMPACT_HERB_TRIGGER_OVERRIDES: ReadonlyArray<[TcmTherapyConcept, RegExp]> = [
  ["blood_move", /(?<!补血)(?<!养血)活血|化瘀|行瘀|破血|通经(?!脉)|(?:气血|血行|血脉)(?:运行|畅行|周行|流通)|调[和畅][^，。；;]{0,6}气血/],
  ["purge", /(?<!润肠)通便|泻下|攻下|逐水|通腑/],
];

/**
 * 在药材知识文本（功用 ∪ 分类 ∪ 风险画像）上，共享词表命中但触发口径不命中的高影响方向。
 * 这些方向从该药的高影响**身份**里剔除；显式声明（intended）该方向时不剔除，门禁照常。
 */
function highImpactTriggerNarrowedOut(
  name: string,
  intended?: ReadonlySet<TcmTherapyConcept> | null,
): Set<TcmTherapyConcept> {
  const text = [
    herbKnowledgeFunctionText(name),
    ...getTcmHerbFunctionCategories(name),
    getTcmHerbRiskProfile(name),
  ].join("；");
  const out = new Set<TcmTherapyConcept>();
  for (const [concept, trigger] of HIGH_IMPACT_HERB_TRIGGER_OVERRIDES) {
    if (intended?.has(concept)) continue;
    const shared = TCM_THERAPY_CONCEPTS.find(([item]) => item === concept)?.[1];
    if (shared?.test(text) && !trigger.test(text)) out.add(concept);
  }
  return out;
}

function herbKnowledgeFunctionText(name: string): string {
  // Controlled pharmacopoeia supplements live in tcm-knowledge so every consumer (validator,
  // reviewer payload, prompt shortlist and visible table) uses one authoritative function text.
  return getTcmHerbFunctionText(name);
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
  const narrowedOut = highImpactTriggerNarrowedOut(name, intendedConcepts);
  return new Set([...categoryConcepts, ...intendedKnowledgeConcepts, ...governedConcepts, ...opposingKnowledgeConcepts]
    .filter((concept) => HIGH_IMPACT_THERAPY_CONCEPTS.has(concept) && !narrowedOut.has(concept)));
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
  const concrete = [
    primaryNode?.therapyDirection,
    prior?.therapy?.overallMethod,
  ].map((value) => String(value || "").trim()).filter(Boolean).join("；");
  return affirmedTcmTherapyConcepts(concrete || String(prior?.therapy?.overallPrinciple || ""));
}

// Current-heat facts documented in the signed M03 payload's own grounded fields: verbatim chain
// anchors, syndrome basis, western supporting facts, resolution reasons and uncertainty notes all
// carry record fragments. When any affirmed (non-negated) clause documents heat polarity, a
// heat_clear high-impact herb counts as supported even when the M03 therapy vocabulary does not
// literally contain 清热 verbs (e.g. 平肝潜阳 for 肝阳上亢 with 舌红苔薄黄 in the record).
// Conservative scope: only heat_clear gets this documented-facts channel — it stays high-impact,
// undocumented usage still rejects, and the opposing-direction invariant below is unchanged.
const GROUNDED_HEAT_FACT_PATTERN = /舌红|舌绛|苔黄|苔燥|少津|口干|口苦|口渴|潮热|盗汗|心烦|烦躁|尿黄|小便黄|大便秘结|便秘|发热|面红|目赤|咽痛|牙龈肿痛|脉数/;

// 「锁定方 + 基于症状的加减」是本产品的既定需求：医生开的是「麻黄汤加川芎」，川芎冲的是
// 患者已记录的**头身疼痛**，不是冲 M03 治法文本里有没有「活血」二字。此前高影响方向的成立
// 依据只认两样：M03 治法文本，以及仅对 heat_clear 开放的症状事实通道。于是一味有明确症状
// 指征的加味药会被判「方向未成立」，连带整张方作废——实测感冒-风寒束表锁麻黄汤：基准四味
// 齐全、川芎针对「头身疼痛」，全方 0 味。
//
// 因此把 heat_clear 那条既有通道推广成**全部高影响方向共用**的症状事实支撑表。这不是放宽
// 安全面，而是补回一条本该存在的成立依据：
//   · 事实来源仍限签名 M03 的 grounded 字段（chain 的 patientFact/syndromeEvidence、主证依据、
//     西医支持事实、病位病性判定理由与不确定项），不接受模型自由文本；
//   · 否定从句照常排除（「无口干」不支撑清热）；
//   · **对立方向一票否决不变**：清热证里的温阳药、温阳证里的清热药照旧驳回（OPPOSING 分支）；
//   · 剂量上下限、十八反十九畏、特殊人群、灵犀审方一条不减，君药方向仍须与 P1 对齐。
const THERAPY_CONCEPT_FACT_SUPPORT: ReadonlyArray<readonly [TcmTherapyConcept, RegExp]> = [
  ["heat_clear", GROUNDED_HEAT_FACT_PATTERN],
  // 痛证与瘀象是活血类加味的经典指征（川芎治头身痛、丹参治胸痹刺痛）。
  ["blood_move", /头痛|头身疼痛|身痛|身疼|肢体疼痛|关节疼痛|刺痛|痛处固定|夜间痛甚|拒按|舌暗|舌紫|紫暗|瘀斑|瘀点|舌下络脉|血块|经血有块|痛经|肌肤甲错|面色晦暗|脉涩|癥瘕|包块/],
  // 腑实/便秘是通下类加味的指征。
  ["purge", /便秘|大便秘结|大便干|大便干结|大便硬|数日未(?:解|行)|腹胀满|腹满痛|腹痛拒按|矢气不通|苔黄燥|苔焦/],
  // 寒象是温阳类加味的指征。**只收特异性里寒征**：舌淡、苔白、脉沉细在血虚/气虚里同样常见
  //（实测「舌淡脉细」的心肝血虚失眠，若把舌淡计入，附子会被判方向成立而放行——那是误放行）；
  // 恶寒同理排除，它是表证的主症，对应治法是解表而非温里。
  ["yang_warm", /畏寒|形寒|肢冷|四肢不温|手足不温|喜温(?:喜按|饮)?|得温则(?:减|舒|缓)|遇冷加重|冷痛|脘腹冷|五更泻|完谷不化|下利清谷|小便清长/],
  // 神昏窍闭是开窍类加味的指征。**只收真窍闭**：健忘、失眠多梦、心神不宁属安神范畴，
  // 让它们支撑开窍会把麝香、冰片一类放进普通失眠方。
  ["orifice_open", /神昏|昏迷|昏蒙|意识不清|谵语|窍闭|牙关紧闭|不省人事|中风闭证/],
  // 结块痰核是软坚散结类加味的指征。
  ["mass_soften", /瘰疬|痰核|癥瘕|积聚|包块|结节|肿块|甲状腺肿|乳癖|肝脾肿大/],
];

/**
 * 签名 M03 已记录事实所支撑的高影响治法方向（症状指征通道）。
 * 与治法文本通道并列：两者任一成立即视为该方向已成立。
 */
function priorDocumentedFactConcepts(prior: M03ReasoningLike | null | undefined): Set<TcmTherapyConcept> {
  const supported = new Set<TcmTherapyConcept>();
  const texts = groundedM03FactText(prior);
  if (!texts) return supported;
  for (const clause of clinicalClauses(texts)) {
    if (isNegatedClinicalClause(clause)) continue;
    for (const [concept, pattern] of THERAPY_CONCEPT_FACT_SUPPORT) {
      if (pattern.test(clause)) supported.add(concept);
    }
  }
  return supported;
}

/** 签名 M03 里可作为患者事实依据的 grounded 字段全集（两条支撑通道共用，避免口径漂移）。 */
function groundedM03FactText(prior: M03ReasoningLike | null | undefined): string {
  if (!prior) return "";
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
  return [
    ...(pathogenesis?.chain || []).flatMap((node) => [node.patientFact, node.syndromeEvidence]),
    ...(Array.isArray(overview?.primarySyndromeBasis) ? overview!.primarySyndromeBasis! : [overview?.primarySyndromeBasis]),
    ...(Array.isArray(westernPrimary?.supportingFacts) ? westernPrimary!.supportingFacts! : []),
    pathogenesis?.locationDifferentiation?.resolutionReason,
    pathogenesis?.locationDifferentiation?.basis,
    pathogenesis?.natureDifferentiation?.resolutionReason,
    pathogenesis?.natureDifferentiation?.basis,
    ...uncertaintyTexts,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
}

type HighImpactHerbLike = {
  name?: unknown;
  dose?: unknown;
  role?: unknown;
  prescriptionRole?: unknown;
  targetKind?: unknown;
  targetRef?: unknown;
  structureRole?: unknown;
  targetPathogenesis?: unknown;
  function?: unknown;
};

type ControlledCounterAssistanceStructure = {
  secondaryHerb: string;
  primaryHerb: string;
  requiredPrimaryConcept: TcmTherapyConcept;
  signedContext: RegExp;
  primaryDose: readonly [number, number];
  secondaryDose: readonly [number, number];
  minimumPrimaryToSecondaryRatio: number;
};

// Product-level counter-assistance governance. A prose label such as “反佐” grants no authority:
// the signed M03 context, paired ingredients, principal/secondary roles, structure target, and
// bounded dose relationship must all match. Add future verified pairs here instead of weakening the
// global cold/heat polarity invariant or accumulating case-text exceptions.
const CONTROLLED_COUNTER_ASSISTANCE_STRUCTURES: readonly ControlledCounterAssistanceStructure[] = [{
  secondaryHerb: "吴茱萸",
  primaryHerb: "黄连",
  requiredPrimaryConcept: "heat_clear",
  signedContext: /肝胃郁热|肝火(?:犯胃|横逆)|胃(?:热|火)[^；。]{0,16}(?:气逆|上逆|失降)/,
  primaryDose: [4, 5],
  secondaryDose: [2, 2],
  minimumPrimaryToSecondaryRatio: 2,
}];

function isControlledCounterAssistanceHerb(
  herbs: ReadonlyArray<HighImpactHerbLike>,
  herbIndex: number,
  prior: M03ReasoningLike | null | undefined,
  requiredConcepts: ReadonlySet<TcmTherapyConcept>,
): boolean {
  const secondary = herbs[herbIndex];
  const rule = CONTROLLED_COUNTER_ASSISTANCE_STRUCTURES.find((item) =>
    canonicalTcmHerbIdentity(secondary?.name) === item.secondaryHerb
  );
  if (!rule || !prior || !requiredConcepts.has(rule.requiredPrimaryConcept)) return false;
  const signedContext = [
    prior.overview?.primarySyndrome,
    prior.overview?.overallPathogenesis,
    prior.therapy?.overallPrinciple,
    ...(prior.pathogenesis?.chain || []).flatMap((node) => [node.pathogenesis, node.therapyDirection]),
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
  if (!rule.signedContext.test(signedContext)) return false;
  if (
    secondary.role !== "佐" ||
    secondary.targetKind !== "formula_structure" ||
    secondary.targetRef !== "FORMULA_STRUCTURE" ||
    secondary.structureRole !== "temper"
  ) return false;
  const secondaryDose = typeof secondary.dose === "string" ? doseInGrams(secondary.dose) : undefined;
  if (secondaryDose == null || secondaryDose < rule.secondaryDose[0] || secondaryDose > rule.secondaryDose[1]) return false;
  const primary = herbs.find((item) =>
    canonicalTcmHerbIdentity(item.name) === rule.primaryHerb &&
    item.role === "君" &&
    item.targetKind === "pathogenesis_node" &&
    item.targetRef === "P1"
  );
  const primaryDose = typeof primary?.dose === "string" ? doseInGrams(primary.dose) : undefined;
  return primaryDose != null &&
    primaryDose >= rule.primaryDose[0] &&
    primaryDose <= rule.primaryDose[1] &&
    primaryDose / secondaryDose >= rule.minimumPrimaryToSecondaryRatio;
}

function unsupportedHighImpactHerbIssue(
  herbs: ReadonlyArray<HighImpactHerbLike>,
  prior: M03ReasoningLike | null | undefined,
  allowGovernedFormulaBaseline = false,
  selectedFormulaNames: readonly string[] = [],
): string | undefined {
  const required = requiredTherapyConcepts(prior);
  // 症状指征通道：M03 治法文本未明写该方向时，签名病历里的对应症状事实同样构成成立依据
  //（锁定方 + 基于症状的加减）。对立方向否决在下方独立执行，不受本通道影响。
  const factSupported = priorDocumentedFactConcepts(prior);
  // 基准组成豁免必须按**药材身份**比对，不能按原始字符串：基准写「当归身」「择细黄连」这类
  // 饮片/部位名，模型按规范名写「当归」「黄连」，字符串相等永远对不上——实测清胃散被 M03 锁定后，
  // 它自己的当归仍以 blood_move 被驳回，整方 0 味。canonicalTcmHerbIdentity 两侧同归一，
  // 当归身与当归收敛到同一身份；解析不了的名字保持原样，不会误并。
  const governedFormulaIngredients = allowGovernedFormulaBaseline
    ? new Set(executableFormulaCompilationReferences(
        selectedFormulaNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim())),
      ).flatMap((formula) => formula.ingredients).map((name) => canonicalTcmHerbIdentity(name)))
    : new Set<string>();
  for (const [index, herb] of herbs.entries()) {
    const herbName = String(herb.name || "").trim();
    if (governedFormulaIngredients.has(canonicalTcmHerbIdentity(herbName))) continue;
    if (isControlledCounterAssistanceHerb(herbs, index, prior, required)) continue;
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
      ...[...highImpact].filter((concept) => !required.has(concept) && !factSupported.has(concept)),
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

/**
 * 单味药的高影响方向判定，入参是**完整候选行**而不是拼接后的功用串。
 *
 * 确定性剔除必须与门禁走同一个入口：门禁读 prescriptionRole/targetPathogenesis（并剥离
 * 「知识库功用：」尾巴、排除占位符），而按字符串拼接再调 highImpactHerbDirectionIssue 只会
 * 落到 herb.function 分支，两条口径判定不一致——该剔的没剔，门禁照样驳回，整方仍然作废
 *（实测感冒-风寒束表：前胡 heat_clear 未成立，剔除未命中，全方 0 味）。
 */
export function m04HerbDirectionIssue(
  herb: HighImpactHerbLike,
  prior: M03ReasoningLike | null | undefined,
  allowGovernedFormulaBaseline = false,
  selectedFormulaNames: readonly string[] = [],
): string | undefined {
  return unsupportedHighImpactHerbIssue([herb], prior, allowGovernedFormulaBaseline, selectedFormulaNames);
}

/**
 * 药味「身份级」高影响方向 = 功能分类 ∪ 风险画像 ∪ 受治理高影响映射。
 *
 * 与 herbHighImpactConcepts 的关键区别：**不看合并功用文本里顺带提到的次要功效**。
 * 中药功用文本天然复合（石菖蒲「化湿开胃，化痰开窍，解毒杀虫，益心益智」、安息香「开窍醒神，
 * 行气活血」），把整段功用文本当成「本方声明的方向」会把全部次要功效升格为高影响声明。
 * 该药真正进入本方时承担的是它被列入的那个方向：编译层把 prescriptionRole 写成
 * `${role}药：${node.therapyDirection}`，验证层 unsupportedHighImpactHerbIssue 看到的就是
 * 该 M03 治法方向，而不是全功用文本。分类/风险/受治理映射是这味药的身份，才是短名单该看的。
 */
function herbIdentityHighImpactConcepts(name: string): Set<TcmTherapyConcept> {
  return new Set([
    ...tcmTherapyConcepts(getTcmHerbFunctionCategories(name).join("；")),
    // 功用文本必须进这个集合。本地分类词表的粒度不足以承载「身份级方向」这个判断：乌药、九香虫、
    // 刀豆、土木香在分类词表里**只标了「理气药」**，它们的温里作用（温肾散寒／温中／温中下气／
    // 温中理气）只存在于功用文本里。只看分类词会让这四味药在纯理气证（P1=胃气上逆、治法仅
    // 「和胃降逆」，M03 未确立温阳方向）的短名单里放行——把未成立的高影响方向送进君药候选。
    // scripts/test-tcm-formula-provenance.mjs 的
    // assert.doesNotMatch(理气方向短名单, /乌药|九香虫|刀豆|土木香/) 就是这条不变量。
    //
    // 合并功用文本确实嘈杂（getTcmHerbFunctionText 会把历史条文按分数重排后取前 5 条），
    // 石菖蒲的「解毒杀虫」被算成 heat_clear 是真实的误杀。但解法不是在这里整体调松——那会
    // 连同上面四味药一起放行。误杀按**逐味受控治理**处理：把该药的药典功用句写进
    // tcm-knowledge.ts 的 CONTROLLED_HERB_FUNCTION_TEXT（玉竹、柴胡已是先例），
    // 让这一味药的功用面回到药典口径，而不是让全部药味的方向门禁一起降级。
    ...tcmTherapyConcepts(herbKnowledgeFunctionText(name)),
    ...tcmTherapyConcepts(getTcmHerbRiskProfile(name)),
    ...getTcmHerbGovernedHighImpactConcepts(name),
  ].filter((concept) => HIGH_IMPACT_THERAPY_CONCEPTS.has(concept)));
}

/**
 * M04 君药/药味短名单的方向准入判定（选择引导，不是安全裁决，故返回 boolean 而不是驳回码）。
 *
 * 这里刻意不复用 highImpactHerbDirectionIssue：短名单原先把**整段合并功用文本**当
 * declaredFunction 传进去，等于宣称「这味药在本例里要发挥它记载过的全部作用」，于是
 * herbHighImpactConcepts 里 intendedConcepts === fullFunctionConcepts，declaredFunction 的
 * 区分机制被完全短路。结果是短名单比它本该预测的那个校验器**更严**：最正统的开窍药石菖蒲
 * 因功用文本含「解毒杀虫」被判 heat_clear 未成立而剔除，安息香因「行气活血」被剔除，开窍
 * 方向只剩 1 味可选——纯属自伤。
 *
 * 两条安全控制原样保留、没有任何放宽：
 * 1) 身份级高影响方向未在 M03 锁定治法（或已记录热象事实）中成立 ⇒ 不进短名单
 *    （鳖甲 governed=mass_soften、红豆蔻/黄连的清热分类在温里病例里仍被挡）。
 * 2) 寒热极性不变量取**全知识面**（功用文本 + 分类 + 风险），与已锁定方向相反的高影响概念
 *    一票否决——「温里病例里混进清热药」这类错误照旧拦截。
 */
export function herbShortlistDirectionEligible(
  herbName: string,
  prior: M03ReasoningLike | null | undefined,
): boolean {
  const required = requiredTherapyConcepts(prior);
  if (required.size === 0) return false;
  // 正向相关性：这味药必须至少落实一条本例已成立的治法方向。此前这里只有「排除」没有「相关」，
  // 一味与本例毫不相干、又恰好没有高影响作用的药可以一路畅通——实测心脾两虚（补益心脾，养血安神）
  // 病例里麻黄判为可任君药，因为它的解表/止咳都不在高影响集内。调用方按方向分桶掩盖了这个洞，
  // 但准入判定本身不该依赖调用方的分桶才成立。
  if (![...herbTherapyConcepts(herbName)].some((concept) => required.has(concept))) return false;
  const factSupported = priorDocumentedFactConcepts(prior);
  const unsupportedIdentity = [...herbIdentityHighImpactConcepts(herbName)].some((concept) =>
    !required.has(concept) && !factSupported.has(concept));
  if (unsupportedIdentity) return false;
  return ![...herbTherapyConcepts(herbName)].some((concept) =>
    HIGH_IMPACT_THERAPY_CONCEPTS.has(concept) &&
    OPPOSING_THERAPY_CONCEPTS.some(([left, right]) =>
      (concept === left && required.has(right)) || (concept === right && required.has(left))));
}

/**
 * 风险画像里真正属于「风险」的那一段。
 *
 * getTcmHerbRiskProfile 返回 `风险类目；中文风险描述；分类；分类…`，尾部只是把功能分类又抄了
 * 一遍。整串取概念会让分类字段的噪声混进风险信号：龙眼肉的回声里带着错误的「补阳药」，
 * 于是这味《药典》功用写着「补益心脾，养血安神」的补血药被判成 yang_warm，在心脾两虚病例里
 * 被自己的短名单剔除。分类该由分类字段负责，风险画像只负责它的风险类目
 * （WARMING_INTERIOR / PURGATIVE_ATTACK / BLOOD_STASIS / BITTER_COLD_HEAT_CLEARING /
 * AROMATIC_ORIFICE…），取前两段即可。
 */
function herbRiskClassText(name: string): string {
  return getTcmHerbRiskProfile(name).split("；").slice(0, 2).join("；");
}

/**
 * 药味「受治理身份」的高影响方向 = 功能分类 ∪ 风险类目 ∪ 受治理映射。
 *
 * 与 herbIdentityHighImpactConcepts 只差一处：**不读合并功用文本**。这处差别是有边界依据的，
 * 不是放松——两者回答的是不同的问题：
 *   - 功能分类/风险类目/受治理映射回答「这味药是干什么的」：大黄=攻下药、丹参=活血化瘀药、
 *     黄连=清热药、红豆蔻=温里药、麝香=开窍药、鳖甲=软坚。这是**主要作用**，也是被选进方里的理由。
 *   - 合并功用文本回答「这味药记载过什么」：它是多条历史条文的并集，几乎每味经典药都会顺带
 *     记载一个高影响作用——当归「补血活血」、甘草「清热解毒」、党参「清肺」、山楂「行气散瘀」。
 *     这些是**伴随作用**，不是这味药被开进方里的理由。
 *
 * 把伴随作用当成主要作用来筛，代价是可证的：心脾两虚（治法「补益心脾，养血安神」）病例里，
 * 当归、党参、甘草、龙眼肉会被自己的短名单全部剔除——归脾汤 12 味中的 4 味，医生一眼就能
 * 看出名单是错的，而这正是「中药味数太少」的直接来源。伴随作用真正的风险出口另有其人：
 * 寒热极性一票否决（下方第 3 条，仍取全知识面）、妊娠/出血等特殊人群规则、以及灵犀审方。
 */
function herbCuratedHighImpactConcepts(name: string): Set<TcmTherapyConcept> {
  const narrowedOut = highImpactTriggerNarrowedOut(name);
  return new Set([
    ...tcmTherapyConcepts(getTcmHerbFunctionCategories(name).join("；")),
    ...tcmTherapyConcepts(herbRiskClassText(name)),
    ...getTcmHerbGovernedHighImpactConcepts(name),
  ].filter((concept) => HIGH_IMPACT_THERAPY_CONCEPTS.has(concept) && !narrowedOut.has(concept)));
}

/**
 * 臣佐使配伍候选的方向准入（需求11：药味数尽可能多，但每一味都要合理且有依据）。
 *
 * 与 herbShortlistDirectionEligible（君药面）并列而不是替代它。君药决定全方走向，用「记载过
 * 什么」这种保守口径筛是站得住的——乌药/九香虫/刀豆/土木香的温里作用只写在功用文本里，
 * 让它们做纯理气证的君药确实不该。但同一把尺子量到臣佐使就过界了：配伍药承担的是它被列入的
 * 那个方向，伴随作用不构成选它的理由。
 *
 * 三条准入，各自用有效范围内的信号：
 * 1) **正向相关**（新增）：这味药必须至少落实一条本例已成立的治法方向。原先的短名单只做排除，
 *    从不检查「这味药到底为本例做什么」——一味与本例毫无关系、又恰好没有高影响作用的药可以
 *    一路畅通。需求11 要的是「多且有依据」，依据就落在这一条上。
 * 2) **受治理身份级高影响方向必须成立**：见 herbCuratedHighImpactConcepts。大黄、丹参、黄连、
 *    红豆蔻、附子、麝香、石菖蒲、鳖甲、远志在方向未成立时照旧挡在门外。
 * 3) **寒热极性一票否决**：取全知识面（功用文本 ∪ 分类），与君药面同一条不变量，一字未放宽。
 *    「温里病例里混进清热药」「清热病例里混进温阳药」照旧拦截。
 */
export function herbCombinationDirectionEligible(
  herbName: string,
  prior: M03ReasoningLike | null | undefined,
): boolean {
  const required = requiredTherapyConcepts(prior);
  if (required.size === 0) return false;
  const knowledgeConcepts = herbTherapyConcepts(herbName);
  if (![...knowledgeConcepts].some((concept) => required.has(concept))) return false;
  const factSupported = priorDocumentedFactConcepts(prior);
  const unsupportedIdentity = [...herbCuratedHighImpactConcepts(herbName)].some((concept) =>
    !required.has(concept) && !factSupported.has(concept));
  if (unsupportedIdentity) return false;
  return ![...knowledgeConcepts].some((concept) =>
    HIGH_IMPACT_THERAPY_CONCEPTS.has(concept) &&
    OPPOSING_THERAPY_CONCEPTS.some(([left, right]) =>
      (concept === left && required.has(right)) || (concept === right && required.has(left))));
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
  // 治法解析为空 = **本系统的词表没覆盖到这条治法**，不等于「这张方的治法不成立」。
  // 把能力边界当成临床错误，代价是整方作废、医生一无所获——实测腰痛-肾阴虚就因治法写
  //「滋补肾阴」（受控词表收录、但概念正则当时未覆盖）被判 unresolved、0 味。
  //
  // 国标治法词表共 1240 条，其中 282 条是针灸/推拿/注射/切开等**操作疗法**、42 条是外科
  // 疮疡外治，它们本来就没有对应的药味方向；即便把内服治法覆盖到 96%，仍会有长尾。
  // 因此这里改为：方向核验能力不可用时**跳过该维度**，其余检查（药味知识、剂量边界、
  // 十八反十九畏、特殊人群、君臣结构、灵犀审方）一条不减，并保持医师复核与审方兜底。
  // 这与项目的 fail-closed 一致——fail-closed 是「不放行未经核验的剂量」，
  // 不是「把系统不认识的治法判成错误」。
  const therapyDirectionVerifiable = required.size > 0;
  const primaryRequired = primaryPathogenesisTherapyConcepts(prior);
  const coverageRequired = primaryRequired.size > 0 ? primaryRequired : required;

  const allHerbs = candidate.herbs || [];
  // 与 m04SemanticIssue 里那道同名检查用**同一套豁免**：命名方基准药味不重复判高影响方向。
  // 此前这里少传后两个参数（allowGovernedFormulaBaseline / selectedFormulaNames），于是同一味药
  // 在前一道门按「它是所选经典方的法定组成」放行、在这道门被判「方向未成立」驳回——两道门对同一
  // 张方给出相反结论，M04 只能反复修复直到 120s 编排时限，医生最终拿到的是一页「无法形成处方」。
  //
  // 实测（公开医案，肝阳上亢兼痰热扰心，治法「平肝潜阳，清热化痰，宁心安神」）：
  // m04_candidate_0_transparent_therapy_herb_2_unsupported_high_impact_yang_warm。
  // 触发药是半夏——温化寒痰药，身份带 yang_warm，而它正是温胆汤/黄连温胆汤的核心组成，
  // 原医案用的也是它（方中另有黄芩、竹茹、胆南星等寒凉药制约其温性）。
  // 这不是「把温药塞进热证」，是经典方自身的配伍结构，理应由命名方基准豁免承接。
  // 基准方名取「候选自带 ∪ M03 已锁定」。只看候选自带的那一半在**透明降级**路径上必然为空：
  // 降级的定义就是剥掉方名身份，formulaNames 被清空，于是这张方自己的法定组成失去豁免依据。
  //
  // 实测 10 例甲方测试病历：M03 锁定命名方 6 例，其中 5 例最终 0 味出方，驳回码全是
  // transparent_therapy_*_unsupported_high_impact_*——被判的正是经典方自己的组成
  // （龙胆泻肝汤的当归、清胃散的生地丹皮、六味地黄丸的牡丹皮，都带 blood_move）。
  // 降级是为了不冒用方名，不是为了否定组成；这些药的正当理由来自 M03 锁定的那张方，
  // 剥标签不该连理由一起剥掉。反过来，M03 没锁方时该集合为空，判定与此前完全一致。
  const baselineFormulaNames = [...new Set([
    ...(governedFormulaNames(candidate.formulaNames) || []),
    ...(governedFormulaNames(prior.overview?.recommendedFormulaNames) || []),
  ])];
  const highImpactIssue = unsupportedHighImpactHerbIssue(
    allHerbs,
    prior,
    true,
    baselineFormulaNames,
  );
  if (highImpactIssue) return `transparent_therapy_${highImpactIssue}`;
  const therapeuticHerbs = allHerbs.filter((herb) => herb.targetKind !== "formula_structure");
  if (therapeuticHerbs.length === 0) return "transparent_therapy_herbs_missing";
  const herbConcepts = therapeuticHerbs.map((herb) => herbTherapyConcepts(String(herb.name || "")));
  if (herbConcepts.some((concepts) => concepts.size === 0)) return "transparent_therapy_herb_knowledge_missing";

  const coveredRequired = [...coverageRequired].filter((concept) => herbConcepts.some((concepts) => concepts.has(concept)));
  // 基准方组成身份集：出现在 M03 锁定（或候选自带）经典方法定组成里的药味，其在方中的正当性
  // 来自方剂本身——方剂与证候的对齐已由 M03 的正向充分性核验完成，这里不重复要求它的功用词
  // 再命中治法词表。P1 内核下限与君臣支撑率两处同用这一豁免（六味地黄丸"三补三泻"，
  // 词表口径下只有熟地黄一味纯滋阴，任何按功用词计数的下限都会误伤这类结构）。
  const baselineIngredientIdentities = new Set(
    executableFormulaCompilationReferences(baselineFormulaNames)
      .flatMap((reference) => reference.ingredients)
      .map((name) => canonicalTcmHerbIdentity(name)),
  );
  const herbInBaseline = (index: number): boolean =>
    baselineIngredientIdentities.has(canonicalTcmHerbIdentity(String(therapeuticHerbs[index]?.name || "")));
  const directlySupportingHerbs = herbConcepts.filter((concepts, index) =>
    setsIntersect(concepts, coverageRequired) || herbInBaseline(index)).length;
  // 「已支撑」的口径必须与 unsupportedHighImpactHerbIssue 一致：那里允许一味清热药由**已记录的
  // 热象患者事实**支撑，即使锁定治法文本只写了平肝潜阳。若这里只认锁定治法，同一味药会被上一道
  // 门放行、被下一道门驳回——医生看到的是无从解释的拒绝，而两处策略本应是同一条。
  // 典型用例：P1=肝阳上亢/治法=平肝潜阳，舌红苔薄黄已记录，方中天麻(平肝)+黄芩(清肝泻火)。
  // 「已锁定方向」必须取全集。requiredTherapyConcepts 只读 therapy.overallPrinciple 和
  // chain[].therapyDirection，**不读 therapy.overallMethod**；而 coverageRequired 走的
  // primaryPathogenesisTherapyConcepts 是读的。若下面这道门只用前者，一味支撑写在 overallMethod
  // 里的治法的药就会被判成「不落在任何锁定方向上」——实测：治法「调畅头部气血，安神定志」，
  // 方为川芎(活血)+酸枣仁(安神)，安神定志只出现在 overallMethod，酸枣仁因此被判无支撑，
  // 1/2=0.5 未过 0.8。overallMethod 同样是 M03 已锁定的治法，必须计入。
  // 症状指征通道与上方高影响门同一口径：一味药的方向由已记录症状事实支撑时，
  // 它同样算「落在已成立方向上」，否则同一味药会被上一道门放行、被这道门驳回。
  const factSupportedConcepts: TcmTherapyConcept[] = [...priorDocumentedFactConcepts(prior)];
  const supportedDirections = new Set<TcmTherapyConcept>([
    ...required,
    ...coverageRequired,
    ...factSupportedConcepts,
  ]);
  // 支撑判定按「角色的有效范围」计（阈值放宽与角色豁免同时执行）：
  //
  // 1) **分母只算君臣**。君臣定义全方治疗方向，要求它们落在已锁定治法方向上是合理的；
  //    佐使的职责本来就不是攻主病机——龙胆泻肝汤的当归（佐，养血防苦寒伤阴）、甘草（使，
  //    调和诸药）按定义就"不支撑"清肝泻火，把它们算进 80% 分母等于禁止经典方的君臣佐使
  //    结构本身。实测 10 例甲方病历里 3 例（六味地黄丸/清胃散/龙胆泻肝汤）栽在这条上。
  //    佐使并非失管：高影响方向门禁（上方 unsupportedHighImpactHerbIssue）对每一味照常执行，
  //    附子做佐药混进热证照旧驳回；十八反十九畏、剂量、特殊人群检查也都按味覆盖。
  // 2) **基准方组成计为支撑**。一味药出现在 M03 锁定（或候选自带）经典方的法定组成里，
  //    它在方中的正当性来自方剂本身，与其功用词是否命中治法词表无关。
  // 3) 模型未标角色（全部无 role）时退回旧口径——按全体治疗性药味算，防止靠"不标角色"绕过。
  const coreRoleHerbs = therapeuticHerbs
    .map((herb, index) => ({ herb, concepts: herbConcepts[index], index }))
    .filter(({ herb }) => herb.role === "君" || herb.role === "臣");
  const supportAccountable = coreRoleHerbs.length > 0
    ? coreRoleHerbs
    : therapeuticHerbs.map((herb, index) => ({ herb, concepts: herbConcepts[index], index }));
  const lockedSupportingHerbs = supportAccountable.filter(({ concepts, index }) =>
    setsIntersect(concepts, supportedDirections) || herbInBaseline(index)).length;
  // 方向不可核验时跳过覆盖率与君臣支撑率——它们都以「已锁定治法方向」为分母，
  // 分母不存在时这两个比值没有意义，强行判定等于用未知否定候选。
  if (therapyDirectionVerifiable && coveredRequired.length / coverageRequired.size < 0.5) return "transparent_therapy_coverage";
  // 主病机 P1 方向必须有真实的君臣内核，但内核规模不应被整方味数稀释成百分比。旧规则是
  // directlySupportingHerbs / therapeuticHerbs >= 0.5，等价于把自拟方味数上限锁死在
  // ≈2×P1方向药味数：实测同一 prior 下 4 味通过、8 味恰好 0.50 通过、11 味即 0.36 被驳。
  // 它拦的是「P1 没有内核」，用绝对下限表达更准，且不再随味数增长自动收紧。
  // 内核下限随方剂规模伸缩。写死 min(2, n) 会要求一张 2 味方把两味都压在 P1 上，
  // 于是「一味主攻 P1 + 一味应对已记录患者事实」这种完全合理的小方被驳回
  // （实测：天麻平肝 + 黄芩清肝泻火，舌红苔薄黄已记录 —— 旧比例规则 1/2=0.5 是通过的）。
  // 3 味以上才要求 2 味内核：既保住「P1 不能没有君臣」，又不给小方施加它无法满足的绝对值。
  const p1CoreFloor = therapeuticHerbs.length >= 3 ? 2 : 1;
  if (directlySupportingHerbs < p1CoreFloor) return "transparent_therapy_herb_support";
  // 君臣核心里几乎每味都必须落在某条已锁定治法方向上（或属基准方组成），杜绝"凑数量"。
  if (therapyDirectionVerifiable && lockedSupportingHerbs / supportAccountable.length < 0.8) return "transparent_therapy_herb_support";

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
  // 「由医师确定用量」类成分（无法定数值边界）：系统不比对边界，因为根本没有边界可比。
  // 它们照旧要求写出一个可解析的数值剂量（不接受空值或占位），并在 HIS 载荷里按类别标注
  // unverified_dose / toxic_regulated，最终由医师确认并经灵犀审方复核。
  // 这是甲方 2026-08-01 的显式决策：此前 fail-closed 让 1352/2915 的方一被锁定就只能返回
  // 非剂量结果；现在把「这一味的量由谁负责」讲清楚，而不是整张方作废。
  if (grams != null && isClinicianDoseHerb(name)) return true;
  if (grams == null || limit?.min == null || limit.max == null) return false;
  const routeMatchedAlternatives = (limit.alternatives || []).filter((range) =>
    range.sourceType === "routeDose" &&
    /煎服|汤剂|另煎|另炖/.test(`${range.routeForm || ""}${range.method || ""}`) &&
    /煎|汤|剂/.test(decoctionMethod)
  );
  const governedRanges = [{ min: limit.min, max: limit.max }, ...routeMatchedAlternatives];
  return governedRanges.some((range) => grams >= range.min && grams <= range.max);
}

const M04_SPECIAL_POPULATION_MATCHERS: ReadonlyArray<{
  population: RegExp;
  patient: RegExp;
  code: string;
}> = [
  { population: /孕期|妊娠/, patient: /妊娠|怀孕|孕妇|孕期|备孕|计划妊娠/, code: "pregnancy" },
  { population: /哺乳期/, patient: /哺乳|乳母|产后喂养/, code: "lactation" },
  { population: /儿童|婴幼儿/, patient: /儿童|婴儿|幼儿|小儿|未成年|(?:年龄|患者年龄)\s*[:：]?\s*(?:[0-9]|1[0-7])\s*岁/, code: "pediatric" },
  { population: /出血倾向|月经期|抗凝状态/, patient: /出血倾向|月经期|经期|抗凝|抗血小板|华法林|利伐沙班|阿哌沙班|达比加群|肝素|阿司匹林|氯吡格雷/, code: "bleeding_anticoagulation" },
  { population: /老年人/, patient: /老年|高龄|(?:年龄|患者年龄)\s*[:：]?\s*(?:6[5-9]|[7-9]\d|1\d{2})\s*岁/, code: "older_adult" },
  { population: /肝功能不全/, patient: /肝功能不全|肝衰竭|失代偿期肝硬化|Child-Pugh\s*[BC]/i, code: "hepatic_impairment" },
  { population: /肾功能不全/, patient: /肾功能不全|肾衰竭|尿毒症|慢性肾脏病|慢性肾病|eGFR\s*[:：]?\s*(?:[0-5]?\d(?:\.\d+)?)\b/i, code: "renal_impairment" },
  { population: /心血管病/, patient: /心力衰竭|心衰|冠心病|心律失常|高血压|心肌梗死|心绞痛/, code: "cardiovascular_disease" },
  { population: /心血管\/青光眼\/前列腺/, patient: /心血管病|心力衰竭|心衰|冠心病|心律失常|高血压|青光眼|前列腺增生/, code: "cardio_glaucoma_prostate" },
  { population: /糖尿病/, patient: /糖尿病|血糖控制不佳|糖化血红蛋白升高/, code: "diabetes" },
  { population: /体虚\/胃弱/, patient: /体虚|体质虚弱|胃弱|脾胃虚弱/, code: "frailty_gastric_weakness" },
  { population: /运动员/, patient: /运动员|竞技体育|兴奋剂检查/, code: "athlete" },
];

export function m04GenerationSpecialPopulationIssue(
  herbs: ReadonlyArray<{ name?: unknown }>,
  clinicalContext: string,
): string | undefined {
  if (!clinicalContext.trim()) return undefined;
  for (const [herbIndex, herb] of herbs.entries()) {
    const name = typeof herb.name === "string" ? herb.name.trim() : "";
    if (!name) continue;
    const profile = getTcmHerbGenerationSafetyProfile(name);
    for (const rule of profile.populationRules) {
      if (rule.severity !== "HIGH") continue;
      const matcher = M04_SPECIAL_POPULATION_MATCHERS.find((item) => item.population.test(rule.population));
      if (matcher && contextAffirmsTerm(clinicalContext, matcher.patient)) {
        return `herb_${herbIndex}_special_population_high_risk_${matcher.code}`;
      }
    }
  }
  return undefined;
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
  if (governedPriorNames?.length) {
    const sufficiencyIssue = namedFormulaPositiveSufficiencyIssue(prior, governedPriorNames);
    if (sufficiencyIssue) return sufficiencyIssue;
  }
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

/**
 * 已删除：随访监测（nonPharma.monitoring）的 metric/timing/trigger 语义合同。
 *
 * 原先这里有 MONITORING_ACTION_OR_CONDITION 词表、monitoringMetricGroundedInPrior 与
 * monitoringSemanticIssue，共产出 5 个 M04 驳回码：monitoring_N_incomplete /
 * _metric_semantics / _trigger_semantics / _duplicate / _metric_ungrounded。任一命中即整份
 * M04 被驳回（prescribe 路由抛 finalized_prescription_*），一张已通过剂量、十八反十九畏、
 * 特殊人群与审方的处方就此作废。
 *
 * 为什么删除是净安全收益：
 * 1) 它防的是「文案的字段语义分离与措辞归属」，不是临床安全。红旗/剂量放行的权威在
 *    withSafetyGate，处方后审方的权威在 rxaudit，两者都完全不读 nonPharma.monitoring。
 * 2) 这 5 个码在 structured-clinical-repair.ts 里本就没有任何修复引导语
 *    （buildM04ClinicalRepairHint 对 m04_monitoring_* 返回空串），命中后模型拿到的是裸码，
 *    只能盲目重采样直到 M04_ORCHESTRATION_DEADLINE_MS 把可用结果降级为签名受限输出。
 * 3) 替代字段 nonPharma.precautions 是零驳回码的自由文本：「必有内容」由
 *    m04-proposal-compiler 的 deterministicPrecautions 确定性兜底提供，而不是靠驳回；
 *    「不得混入剂量」由编译层的 PRECAUTION_DOSE_LIKE 逐条剥离承担（丢该行、不丢整份处方）。
 * 因此合同层对注意事项刻意**不做任何校验**，也不要重新加回来。
 */
export function m04SemanticIssue(
  reasoning: M04ReasoningLike | null | undefined,
  visibleContent = "",
  priorReasoning?: M03ReasoningLike | null,
  isKnownHerbName?: (name: string) => boolean,
  serverOwnsDecoctionMethod = false,
  serverOwnsFollowUpNode = false,
  trustedWorkbenchEdit = false,
  auditedClinicalRisksAreAdvisory = false,
  clinicalContext = "",
): string | undefined {
  const candidates = reasoning?.formula?.candidates;
  if (reasoning?.stage !== "prescribe") return "stage";
  const nonPharma = reasoning.nonPharma;
  // 语义收窄：只要求饮食/起居/情志三段调护非空。注意事项（precautions）刻意不在这里校验——
  // 它是零驳回码字段，专业度由提示词在生成侧要求，内容兜底由编译层确定性提供。
  if (
    !nonPharma ||
    typeof nonPharma.diet !== "string" || !nonPharma.diet.trim() ||
    typeof nonPharma.lifestyle !== "string" || !nonPharma.lifestyle.trim() ||
    typeof nonPharma.emotion !== "string" || !nonPharma.emotion.trim()
  ) return "non_pharma_incomplete";
  const treatmentProjects = Array.isArray(nonPharma.tcmTreatments) ? nonPharma.tcmTreatments : [];
  const treatmentNodeIds = new Set((priorReasoning?.pathogenesis?.chain || [])
    .map((node, index) => String(node.nodeId || `P${index + 1}`)));
  const knownTreatmentCodes = new Set<string>(TCM_TREATMENT_PROJECT_CODES);
  if (treatmentProjects.length > 3) return "non_pharma_treatment_count";
  for (const [index, project] of treatmentProjects.entries()) {
    if (!knownTreatmentCodes.has(String(project.projectCode || ""))) return `non_pharma_treatment_${index}_code`;
    if (![project.targetRef, project.targetPathogenesis, project.treatmentContent,
      project.techniqueBoundary, project.protocolSource, project.operatorRequirement]
      .every((value) => typeof value === "string" && value.trim())) return `non_pharma_treatment_${index}_incomplete`;
    if (project.assessmentPositioning != null &&
      (typeof project.assessmentPositioning !== "string" || !project.assessmentPositioning.trim())) {
      return `non_pharma_treatment_${index}_positioning`;
    }
    if (!treatmentNodeIds.has(String(project.targetRef))) return `non_pharma_treatment_${index}_target_ref`;
    if (!Array.isArray(project.requiredChecks) || project.requiredChecks.length === 0) return `non_pharma_treatment_${index}_checks`;
    if (!Array.isArray(project.suggestedSitesOrPoints) ||
      project.suggestedSitesOrPoints.some((value) => typeof value !== "string" || !value.trim())) {
      return `non_pharma_treatment_${index}_plan`;
    }
    const protocolStatus = String(project.protocolStatus || "");
    if (!["governed_patient_specific_plan", "assessment_only_no_patient_specific_protocol"].includes(protocolStatus)) {
      return `non_pharma_treatment_${index}_protocol_status`;
    }
    if (protocolStatus === "governed_patient_specific_plan" &&
      ((project.suggestedSitesOrPoints.length === 0 && !tcmTreatmentProjectIsPointFree(String(project.projectCode || ""))) ||
        typeof project.scheduleSuggestion !== "string" || !project.scheduleSuggestion.trim())) {
      return `non_pharma_treatment_${index}_governed_plan_incomplete`;
    }
    if (protocolStatus === "assessment_only_no_patient_specific_protocol" &&
      (project.suggestedSitesOrPoints.length > 0 || (typeof project.scheduleSuggestion === "string" && project.scheduleSuggestion.trim()) ||
        typeof project.protocolGap !== "string" || !project.protocolGap.trim())) {
      return `non_pharma_treatment_${index}_assessment_parameters`;
    }
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
  const candidateNeedsKnowledgeCoverage =
    !trustedWorkbenchEdit &&
    (candidates[0].constructionType === "self_devised" ||
      !Array.isArray(candidates[0].formulaNames) ||
      candidates[0].formulaNames.length === 0);
  if (candidateNeedsKnowledgeCoverage && priorReasoning) {
    const coverageIssue = transparentFormulaTherapyIssue(reasoning, priorReasoning);
    if (coverageIssue) return `candidate_0_${coverageIssue}`;
  }
  const availableRows = visibleContent ? visibleHerbRows(visibleContent) : [];
  const visibleMethod = visibleContent ? visibleLabeledValue(visibleContent, "煎服法") : "";
  if (!serverOwnsDecoctionMethod && visibleContent && (!visibleMethod || !hasCompleteDecoctionMethod(visibleMethod))) {
    return `visible_method_incomplete_${visibleMethod ? decoctionMethodMissing(visibleMethod).join("_") : "missing"}`;
  }
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (typeof candidate.name !== "string" || !candidate.name.trim()) return `candidate_${candidateIndex}_name`;
    if (typeof candidate.therapyMatch !== "string" || !candidate.therapyMatch.trim()) return `candidate_${candidateIndex}_therapy_match`;
    if (!Array.isArray(candidate.herbs) || candidate.herbs.length === 0) return `candidate_${candidateIndex}_herbs_empty`;
    const classicContraindicationIssue = !trustedWorkbenchEdit
      ? firstFormulaContraindicationIssue(
          [
            typeof candidate.name === "string" ? candidate.name : "",
            ...(Array.isArray(candidate.formulaNames)
              ? candidate.formulaNames.filter((name): name is string => typeof name === "string")
              : []),
          ],
          clinicalContext,
        )
      : undefined;
    if (classicContraindicationIssue) {
      return `candidate_${candidateIndex}_classic_contraindication_${classicContraindicationIssue}`;
    }
    const normalizedHerbNames = candidate.herbs.map((herb) => canonicalTcmHerbIdentity(herb.name));
    if (new Set(normalizedHerbNames).size !== normalizedHerbNames.length) return `candidate_${candidateIndex}_duplicate_herb`;
    const specialPopulationIssue = !trustedWorkbenchEdit
      ? m04GenerationSpecialPopulationIssue(candidate.herbs, clinicalContext)
      : undefined;
    if (specialPopulationIssue) return `candidate_${candidateIndex}_${specialPopulationIssue}`;
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
    const regimenIssue = prescriptionRegimenIssue(doseCount, course, candidate.decoction?.dosesPerDay);
    if (regimenIssue) return `candidate_${candidateIndex}_${regimenIssue}`;
    const administrationTimesPerDay = candidate.decoction?.administrationTimesPerDay;
    if (
      typeof administrationTimesPerDay !== "number" ||
      !Number.isInteger(administrationTimesPerDay) ||
      administrationTimesPerDay < 1 ||
      administrationTimesPerDay > 6 ||
      typeof candidate.decoction?.dosesPerDay !== "number" ||
      administrationTimesPerDay < candidate.decoction.dosesPerDay
    ) {
      return `candidate_${candidateIndex}_administration_times_per_day`;
    }
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
    if (!finalModificationTriggerGrounded(String(modification.trigger), priorReasoning)) {
      return `modification_${modificationIndex}_trigger_ungrounded`;
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
  // 覆盖不足放在最后：它是 T2，绝不能短路掉排在它前面的任何安全检查。
  if (priorReasoning) {
    const coverageIssue = m03NodeCoverageIssue(reasoning, priorReasoning);
    if (coverageIssue) return coverageIssue;
  }
  return undefined;
}

/**
 * 病机节点覆盖：M03 每个声明了治法方向的节点，都必须至少有一味药承接。
 *
 * 这是「处方不得超出诊断」的反方向，而它此前在全仓库不存在。超出的一侧被三重把守——
 * crossStageReasoningIssue 的 target_ref_invalid / _mismatch / _missing 要求每味药都指向真实节点，
 * unsupportedHighImpactHerbIssue 再禁止药味超出 M03 已签名方向；反方向（M03 的每个 Pn 是否
 * 真的被处方覆盖）没有任何检查。实测：M03 给出 P1 脾胃虚弱 与 P2 脾虚湿盛，一张把全部药味都绑在
 * P1、完全无视 P2 的处方，可以通过包括 T1 硬门在内的每一道检查。
 *
 * 唯一近似的覆盖检查 transparentFormulaTherapyIssue 被 candidateNeedsKnowledgeCoverage 门死：
 * 只在自拟方或未锁定方名时才跑，而 M03 成功锁定经典方恰恰是本产品主推路径。
 *
 * 分级为 T2（带批注受理）而非 T1：覆盖不足不影响这张方能不能安全服用，但医生必须被告知
 * 「M03 提出的某个病机方向本次没有对应药味」——静默不覆盖比明确降级更危险，因为医生看不到缺口
 * 就不会去补。只检查声明了 therapyDirection 的节点：没有治法方向的节点本就不要求药味承接。
 */
export function m03NodeCoverageIssue(
  reasoning: M04ReasoningLike | null | undefined,
  priorReasoning: M03ReasoningLike | null | undefined,
): string | undefined {
  const chain = priorReasoning?.pathogenesis?.chain || [];
  if (chain.length === 0) return undefined;
  const referenced = new Set(
    (reasoning?.formula?.candidates || [])
      .flatMap((candidate) => candidate.herbs || [])
      .filter((herb) => herb.targetKind === "pathogenesis_node")
      .map((herb) => String(herb.targetRef || "").trim())
      .filter(Boolean),
  );
  for (const [index, node] of chain.entries()) {
    const nodeId = String(node.nodeId || `P${index + 1}`).trim();
    if (!nodeId) continue;
    // 没有治法方向的节点不要求药味承接（例如仅描述病程或限制条件的节点）。
    if (typeof node.therapyDirection !== "string" || !node.therapyDirection.trim()) continue;
    if (!referenced.has(nodeId)) return `pathogenesis_node_uncovered_${nodeId}`;
  }
  return undefined;
}

/**
 * m04SemanticIssue 的 T1 子集，为 M04「带批注受理」提供硬门禁。
 *
 * 为什么必须独立完整重跑（与 m03SafetyContractIssue 同理，但在 M04 上后果更重）：
 * m04SemanticIssue 命中第一个问题就短路返回，而它的检查顺序**不反映临床严重度**——
 * nonPharma.tcmTreatments 的 15 个字段完整性检查排在最前，早于跨阶段锁定字段、候选方、
 * 剂量、十八反十九畏与特殊人群。实测：一张含甘草+甘遂（十八反）的处方，只要同时带一条
 * 字段不全的中医治疗项目卡片，返回的就是 non_pharma_treatment_0_incomplete——配伍禁忌与
 * 全部剂量、特殊人群检查根本没有执行。今天这不构成放行（任何码都整份驳回），但一旦把建议性
 * 字段降级为可受理，只看拒绝码就等于放行了一张从未被安全检查过的剂量级处方。
 *
 * ★ 核心不变量（改动前必读）★
 * 1) 本函数只调用 m04SemanticIssue 已经在用的同一批谓词，不重写任何判定——安全规则在本仓库
 *    只存在一份。
 * 2) 多码辅助函数一律按「绝对否决」处理：只要返回非空就阻断受理，不看分级。理由与 M03 相同——
 *    它们内部同样短路，若按分级丢弃排在前面的码，排在后面的 T1 检查就永远执行不到。属此类的有：
 *    crossStageReasoningIssue（含君药绑定与 M03 锁定字段漂移）、transparentFormulaTherapyIssue、
 *    firstFormulaContraindicationIssue、m04GenerationSpecialPopulationIssue、
 *    unsupportedHighImpactHerbIssue、prescriptionRegimenIssue、prescriptionRegimenContractIssue。
 * 3) 展示层不参与安全判定：visibleContent 一律按空串处理。权威是结构化 JSON，可见正文由服务端
 *    同步生成；用渲染结果反向否决临床结论是本末倒置。
 *
 * 不属于 T1 的（因此可降级为带批注受理）：建议性字段（nonPharma 全部、随症加减的措辞与接地）、
 * 展示同步（visible_*）、药味行的叙述性字段（role/prescriptionRole/targetPathogenesis/function）、
 * 以及煎服法与复诊节点的文本完整性——它们要么由服务端确定性生成，要么不改变这张方能否安全服用。
 *
 * 维护要求：往 m04SemanticIssue 新增任何安全承重检查时必须同步加到这里；
 * scripts/test-m04-safety-contract.mjs 对遗漏做确定性断言。
 */
export function m04SafetyContractIssue(
  reasoning: M04ReasoningLike | null | undefined,
  priorReasoning?: M03ReasoningLike | null,
  isKnownHerbName?: (name: string) => boolean,
  trustedWorkbenchEdit = false,
  auditedClinicalRisksAreAdvisory = false,
  clinicalContext = "",
): string | undefined {
  if (reasoning?.stage !== "prescribe") return "stage";
  // 锁定字段漂移与君药绑定：绝对否决。
  const stageIssue = crossStageReasoningIssue(reasoning, priorReasoning, "", trustedWorkbenchEdit);
  if (stageIssue) return stageIssue;
  const candidates = reasoning.formula?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "candidates_empty";
  if (candidates.length !== 1) return "candidate_count";

  const candidateNeedsKnowledgeCoverage =
    !trustedWorkbenchEdit &&
    (candidates[0].constructionType === "self_devised" ||
      !Array.isArray(candidates[0].formulaNames) ||
      candidates[0].formulaNames.length === 0);
  if (candidateNeedsKnowledgeCoverage && priorReasoning) {
    const coverageIssue = transparentFormulaTherapyIssue(reasoning, priorReasoning);
    if (coverageIssue) return `candidate_0_${coverageIssue}`;
  }

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (!Array.isArray(candidate.herbs) || candidate.herbs.length === 0) return `candidate_${candidateIndex}_herbs_empty`;
    const classicContraindicationIssue = !trustedWorkbenchEdit
      ? firstFormulaContraindicationIssue(
          [
            typeof candidate.name === "string" ? candidate.name : "",
            ...(Array.isArray(candidate.formulaNames)
              ? candidate.formulaNames.filter((name): name is string => typeof name === "string")
              : []),
          ],
          clinicalContext,
        )
      : undefined;
    if (classicContraindicationIssue) {
      return `candidate_${candidateIndex}_classic_contraindication_${classicContraindicationIssue}`;
    }
    const normalizedHerbNames = candidate.herbs.map((herb) => canonicalTcmHerbIdentity(herb.name));
    if (new Set(normalizedHerbNames).size !== normalizedHerbNames.length) return `candidate_${candidateIndex}_duplicate_herb`;
    const specialPopulationIssue = !trustedWorkbenchEdit
      ? m04GenerationSpecialPopulationIssue(candidate.herbs, clinicalContext)
      : undefined;
    if (specialPopulationIssue) return `candidate_${candidateIndex}_${specialPopulationIssue}`;
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

    // 处方计划算术：剂数/每日剂数/分服次数不自洽会直接产生不可执行或超量的服法。
    const regimenIssue = prescriptionRegimenIssue(
      candidate.decoction?.doseCount,
      candidate.decoction?.course,
      candidate.decoction?.dosesPerDay,
    );
    if (regimenIssue) return `candidate_${candidateIndex}_${regimenIssue}`;
    const administrationTimesPerDay = candidate.decoction?.administrationTimesPerDay;
    if (
      typeof administrationTimesPerDay !== "number" ||
      !Number.isInteger(administrationTimesPerDay) ||
      administrationTimesPerDay < 1 ||
      administrationTimesPerDay > 6 ||
      typeof candidate.decoction?.dosesPerDay !== "number" ||
      administrationTimesPerDay < candidate.decoction.dosesPerDay
    ) {
      return `candidate_${candidateIndex}_administration_times_per_day`;
    }

    for (const [herbIndex, herb] of candidate.herbs.entries()) {
      // 药味身份与剂量：无法核验身份或超出安全边界的药味不能进入剂量级处方。
      if (typeof herb.name !== "string" || !herb.name.trim()) return `candidate_${candidateIndex}_herb_${herbIndex}_name`;
      if (isKnownHerbName && !isKnownHerbName(herb.name.trim())) return `candidate_${candidateIndex}_herb_${herbIndex}_unknown`;
      if (typeof herb.dose !== "string" || !normalizeComparableDose(herb.dose)) return `candidate_${candidateIndex}_herb_${herbIndex}_dose`;
      if (!dosePassesSafetySanityCeiling(herb.name.trim(), herb.dose)) return `candidate_${candidateIndex}_herb_${herbIndex}_dose_sanity_ceiling`;
      if (!trustedWorkbenchEdit && !doseWithinConservativeModelLimit(herb.name.trim(), herb.dose, String(candidate.decoction?.method || ""))) {
        return `candidate_${candidateIndex}_herb_${herbIndex}_dose_outside_conservative_range`;
      }
      // 特殊煎法是毒性与刺激性药味安全控制的一部分，不是叙述性字段。
      const decoctionRule = decoctionRuleForHerb(herb.name);
      if (decoctionRule?.prohibited.includes("同煎")) return `candidate_${candidateIndex}_herb_${herbIndex}_route_not_decoction`;
      if (!decoctionRuleSatisfied(herb.name, String(herb.decoctionRequirement || ""))) {
        return `candidate_${candidateIndex}_herb_${herbIndex}_decoction_missing_required`;
      }
    }
  }

  // 随症加减里只有三类属安全承重：夹带未经审方的剂量（自由文本变成绕过审方的剂量通道）、
  // 加入知识库未收载的药味、以及加入方向未成立的高影响药味。措辞与接地问题属建议层。
  for (const [modificationIndex, modification] of (reasoning.formula?.modifications || []).entries()) {
    if (typeof modification.doseOrHandling === "string" && modification.doseOrHandling.trim()) {
      return `modification_${modificationIndex}_unaudited_dose`;
    }
    const fields = [modification.trigger, modification.targetPathogenesis, modification.action,
      modification.doseOrHandling, modification.reason, modification.riskNote]
      .filter((value): value is string => typeof value === "string")
      .join("；")
      .replace(/\s/g, "");
    if (/(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)(?:mg|g|毫克|克)(?![\/／](?:L|升))/i.test(fields)) {
      return `modification_${modificationIndex}_unaudited_dose`;
    }
    const action = typeof modification.action === "string" ? modification.action.trim().replace(/\s/g, "") : "";
    const addition = action.match(/(?:^|时|则|可|建议)(?:加入|加用|新增|加)([一-龥]{1,8})/);
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
