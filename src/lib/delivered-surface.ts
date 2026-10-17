/**
 * 交付面：调用方实际收到的结构化结果里，哪些字段不再带内容、哪些服务端生成的措辞要换成临床语言。
 *
 * 2026-10-13，甲方 10.12 测评。甲方面板读的是辨证、开方两个接口返回的结构化字段，用自己的标签直接显示。
 * 测评里被框出来的内容分两类：
 *   · 甲方明确不要的整块：西医诊断下面的症状依据、待查依据、检查建议；诊断名里的括号和「病因待查」；
 *   · 服务端写给审计看的话：「病历尚未确认胸痛是否存在」「病历已记录瘙痒阳性」「（需问诊核实后方可用于排除）」
 *     「适用于与本例锁定证候…一致的情况」「说明书用法字段已与…指纹绑定」「本例辨证组方」等。
 *
 * 接口冻结：字段名、层级、类型都不变，只允许某个字段不再带内容（空数组 / 空串）或写得更像临床语言。
 * 内部校验仍然需要其中一些内容（例如西医支持事实是多条接地校验的取材），所以不是让模型不写，
 * 而是在全部校验做完、签名之前投影一次：这里是「调用方看到什么」的唯一口径，页面、HIS 与接口读同一份。
 *
 * 净化器的句式是有限闭集（都由 diagnosis-safety.ts 自己生成），这里逐式换成医生平时的写法：
 * 没问到的写「未诉」，病历否认的写「否认」，病历有的写「有」。不改净化器本身——它守的是事实极性，
 * 守得对；不对的只是把守的过程原样念给了医生听。
 */

import { compositionIdentityName, formulaCompilationReferences } from "./tcm-formula-provenance";
import { textbookDifferentialsForDisease, textbookFormulaLabel, textbookRowForSyndrome } from "./tcm-textbook-syndromes";
import { resolveTcmDiseaseDifferentialName } from "./tcm-disease-differential-normalization";
import { clinicalTreatmentScheduleWording } from "./treatment-schedule-wording";
import { hasHerbBoundaryTail, herbBoundaryTail, stripHerbBoundaryTail, type HerbBoundaryAudience } from "./candidate-boundary-text";
import { getTcmHerbGenerationSafetyProfile } from "./tcm-knowledge";
import { deliveredTreatmentCodes, precautionMentionsUndeliveredTreatment } from "./tcm-treatment-capabilities.server";
import type { RequiredPrecaution } from "./required-precautions";

/**
 * 投影时可选的本例信息：herbBoundaryAudience 决定逐味人群提示列哪些人群（见 herbBoundaryPopulationRelevant）；
 * requiredPrecautions 是本例注意事项必须写到的项目（required-precautions.server.ts 由病历算出）。
 */
export type DeliveredSurfaceOptions = {
  herbBoundaryAudience?: HerbBoundaryAudience;
  requiredPrecautions?: readonly RequiredPrecaution[];
};

/** 注意事项里已经写到这一项了吗（说到药名 / 哺乳 / 抗菌治疗即算，不管模型怎么措辞）。 */
function requiredPrecautionCovered(item: RequiredPrecaution, lines: readonly string[]): boolean {
  if (item.kind === "self_medication") return lines.some((line) => line.includes(item.base) || line.includes(item.name));
  if (item.kind === "postpartum_lactation") return lines.some((line) => /哺乳|喂奶|母乳|授乳|乳汁/.test(line));
  return lines.some((line) => /抗生素|抗菌|抗感染|青霉素|头孢/.test(line));
}

/**
 * 模型写的自服药那一条里说「与本方同有/重叠」的药，只留本方处方里真有的（2026-10-17 本地复测：病历 7 的处方是清胃散加减，
 * 模型把提示里给的黄连上清丸组成整串抄成「与本方黄连、大黄、黄芩、黄柏、栀子、连翘等重叠」，后四味本方没有）。
 * 一味真有的都不剩、却仍说重叠时，换成规则那一句。药名本身（黄连上清丸含「黄连」）先保护起来再删。
 */
function withOnlyPrescribedOverlap(line: string, item: Extract<RequiredPrecaution, { kind: "self_medication" }>, herbIdentities: ReadonlySet<string>): string | undefined {
  if (item.composition.length === 0 || !(line.includes(item.base) || line.includes(item.name))) return line;
  const shielded = line.split(item.name).join("\u0000").split(item.base).join("\u0001");
  let pruned = shielded;
  for (const herb of item.composition.filter((name) => !herbIdentities.has(name))) {
    pruned = pruned.split(`${herb}、`).join("").split(`、${herb}`).join("").split(herb).join("");
  }
  const restored = pruned.split("\u0000").join(item.name).split("\u0001").join(item.base);
  const claimsOverlap = /重叠|同含|同有|都含|均含|共有/.test(restored);
  const remaining = item.composition.filter((name) => herbIdentities.has(name) && restored.includes(name));
  return claimsOverlap && remaining.length === 0 ? undefined : restored;
}

/** 模型漏写时由规则补的那一句。只说病历记录的事实、方剂目录与说明书写着的内容。 */
function requiredPrecautionLine(item: RequiredPrecaution, herbIdentities: ReadonlySet<string>, lactationHerbs: readonly string[]): string {
  if (item.kind === "self_medication") {
    const overlap = item.composition.filter((herb) => herbIdentities.has(herb));
    const head = overlap.length > 0
      ? `已自服的${item.name}与本方同含${overlap.slice(0, 4).join("、")}，服本方期间不宜再同时服用，以免药力叠加；如需继续请先告知医生`
      : `已自服的${item.name}是否继续服用，请服本方前告知医生，由医生决定`;
    return `${head}${item.alcoholWarning ? `；服用${item.base}期间须戒酒，饮酒可引起双硫仑样反应` : ""}。`;
  }
  if (item.kind === "postpartum_lactation") {
    return `产后如正在哺乳，请服药前告知医生${lactationHerbs.length > 0 ? `（方中${lactationHerbs.slice(0, 4).join("、")}哺乳期须慎用）` : ""}，由医生评估后再服。`;
  }
  return `${item.disease}是细菌感染，除服本方外请到医院就诊，由医生决定抗菌药物治疗；如出现寒战高热、红肿迅速扩大、皮肤发紫或起水疱，请立即就医。`;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Json => Boolean(item)) : [];
}

