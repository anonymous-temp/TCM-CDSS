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
  [new RegExp(`病历未记录${OBJECT}(?:记录)?[（(]需问诊核实后方可用于排除[）)]`, "g"), "未诉$1"],
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
  // 「某某类病」是国标里的分类名，不是病名（测评截图里的「痹证类病」「虚劳类病」）。
  const overview = record(reasoning.overview);
  if (overview && typeof overview.tcmDiseaseName === "string") overview.tcmDiseaseName = overview.tcmDiseaseName.replace(/类病$/u, "");
  // 中医鉴别诊断每例必出（甲方 10.12 测评 2.3「中医鉴别诊断未生成」）：模型没写或写的病名全被归一丢掉时，
  // 用教材【鉴别诊断】对该病列出的病证补齐，要点是教材原文。有限结论（证候未形成）不补。
  if (overview && !isLimitedDiagnose(reasoning) && typeof overview.tcmDiseaseName === "string" &&
    (!Array.isArray(overview.tcmDiseaseDifferentials) || overview.tcmDiseaseDifferentials.length === 0)) {
    const textbookDifferentials = textbookDifferentialsForDisease(overview.tcmDiseaseName);
    if (textbookDifferentials.length > 0) {
      overview.tcmDiseaseDifferentials = textbookDifferentials.map((item) => ({
        diseaseName: item.name,
        reason: "主症相近，教材列为本病的鉴别病证",
        distinguishingPoints: item.text,
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
  for (const item of records(western?.candidates)) {
    item.name = records(western?.candidates).indexOf(item) === 0 && primary ? primary.name : deliveredDifferentialName(item.name);
  }
}

function deliveredPrescribe(reasoning: Json): void {
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
    if (typeof candidate.name === "string" && SELF_COMPOSED_NAME.test(candidate.name.trim())) candidate.name = "自拟方";
    // 「适用于与本例锁定证候…及病机链一致的情况」是每例相同的模板句，不带内容。
    if (typeof candidate.applicable === "string") candidate.applicable = "";
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
      return !(pointFree && points === 0 && item.tailoringStatus === "class_template_only");
    });
  }
  for (const treatment of records(nonPharma?.tcmTreatments)) {
    for (const key of ["scheduleSuggestion", "techniqueBoundary"]) {
      if (typeof treatment[key] === "string") {
        treatment[key] = String(treatment[key])
          .replace(/疗程由复评决定。?/g, "")
          .replace(/[；;，,]?\s*实际(?:取穴|间隔与疗程)[^。；;]*?(?:复核|确定)。?/g, "。")
          .replace(/。{2,}/g, "。").replace(/^[。；;，,\s]+/, "").trim() || String(treatment[key]);
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

/** 就地投影一份已解析的结构化结果。非 V2 结果原样返回。 */
export function projectDeliveredReasoning<T>(reasoning: T): T {
  const object = record(reasoning);
  if (!object || object.schemaVersion !== "tcm-cdss-reasoning-v2") return reasoning;
  const projected = structuredClone(object);
  if (projected.stage === "diagnose") deliveredDiagnose(projected);
  else if (projected.stage === "prescribe") deliveredPrescribe(projected);
  else return reasoning;
  rewordDeep(projected);
  return projected as T;
}

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/** 对 sentinel 内的结构化结果应用交付面投影；没有变化时逐字节返回原文。 */
export function applyDeliveredSurfaceToContent(content: string): string {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const parsed = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
    const projected = projectDeliveredReasoning(parsed);
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
