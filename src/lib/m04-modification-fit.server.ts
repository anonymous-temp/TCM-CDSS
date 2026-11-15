import { patentMedicineDuplication } from "./patent-medicine-duplication.server";
import "server-only";

import { parseConfirmed, proposeTwiceThenVerifyAll } from "./cross-model-small-task.server";
import { herbCautionReferenceText, herbClaimReferenceText, herbPropertyReferenceText } from "./m04-formula-analysis-claim-check.server";
import { modificationTriggerNotFinding, distinctModificationConditions, standbyModificationsDelivered, topUpModificationRow, withoutOrphanPartnerRows } from "./m04-proposal-compiler";
import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";
import { compositionIdentityName } from "./tcm-formula-provenance";
import { quoteGroundedInText } from "./verbatim-quote";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import modificationRelevance from "../data/tcm-modification-relevance.source.json" with { type: "json" };

const MECHANISM_HALVES = new Set((modificationRelevance as { mechanismHalvesNotFindings?: string[] }).mechanismHalvesNotFindings || []);

/**
 * 随证加减每一行与本例对不对得上（2026-10-31 起；第三十三轮扩到教材条目和条件与病历的关系）。
 * 条件与病历相反，规则判不完：舌脉那几个维度之外，便溏对大便干结、口不渴对口渴、痰白对痰黄、多食对食少都要读懂，22 组相反条件字面规则只抓到 6 组；
 * 药对不对症按功效字面比对错删居多（离线 563 张处方）。一个模型逐行列两次判断取并集（教材本证条目只判条件，模型自写的和借别的病的行连药一起判），每条由另一厂商的模型只对被点名的那一行答对错，说对才删。条件相反的一定删；药不对症的只在删后还剩至少一行时删（之后的补写会补足两个条件），免得加减一栏被删空。
 * 超时、失败按原样交付。开关：CDSS_M04_MODIFICATION_FIT=false。
 */
const TIMEOUT_MS = 4_000;
// 药不对症的行删到只剩一行为止（第三十八轮：原为两行。核对之后紧接着有补写 topUpModificationConditions，不足两个条件会补上；
// 留着两行下限时，甲方标准病历5 的「若气喘加炙麻黄」两次提名、复核都确认不对症，却因为加减只有两行留了下来）。
const MIN_ROWS_AFTER_FIT = 1;
const MIN_DISTINCT_CONDITIONS = 2;
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

