import { recordMentionPolarityAt } from "./diagnosis-safety";
import { textbookDiseaseHistoryCrosswalk, textbookDiseaseNamesForCase, type TextbookDiseaseCrosswalkEntry } from "./tcm-textbook-syndromes";

/**
 * 既往史里已确诊的西医病，按教材「西医学的X可参考本病」对到中医病名，本次主诉正是那个病的主症时，本次多是它的发作
 *（第三十八轮，甲方 11.05 病历2）。
 *
 * 病历2：既往史「慢性扁桃体炎史2年」，本次「咽痛、发热2天」，咽部红肿疼痛、吞咽时加重。甲方判「非常明确的乳蛾」：
 * 慢性扁桃体炎就是慢乳蛾，本次是它的急性发作（急乳蛾）。我们三次都写成喉痹：选病请求只看主诉与现病史，看不到既往史；
 * 辨证半看到的教材乳蛾要「喉核红肿」，病历没写喉核查体，就退到了同部位的喉痹。
 *
 * 判据只用三样受治理的东西，不读开放语言：
 *  · 教材该病写明的西医对应病名（westernEquivalents，教材或补充表原文），去掉「急性/慢性」后的病名主体出现在既往史里，
 *    且这一处是患者本人、肯定、已发生的（与安全门同一套 ConText 读法：「否认慢性胃炎」「母亲有…」「是否…待查」都不算）；
 *  · 主诉主段（「伴」、括号之前）里的两字症状出现在该病的教材定义首句里（咽痛 ↔ 乳蛾「…咽痛不适者，为乳蛾」）——同一部位、
 *    同一主症，才说本次是它的发作；
 *  · 只认患者所属科别能看到的病名（与闭集选病同一份清单）。
 * 结果只作排序与提示：放到选病结果的最前面，给辨证半一段说明；辨证半写成该病在教材里的鉴别病（喉痹）时，按这段说明重写一次。
 * 不改安全判断、不改西医名。
 */
export interface HistoryStatedTextbookDisease {
  /** 教材中医病名。 */
  disease: string;
  /** 教材写明的西医对应病名（「慢性扁桃体炎」）。 */
  western: string;
  /** 既往史里那一处的原文（所在分句，≤40字）。 */
  quote: string;
  /** 主诉主段里与定义相合的两字症状（「咽痛」）。 */
  chiefSymptom: string;
}