const OBJECT = "([^，,。；;：:（）()\\n]{1,60}?)";

/** 净化器与鉴别归一写出的系统句式 → 临床写法。顺序有意义：长句式在前。 */
const SYNTHETIC_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [new RegExp(`病历尚未确认${OBJECT}是否已排除[；;，,]\\s*病历已记录该表现存在[，,]\\s*请医生核对后再采纳`, "g"), "有$1"],
  [new RegExp(`病历已记录否认${OBJECT}[，,]\\s*[^，,。；;\\n]{1,30}?的一般情况需医生核实`, "g"), "否认$1"],
  [new RegExp(`病历已记录本次${OBJECT}未见明显异常[；;，,]\\s*是否复查由医生结合病情判断`, "g"), "本次$1未见明显异常"],
  // 对象里可以自带括注（「口腔专科检查（牙髓活力、叩诊等）」），这一式的结尾是固定句，按到它为止取对象。
  [/病历未记录([^，,。；;：:\n]{1,60}?)(?:记录)?[（(]需问诊核实后方可用于排除[）)]/g, "未诉$1"],
  [new RegExp(`病历(?:中)?尚未确认${OBJECT}是否存在`, "g"), "未诉$1"],
  [new RegExp(`${OBJECT}是否存在尚未(?:确认|核实)`, "g"), "未诉$1"],
  [new RegExp(`病历已记录否认${OBJECT}(?=[，,。；;）)\\n]|$)`, "g"), "否认$1"],
  [new RegExp(`病历已记录${OBJECT}阳性`, "g"), "有$1"],
  [new RegExp(`病历已记录${OBJECT}阴性`, "g"), "无$1"],
  // 「病历已记录无胸痛」：后面本来就是一句通顺的否定，去掉前缀即可。
  [/病历已记录(?=无|未见|未诉|不伴|否认)/g, ""],
  // 「病历已记录关节无明显红肿发热」：部位在前、否定在后，同样去掉前缀。
  [/病历已记录(?=[^，,。；;：:\n]{1,8}(?:无|未见|未诉|不伴))/g, ""],
];

/**
 * 「完整度未达C级：以下结论基于现有信息形成，属有界建议；…正式采纳前请医生核对未知项。」是服务端对信息覆盖有限的
 * 结果统一加的标注（diagnosis-visible-summary.applyM03DecisionSpecificityPolicy），甲方测评第一条点名的工程术语。
 * 它被写进待查依据、证候把握度说明和不确定项三处；交付时整句去掉，原字段里模型自己写的内容保留。
 */
const BOUNDED_ADVICE_NOTE = /完整度未达C级[:：][^。\n]*。(?:\s*)/g;
/** 其余几句服务端批注（都是固定句，有限闭集）：病机栏的提示、把握度说明里的校验状态、推荐方向里的锁定说明。 */
const SERVER_NOTES: readonly RegExp[] = [
  /[（(]服务端提示[:：][^）)]*[）)]/g,
  /本次结构化辨证结果未通过服务端完整性校验[。；;，,]?\s*/g,
  /[（(](?:按已签名证候反查受控目录锁定|原选另含未通过受控目录核验的方)[^）)]*[）)]/g,
];

/** 把系统句式换成临床写法；没有命中时原样返回（逐字节不变）。 */
export function clinicalWordingForSyntheticPhrases(value: string): string {
  if (!/病历(?:中)?(?:尚未确认|已记录|未记录)|是否存在尚未|完整度未达C级|服务端|受控目录/.test(value)) return value;
  let text = value.replace(BOUNDED_ADVICE_NOTE, "");
  for (const note of SERVER_NOTES) text = text.replace(note, "");
  text = text.trim();
  for (const [pattern, replacement] of SYNTHETIC_PHRASES) text = text.replace(pattern, replacement);
  return text
    .replace(/未诉([^，,。；;\n]{1,40}?)记录(?=[，,。；;）)\n]|$)/g, "未诉$1")
    .replace(/(未诉[^，,。；;\n]{1,40})[，,]\s*未诉/g, "$1、")
    .replace(/[，,]{2,}/g, "，");
}

/** 这些键的值是机器取值或逐字引用，不做措辞替换。 */
const VERBATIM_KEYS = new Set([
  "schemaVersion", "stage", "contractSignature", "contractSignatureVersion", "clinicalReview", "terminologyMappings",
  "evidenceId", "evidenceFingerprint", "sourceRef", "sourceRefs", "sourceQuote", "patientFact", "syndromeEvidence",
  "primarySyndromeBasis", "citation", "excerpt", "coding", "classicEvidence", "pointProvenance", "protocolSource",
]);

function rewordDeep(value: unknown, key = ""): unknown {
  if (VERBATIM_KEYS.has(key)) return value;
  if (typeof value === "string") return clinicalWordingForSyntheticPhrases(value);
  if (Array.isArray(value)) return value.map((item) => rewordDeep(item, key));
  const object = record(value);
  if (!object) return value;
  for (const [childKey, child] of Object.entries(object)) object[childKey] = rewordDeep(child, childKey);
  return object;
}

const CAUSE_UNKNOWN_SUFFIX = /(?:[，,]\s*(?:病因待查|病因待鉴别|病因未明|病因不明)|[（(]\s*(?:病因待查|待查|待因|症状性|症状|病因待鉴别|病因不明)\s*[）)]|待因)$/u;
const PLACEHOLDER_WESTERN_NAME = /^(?:当前未形成可复核的西医工作诊断|症状性(?:诊断|问题)[，,]\s*病因待(?:临床)?鉴别)$/;

/**
 * 交付的西医诊断名：一个规范病名，不带括号说明，不带「，病因待查」。
 * 症状层面的工作诊断（ICD-10 R 章，或名称本身以「症状」收尾）写成「X待查」；点了名的病种只留病名本身
 *（「功能性消化不良，病因待查」自相矛盾：既已定病，又说病因待查）。
 */