export function modificationFitEnabled(): boolean {
  return process.env.CDSS_M04_MODIFICATION_FIT !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const SYSTEM = [
  "你是中医主治医师，逐行核对随证加减。每行是「某情况，加某药」：条件以「若」起头的说的是本例现在没有、之后可能出现的变化，不带「若」的是病历已记录的表现。",
  "每行写 verdict：",
  "contradicts：这个条件与病历已记录的情况相反，本例在现在的证候下不会这样（病历便溏对“若大便干结”、舌淡脉弱对“若舌红脉数”、口不渴对“若口渴”、多食易饥对“若食少”）。病历没提到的症状不算相反；quote 摘病历逐字原文。",
  "misfit：只在 kind 为 model 的行判。这味药的主要功效管不到这个症，或与本证方向相反（虚寒证单加苦寒药、阴虚证单加温燥药；实热、火热证为非主诉的次要表现加温性药，如胃热炽盛证「纳差」加焦山楂——property 是《中药学》药性，次要表现由主证病机所致、主方清其病机即可），或这个条件不是本病会出现的变化；这个表现是主病直接引起的（高热、热毒内陷致拒食纳差，剧痛致失眠，失血、气脱致头晕），治好主病自然缓解，另加偏性药不当（如热毒证拒食加焦山楂、失血头晕加天麻）；药的功效与这个表现在本证里的病机对不上（气血不足的头晕加平肝息风的天麻，固摄缩尿写桑椹、白术）。不因为有更好的选择就判 misfit。",
  "caution：两种 kind 都判。每一行先读 caution（《中药学》使用注意原文）：它点名慎用或忌用的某个症状（自汗、盗汗、便溏、失眠、出血…）本例病历写着，就判 caution，不论这一行的条件写的是什么（如麻黄 caution「表虚自汗、阴虚盗汗…慎用」，病历写「自汗」）。只看症状，「内有实热者慎用」这类说的是证候，不算；quote 摘病历里那个症状的逐字原文。",
  "unrelated：两种 kind 都判。条件说的情况与本例已记录的表现都无关——不是本例已有某个症状的加重或演变，也不是主诉主症的变化，而是另一组本例一条相关表现都没有的情况（如胃痛病例「若兼头晕目眩」而病历没有头晕；咳嗽病例「若兼有瘀血」而病历没有任何瘀象）。条件里的症状本例已有（程度不同也算）、或是本例主症常见的加重，不算 unrelated。quote 留空。",
  "not_finding：两种 kind 都判。主诉主症已经由主方治疗，主症本身、频次或形态不作加减条件；缓解/加重因素、表情神态、闸门红旗或优先评估所引用的危重表现、脱水休克灌注不足征象也不作条件。条件说的不是患者此刻的一个症状、体征或舌脉：生活习惯或诱因（熬夜、久坐、加班、屏幕使用时间长、饮食不节）、缓解因素（吃糖后好转、休息后减轻）、病名或基础病（慢性肾病3期、焦虑症病史）、检查或就诊经过（未接受检查、拒绝说明）、病历里的说明（家属与本人描述不同）、正常情况（睡眠尚可）。quote 留空。",
  "ok：其余。",
  "只输出 JSON：{\"rows\":[{\"line\":0,\"verdict\":\"ok\",\"quote\":\"\"}]}",
].join("\n");

const VERIFY_SYSTEM = [
  "你是中医主治医师。有人认为下面这条随证加减不该留给本例，理由在 verdict 里（not_finding：条件说的不是患者的症状、体征或舌脉，而是习惯、诱因、缓解或加重因素、表情神态、主诉主症本身、急危重征象、病名、检查或病历说明；contradicts：条件与病历已记录的情况相反；misfit：这味药管不到这个症或与本证方向相反，含实热证为非主诉的次要表现加温性药；caution：这味药的使用注意点名慎用或忌用的那个症状，本例病历写着；unrelated：条件说的情况与本例已记录的表现都无关，既不是已有症状的加重或演变，也不是主诉主症的变化）。",
  "只判这一条。理由成立答 true。条件只是病历没提到、或者只是另有更好的药，答 false。",
  "先在 why 里写这条理由依据的病历原文或药的功效（不超过20字），再下结论。",
  "只输出 JSON：{\"why\":\"…\",\"confirmed\":true} 或 {\"why\":\"…\",\"confirmed\":false}",
].join("\n");

type Finding = { line: number; verdict: "contradicts" | "misfit" | "unrelated" | "caution" | "not_finding"; quote: string };

function parse(content: unknown): Finding[] | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const list = record(JSON.parse(content))?.rows;
    if (!Array.isArray(list)) return undefined;
    return list.flatMap((entry) => {
      const row = record(entry);
      const verdict = text(row?.verdict);
      return row && Number.isInteger(row.line) && (verdict === "contradicts" || verdict === "misfit" || verdict === "unrelated" || verdict === "caution" || verdict === "not_finding")
        ? [{ line: row.line as number, verdict: verdict as Finding["verdict"], quote: text(row.quote) }]
        : [];
    });
  } catch {
    return undefined;
  }
}

/** 教材本证条目只判条件；模型自写的和借别的病的行连药一起判。 */
const isModelWritten = (row: Json, disease = "") => {
  const evidence = record(row.evidence);
  if (evidence?.evidenceLevel !== "kb_entry") return true;
  const source = /》([^·]+)·/u.exec(text(evidence.source))?.[1] || "";
  return Boolean(disease && source && !source.includes(disease) && !disease.includes(source));
};

