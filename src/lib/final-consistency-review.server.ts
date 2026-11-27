import "server-only";

import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { buildDeliveryInvariantGovernance } from "./delivery-invariant-governance";
import { scanDeliveryInvariants } from "./delivery-invariants";
import { settleWesternDiagnosisBasis } from "./recorded-test-claims";
import { primaryModelJsonTask } from "./cross-model-small-task.server";
import { quoteGroundedInText } from "./verbatim-quote";
import { splitTextbookDiseaseSubtype, textbookDiseaseDifferentialNames, textbookDiseaseTypicalManifestation, textbookRowForSyndrome, textbookTherapyItems } from "./tcm-textbook-syndromes";
import { governedFourCharacterMethodTerms } from "./clinical-governance-tables";
import { diagnosticsCriteriaFor } from "./m03-secondary-syndrome-consistency.server";
import { natureLabelsNamedBySyndromeMissingFrom } from "./nature-column-classification";
import { canonicalTcmHerbIdentity } from "./diagnosis-stage-contract";
import { isKnownTcmHerbName } from "./tcm-knowledge";
import { herbFunctionSourceClauses, selectGroundedHerbFunction, type HerbFunctionPatient } from "./herb-function-display-source";

/**
 * 定稿前的一致性通读（2026-11-22 第五十五轮，CDSS_FINAL_CONSISTENCY_REVIEW=on 时启用，缺省关）。
 *
 * 为什么：甲方三轮测评病例 72 份 + 新写病历 40 份同日对照（~/runlogs/r1018/work/r1073），同一份交付结果再让 deepseek-flash
 * 按甲方验收口径整体通读一遍、只改确实错的字段（与病历不符、前后矛盾、违反甲方明确规定），qwen4-max 按甲方 20 项判：
 * 不通过 137 → 108，无一项不通过的病例 32 → 47（病机、中成药、随证加减、诊断依据、调护几项为主）。同一个读稿人放开了改
 * 加减与病名时反而更差（加减删到不足两条、改坏甲方标准病历的证名），所以这里只放开实验里表现好的字段，并加服务端核对：
 *  · 辨证阶段：辨病依据、辨证依据、病位、病性、总体病机、病机链、待核实、治法（每项四字、不重复）、中医鉴别、西医依据；
 *    西医病名只许加或去「待查」，不换病；病名、主证、兼证、方名不动。
 *  · 开方阶段：方义；中成药只删不加；药味只改功效文字与同一味药的炮制写法（同一身份、知识库认得），不增删药、不改剂量、不改角色。
 * 注意事项、调护、随访、加减不在范围内（规则算出的安全提示不能被删）。读稿人每改一处须在 review 里引病历或结果原文；
 * 改动在投影与签名之前生效，随后照常经交付面投影、合同校验与签名。模型失败、超时或解析不了：原样交付。
 */
export type FinalReviewStage = "diagnose" | "prescribe";

export function finalConsistencyReviewMode(): "on" | "off" {
  return process.env.CDSS_FINAL_CONSISTENCY_REVIEW?.trim() === "on" ? "on" : "off";
}

// 辨病依据、辨证依据不在范围内（第五十五轮 b2→b3）：读稿人改写这两段时诊断依据一项改坏多于改好（6/2，「以既定证名反推」之类），
// 这两段由定稿后的依据重写（m03-final-rationale）负责。
const DIAGNOSE_FIELDS = ["病位", "病性", "总体病机", "病机链", "待核实", "治法", "中医鉴别", "西医诊断", "西医依据"] as const;
const PRESCRIBE_FIELDS = ["方义", "中成药", "药味"] as const;

const RULES = `你是三甲医院中医科副主任医师，在门诊辅助诊疗结果交给医生之前做最后一遍通读。你会看到病历原文和一份已经写好的结果（JSON）。
你只改三类错，其余一律不动：
① 与病历不符：写了病历没有的症状、体征、检查结果、病程、诱因（病历没做的检查写成"未见异常""未闻及"也算），或与病历相反。
② 同一份结果前后矛盾：证名与病位、病性、病机链、依据对不上；治法与证候对不上；方义与药味表（药名、君臣佐使）对不上；"待核实"问的是病历已写的内容；鉴别里说本例没有该病的任何表现。
③ 违反甲方明确提出过的规定：辨证依据要讲"表现→病机"、提到已记录的舌象和脉象；西医病名的确定程度与依据一致（依据自己说尚不能确诊、缺关键检查或病程不够时写"X待查"）；治法每项四字、不重复、覆盖主症；方义不写"去X"而X仍在方中；中成药与证候寒热方向相反、与汤药成分重复的删掉。
可改可不改的、你认为另一种写法更好的、教材原文写法（教材治法、教材证名、原方本有的药味）——不改。拿不准就不改。
不能碰的：红旗判断；药味的增删与剂量。`;