export function deliveredWesternDiagnosisName(name: unknown, coding?: unknown): string {
  const label = typeof name === "string" ? name.trim() : "";
  if (!label || PLACEHOLDER_WESTERN_NAME.test(label)) return label;
  const causeUnknown = CAUSE_UNKNOWN_SUFFIX.test(label);
  let core = label.replace(CAUSE_UNKNOWN_SUFFIX, "").trim();
  // 括号里的部位、分期、累及范围等说明不进诊断名；ICD 名称自带的括号（如「高血压病（原发性）」）很少，统一去掉。
  core = core.replace(/[（(][^（）()]{0,60}[）)]/g, "").replace(/[，,；;、\s]+$/g, "").trim();
  if (!core) return label;
  const code = typeof record(coding)?.code === "string" ? String(record(coding)!.code) : "";
  const symptomLevel = /^R/i.test(code) || /症状$/.test(core);
  core = core.replace(/症状$/, "");
  if (/待查$/.test(core)) return core;
  return causeUnknown && symptomLevel ? `${core}待查` : core;
}

/** 西医鉴别名同样只留名称本身。 */
function deliveredDifferentialName(name: unknown): unknown {
  if (typeof name !== "string") return name;
  const core = name.replace(CAUSE_UNKNOWN_SUFFIX, "").replace(/[（(][^（）()]{0,60}[）)]/g, "").trim();
  return core || name;
}

const SELF_COMPOSED_NAME = /^本例辨证组方(?:加减)?$/;
/** 逐味安全边界句（candidate-boundary-text.ts 写的那一段）之前的通用模板句。 */
const NOT_APPLICABLE_TEMPLATE_HEAD = /^[\s\S]*?(?=各药毒性与特殊人群提示[:：])/;

/** 服务端的有限结论（红旗收口、修复用尽）：证候未定且病机链为空。它的支持事实里放的是红旗发现，开方阶段要读。 */
function isLimitedDiagnose(reasoning: Json): boolean {
  const overview = record(reasoning.overview);
  const chain = record(reasoning.pathogenesis)?.chain;
  return overview?.primarySyndromeResolution === "unresolved" && (!Array.isArray(chain) || chain.length === 0);
}

function deliveredDiagnose(reasoning: Json): void {
  // 鉴别的「建议核实」模型写成字符串 null 的，按空值交付（2026-10-17 留出例 S132「建议核实：null」）。
  const overviewForNulls = record(reasoning.overview);
  for (const row of [
    ...records(overviewForNulls?.tcmDiseaseDifferentials),
    ...records(overviewForNulls?.tcmDifferentials),
    ...records(record(reasoning.westernDiagnosis)?.differentials),
  ]) {
    if (typeof row.nextCheck === "string" && /^(?:null|undefined)$/i.test(row.nextCheck.trim())) row.nextCheck = null;
  }
  // 只有那句统一标注、没有别的内容的不确定项整条去掉（留一条空原因的条目没有意义）。
  const pathogenesis = record(reasoning.pathogenesis);
  if (pathogenesis && Array.isArray(pathogenesis.uncertainties)) {
    pathogenesis.uncertainties = pathogenesis.uncertainties.filter((item) => {
      const row = record(item);
      const reason = typeof row?.reason === "string" ? row.reason : "";
      return !(reason && !reason.replace(BOUNDED_ADVICE_NOTE, "").trim());
    });
  }
  const western = record(reasoning.westernDiagnosis);
  const primary = record(western?.primary);
  if (primary && !isLimitedDiagnose(reasoning)) {
    primary.name = deliveredWesternDiagnosisName(primary.name, primary.coding);
    // 甲方红框「方框内内容不建议展示」：症状依据、待查依据、检查建议三块整块不再输出。
    primary.supportingFacts = [];
    if (Array.isArray(primary.supportingFactKinds)) primary.supportingFactKinds = [];
    primary.limitations = [];
    primary.suggestedChecks = [];
  }
  for (const item of records(western?.differentials)) item.name = deliveredDifferentialName(item.name);
  // 模型自己写明「不适用」的鉴别项（女性病例列前列腺增生、男性病例列异位妊娠，理由写「本例为男性患者，不适用」）不列（2026-10-14 独立评审）。
  if (western && Array.isArray(western.differentials)) {
    western.differentials = records(western.differentials).filter((item) =>
      !/不适用/.test(`${typeof item.reason === "string" ? item.reason : ""}${typeof item.distinguishingPoints === "string" ? item.distinguishingPoints : ""}`));
  }
  // 「某某类病」是国标里的分类名，不是病名（测评截图里的「痹证类病」「虚劳类病」）。
  const overview = record(reasoning.overview);
  if (overview && typeof overview.tcmDiseaseName === "string") overview.tcmDiseaseName = overview.tcmDiseaseName.replace(/类病$/u, "");
  // 中医鉴别诊断每例必出（甲方 10.12 测评 2.3「中医鉴别诊断未生成」）：模型没写或写的病名全被归一丢掉时，
  // 用教材【鉴别诊断】对该病列出的病证补齐，要点是教材原文。有限结论（证候未形成）不补。
  if (overview && !isLimitedDiagnose(reasoning) && typeof overview.tcmDiseaseName === "string" &&
    (!Array.isArray(overview.tcmDiseaseDifferentials) || overview.tcmDiseaseDifferentials.length === 0)) {
    // 教材一句话列几个病（「本病应与甲、乙、丙相鉴别」）时，这几个病取到的是同一句：同一句只用一次。
    // 名字与补写小任务、辨证阶段归一走同一个判据（resolveTcmDiseaseDifferentialName）：西医病名（瘾疹节的丘疹性荨麻疹）不贴。
    const diseaseName = overview.tcmDiseaseName;
    const textbookDifferentials = textbookDifferentialsForDisease(diseaseName)
      .flatMap((item) => {
        const resolved = resolveTcmDiseaseDifferentialName(item.name, diseaseName);
        return resolved.action === "drop" ? [] : [{ ...item, name: resolved.name }];
      })
      .filter((item, index, list) => list.findIndex((other) => other.text === item.text) === index);
    // 理由不写来源口吻（「教材列为本病的鉴别病证」），要点去掉「本病与X相鉴别。」这类开场句（2026-10-14 独立评审：元话语）。
    // 教材对鉴别病的描述照列；按本例写区分要点的是辨证阶段的补写（tcm-disease-differential-authoring），这里只是它没写出时的兜底。
    if (textbookDifferentials.length > 0) {
      overview.tcmDiseaseDifferentials = textbookDifferentials.map((item) => ({
        diseaseName: item.name,
        reason: "主症相近",
        distinguishingPoints: item.text
          .replace(/^(?:本病|本证)?(?:应|需|须)?与[^。；;]{1,40}(?:相)?鉴别[。；;]\s*/u, "")
          .replace(/。[；;]/g, "。")
          .trim() || item.text,
        typicalManifestation: "",
        nextCheck: null,
      }));
    }
  }
  // 推荐方向里的系统批注（「按已签名证候反查受控目录锁定，医生可改选」）不是方名的一部分。
  if (overview && typeof overview.recommendedFormulaDirection === "string") {
    overview.recommendedFormulaDirection = overview.recommendedFormulaDirection.replace(/[（(]按已签名证候反查受控目录锁定[^）)]*[）)]/g, "").trim();
  }
  for (const item of records(overview?.tcmDiseaseDifferentials)) {
    if (typeof item.diseaseName === "string") item.diseaseName = item.diseaseName.replace(/类病$/u, "");
  }
  // 中医鉴别的理由写病证本身为何相近，不写「以免漏诊」「避免误诊」这类处置口吻（甲方 10.12 测评；提示词已要求，模型仍偶有，
  // 2026-10-14 评测 28 例里 3 例）。只删这半句；删完为空时保留原句。
  for (const item of [...records(overview?.tcmDiseaseDifferentials), ...records(overview?.tcmDifferentials)]) {
    if (typeof item.reason !== "string") continue;
    const trimmed = item.reason.replace(/[，,；;]?\s*(?:以免|避免|防止)(?:漏诊|误诊)[^，,。；;]*/gu, "").trim();
    if (trimmed.length >= 2) item.reason = trimmed;
  }
  for (const item of records(western?.candidates)) {
    item.name = records(western?.candidates).indexOf(item) === 0 && primary ? primary.name : deliveredDifferentialName(item.name);
  }
}