/** 提名是否合格（纯函数）：行号在表内；说条件相反的要有病历逐字摘录；misfit 只看模型自写的「加」行。 */
export function modificationFindingQualifies(finding: Finding, rows: readonly Json[], recordText: string, disease = ""): boolean {
  const row = rows[finding.line];
  if (!row || row.action !== "加") return false;
  if (finding.verdict === "misfit") return isModelWritten(row, disease);
  // 与本例记录无关的条件（第三十七轮甲方 11.05 病历13「随症加减与患者病情无关…偶尔也能遇到根据疾病本身推荐」、病历10「香附、艾叶与患者病症不符」）：
  // 教材条目也判。条件里有本例已记录的症状时不算（「若恶寒甚」之于恶寒）。
  if (finding.verdict === "unrelated") return !conditionMentionsRecordedFinding(text(row.trigger), recordText);
  // 使用注意点名的症状本例写着（第三十八轮甲方标准病历5：自汗，加减「若气喘加炙麻黄」，麻黄「表虚自汗…慎用」）：摘录要逐字在病历里，
  // 并且摘录与这味药的使用注意原文共有一个两字词——说的是同一个症状，不是证候层面的「内有实热」。
  // 条件不是症状体征（习惯、诱因、缓解因素、病名、检查、病历说明；第四十五轮）：两种 kind 都判，由另一厂商复核确认。
  if (finding.verdict === "not_finding") return true; // 闭集在调用模型前由 modificationTriggerNotFinding 剔除；开放语义须跨厂商复核。
  if (finding.verdict === "caution") return cautionNamesRecordedSymptom(herbCautionReferenceText(text(row.herbName)), finding.quote, recordText);
  return Boolean(finding.quote) && quoteGroundedInText(finding.quote, recordText, { minChars: 2 });
}

/** 使用注意原文与病历摘录共有一个两字词，且摘录逐字在病历里（纯函数，供测试）。 */
export function cautionNamesRecordedSymptom(caution: string, quote: string, recordText: string): boolean {
  const cleaned = String(quote || "").trim();
  if (!caution || cleaned.length < 2 || !quoteGroundedInText(cleaned, recordText, { minChars: 2 })) return false;
  for (let index = 0; index + 2 <= cleaned.length; index += 1) {
    const pair = cleaned.slice(index, index + 2);
    if (/^[\u4e00-\u9fff]{2}$/u.test(pair) && caution.includes(pair)) return true;
  }
  return false;
}

/**
 * 条件里是否点到了病历已记录的表现（两字以上的症状词，按逗号顿号切开、去掉「若/兼/见/较甚/明显/者」这类外壳后逐字在病历里）。
 * 点到了就不判「无关」：「无关」只给条件里一条本例表现都没有的行。纯函数，供测试。
 */
export function conditionMentionsRecordedFinding(trigger: string, recordText: string): boolean {
  const parts = String(trigger || "").replace(/^(?:本例已见|若|如|兼见|兼有|兼|伴)/u, "").split(/[，,、；;或及与和]/u)
    .map((part) => part.replace(/^(?:兼见|兼有|兼|伴有|伴|见|出现|症见|若)/u, "").replace(/(?:较甚|较重|甚者|甚|明显|加重|较多|多|重|者)$/u, "").trim())
    .filter((part) => part.length >= 2);
  // 四字以上的条件也看头两字、末两字（「鼻塞流涕」之于「鼻塞、流清涕」）；病机词（内蕴、凝滞、郁热这类）不算症状。
  return parts.some((part) => recordText.includes(part) || (part.length >= 4 && [part.slice(0, 2), part.slice(-2)].some((half) => !MECHANISM_HALVES.has(half) && recordText.includes(half))));
}

/** 交付前去掉复核确认不该留的行。 */
/**
 * 哪类发现要两次提名都说到才去问复核。「药管不到这个症」比「条件与病历相反」更看读法：两次都这么说才问
 *（第三十五轮：病历有大便干，「大便秘结→玄参」因一次提名被删）。「与本例无关」一次提名加另一厂商复核即可
 *（两次都要提名时，第二次草草全答 ok 就把甲方点名的「若寒湿凝滞腹痛」留下了，第三十七轮实测）。
 */