const SCOPE: Record<FinalReviewStage, string> = {
  diagnose: `【本次审稿范围】只审改：病位、病性、总体病机、病机链、待核实、治法、中医鉴别、西医诊断、西医依据。
- 逐项对照病历和教材。辨证依据中成组表现所支持的病因、脏腑与病性要落实到总体病机和相应栏目；分清致病之本和病后损伤，区分虚热和独立实邪。病名、证名和依据保留。
- 治法每项四字、至多三项，覆盖主症及并病脏腑，按教材本证治法核对方义。每个病机节点只引病历中支持该节点的原话。已记载的舌脉和检查不再列为待核实，只保留影响辨证或用药的具体缺项。
- 西医诊断只改确定程度（加或去"待查"），不换成别的病。`,
  prescribe: `【本次审稿范围】只审改：方义、中成药、药味。辨证结论（病名、证名、治法）只作参照，不改。
- 中成药只能删，不能加。
- 药味只改功效文字和同一味药的炮制写法，不增删药、不改剂量、不改君臣佐使。`,
};

const OUTPUT = `输出 JSON：{"review":[{"field":"字段名","kind":"①|②|③","evidence":"引病历或结果里的原文，≤60字","problem":"≤40字"}],"patch":{"字段名":改后的完整新值}}
- 每条 review 必须有 evidence；拿不出原文依据的不要提。先写 review 再写 patch；patch 里只能出现 review 里点到的字段。
- 新值的类型和子键与草稿一致，只改出错的那部分，其余原样保留。没有问题就输出 {"review":[],"patch":{}}。`;

type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const object = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function finalReviewDraft(stage: FinalReviewStage, reasoning: Json, prior?: Json): Json {
  if (stage === "diagnose") {
    const overview = object(reasoning.overview) || {};
    const pathogenesis = object(reasoning.pathogenesis) || {};
    const location = object(pathogenesis.locationDifferentiation) || {};
    const nature = object(pathogenesis.natureDifferentiation) || {};
    const western = object(object(reasoning.westernDiagnosis)?.primary) || {};
    const ref = textbookRowForSyndrome(text(overview.tcmDiseaseName), text(overview.primarySyndrome));
    return {
      病名: text(overview.tcmDiseaseName), 主证: text(overview.primarySyndrome), 兼证: list(overview.secondarySyndromes),
      辨病依据: text(overview.tcmDiseaseRationale), 辨证依据: text(overview.tcmDiagnosticRationale),
      教材治法: ref?.syndromeName === overview.primarySyndrome ? ref?.therapy : "",
      选方方向: text(overview.recommendedFormulaDirection),
      辨证要点: diagnosticsCriteriaFor(text(overview.primarySyndrome))?.keyPointsText || "",
      病位: { 病位: list(location.items), 依据: list(location.details).map((row) => ({ 病位: text(object(row)?.location), 依据: text(object(row)?.basis) })) },
      病性: { 病性: list(nature.items), 本虚: list(nature.rootDeficiency), 标实: list(nature.branchExcess), 依据: text(nature.basis) },
      总体病机: text(pathogenesis.overallPathogenesis || pathogenesis.summary || overview.overallPathogenesis),
      病机链: list(pathogenesis.chain).map((row) => ({ 表现: text(object(row)?.patientFact), 病机: text(object(row)?.pathogenesis), 治法方向: text(object(row)?.therapyDirection), 证据: text(object(row)?.syndromeEvidence) })),
      待核实: list(pathogenesis.uncertainties).map((row) => ({ 项目: text(object(row)?.item), 原因: text(object(row)?.reason) })),
      治法: text(object(reasoning.therapy)?.overallMethod),
      中医鉴别: list(overview.tcmDiseaseDifferentials).map((row) => ({ 病名: text(object(row)?.diseaseName), 相似: text(object(row)?.reason), 要点: text(object(row)?.distinguishingPoints), 典型表现: text(object(row)?.typicalManifestation) })),
      西医诊断: text(western.name), 西医依据: text(western.clinicalRationale) || list(western.supportingFacts).map(text).join(""),
    };
  }
  const formula = object(reasoning.formula) || {};
  const candidate = object(list(formula.candidates)[0]) || {};
  const priorOverview = object(prior?.overview) || {};
  return {
    病名: text(priorOverview.tcmDiseaseName), 主证: text(priorOverview.primarySyndrome), 治法: text(object(prior?.therapy)?.overallMethod),
    方名: text(candidate.name),
    药味: list(candidate.herbs).map((row) => ({ 药名: text(object(row)?.name), 剂量: text(object(row)?.dose), 角色: text(object(row)?.role), 功效: text(object(row)?.function) })),
    方义: text(candidate.formulaAnalysis),
    中成药: list(formula.patentAndWestern).map((row) => ({ 药名: text(object(row)?.name), 对应问题: text(object(row)?.correspondingProblem) })),
  };
}