function deliveredPrescribe(reasoning: Json, options?: DeliveredSurfaceOptions): void {
  // 开方结果里带着辨证阶段的副本：同一口径再投影一次（调用方回传的是已投影的那份，幂等）。
  deliveredDiagnose(reasoning);
  const formula = record(reasoning.formula);
  const priorOverview = record(reasoning.overview);
  const textbookRow = textbookRowForSyndrome(String(priorOverview?.tcmDiseaseName || ""), String(priorOverview?.primarySyndrome || ""));
  const direction = typeof priorOverview?.recommendedFormulaDirection === "string" ? priorOverview.recommendedFormulaDirection.trim() : "";
  for (const candidate of records(formula?.candidates)) {
    // 两个阶段方名一致（甲方 10.12 测评「方剂名称前后不一致」）：辨证阶段定的是教材代表方、处方确实以该方组成为主体
    //（教材组成过半在方中），而方名在开方阶段被改成了别的名字或「本例辨证组方」时，方名用辨证阶段定下的那个。
    // 组成没有过半时不改名——那时方子确实不是这张方，名字照实。
    if (textbookRow && direction && textbookRow.formulas.some((name) => direction.includes(name)) &&
      typeof candidate.name === "string" && !textbookRow.formulas.some((name) => String(candidate.name).includes(name))) {
      const herbs = records(candidate.herbs).map((herb) => String(herb.name || ""));
      const covered = textbookFormulasCoveredByPrescription(textbookRow, herbs);
      if (covered.length > 0) {
        // 合方只有其中一张的组成在处方里时，方名只写那一张（「龙胆泻肝汤合萆薢渗湿汤加减」而方中没有后者的药）。
        const allCovered = covered.length === textbookRow.formulas.length;
        candidate.name = allCovered ? (/加减$/.test(direction) ? direction : `${direction}加减`) : `${covered.join("合")}加减`;
        const sourceRecord = record(candidate.formulaSource);
        // 出处写方剂的原书（方剂目录里有的按目录），目录没有收的方才注明是哪本教材哪一证的代表方。
        // 此前一律写教材（「三子养亲汤：《中医内科学》咳嗽·痰湿蕴肺证代表方」），原书应为《韩氏医通》（2026-10-13 独立评审）。
        if (sourceRecord) {
          const textbookNote = `《${textbookRow.book}》${textbookRow.disease}·${textbookRow.syndromeName}代表方`;
          sourceRecord.source = (allCovered ? textbookRow.formulas : covered)
            .map((name) => `${name}：${formulaCompilationReferences([name])[0]?.source || textbookNote}`)
            .join("；");
        }
        // 方义里的方名此前被当作「自拟方不得自称成方」替换成了「本方案」，随方名一起还原。
        if (typeof candidate.formulaAnalysis === "string") {
          // 方名已随辨证阶段改回教材代表方，方义里「故自拟组方」的说法随之改掉。
          candidate.formulaAnalysis = candidate.formulaAnalysis
            .replace(/自拟(?:组方|方剂|一方|方)/g, `以${allCovered ? textbookFormulaLabel(textbookRow) : covered.join("合")}加减`);
        }
      }
    }
    // 方义里的方名此前被「自拟方不得自称成方」一律换成了「本方案」（tcm-formula-provenance）。
    // 方名最终是成方时把它换回来；确是自拟方时「本方以本方案为基础加减」只是空话，改成一句说明。
    // 此前只处理了带「为基础」的写法，「本方以本方案加减。」被留成「本方以本方。」（合成集 84 例里 3 例）。
    if (typeof candidate.formulaAnalysis === "string" && /本方案/.test(candidate.formulaAnalysis)) {
      const finalName = typeof candidate.name === "string" ? candidate.name.trim() : "";
      const selfComposed = !finalName || finalName === "自拟方" || SELF_COMPOSED_NAME.test(finalName);
      const label = finalName.replace(/加减$/u, "");
      // 开头点方名的那个分句整句重写：占位替换会把合方名拆坏（「本方以本方案合脾约本方案为基础加减」「本方以本方案化裁」），
      // 逐个词替换救不回来；后文其余的「本方案」改回「本方」。
      const opening = candidate.formulaAnalysis.match(/^([^，,。；;]*本方案[^，,。；;]*)([，,。；;])\s*/);
      const rest = opening ? candidate.formulaAnalysis.slice(opening[0].length) : candidate.formulaAnalysis;
      candidate.formulaAnalysis = `${opening ? (selfComposed ? "本方为自拟方。" : `本方以${label}为基础加减${opening[2]}`) : ""}${rest}`
        .replace(/本方案/g, "本方");
    }
    // 方义说「去原方中…之品」而处方其实保留了原方全部药味（2026-10-17：甲方标准病历 1、4、10，三次生成里 4 次，独立评审判陈述失实）。
    // 方名能在方剂目录里查到组成、且组成逐味都在处方里时，去掉这句「去…」以及紧跟的「保留…/留其主体」；查不到组成时不动。
    if (typeof candidate.formulaAnalysis === "string" && REMOVAL_CLAIM_CLAUSE.test(candidate.formulaAnalysis) && typeof candidate.name === "string") {
      const baseName = candidate.name.trim().replace(/(?:加减|化裁|加味)$/u, "");
      const reference = formulaCompilationReferences([baseName])[0];
      const present = new Set(records(candidate.herbs).map((herb) => compositionIdentityName(String(herb.name || ""))).filter(Boolean));
      const ingredients = (reference?.ingredients || []).map((name) => compositionIdentityName(name.replace(/[（(][^）)]*[）)]/g, ""))).filter(Boolean);
      if (ingredients.length > 0 && ingredients.every((id) => present.has(id))) {
        candidate.formulaAnalysis = withoutRemovalClaims(candidate.formulaAnalysis);
      }
    }
    // 开头一句说「加X」而X本来就在原方组成里（含生用写法：消风散原方有地黄，方义写「加生地黄」「以生地黄易原方地黄并加用」，
    // 2026-10-17 甲方标准病历 9 两次生成）：去掉这个不实的加药说法，其余照留。原方组成查不到时不动。
    if (typeof candidate.formulaAnalysis === "string" && typeof candidate.name === "string" && /加|易/.test(candidate.formulaAnalysis)) {
      const reference = formulaCompilationReferences([candidate.name.trim().replace(/(?:加减|化裁|加味)$/u, "")])[0];
      const catalogIds = new Set((reference?.ingredients || []).map((name) => rawFormHerbIdentity(name.replace(/[（(][^）)]*[）)]/g, ""))).filter(Boolean));
      if (catalogIds.size > 0) candidate.formulaAnalysis = withoutFalseAdditionClaims(candidate.formulaAnalysis, catalogIds);
    }
    // 方义里夹着模型的自问自答（「去原方中…的川芎？不，川芎保留。」，2026-10-17 甲方标准病历 4）：带问号的小句与同句里紧跟的自我更正不留。
    if (typeof candidate.formulaAnalysis === "string" && /[？?]/.test(candidate.formulaAnalysis)) {
      candidate.formulaAnalysis = withoutQuestionChatter(candidate.formulaAnalysis);
    }
    if (typeof candidate.name === "string" && SELF_COMPOSED_NAME.test(candidate.name.trim())) candidate.name = "自拟方";
    // 「适用于与本例锁定证候…及病机链一致的情况」是每例相同的模板句，不带内容。
    if (typeof candidate.applicable === "string") candidate.applicable = "";
    // 逐味人群提示只列本例可能属于的人群：按候选药味从同一份知识库重写尾段（尾段的写法只在 candidate-boundary-text 一处）。
    // 投影后尾段的标记已去掉，再投影一次不会重写，幂等。
    if (options?.herbBoundaryAudience && typeof candidate.notApplicable === "string" && hasHerbBoundaryTail(candidate.notApplicable)) {
      const herbNames = records(candidate.herbs).map((herb) => typeof herb.name === "string" ? herb.name.trim() : "").filter(Boolean);
      const tail = herbBoundaryTail(herbNames.map((name) => getTcmHerbGenerationSafetyProfile(name)), options.herbBoundaryAudience);
      // 交付面本来只留尾段（尾段前的模板句由下面同一处去掉）；一味都不剩时整栏为空。
      candidate.notApplicable = tail ? [stripHerbBoundaryTail(candidate.notApplicable), tail].filter(Boolean).join(" ") : "";
    }
    if (typeof candidate.notApplicable === "string") {
      const text = candidate.notApplicable;
      if (/各药毒性与特殊人群提示[:：]/.test(text)) {
        // 只留逐味的特殊人群提示（数据来自药典与说明书），去掉前面每例相同的模板句与收尾的流程话。
        candidate.notApplicable = text.replace(NOT_APPLICABLE_TEMPLATE_HEAD, "")
          .replace(/^各药毒性与特殊人群提示[:：]\s*/, "")
          .replace(/相应人群或状态请停用、替换，或经医生\/药师复核后使用。?$/, "")
          .replace(/禁用或须强复核/g, "禁用").replace(/[；;。\s]+$/g, "").trim();
      } else if (/^证候、病机、舌脉或安全边界变化时/.test(text.trim())) {
        candidate.notApplicable = "";
      }
    }
    const source = record(candidate.formulaSource);
    if (source && typeof source.source === "string" && /^自拟方/.test(source.source.trim())) source.source = "自拟方";
  }
  for (const medicine of records(formula?.patentAndWestern)) {
    // 「说明书用法字段已与本候选的说明书条目及指纹绑定」「与中药饮片方案不默认联用…」是系统说明，不是用药信息。
    if (typeof medicine.usageBoundary === "string") medicine.usageBoundary = "";
    if (typeof medicine.relationship === "string") medicine.relationship = "";
  }
  const nonPharma = record(reasoning.nonPharma);
  if (nonPharma && Array.isArray(nonPharma.precautions)) {
    // 整句被禁词表或净化清空后只剩标点的条目不下发。
    nonPharma.precautions = nonPharma.precautions.filter((item) => typeof item === "string" && /[\u4e00-\u9fff]{4,}/u.test(item));
  }
  if (nonPharma && Array.isArray(nonPharma.tcmTreatments)) {
    // 给不出具体内容的项目不下发（甲方 10.12 测评 5.2「中医治疗具体内容未展示」）：「仅评估」的项目只有项目名和一句
    //「本轮仅进行现场评估，不形成操作计划」；食疗、导引、情志这类无穴项目在目录里只有类目模板、没有任何做法。
    nonPharma.tcmTreatments = records(nonPharma.tcmTreatments).filter((item) => {
      if (item.protocolStatus === "assessment_only_no_patient_specific_protocol" || item.tailoringStatus === "assessment_only") return false;
      const points = Array.isArray(item.suggestedSitesOrPoints) ? item.suggestedSitesOrPoints.length : 0;
      const pointFree = item.projectCode === "diet_therapy" || item.projectCode === "qigong_daoyin" || item.projectCode === "mind_therapy";
      if (pointFree && points === 0 && item.tailoringStatus === "class_template_only") return false;
      // 病种模板的治疗内容只是一段治则（「治则：虚劳以本虚为主…」），没有本例的操作（2026-10-17，甲方标准病历 5 的推拿卡）。
      if (item.tailoringStatus === "class_template_only" && /^治则[:：]/.test(String(item.treatmentContent || "").trim())) return false;
      // 食疗方与本例饮食宜忌相反：饮食栏写清淡、忌油腻或避免滋腻，食疗卡却是猪排、猪肺这类肥甘之品
      //（2026-10-17，甲方标准病历 9「芋头炖猪排」对「饮食清淡易消化」，病历 5「猪肺粥」对「避免滋腻碍脾」）。
      if (item.projectCode === "diet_therapy" && DIET_AVOIDS_RICH_FOOD.test(String(nonPharma.diet || "")) &&
        RICH_RECIPE_INGREDIENT.test(String(item.treatmentContent || ""))) return false;
      return true;
    });
  }
  if (nonPharma && Array.isArray(nonPharma.precautions)) {
    // 去掉卡之后再按最终给出的项目核一遍注意事项（出卡处按出卡时的集合核过，交付面去掉的卡它不知道）。
    const delivered = deliveredTreatmentCodes(records(nonPharma.tcmTreatments), nonPharma.acupointCare);
    let precautions: unknown[] = nonPharma.precautions.filter((line) => !precautionMentionsUndeliveredTreatment(line, delivered));
    // 服药时间以本方的煎服法为准：煎服法写饭后、注意事项写饭前（或反过来）时，去掉注意事项里说时间的那一小句
    //（甲方标准病历 2 两次生成都是「汤剂宜饭前温服」对「饭后温服」）。
    const method = String(record(records(formula?.candidates)[0]?.decoction)?.method || "");
    const methodTiming = /饭后|餐后/.test(method) ? "after" : /饭前|餐前|空腹/.test(method) ? "before" : "";
    // 「若胃脘不适可改为饭后温服」而煎服法本来就是饭后（甲方标准病历 2）：说「改为」煎服法已定的时间，同样前后矛盾；
    // 煎服法是饭前时，「若胃脘不适可改为饭后」是有条件的改法，不算矛盾，照留。
    const conflicting = methodTiming === "after"
      ? /(?<!改(?:为|在|到))(?:饭前|餐前|空腹)|改(?:为|在|到)(?:饭|餐)后/
      : methodTiming === "before" ? /(?<!改(?:为|在|到))(?:饭后|餐后)|改(?:为|在|到)(?:(?:饭|餐)前|空腹)/ : undefined;
    if (conflicting) {
      precautions = precautions
        .map((line) => typeof line === "string" ? withoutTimingClauses(line, conflicting) : line)
        .filter((line) => typeof line === "string" && /[\u4e00-\u9fff]{4,}/u.test(line));
    }
    // 注意事项叫患者别再服的药，正是本次推荐西成药里的药（2026-10-17：「不宜再服人参口服液」与推荐人参口服液同出一页）。
    // 推荐是医生评估后的选项，注意事项那一条不留。
    const recommended = records(formula?.patentAndWestern).map((item) => String(item.name || "").trim()).filter((name) => name.length >= 2);
    if (recommended.length > 0) {
      precautions = precautions.filter((line) => typeof line !== "string" ||
        !recommended.some((name) => line.includes(name) && /不宜|不要|勿|避免|停服|忌/.test(line)));
    }
    // 针刺卡在皮损局部取穴（阿是穴、围刺）时，注意事项里「皮损局部暂不施针」那一小句与之矛盾，不留（2026-10-17 本地复测：
    // 蛇串疮卡按教材「皮损局部阿是穴用围刺法」，注意事项写「皮损局部暂不施针」；丹毒卡列阿是穴，注意事项写「红肿处不宜针刺」）。
    const localNeedling = records(nonPharma.tcmTreatments).some((item) => item.projectCode === "acupuncture" &&
      (JSON.stringify(item.suggestedSitesOrPoints || []).includes("阿是穴") || /围刺/.test(`${String(item.techniqueBoundary || "")}${String(item.treatmentContent || "")}`)));
    if (localNeedling) {
      precautions = precautions
        .map((line) => typeof line === "string" ? withoutTimingClauses(line, LOCAL_NEEDLING_FORBIDDEN) : line)
        .filter((line) => typeof line !== "string" || /[\u4e00-\u9fff]{4,}/u.test(line));
    }
    // 本例必须写到的项目（自服药、产后哺乳、丹毒抗感染）逐项核对，模型漏写的用规则那句补在最前（2026-10-17）。
    // 已写到的不动；补上之后再投影一次就都算写到了，幂等。
    const required = options?.requiredPrecautions || [];
    if (required.length > 0) {
      const herbIdentities = new Set(records(records(formula?.candidates)[0]?.herbs)
        .map((herb) => compositionIdentityName(String(herb.name || ""))).filter(Boolean));
      // 模型写到的自服药那一条：说重叠的药只留本方真有的；一味不剩又说重叠的，删掉这条，下面按漏写补规则那句。
      for (const item of required) {
        if (item.kind !== "self_medication") continue;
        precautions = precautions.flatMap((line) => typeof line === "string" ? [withOnlyPrescribedOverlap(line, item, herbIdentities)].filter((value): value is string => Boolean(value)) : [line]);
      }
      // 哺乳期慎用的药按逐味人群提示同一份知识库、同一档（中、高）列；模型写「方中暂无哺乳期慎用药」而知识库列了的，换成规则那一句
      //（2026-10-17 本地复测病历 3：同一页的逐味提示写着川芎哺乳期慎用）。
      const lactationHerbs = records(records(formula?.candidates)[0]?.herbs)
        .map((herb) => String(herb.name || "").trim())
        .filter((name) => name && getTcmHerbGenerationSafetyProfile(name).populationRules
          .some((rule) => rule.population.includes("哺乳") && (rule.severity === "HIGH" || rule.severity === "MEDIUM")));
      if (lactationHerbs.length > 0 && required.some((item) => item.kind === "postpartum_lactation")) {
        precautions = precautions.filter((line) => typeof line !== "string" ||
          !/(?:暂无|并无|无|没有|不含|未见)[^，,。；;]{0,8}(?:哺乳期慎用|回乳)/.test(line));
      }
      const current = precautions.filter((line): line is string => typeof line === "string");
      const added = required.filter((item) => !requiredPrecautionCovered(item, current))
        .map((item) => requiredPrecautionLine(item, herbIdentities, lactationHerbs));
      if (added.length > 0) precautions = [...added, ...precautions];
    }
    nonPharma.precautions = precautions;
  }
  for (const treatment of records(nonPharma?.tcmTreatments)) {
    for (const key of ["scheduleSuggestion", "techniqueBoundary"]) {
      // 先去掉「实际取穴由现场医师复核」「实际间隔与疗程由面诊医生…确定 / 调整」这类操作人员要求，
      // 再按出卡处同一个函数改写流程用语（此前已签名、仍在回放的结果也按同一口径）。
      if (typeof treatment[key] === "string") {
        const original = String(treatment[key]);
        treatment[key] = clinicalTreatmentScheduleWording(original
          .replace(/[；;，,]?\s*实际(?:取穴|间隔与疗程)[^。；;]*?(?:复核|确定|调整)。?/g, "。")) || original;
      }
    }
    if (Array.isArray(treatment.suggestedSitesOrPoints)) {
      treatment.suggestedSitesOrPoints = treatment.suggestedSitesOrPoints.map((item) => typeof item === "string" ? item.replace(/[（(]按证型加选[）)]/g, "") : item);
    }
  }
  for (const modification of records(formula?.modifications)) {
    if (typeof modification.riskNote === "string" && /药味工作台|重新审方/.test(modification.riskNote)) modification.riskNote = "";
  }
}