export interface HistoryStatedDiseaseInput {
  chiefComplaint?: string;
  pastHistory?: string;
  /** 闭集选病看到的病名清单（按性别、年龄筛过的科别）。 */
  allowedDiseases: readonly string[];
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

/** 主诉主段：第一个「伴/兼/合并」或括号之前（与 m03-visit-reason-check 的 chiefComplaintLeadSegment 同一写法；那个模块是 server-only）。 */
function chiefLead(chiefComplaint: string): string {
  const text = compact(chiefComplaint);
  const at = text.search(/[（(]|伴有?|兼有?|合并/u);
  return at > 0 ? text.slice(0, at) : text;
}

/**
 * 主诉第一个症状分句里的两字片段，按出现先后：去掉时程、数字与「反复/加重/发作」一类病程词后的连续汉字两两相邻
 *（「咽痛、发热2天」→ 咽痛；「双脚水肿1个月，乏力1周」→ 双脚、脚水、水肿）。只看第一个分句：主诉写在最前面的才是主症，
 * 排在后面的乏力、心悸对上糖尿病、冠心病的定义不算（扫描 1,600 份病历时 C036 水肿伴乏力被对到消渴）。
 */
function chiefSymptomBigrams(lead: string): string[] {
  const first = lead.split(/[、，,；;。]/u).find((part) => /[\u4e00-\u9fff]{2}/u.test(part)) || "";
  const cleaned = first
    .replace(/[0-9０-９一二三四五六七八九十百半余多个+]+(?:天|日|周|月|年|小时|分钟|次)?/gu, "，")
    .replace(/反复|加重|突发|渐进|持续|间断|阵发性?|发作性?|再发|复发/gu, "，");
  const out: string[] = [];
  for (const run of cleaned.match(/[\u4e00-\u9fff]{2,}/gu) || []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return [...new Set(out)];
}

/** 病名主体：去掉开头的「急性/慢性/急慢性」。主体至少 3 个字（「胃炎」「肺炎」这类两字主体太宽，不用）。 */
function westernCore(name: string): string {
  return compact(name).replace(/^(?:急慢性|急性|慢性)/u, "");
}

function clauseAround(text: string, index: number): string {
  let start = index;
  while (start > 0 && !/[，,。；;\n]/u.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !/[，,。；;\n]/u.test(text[end])) end += 1;
  return text.slice(start, end).slice(0, 40);
}

/** 既往史里那一处肯定是患者本人已确诊的病：至少一处读成 affirmed。 */
function affirmedHistoryMention(history: string, core: string): number {
  let at = history.indexOf(core);
  while (at >= 0) {
    if (recordMentionPolarityAt(history, at + core.length - 1) === "affirmed") return at;
    at = history.indexOf(core, at + core.length);
  }
  return -1;
}

export function historyStatedTextbookDiseases(input: HistoryStatedDiseaseInput): HistoryStatedTextbookDisease[] {
  const history = compact(input.pastHistory || "");
  const lead = chiefLead(input.chiefComplaint || "");
  if (history.length < 3 || lead.length < 2) return [];
  const allowed = new Set(input.allowedDiseases);
  const bigrams = chiefSymptomBigrams(lead);
  if (bigrams.length === 0) return [];
  const crosswalk = textbookDiseaseHistoryCrosswalk() as readonly TextbookDiseaseCrosswalkEntry[];
  // 主症取第一个分句里最先出现、且是某个教材病定义里写到的两字片段（「胸闷心悸气短」→ 胸闷；「右上腹疼痛」→ 上腹）。
  // 只拿这一个比：教材表把冠心病只写在心衰下，「胸闷心悸气短」+ 冠心病若按任意片段比会对到心衰（心悸），而本例主症是胸闷。
  const chiefSymptom = bigrams.find((bigram) => crosswalk.some((entry) => entry.definition.includes(bigram)));
  if (!chiefSymptom) return [];
  const found: HistoryStatedTextbookDisease[] = [];
  for (const entry of crosswalk) {
    if (!allowed.has(entry.disease) || found.some((item) => item.disease === entry.disease)) continue;
    // 主诉主段本身已点名这个病（「乳蛾反复发作」），选病自己就会选到，不用这条。
    if (lead.includes(compact(entry.disease))) continue;
    if (!entry.definition.includes(chiefSymptom)) continue;
    // 病历写的是全名的那个先用（「慢性扁桃体炎史」配慢性扁桃体炎，不配急性扁桃体炎）。
    const ordered = [...entry.westernEquivalents].sort((left, right) => Number(history.includes(compact(right))) - Number(history.includes(compact(left))));
    for (const western of ordered) {
      const core = westernCore(western);
      if (core.length < 3) continue;
      const at = affirmedHistoryMention(history, core);
      if (at < 0) continue;
      found.push({ disease: entry.disease, western, quote: clauseAround(history, at), chiefSymptom });
      break;
    }
  }
  return found;
}

/** 唯一一个时才用来排序与重写；几个病都对得上（慢性支气管炎 → 咳嗽、痰饮）时只作提示。 */
export function uniqueHistoryStatedDisease(stated: readonly HistoryStatedTextbookDisease[]): HistoryStatedTextbookDisease | undefined {
  return stated.length === 1 ? stated[0] : undefined;
}

/** 选病结果按既往确诊病排序：唯一一个时放到最前（其余次序不变）。 */
export function withHistoryStatedDiseaseFirst(picks: readonly string[], stated: readonly HistoryStatedTextbookDisease[]): string[] {
  const unique = uniqueHistoryStatedDisease(stated);
  // 选病落空（超时、未配置）时不补：候选只剩这一个病会挤掉字面检索的其余候选，说明段照样给辨证半。
  if (!unique || picks.length === 0) return [...picks];
  return [unique.disease, ...picks.filter((pick) => pick !== unique.disease)];
}

/** 辨证半提示词里的说明段；没有对上时为空串。 */
export function historyStatedDiseaseNotice(stated: readonly HistoryStatedTextbookDisease[]): string {
  if (stated.length === 0) return "";
  const lines = stated.map((item) => `- 既往史「${item.quote}」：教材「${item.disease}」写明可参考西医${item.western}；本次主诉的「${item.chiefSymptom}」正是${item.disease}的主症。`);
  return [
    "",
    "【既往确诊病与本次主诉】",
    ...lines,
    "本次主症与既往确诊的病同一部位、同一主症时，本次按该病的发作辨病（如慢性扁桃体炎急性发作属乳蛾），不要因病历未写专科查体而改辨同部位的邻近病；病历未记录的专科体征（如喉核红肿程度、脓点）写进待核实信息。若本次主症确实另有归属（如以恶寒发热、鼻塞流涕为主的外感），按实际辨病，并在辨病依据里说明与既往病的关系。",
  ].join("\n");
}

/**
 * 辨证半写出的病名是不是该病的教材邻近病（互为教材鉴别病名，如乳蛾 ↔ 喉痹）。只有这时才按既往确诊病重写一次：
 * 写成别的病（感冒）说明模型看到了另一组主症，不改。
 */
export function writtenDiseaseIsTextbookNeighbour(written: string, stated: HistoryStatedTextbookDisease, differentialsOf: (disease: string) => readonly string[]): boolean {
  const name = compact(written).replace(/类病$/u, "");
  if (!name || name === compact(stated.disease)) return false;
  return differentialsOf(stated.disease).some((item) => compact(item) === name) || differentialsOf(name).some((item) => compact(item) === compact(stated.disease));
}

export function historyStatedDiseaseRedrawInstruction(written: string, stated: HistoryStatedTextbookDisease): string {
  return [
    "【既往确诊病与本次主诉（服务端核对）】",
    `既往史「${stated.quote}」：教材「${stated.disease}」写明可参考西医${stated.western}，本次主诉的「${stated.chiefSymptom}」正是${stated.disease}的主症。上一稿把病名写成「${written}」，它是${stated.disease}在教材里的鉴别病。`,
    `请按既往确诊病的发作辨病，病名写「${stated.disease}」，并据此重写本半全部内容：辨病依据（交代既往史与本次主症）、病名与证候鉴别（与「${written}」相区分）、证候、病机与治法；病历未记录的专科体征写进待核实信息。`,
  ].join("\n");
}

/** 病例里的既往史原文（规范槽位、HIS 字段、病历式中文键，取第一个有内容的）。 */
export function caseStatePastHistoryText(caseState: { pastHistory?: unknown; symptoms?: unknown; hisRecord?: { fields?: Record<string, unknown> } }): string {
  const symptoms = caseState.symptoms && typeof caseState.symptoms === "object" ? caseState.symptoms as Record<string, unknown> : {};
  const value = [caseState.hisRecord?.fields?.jiwangshi, caseState.pastHistory, symptoms["既往史"], symptoms["既往病史"], symptoms.pastHistory]
    .find((item): item is string => typeof item === "string" && Boolean(item.trim()));
  return value || "";
}

function enabled(): boolean {
  return process.env.CDSS_HISTORY_STATED_DISEASE !== "false";
}

/** 按病例取既往确诊病对照（科别清单与闭集选病相同）。开关 CDSS_HISTORY_STATED_DISEASE=false 关闭。 */
export function historyStatedDiseasesForCase(caseState: {
  chiefComplaint?: string;
  pastHistory?: unknown;
  symptoms?: unknown;
  hisRecord?: { fields?: Record<string, unknown> };
  patient?: { sex?: string; age?: unknown };
}): HistoryStatedTextbookDisease[] {
  if (!enabled()) return [];
  const ageYears = typeof caseState.patient?.age === "number" ? caseState.patient.age : undefined;
  return historyStatedTextbookDiseases({
    chiefComplaint: caseState.chiefComplaint || "",
    pastHistory: caseStatePastHistoryText(caseState),
    allowedDiseases: textbookDiseaseNamesForCase({ sex: caseState.patient?.sex, ageYears }),
  });
}