const core = (name: string) => name.replace(/待[查排]$/u, "");

/** 按范围把读稿人的改动写回结构化结果；越界、类型不对、违反核对的改动不写，记进 rejected。返回实际写入的字段。 */
type DiagnoseReviewContext = { suggestedPrinciple?: string; recordText?: string; redFlag?: boolean; unconfirmedFollowupQuestions?: readonly string[] };
export function applyFinalReviewPatch(stage: FinalReviewStage, reasoning: Json, patch: Json, reviewed: ReadonlySet<string>, context: DiagnoseReviewContext = {}): { applied: string[]; rejected: string[] } {
  const applied: string[] = []; const rejected: string[] = [];
  const scope = new Set<string>(stage === "diagnose" ? DIAGNOSE_FIELDS : PRESCRIBE_FIELDS);
  if (stage === "diagnose" && context.suggestedPrinciple) scope.add("治则");
  for (const [field, value] of Object.entries(patch)) {
    if (!scope.has(field)) { rejected.push(`${field}:out_of_scope`); continue; }
    if (!reviewed.has(field)) { rejected.push(`${field}:not_reviewed`); continue; }
    if (JSON.stringify(value) !== sanitizeFreeTextForModel(JSON.stringify(value))) {
      rejected.push(field + ":sensitive_text"); continue;
    }
    const ok = stage === "diagnose" ? applyDiagnoseField(reasoning, field, value, context) : applyPrescribeField(reasoning, field, value);
    (ok === true ? applied : rejected).push(ok === true ? field : `${field}:${ok}`);
  }
  return { applied, rejected };
}