/**
 * 处方确以教材代表方中的哪几张为主体（组成过半在方中）。
 *
 * 基准有两个，取高的：教材行自带的组成（外科、妇科的合方常只列一部分，个别方没有列），与方剂目录里该方的组成。
 * 药名按组成身份比（龙胆草=龙胆、当归尾=当归、生甘草=甘草、麻子仁=火麻仁）——此前按字面比，
 * 合成集 6 例辨证阶段定了教材代表方、处方也确是那张方，方名却落成「自拟方」，两个阶段方名不一致。
 * 教材行的组成不分属哪张方：合方时它过半只说明「并集过半」，各张都算；目录能分清时按目录各算各的。
 */
function textbookFormulasCoveredByPrescription(row: { formulas: string[]; composition: string[] }, herbNames: readonly string[]): string[] {
  const present = new Set(herbNames.map((name) => compositionIdentityName(name)).filter(Boolean));
  const share = (ingredients: readonly string[]) => {
    const ids = [...new Set(ingredients.map((name) => compositionIdentityName(name.replace(/[（(][^）)]*[）)]/g, ""))).filter(Boolean))];
    return ids.length === 0 ? 0 : ids.filter((id) => present.has(id)).length / ids.length;
  };
  const byCatalog = row.formulas.filter((name) => formulaCompilationReferences([name]).some((reference) => share(reference.ingredients) >= 0.5));
  if (byCatalog.length > 0) return byCatalog;
  return share(row.composition) >= 0.5 ? [...row.formulas] : [];
}