export function modificationFindingNeedsBothSamples(finding: { verdict: string }): boolean {
  return finding.verdict === "misfit";
}

/** 提名与复核看到的一行：条件、药、药的功效参考，以及《中药学》药性（第三十八轮：看所加药的寒热与本证是否相反）。纯函数，供测试。 */
export function modificationFitRowPayload(row: Record<string, unknown>, line: number, disease = "") {
  return {
    line,
    kind: isModelWritten(row, disease) ? "model" : "textbook",
    condition: text(row.trigger),
    herb: text(row.herbName),
    reference: herbClaimReferenceText(text(row.herbName)).slice(0, 160),
    property: herbPropertyReferenceText(text(row.herbName)) || null,
    caution: herbCautionReferenceText(text(row.herbName)) || null,
  };
}

export async function dropMisfitModifications(content: string, context: { recordText: string; caseState?: CaseState; prior?: ClinicalReasoningResultV2 | null }, signal?: AbortSignal): Promise<string> {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content.slice(start + START_MARKER.length, end).trim())); } catch { return content; }
  const formula = record(root?.formula);
  const overview = record(root?.overview);
  const originalRows = Array.isArray(formula?.modifications) ? formula.modifications.map(record).filter((row): row is Json => Boolean(row)) : [];
  const rows = originalRows.filter((row) => !modificationTriggerNotFinding(text(row.trigger), { ...context, prior: context.prior || { overview: { tcmDiseaseName: text(overview?.tcmDiseaseName) } } }));
  if (!root || !formula) return content;
  if (rows.length !== originalRows.length) {
    formula.modifications = rows;
    content = `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(root, null, 2)}\n${content.slice(end)}`;
  }
  if (!modificationFitEnabled() || rows.length === 0) return content;
  const syndrome = text(overview?.primarySyndrome);
  const method = text(record(root.therapy)?.overallMethod);
  const disease = text(overview?.tcmDiseaseName);
  const payload = (row: Json, line: number) => modificationFitRowPayload(row, line, disease);
  const findings = await proposeTwiceThenVerifyAll<Finding>("m04_modification_fit", "prescribe", {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, record: context.recordText.slice(0, 2_400), rows: rows.map((row, line) => payload(row, line)) }) },
    ],
    maxTokens: 400,
    parse,
  }, (finding) => `${finding.line}:${finding.verdict}`, (finding) => modificationFindingQualifies(finding, rows, context.recordText, disease) ? {
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, record: context.recordText.slice(0, 2_400), row: payload(rows[finding.line], finding.line), verdict: finding.verdict, quote: finding.quote }) },
    ],
    maxTokens: 90,
    parse: parseConfirmed,
  } : undefined, rows.length, TIMEOUT_MS, signal, {
    needsBothSamples: modificationFindingNeedsBothSamples,
  });
  if (findings.length === 0) return content;
  const contradicted = new Set(findings.filter((finding) => finding.verdict === "contradicts" || finding.verdict === "unrelated" || finding.verdict === "caution" || finding.verdict === "not_finding").map((finding) => finding.line));
  const bad = new Set(contradicted);
  for (const finding of findings) {
    if (finding.verdict === "misfit" && rows.length - bad.size > MIN_ROWS_AFTER_FIT) bad.add(finding.line);
  }
  const candidateHerbs = Array.isArray(record(Array.isArray(formula.candidates) ? formula.candidates[0] : undefined)?.herbs)
    ? (record((formula.candidates as unknown[])[0])?.herbs as unknown[]).map((herb) => text(record(herb)?.name)).filter(Boolean)
    : [];
  formula.modifications = withoutOrphanPartnerRows(rows.filter((_, index) => !bad.has(index)), candidateHerbs);
  console.info("[tcm-cdss:telemetry] m04_modification_fit", { dropped: bad.size, checked: rows.length, verdicts: findings.map((finding) => finding.verdict) });
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(root, null, 2)}\n${content.slice(content.indexOf(END_MARKER, start + START_MARKER.length))}`;
}

/** 把 source 里核对后的加减行放进 target（两份来自同一份内容、各改一处）。解析不了时返回 target。 */
export function withModificationsFrom(target: string, source: string): string {
  if (target === source) return target;
  const read = (content: string) => {
    const start = content.indexOf(START_MARKER);
    const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
    if (start < 0 || end < 0) return undefined;
    try { return { start, end, root: record(JSON.parse(content.slice(start + START_MARKER.length, end).trim())) }; } catch { return undefined; }
  };
  const to = read(target);
  const from = read(source);
  const toFormula = record(to?.root?.formula);
  const fromFormula = record(from?.root?.formula);
  if (!to || !toFormula || !fromFormula || !Array.isArray(fromFormula.modifications)) return target;
  toFormula.modifications = fromFormula.modifications;
  return `${target.slice(0, to.start + START_MARKER.length)}\n${JSON.stringify(to.root, null, 2)}\n${target.slice(to.end)}`;
}

const TOP_UP_SYSTEM = [
  "你是中医主治医师。证型、治法、方药已定，现在为本例补写随证加减。随证加减是给这位患者这次就用的，不写「若…」这种以后才可能出现的备用条件。",
  "先读 record，找出病历里已经记录、主方 herbs 没有直接照顾到的伴随表现（主诉主症以外的症状，如便溏、口干、咽痛、眠差、咳痰、多汗、小便不利；舌苔、舌质、脉象只能和症状写在同一条里作条件，如「口苦、苔黄」，单写舌象或脉象不作条件，舌淡红、苔薄白、脉缓这类正常所见不写）；这样的表现不够两个时，再从本例较突出、主方照顾力度不足的已记录表现里补（如畏寒肢冷明显、腰膝酸软，加一味同向的药增强）；主诉主症及其频次、形态由主方治疗，不作加减条件，不能为凑条数再写主症加强。每个表现写一条，凑够 2 条、最多 3 条：trigger 逐字摘病历里这个表现的原话（2–12 字，不加「若」，不写证候名）；herbName 是不在 herbs 里的一味常用饮片；dose 写克数（如 10g），在药典常用量内；reason 说这味药怎样管这个表现；symptomPathogenesis 用一句话（≤20字）写这个表现本身的病机。",
  "纳差、食少不是主诉、证候又不涉脾胃食积时，不为它加消食药（焦山楂、神曲、麦芽、鸡内金）；病人高热、意识改变、休克、少尿这类急危重表现不作加减条件。",
  "trigger 必须是患者此刻的一个症状、体征（不写生活习惯或诱因如熬夜、久坐、屏幕时间长，不写缓解或加重因素如吃糖后好转、遇冷加重，不写表情神态，不写主诉主症本身，不写急危重征象，不写病名、病史、检查或就诊经过，不写既往史、个人史里的内容）。",
  "主病直接引起的伴随表现不另加药（因疼痛或瘙痒而眠差、因发热而纳差、外感正邪相争而精神差，主病好了自然好）。药的寒热补泻要与证型一致：外感、痰热、湿热、瘀血这类实证不为次要表现加补益药，虚证不加攻伐药。病历否认的、existing 里已有的不写。病历里找不到这样的表现就少写或输出空数组，不要编。",
  // 第四十六轮：补写的行要过编译的全部判据，模型只给一两条时常常一条都进不去（p100c 23 份不足两个条件）。多给几条备选，理由只写这味药对这个表现的作用。
  "给 3–4 条备选，按把握从大到小排；每条的条件不同、药不同。reason 只写这味药针对这个表现的作用，用治法 method 里有的说法；治法里没有的温里、清热、补益、泻下、破血、散结这类方向不要写进 reason。",
  "只输出 JSON：{\"rows\":[{\"trigger\":\"\",\"herbName\":\"\",\"dose\":\"\",\"reason\":\"\",\"symptomPathogenesis\":\"\"}]}",
].join("\n");

/** CDSS_STANDBY_MODIFICATIONS=true（回到第四十三轮口径）时的补写：备用的「若…」加减。 */
const STANDBY_TOP_UP_SYSTEM = [
  "你是中医主治医师。证型、治法、方药已定，现在写备用的随证加减。",
  "写 3 条不同的条件，每条一味药：trigger 写「若+具体症状」，是本例已记录的某个症状加重、或主诉主症常见的进一步变化（不写与本例记录无关的另一组证候，不写舌脉，不写「气虚」「阴虚」这类证候名）；herbName 是不在 herbs 里的一味常用饮片；dose 写克数（如 10g），在药典常用量内；reason 说这味药怎样管这个症。",
  "药的寒热补泻要与证型一致。不要写病历已经否认的症状，也不要写 existing 里已有的条件。",
  "只输出 JSON：{\"rows\":[{\"trigger\":\"\",\"herbName\":\"\",\"dose\":\"\",\"reason\":\"\"}]}",
].join("\n");

const TOP_UP_VERIFY_SYSTEM = [
  "你是中医主治医师。下面这条随证加减针对本例病历里已有的一个表现，这次就用。默认答 true；只有这味药管不到这个表现、与本证方向相反（实证为次要表现加补益药、虚证加攻伐药、寒证加寒凉药、热证加温热药）、这个表现病历里其实是否认的，或它只是主病直接引起、治好主病自然缓解的表现，或条件只是主诉主症本身，或是急危重表现，或条件根本不是可据以加减的症状体征（习惯、诱因、缓解或加重因素、表情神态、病名、检查、病历说明）时答 false。",
  "只输出 JSON：{\"confirmed\":true} 或 {\"confirmed\":false}",
].join("\n");

type TopUpRow = { trigger: string; herbName: string; dose: string; reason: string; symptomPathogenesis?: string };

function parseTopUp(content: unknown): TopUpRow[] | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const list = record(JSON.parse(content))?.rows;
    if (!Array.isArray(list)) return undefined;
    return list.flatMap((entry) => {
      const row = record(entry);
      const trigger = text(row?.trigger);
      const herbName = text(row?.herbName);
      const symptomPathogenesis = text(row?.symptomPathogenesis);
      return trigger && herbName ? [{ trigger, herbName, dose: text(row?.dose), reason: text(row?.reason), ...(symptomPathogenesis ? { symptomPathogenesis } : {}) }] : [];
    }).slice(0, 6);
  } catch {
    return undefined;
  }
}

/**
 * 历史兼容工具，第四十七轮补写不再调用。原主诉主症加强行可选的药（第四十六轮：病历只有主症时，补写给不出第二个条件——C040「多尿乏力」两次提名都是空的）：
 * 教材本证一行的组成里不在本方的药，加上教材本证加减里条件点到主诉主症的那几条的药。名字按组成身份比对，至多 8 味。纯函数，供测试。
 */
export function mainSymptomStrengtheningHerbs(prior: ClinicalReasoningResultV2 | null | undefined, chiefComplaint: string, candidateHerbs: readonly string[]): string[] {
  if (!prior || prior.stage !== "diagnose") return [];
  const row = textbookRowForSyndrome(String(prior.overview?.tcmDiseaseName || ""), String(prior.overview?.primarySyndrome || ""));
  if (!row) return [];
  const taken = new Set(candidateHerbs.map((name) => compositionIdentityName(name)));
  const complaint = String(chiefComplaint || "").replace(/[\d０-９]+\s*(?:天|日|周|月|年|小时|个月)[余多]?/gu, "");
  const pairs = new Set([...complaint].map((_char, index) => complaint.slice(index, index + 2)).filter((pair) => /^[\u4e00-\u9fff]{2}$/u.test(pair)));
  const mentionsMain = (condition: string) => [...pairs].some((pair) => condition.includes(pair));
  const fromEntries = row.modifications.filter((entry) => mentionsMain(entry.condition)).flatMap((entry) => entry.herbs);
  return [...new Set([...fromEntries, ...row.composition])]
    .filter((name) => name && !taken.has(compositionIdentityName(name)))
    .slice(0, 8);
}

/**
 * 不同的条件不足两个时补写（第三十四轮）。甲方 10.29 测评「仅生成 1 个不足以满足临床」；教材没有这一证（中性证名、自拟方）、模型又没写时，编译阶段没东西可补：
 * 接口 142 份里 12 份不足两个条件，3 份一条都没有。其余病例不发请求。一个模型写，另一厂商的模型复核，每行再过编译阶段同一套判据（topUpModificationRow）。
 */
export async function topUpModificationConditions(
  content: string,
  context: { recordText: string; prior: ClinicalReasoningResultV2 | null | undefined; caseState?: CaseState },
  signal?: AbortSignal,
): Promise<string> {
  if (!modificationFitEnabled() || !context.prior) return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content.slice(start + START_MARKER.length, end).trim())); } catch { return content; }
  const formula = record(root?.formula);
  const candidate = record(Array.isArray(formula?.candidates) ? formula.candidates[0] : undefined);
  if (!root || !formula || !candidate || !Array.isArray(candidate.herbs)) return content;
  const originalRows = Array.isArray(formula.modifications) ? formula.modifications.map(record).filter((row): row is Json => Boolean(row)) : [];
  const rows = originalRows.filter((row) => !modificationTriggerNotFinding(text(row.trigger), context));
  formula.modifications = rows;
  const existing = rows.map((row) => text(row.trigger));
  if (distinctModificationConditions(rows) >= MIN_DISTINCT_CONDITIONS) return rows.length === originalRows.length ? content
    : `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(root, null, 2)}\n${content.slice(end)}`;
  const duplicationHerbs = candidate.herbs.map((herb) => ({ name: text(record(herb)?.name), role: text(record(herb)?.role) }));
  const herbs = duplicationHerbs.map((herb) => herb.name).filter(Boolean);
  const syndrome = text(record(root.overview)?.primarySyndrome);
  const method = text(record(root.therapy)?.overallMethod);
  const chiefComplaint = text(context.caseState?.chiefComplaint);
  const added = await proposeTwiceThenVerifyAll<TopUpRow>("m04_modification_top_up", "prescribe", {
    messages: [
      { role: "system", content: standbyModificationsDelivered() ? STANDBY_TOP_UP_SYSTEM : TOP_UP_SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, herbs, existing, chiefComplaint, record: context.recordText.slice(0, 2_400) }) },
    ],
    maxTokens: 700,
    parse: parseTopUp,
  }, (row) => `${row.trigger}|${row.herbName}`, (row) => modificationTriggerNotFinding(row.trigger, context) ? undefined : ({
    messages: [
      { role: "system", content: TOP_UP_VERIFY_SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, herbs, row, record: context.recordText.slice(0, 1_500) }) },
    ],
    maxTokens: 40,
    parse: parseConfirmed,
  }), 8, TIMEOUT_MS, signal);
  const delivered = [...rows];
  const triggers = [...existing];
  const taken = [...herbs, ...rows.map((row) => text(row.herbName))];
  for (const row of added) {
    if (distinctModificationConditions(delivered) >= MIN_DISTINCT_CONDITIONS + 1 || delivered.length >= 4) break;
    const compiled = topUpModificationRow(row, { prior: context.prior, caseState: context.caseState, candidateHerbNames: taken, existingTriggers: triggers });
    if (!compiled) continue;
    delivered.push(compiled);
    triggers.push(row.trigger);
    taken.push(row.herbName);
  }
  if (delivered.length === rows.length && rows.length === originalRows.length) return content;
  formula.modifications = delivered;
  if (Array.isArray(formula.patentAndWestern)) formula.patentAndWestern = formula.patentAndWestern.map(record).filter((row): row is Json => Boolean(row))
    .filter((medicine) => !patentMedicineDuplication(medicine, duplicationHerbs, [], delivered));
  console.info("[tcm-cdss:telemetry] m04_modification_top_up", { before: rows.length, after: delivered.length });
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(root, null, 2)}\n${content.slice(end)}`;
}