function applyDiagnoseField(reasoning: Json, field: string, value: unknown, context: DiagnoseReviewContext): true | string {
  const overview = object(reasoning.overview); const pathogenesis = object(reasoning.pathogenesis); const therapy = object(reasoning.therapy);
  const primary = object(object(reasoning.westernDiagnosis)?.primary);
  if (!overview || !pathogenesis) return "shape";
  switch (field) {
    case "辨病依据": if (!nonEmpty(value)) return "type"; overview.tcmDiseaseRationale = value; return true;
    case "辨证依据": if (!nonEmpty(value)) return "type"; overview.tcmDiagnosticRationale = value; return true;
    case "病位": {
      const row = object(value); if (!row || !Array.isArray(row.病位) || !row.病位.every(nonEmpty)) return "type";
      const location = object(pathogenesis.locationDifferentiation) || {};
      location.items = row.病位;
      if (Array.isArray(row.依据)) location.details = row.依据.map((item) => ({ location: text(object(item)?.病位), basis: text(object(item)?.依据) })).filter((item) => item.location);
      pathogenesis.locationDifferentiation = location; return true;
    }
    case "病性": {
      const row = object(value); if (!row || !Array.isArray(row.病性) || !row.病性.every(nonEmpty)) return "type";
      const nature = object(pathogenesis.natureDifferentiation) || {};
      const names = [text(overview.primarySyndrome), ...list(overview.secondarySyndromes).map(text)].join("、");
      const previousMissing = natureLabelsNamedBySyndromeMissingFrom(names, list(nature.items).map(text));
      if (natureLabelsNamedBySyndromeMissingFrom(names, row.病性).some(label => !previousMissing.includes(label))) return "dropped_named_element";
      nature.items = row.病性;
      if (Array.isArray(row.本虚)) nature.rootDeficiency = row.本虚.filter(nonEmpty);
      if (Array.isArray(row.标实)) nature.branchExcess = row.标实.filter(nonEmpty);
      if (nonEmpty(row.依据)) nature.basis = row.依据;
      pathogenesis.natureDifferentiation = nature; return true;
    }
    case "总体病机": if (!nonEmpty(value)) return "type"; pathogenesis.overallPathogenesis = value; if ("summary" in pathogenesis) pathogenesis.summary = value; overview.overallPathogenesis = value; return true;
    case "病机链": {
      if (!Array.isArray(value) || value.length === 0 || value.length !== list(pathogenesis.chain).length) return "chain_length";
      const chain = list(pathogenesis.chain);
      const checked = value.map((item, index) => {
        const row = object(item);
        if (!row || ![row.表现, row.病机, row.治法方向, row.证据].every(nonEmpty)) return chain[index];
        if (context.recordText && ![row.表现, row.证据].every(quote => quoteGroundedInText(text(quote), context.recordText!, { minChars: 2, maxChars: 160 }))) return chain[index];
        return { ...object(chain[index]), patientFact: row.表现, pathogenesis: row.病机, therapyDirection: row.治法方向, syndromeEvidence: row.证据 };
      });
      if (checked.every((item, index) => item === chain[index])) return "ungrounded_chain";
      pathogenesis.chain = checked;
      return true;
    }
    case "待核实": {
      if (!Array.isArray(value)) return "type";
      const before = list(pathogenesis.uncertainties).map((row) => text(object(row)?.item));
      const pending = context.unconfirmedFollowupQuestions || [];
      const axes = { 病位: object(pathogenesis.locationDifferentiation), 病性: object(pathogenesis.natureDifferentiation), 证候: overview };
      const updates = value.flatMap((item) => {
        const row = object(item);
        if (!row || !pending.includes(text(row.题干)) || !nonEmpty(row.项目) || !nonEmpty(row.原因) || !Object.hasOwn(axes, text(row.影响))) return [];
        const axis = text(row.影响) as keyof typeof axes;
        return [{ axis, owner: axes[axis], row }];
      });
      const rows = value.map((row) => ({ item: text(object(row)?.项目), reason: text(object(row)?.原因) })).filter((row) => row.item);
      // 只许删或改写已有条目，不许凭空加新的待核实项。
      if (rows.length > before.length + new Set(updates.map(({ row }) => row.项目)).size) return "added_items";
      for (const { axis, owner, row } of updates) {
        const key = axis === "证候" ? "primarySyndromeResolution" : "resolution";
        if (owner?.[key] === "resolved") {
          owner[key] = "bounded";
          owner[axis === "证候" ? "primarySyndromeResolutionReason" : "resolutionReason"] = row.原因;
        }
      }
      pathogenesis.uncertainties = rows.map((row) => {
        const old = object(list(pathogenesis.uncertainties).find((entry) => object(entry)?.item === row.item));
        const axes = updates.filter(update => update.row.项目 === row.item).map(update => update.axis);
        return { ...old, ...row, affects: axes.length ? [...new Set(axes)].join("、") : text(old?.affects) };
      });
      return true;
    }
    case "治则":
      if (!therapy || !context.suggestedPrinciple || value !== context.suggestedPrinciple) return "unsupported_principle";
      therapy.overallPrinciple = value;
      return true;
    case "治法": {
      if (!nonEmpty(value) || !therapy) return "type";
      const items = value.split(/[，,、；;]/u).map((item) => item.trim()).filter(Boolean);
      if (!items.length || items.length > 3 || items.some((item) => item.length !== 4) || new Set(items).size !== items.length) return "not_four_char_items";
      // 第六十三轮配对盲评：通读删掉过主症的治法项（风热咳嗽删「清热化痰」），也写出过非通行的拼合项（「固脱救逆，回阳固脱」）。
      // 通读只许改写不许减项；新写的每项须是原有项、或受治理/教材里的四字治法。
      const before = text(therapy.overallMethod).split(/[，,、；;]/u).map((item) => item.trim()).filter(Boolean);
      if (items.length < Math.min(before.length, 3)) return "dropped_items";
      const governed = new Set([...governedFourCharacterMethodTerms(), ...textbookTherapyItems()]);
      if (items.some((item) => !before.includes(item) && !governed.has(item))) return "ungoverned_item";
      const halves = (list: string[]) => list.flatMap((item) => [item.slice(0, 2), item.slice(2)]);
      const repeated = (list: string[]) => halves(list).filter((half, i, all) => all.indexOf(half) !== i);
      if (repeated(items).some((half) => !repeated(before).includes(half))) return "repeated_half";
      therapy.overallMethod = items.join("，");
      if (typeof overview.overallTherapy === "string") overview.overallTherapy = therapy.overallMethod;
      return true;
    }
    case "中医鉴别": {
      if (!Array.isArray(value)) return "type";
      const previous = list(overview.tcmDiseaseDifferentials).map(object);
      const rows = value.map(item => {
        const row = object(item);
        const name = text(row?.病名).trim();
        return { ...previous.find(old => old?.diseaseName === name), diseaseName: name, reason: text(row?.相似),
          distinguishingPoints: text(row?.要点), typicalManifestation: textbookDiseaseTypicalManifestation(name) || text(previous.find(old => old?.diseaseName === name)?.typicalManifestation) };
      });
      if (rows.length < 2) return "too_few";
      if (rows.some(row => !row.diseaseName || !row.reason || !row.distinguishingPoints || !row.typicalManifestation ||
          row.diseaseName === overview.tcmDiseaseName) || new Set(rows.map(row => row.diseaseName)).size !== rows.length) return "invalid_differential";
      overview.tcmDiseaseDifferentials = rows;
      return true;
    }
    case "西医诊断": {
      if (!nonEmpty(value) || !primary) return "type";
      if (core(value.trim()) !== core(text(primary.name).trim())) return "renamed";
      if (context.recordText && /待[查排]$/u.test(value.trim()) &&
          !/待[查排]$/u.test(settleWesternDiagnosisBasis(value.trim(), text(primary.clinicalRationale), context.recordText).name)) return "established_diagnosis";
      // 去「待查」同样要确定性结算同意；急危重红旗病例不去（异位妊娠破裂未做超声、溃疡出血未做胃镜被写成确诊）。
      if (/待[查排]$/u.test(text(primary.name).trim()) && !/待[查排]$/u.test(value.trim()) && (context.redFlag ||
          !context.recordText || /待[查排]$/u.test(settleWesternDiagnosisBasis(value.trim(), text(primary.clinicalRationale), context.recordText).name))) return "not_established";
      primary.name = value.trim(); return true;
    }
    case "西医依据": {
      if (!nonEmpty(value) || !primary) return "type";
      primary.clinicalRationale = value; return true;
    }
    default: return "out_of_scope";
  }
}