function withoutQuestionChatter(analysis: string): string {
  return analysis.split(/(?<=[。！!])/).map((sentence) => {
    const clauses = sentence.split(/(?<=[，,；;？?])/);
    const at = clauses.findIndex((clause) => /[？?]/.test(clause));
    if (at < 0) return sentence;
    // 问号小句及其后的同句内容（「不，川芎保留。」）都是自我更正的过程，只留问号之前的部分。
    const kept = clauses.slice(0, at).join("").replace(/[，,；;]$/, "");
    return kept ? `${kept}。` : "";
  }).join("");
}

/** 方义里「去原方中…之品」这类说删了原方药味的小句。 */
/** 注意事项里叫患者别在皮损/患处针刺的小句。 */
const LOCAL_NEEDLING_FORBIDDEN = /(?:皮损|局部|患处|红肿处|疱疹|皮疹)[^，,。；;]{0,6}(?:暂不|不宜|勿|避免|禁止|不可|不要)[^，,。；;]{0,4}(?:施针|针刺|针)/u;

/** 组成身份，生用写法算同一味（生地黄 = 地黄）：与开方编译里判断加减是否重复同一口径。 */
function rawFormHerbIdentity(name: string): string {
  const trimmed = name.trim();
  return compositionIdentityName(trimmed.length >= 3 ? trimmed.replace(/^生/u, "") : trimmed);
}