function applyPrescribeField(reasoning: Json, field: string, value: unknown): true | string {
  const formula = object(reasoning.formula); const candidate = object(list(formula?.candidates)[0]);
  if (!formula || !candidate) return "shape";
  switch (field) {
    case "方义": {
      if (!nonEmpty(value)) return "type";
      // 原方义讲到的药，新方义也要讲到（实验里读稿人改方义时漏讲过大黄）。
      const before = text(candidate.formulaAnalysis);
      const dropped = list(candidate.herbs).map((row) => text(object(row)?.name)).filter((name) => name && before.includes(name) && !value.includes(name));
      if (dropped.length) return "herb_mention_dropped";
      candidate.formulaAnalysis = value; return true;
    }
    case "中成药": {
      if (!Array.isArray(value)) return "type";
      const keep = new Set(value.map((row) => text(object(row)?.药名)).filter(Boolean));
      const before = list(formula.patentAndWestern);
      const kept = before.filter((row) => keep.has(text(object(row)?.name)));
      if (keep.size > kept.length) return "added_medicine";
      formula.patentAndWestern = kept; return true;
    }
    case "药味": {
      const herbs = list(candidate.herbs);
      if (!Array.isArray(value) || value.length !== herbs.length) return "composition_changed";
      const next = herbs.map((row, index) => {
        const old = object(row) || {}; const proposed = object(value[index]) || {};
        const name = text(proposed.药名).trim() || text(old.name);
        const sameHerb = name === text(old.name) || (canonicalTcmHerbIdentity(name) === canonicalTcmHerbIdentity(text(old.name)) && isKnownTcmHerbName(name));
        const sameDose = text(proposed.剂量).replace(/\s+/gu, "") === text(old.dose).replace(/\s+/gu, "");
        const sameRole = !text(proposed.角色) || text(proposed.角色) === text(old.role);
        return sameHerb && sameDose && sameRole ? { ...old, name, function: text(proposed.功效).trim() || old.function } : undefined;
      });
      if (next.some((row) => !row)) return "composition_changed";
      candidate.herbs = next; return true;
    }
    default: return "out_of_scope";
  }
}

/** One request for the final table. A reply can select only verbatim source clauses of that herb. */
export async function selectFinalHerbFunctions(reasoning: Json, patient: HerbFunctionPatient, signal?: AbortSignal, ask = primaryModelJsonTask, deadline = Infinity): Promise<Map<string, string>> {
  if (process.env.CDSS_M04_FUNCTION_CHOICE === "false") return new Map();
  const candidate = object(list(object(reasoning.formula)?.candidates)[0]);
  const rows = list(candidate?.herbs).map((row) => {
    const name = text(object(row)?.name);
    return { name, sources: herbFunctionSourceClauses(name), target: text(object(row)?.targetPathogenesis) };
  });
  const result = new Map<string, string>();
  const timeoutMs = Math.min(4000, deadline - Date.now());
  if (timeoutMs <= 0 || signal?.aborted || !rows.some((row) => row.sources.length > 1)) return result;
  const choices = await ask("m04_final_function_choices", "prescribe", [
    { role: "system", content: "按本方方义、证候和治法，逐味选择在本方起作用的一至两项功效。只选该味药给出的从零开始的编号，不选毒性。返回 JSON {rows:[{name,indices:[0]}]}。无合适选项时略过。" },
    { role: "user", content: JSON.stringify({ record: sanitizeFreeTextForModel(patient.recordText || ""), analysis: candidate?.formulaAnalysis, syndrome: object(reasoning.overview)?.primarySyndrome,
      therapy: object(reasoning.therapy)?.overallMethod, herbs: rows.map(({ name, sources, target }) => ({ name, target, options: sources.map((source) => source.text) })) }) },
  ], { maxTokens: 640, timeoutMs }, (raw) => {
    try { return list(object(JSON.parse(String(raw)))?.rows).map(object); } catch { return undefined; }
  }, signal).catch(() => undefined);
  if (signal?.aborted || Date.now() >= deadline) return result;
  for (const row of rows) {
    const matching = choices?.filter((choice) => choice?.name === row.name);
    const indices = matching?.[0]?.indices;
    if (matching?.length !== 1 || !Array.isArray(indices) || !indices.length || indices.length > 2 || new Set(indices).size !== indices.length ||
        !indices.every((i) => Number.isInteger(i) && i >= 0 && i < row.sources.length)) continue;
    const ids = indices.map((i: number) => row.sources[i].id);
    const selected = selectGroundedHerbFunction({ name: row.name, patient, role: "", target: row.target, therapy: "", preferredSourceIds: ids });
    if (ids.every((id) => selected.sources.some((source) => source.id === id)) && !indices.some((i: number) => /^有(?:大|小)?毒$/u.test(row.sources[i].text))) result.set(row.name, selected.text);
  }
  return result;
}

type ReviewReply = { review: Array<{ field: string; evidence: string }>; patch: Json };
function parseReply(content: unknown): ReviewReply | undefined {
  try {
    const parsed = JSON.parse(text(content)) as Json;
    if (!Array.isArray(parsed.review) || !object(parsed.patch)) return undefined;
    const review = parsed.review.map(row => ({ field: text(object(row)?.field), evidence: text(object(row)?.evidence).trim() }))
      .filter(row => row.field);
    const patch = object(parsed.patch)!;
    return { review, patch };
  } catch {
    return undefined;
  }
}

/**
 * 读一遍、按范围改：返回改过的结构化结果（深拷贝）与改动清单；没有改动、模型失败或超时返回 undefined。
 * recordText 用 clinicalGroundingText（带年龄、性别标签的病历正文）；redFlag 时告诉读稿人不碰相关内容。
 */