/**
 * 方义开头一句（「本方以X为基础加减，去A，加B。」）里不实的加药说法：「加B」的B已在原方组成里，去掉B（都去掉时整小句不留）；
 *「以B易原方B'」两边是同一味，整小句不留。只看第一句，后面讲配伍的话不动。
 */
function withoutFalseAdditionClaims(analysis: string, catalogIds: ReadonlySet<string>): string {
  const end = analysis.indexOf("。");
  const first = end >= 0 ? analysis.slice(0, end) : analysis;
  const rest = end >= 0 ? analysis.slice(end) : "";
  // 「去石膏、加生地黄」：加药说法也会跟在顿号后面（2026-10-17 生产复测病历 9），顿号后紧跟「加」的地方同样切开。
  const clauses = first.split(/[，,；;]|、(?=(?:并|再|另)?加)/);
  const kept = clauses.flatMap((clause) => {
    const swap = clause.match(/^\s*(?:并|且)?以([^，,；;易]{2,6})易(?:原方(?:中)?)?([^，,；;并]{2,6})/u);
    if (swap && rawFormHerbIdentity(swap[1]) === rawFormHerbIdentity(swap[2])) return [];
    const addition = clause.match(/^(\s*(?:并|再|另)?(?:加用|加入|加))([^，,；;]+)$/u);
    if (!addition) return [clause];
    const names = addition[2].split(/[、和及与]/u).map((item) => item.trim()).filter(Boolean);
    const remaining = names.filter((item) => !catalogIds.has(rawFormHerbIdentity(item)));
    if (remaining.length === names.length) return [clause];
    return remaining.length > 0 ? [`${addition[1]}${remaining.join("、")}`] : [];
  });
  if (kept.length === clauses.length && kept.every((clause, index) => clause === clauses[index])) return analysis;
  return `${kept.join("，")}${rest}`;
}

const REMOVAL_CLAIM_CLAUSE = /(?:^|[，,。；;])\s*(?:并|且)?(?:去|删去|减去|去掉)(?:原方|其)?[^，,。；;]{0,20}(?:之品|之药|药味|诸药|之味)/u;
function withoutRemovalClaims(analysis: string): string {
  return analysis.split(/(?<=。)/).map((sentence) => {
    const clauses = sentence.split(/(?<=[，,；;])/);
    const kept: string[] = [];
    let dropping = false;
    for (const clause of clauses) {
      const body = clause.replace(/^\s*(?:并|且)?/u, "");
      const claim = body.match(/^(?:去|删去|减去|去掉)(?:原方|其)?[^，,。；;]{0,20}?(?:之品|之药|药味|诸药|之味)(?:后|而)?/u);
      if (claim) {
        // 同一小句里「去…之品后以附子、肉桂为君」：只去掉说删药的部分，后面的话留下。
        const rest = body.slice(claim[0].length);
        dropping = true;
        // 只留「以附子、肉桂为君」这种自成一句的后半；「以免过峻之弊」「以防…」这类说删药理由的残段一并不留
        //（2026-10-17 本地复测：「本方以龙胆泻肝汤为基础加减，过峻之弊，加牡丹皮…」）。
        if (!/^(?:以|用)[^，,。；;]*为/u.test(rest.trim())) continue;
        kept.push(rest);
        dropping = false;
        continue;
      }
      if (dropping && /^(?:而)?(?:留|保留)/u.test(body)) continue;
      dropping = false;
      kept.push(clause);
    }
    const joined = kept.join("");
    // 去掉的是句末小句时，前一小句收尾的逗号换成句号。
    return /[，,；;]$/.test(joined) && /。$/.test(sentence) ? `${joined.replace(/[，,；;]$/, "")}。` : joined;
  }).join("");
}

/** 饮食栏要求清淡、忌油腻或避免滋腻。 */
const DIET_AVOIDS_RICH_FOOD = /清淡|忌(?:食)?[^。；，,]{0,6}油腻|少(?:食|吃)[^。；，,]{0,4}油腻|避免[^。；，,]{0,4}滋腻|忌[^。；，,]{0,4}肥甘|少(?:食|吃)肥甘|不宜油腻/u;
/** 食疗方里的肥甘之品（猪苓、鸡内金是药，不算）。 */
const RICH_RECIPE_INGREDIENT = /猪(?!苓)|羊肉|牛肉|排骨|肥肉|蹄|鸭肉|老鸭|鹅|鸡汤|鸡肉|乌鸡|母鸡/u;

/** 去掉命中的小句（逗号、分号、句号分隔），其余原样；全部命中时返回空串。 */
function withoutTimingClauses(line: string, pattern: RegExp): string {
  if (!pattern.test(line)) return line;
  const joined = line.split(/(?<=[，,；;。])/).filter((clause) => !pattern.test(clause)).join("").replace(/[，,；;]+$/, "").trim();
  return joined && !/[。！？!?]$/.test(joined) ? `${joined}。` : joined;
}

/** 就地投影一份已解析的结构化结果。非 V2 结果原样返回。 */
export function projectDeliveredReasoning<T>(reasoning: T, options?: DeliveredSurfaceOptions): T {
  const object = record(reasoning);
  if (!object || object.schemaVersion !== "tcm-cdss-reasoning-v2") return reasoning;
  const projected = structuredClone(object);
  if (projected.stage === "diagnose") deliveredDiagnose(projected);
  else if (projected.stage === "prescribe") deliveredPrescribe(projected, options);
  else return reasoning;
  rewordDeep(projected);
  return projected as T;
}

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/** 对 sentinel 内的结构化结果应用交付面投影；没有变化时逐字节返回原文。 */
export function applyDeliveredSurfaceToContent(content: string, options?: DeliveredSurfaceOptions): string {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const parsed = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
    const projected = projectDeliveredReasoning(parsed, options);
    if (JSON.stringify(projected) === JSON.stringify(parsed)) return content;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(projected, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * 开方阶段读回辨证结果时，把病历里已记录的当前表现补回西医支持事实（只在本次请求的内存里）。
 *
 * 交付面不再带症状依据，但开方阶段有三处核对要用它：随证加减的触发症状必须能回溯到「已记录的当前表现」。
 * 这些支持事实本来就是病历原句的逐字摘录，所以直接从病历的现病史取同一类内容（肯定极性的分句），
 * 不改变任何判定口径；交付前会再次清空。回传的辨证结果自带支持事实时原样不动。
 */
export function restoreDiagnoseSupportingFacts<T>(prior: T, affirmedRecordClauses: readonly string[]): T {
  const object = record(prior);
  const primary = record(record(object?.westernDiagnosis)?.primary);
  if (!object || object.stage !== "diagnose" || !primary) return prior;
  const existing = Array.isArray(primary.supportingFacts) ? primary.supportingFacts.filter((item) => typeof item === "string" && item.trim()) : [];
  if (existing.length > 0) return prior;
  const facts = [...new Set(affirmedRecordClauses.map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 600))].slice(0, 12);
  if (facts.length === 0) return prior;
  const restored = structuredClone(object);
  (record(record(restored.westernDiagnosis)!.primary)!).supportingFacts = facts;
  return restored as T;
}