export async function finalConsistencyReview(
  stage: FinalReviewStage,
  reasoning: Json,
  context: DiagnoseReviewContext & { recordText: string; redFlag: boolean; visibleText?: string; lockedFields?: readonly string[]; prior?: Json; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ reasoning: Json; applied: string[]; rejected: string[] } | undefined> {
  if (!context.recordText.trim() || context.signal?.aborted) return undefined;
  const draft = finalReviewDraft(stage, reasoning, context.prior);
  if (stage === "diagnose" && context.unconfirmedFollowupQuestions?.length) {
    draft.未确认事项 = context.unconfirmedFollowupQuestions;
    const path = object(reasoning.pathogenesis);
    draft.判断程度 = { 病位: object(path?.locationDifferentiation)?.resolution, 病性: object(path?.natureDifferentiation)?.resolution,
      证候: object(reasoning.overview)?.primarySyndromeResolution };
    draft.说明 = "题干不是已发生事实。直接影响病位、病性或证候时，在待核实改稿中为该项写项目、原因、题干原文与影响（病位、病性、证候三选一）。项目和原因只写临床问题，无关的判断保留。";
  }
  let suggestedPrinciple: string | undefined;
  if (stage === "diagnose") {
    const overview = object(reasoning.overview);
    const snapshot = { m03: reasoning };
    const governedContext = buildDeliveryInvariantGovernance(snapshot);
    const findings = scanDeliveryInvariants({ ...snapshot, governedContext });
    const nature = object(object(reasoning.pathogenesis)?.natureDifferentiation);
    if (!context.redFlag && findings.some(f => f.ruleId === "R04") && nature?.resolution === "resolved" &&
        list(nature.rootDeficiency).length && list(nature.branchExcess).length && list(object(reasoning.therapy)?.subTherapies).length >= 2) {
      suggestedPrinciple = governedContext.principle?.expected;
      draft.治则 = text(object(reasoning.therapy)?.overallPrinciple);
      draft.治则核对 = { 候选: suggestedPrinciple, 分治法: object(reasoning.therapy)?.subTherapies,
        说明: "本虚标实分栏只提供线索。仅当本例证候、病机和实际分治法均支持该候选且当前治则不符时，可在治则字段选它并引用证据。兼带或继发病性不足以更改治则。" };
    }
    if (findings.some(f => f.ruleId === "R09" && f.path.endsWith("/tcmDiseaseDifferentials"))) {
      const disease = splitTextbookDiseaseSubtype(text(overview?.tcmDiseaseName)).disease;
      draft.病名鉴别核对 = { 要求: "少于两项。用中医鉴别字段提交至少两种有病历依据的不同疾病，写明相似处与区分点。典型表现由教材提供。",
        教材候选: textbookDiseaseDifferentialNames(disease).map(name => ({ 病名: name, 定义: textbookDiseaseTypicalManifestation(name) })) };
    }
  }
  if (context.lockedFields?.length) draft.其他步骤已定稿只读 = context.lockedFields;
  const user = `【病历】\n${sanitizeFreeTextForModel(context.recordText)}\n【红旗状态】${context.redFlag ? "已判为急危重红旗（处方在风险解除前不可采纳），不要改动与此相关的内容" : "未判红旗"}\n【结果草稿 JSON】\n${JSON.stringify(draft)}`;
  const reply = await primaryModelJsonTask(`final_consistency_review_${stage}`, stage,
    [{ role: "system", content: `${RULES}\n${SCOPE[stage]}\n${OUTPUT}` }, { role: "user", content: user }],
    { maxTokens: 3000, timeoutMs: context.timeoutMs ?? 9000 }, parseReply, context.signal);
  if (!reply || Object.keys(reply.patch).length === 0) {
    console.info("[tcm-cdss:telemetry] final_consistency_review", { stage, status: reply ? "no_patch" : "unavailable" });
    return undefined;
  }
  for (const field of context.lockedFields || []) delete reply.patch[field];
  const copy = structuredClone(reasoning);
  const { applied, rejected } = applyFinalReviewPatch(stage, copy, reply.patch, new Set(reply.review.map((row) => row.field)), { ...context, suggestedPrinciple });
  console.info("[tcm-cdss:telemetry] final_consistency_review", { stage, proposed: applied, rejected, reviewItems: reply.review.length });
  return applied.length > 0 ? { reasoning: copy, applied, rejected } : undefined;
}
