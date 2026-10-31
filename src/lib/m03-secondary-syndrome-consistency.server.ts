import "server-only";
import secondaryStructureJson from "../data/tcm-secondary-syndrome-structure.source.json" with { type: "json" };

import { affirmedClinicalSourceClauses } from "./clinical-polarity";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { textbookManifestationTerms, textbookRowForSyndrome, type TextbookSyndromeRow } from "./tcm-textbook-syndromes";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { claimsSecondaryPattern, declaresSecondaryMechanism, deniesSeparateSecondaryPattern, mechanismClaimsUncoveredBy, ruleOutCueIndex, therapyItemsOnlyFor, withoutRedundantTherapyPhrases } from "./tcm-therapy-phrasing";
import criteriaJson from "../data/tcm-diagnostics-syndrome-criteria.json" with { type: "json" };

/**
 * 辨证依据与兼证栏一致（2026-10-19）。
 *
 * ≥300 条验收 M 集：360 例里只有 3 例写了兼证，66 例在辨证依据或病机里写了「兼脾虚之象」「夹瘀」「本虚标实」而兼证栏为空，
 * 评审判「前后矛盾」69 例，是中医诊断最大的一类不合格。提示词早就要求两者一致、输出前自查，模型照样两头都留。
 *
 * 做法是窄核对：中医半返回后先用确定性规则找「兼/夹 + 病性字」这类说法，兼证栏为空、又找到了，才发一次小任务（约 1 秒），
 * 让它二选一——病历里该病机另有至少两条相互印证的表现，就补成兼证并并列治法；不够，就指出依据和病机里要删的分句。
 * 服务端只核对：兼证名是证名、不是主证本身；支持表现逐字出自病历、且不在否认句里；要删的分句逐字在原文里。其余情况原样返回。
 * 开关：CDSS_M03_SECONDARY_CONSISTENCY=false 关闭。
 *
 * 第二条路：独立成组证据核对（2026-10-19 晚，第九轮 WP9-C）。
 * M 集（真实医案）中医诊断 183 例不合格里，参考为复合证、病历里第二组表现确实成组（舌脉各自有支撑）、系统却只给了单证的约占两成：
 * 模型在辨证依据里常已写到那一组（「舌淡暗边有齿痕、脉细为脾运不健」「腰酸畏寒、夜尿频示肾阳亦不足」），却既没有「兼」「夹」字样（第一条路碰不到），
 * 也没立兼证。第一条路只在依据里自称兼夹时才核对。
 * 做法与它同一风格：兼证栏为空时，按病历另发一次小任务，让模型先分组再下结论（每组逐字摘录、标判断），采信后再发一次否决式复核
 * （保留须有至少两条是该兼证的特异表现），两次都过，才补兼证。服务端只做三件事：摘录逐字出自病历肯定句且不少于两条；兼证名不是主证本身；
 * 教材吻合度闸门（见 GROUP_CHECK_FIT_CEILING）。
 * 为什么不是「看到第二组就立」：同一套提示词在甲方标准病历（教材式单证，标准答案无兼证）上也会找到「第二组」——病历 4（肝气犯胃）的
 * 「大便溏结不调、饮食欠佳」、病历 3（血虚头痛）的「食欲下降、大便稀溏」——模型自己分不出哪些是应立的兼证，复核提示词也分不出（离线对照：
 * 复核保留了所有 4 个甲方病例的候选中的 3 个）。能把两类病例分开的只有一个与临床内容无关的量：病历对主证教材证型的吻合度。
 * 开关：CDSS_M03_SECONDARY_GROUP_CHECK=false 关闭第二条路。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.M03_SECONDARY_CONSISTENCY_TIMEOUT_MS || 5_000);
  return Number.isFinite(value) && value >= 1_500 && value <= 10_000 ? Math.round(value) : 5_000;
})();
const MAX_RECORD_CHARS = 1_800;

function broadTrigger(): "markers" | "all" | "off" {
  const value = process.env.CDSS_M03_SECONDARY_BROAD_TRIGGER;
  return value === "false" ? "off" : value === "all" ? "all" : "markers";
}

function enabled(): boolean {
  return process.env.CDSS_M03_SECONDARY_CONSISTENCY !== "false";
}

function groupCheckEnabled(): boolean {
  return process.env.CDSS_M03_SECONDARY_GROUP_CHECK !== "false";
}

function criteriaCheckEnabled(): boolean {
  return process.env.CDSS_M03_SECONDARY_CRITERIA !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const compact = (value: string) => value.normalize("NFKC").replace(/[\s，,。．.；;：:、（）()“”"'‘’！!？?]/gu, "");

// 「兼/夹」后 8 字内出现病性字（兼脾虚之象、夹瘀、兼有湿浊内蕴、兼有肺气不足）见 tcm-therapy-phrasing 的 claimsSecondaryPattern；
// 兼顾/兼治/兼以 与否定（无兼、不夹）不算。
const DEFICIENCY_EXCESS_MIX = /本虚标实|虚实夹杂/u;

const DEFICIENT_HOST_EXCESS_EVIL = /正虚邪实/u;

/** 辨证依据与病机里指向主证以外另一证候的说法（逐个分句）。 */
export function secondaryPatternClaims(...values: string[]): string[] {
  const clauses = values.flatMap((value) => value.split(/[，,。；;]/u)).map((clause) => clause.trim()).filter(Boolean);
  return clauses.filter((clause) =>
    claimsSecondaryPattern(clause) || DEFICIENCY_EXCESS_MIX.test(clause) || DEFICIENT_HOST_EXCESS_EVIL.test(clause));
}

export type SecondaryConsistencyDecision =
  | { decision: "add"; secondarySyndrome: string; method: string; evidence: string[] }
  | { decision: "remove"; clauses: string[] }
  | { decision: "none" };

/** item 的字在 clause 里按顺序出现，且首尾跨度不超过 maxSpan。 */
function orderedWithin(clause: string, item: string, maxSpan: number): boolean {
  for (let start = clause.indexOf(item[0]); start >= 0; start = clause.indexOf(item[0], start + 1)) {
    let at = start;
    let ok = true;
    for (const char of item.slice(1)) {
      at = clause.indexOf(char, at + 1);
      if (at < 0 || at - start + 1 > maxSpan) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** 小任务输出 → 可用的决定。不合格一律 undefined（原样返回）。 */
export function parseSecondaryConsistencyDecision(
  content: unknown,
  context: { recordText: string; primarySyndrome: string; editableText: string },
): SecondaryConsistencyDecision | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: Json | undefined;
  try { parsed = record(JSON.parse(content)); } catch { return undefined; }
  if (!parsed) return undefined;
  const decision = text(parsed.decision);
  if (decision === "none") return { decision: "none" };
  if (decision === "add") {
    const name = text(parsed.secondarySyndrome).replace(/\s+/gu, "");
    const method = text(parsed.method).replace(/\s+/gu, "");
    if (!/^[一-鿿]{2,10}证$/u.test(name)) return undefined;
    const primary = compact(context.primarySyndrome);
    const core = name.replace(/证$/u, "");
    if (!primary || primary === compact(name) || primary.includes(core)) return undefined;
    if (!/^[一-鿿]{2,8}$/u.test(method)) return undefined;
    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence.map((item) => compact(text(item))).filter((item) => item.length >= 2 && item.length <= 16)
      : [];
    // 支持表现要出自病历的肯定小句（「无腹胀」里的「腹胀」不算）。允许病历写法里夹着几个字（「苔黄腻」对「舌苔黄、质腻」）：
    // 同一个小句里按顺序找得到这几个字、跨度不超过引文长度加 3 即算（2026-10-19，M 子集 13 例补兼证被逐字比对挡掉）。
    const affirmedClauses = affirmedClinicalSourceClauses(context.recordText).flatMap((clause) => clause.split(/[，,]/u)).map(compact).filter(Boolean);
    const grounded = [...new Set(evidence)].filter((item) => affirmedClauses.some((clause) => clause.includes(item) || orderedWithin(clause, item, item.length + 3)));
    if (grounded.length < 2) return undefined;
    return { decision: "add", secondarySyndrome: name, method, evidence: grounded };
  }
  if (decision === "remove") {
    const editable = context.editableText;
    // 只删兼夹说法本身（2026-10-19 甲方标准病历 1 两次：小任务让删「恶寒重、发热轻、无汗、鼻塞流清涕」这类主症分句，
    // 辨证依据只剩「咳嗽，…」，风寒鉴别投影又把主症补在句末）。要删的分句自己必须是一条兼夹说法。
    const clauses = Array.isArray(parsed.clauses)
      ? parsed.clauses.map((item) => text(item)).filter((item) => item.length >= 2 && editable.includes(item) &&
        // 能删的只有自称兼夹的分句（兼夹说法，或「之兼象」「兼见」「同病」这类标记）。只用病机词解释某个表现的分句
        //（「易疲劳为气血不足」）可以据此补兼证，不删——删了等于把这个表现的解释拿掉。
        (secondaryPatternClaims(item).length > 0 || declaresSecondaryMechanism(item)))
      : [];
    return clauses.length > 0 ? { decision: "remove", clauses } : undefined;
  }
  return undefined;
}

/** 从一段话里删掉指定分句，连带它前面（或句首时后面）的逗号；句子删空时连句末标点一起去掉。 */
export function withoutClauses(value: string, clauses: readonly string[]): string {
  let out = value;
  for (const clause of clauses) {
    if (!clause || !out.includes(clause)) continue;
    const at = out.indexOf(clause);
    const before = out.slice(0, at);
    const after = out.slice(at + clause.length);
    if (/[，,]$/u.test(before)) out = `${before.slice(0, -1)}${after}`;
    else if (/^[，,]/u.test(after)) out = `${before}${after.slice(1)}`;
    else out = `${before}${after.replace(/^[。；;]/u, before && !/[。；;]$/u.test(before) ? "。" : "")}`;
  }
  return out.replace(/^[，,。；;]+/u, "").replace(/([。；;])[，,]+/gu, "$1").trim();
}

// ───── 第二条路：独立成组证据核对 ─────

/**
 * 教材吻合度闸门：病历对主证教材证型的主症吻合度（病历肯定句里出现的教材主症短语占比）达到此值，主证已解释了主要表现，不再另找第二组。
 * 数值阈值，取自离线分布（2026-10-19，deepseek-flash 找组 + 否决复核，同一份提示词）：
 *   甲方标准病历 10 例吻合度 0.20–0.50（病历 3 血虚头痛 0.43、病历 4 肝气犯胃 0.50、牙痛 胃火上炎有教材行，找组都找到了「第二组」）；
 *   留出（教材式单证）10 例 0.10–0.44；
 *   验收 M 集参考为复合证、人工判「第二组确实成组」的 18 例 0.00–0.27（RobustSDT-0614/0617/0621/0631 四例 0.00–0.10，0530/0541 最高 0.27）。
 * 取 0.30：教材式病历（写病历时照着教材证型的主症写）几乎都在其上；真实医案对教材证型只是部分吻合。吻合度未知（模型证名对不上教材行）时不设闸。
 */
export const GROUP_CHECK_FIT_CEILING = 0.3;
/** 教材主症短语至少这么多条，吻合度才有意义（只有两三条的证型，一条之差就是三成）。 */
const FIT_MIN_ITEMS = 4;
const FIT_BIGRAM_SHARE = 0.6;

const bigramsOf = (value: string): Set<string> => {
  const grams = new Set<string>();
  for (let index = 0; index + 1 < value.length; index += 1) grams.add(value.slice(index, index + 2));
  return grams;
};

/**
 * 病历对教材证型主症的吻合度（0–1）：教材主症按标点切成短语，病历肯定句里整句包含，或二字组至少 FIT_BIGRAM_SHARE 出现在病历里，算对上一条。
 * 教材证型的主症短语不足 FIT_MIN_ITEMS 条时返回 undefined。
 */
export function textbookPatternFit(row: Pick<TextbookSyndromeRow, "manifestations">, recordText: string): number | undefined {
  const items = textbookManifestationTerms(row).map(compact).filter((phrase) => phrase.length >= 2);
  if (items.length < FIT_MIN_ITEMS) return undefined;
  const record = compact(affirmedClinicalSourceClauses(recordText).join("，") || recordText);
  const recordGrams = bigramsOf(record);
  const covered = items.filter((item) => {
    if (record.includes(item)) return true;
    const grams = bigramsOf(item);
    if (grams.size === 0) return false;
    let shared = 0;
    for (const gram of grams) if (recordGrams.has(gram)) shared += 1;
    return shared / grams.size >= FIT_BIGRAM_SHARE;
  }).length;
  return covered / items.length;
}

const GROUP_FINDER_SYSTEM = [
  "你是中医主治医师，复核一份辨证结论有没有漏掉“第二个成组的证候”。主证已定，不改主证。",
  "",
  "先分组，再判断。把病历里主证没有包含的表现，按脏腑或病性分成最多两组，每组写：",
  "- syndrome：国标规范证名（以“证”结尾）；",
  "- items：逐字摘自病历的表现 2–4 条（每条不超过12字；只摘病历肯定存在的，否认的不摘）；",
  "- verdict：independent（独立成组）/ merged（并入主证）/ single（只有一条或顺带提到）。",
  "",
  "一组判 independent，须同时满足：",
  "1. 至少两条相互印证的表现（症状、舌象、脉象均可）；",
  "2. 属于与主证不同的脏腑，或不同的病性（例：主证肝气郁结，另一组是脾气虚；主证湿热中阻，另一组是脾胃气虚；主证脾阳虚，另一组是肾阳虚）；",
  "3. 这些表现不是主证本身的典型表现（primaryManifestations 里列出的），也不是主证病机的直接结果。",
  "不算第二组：只有一条表现；睡眠欠佳、纳差、乏力这类顺带提到的单项；年龄、病程、检查指标本身；病历没写的。",
  "",
  "decision=add 当且仅当有一组判 independent；多组满足时只取对治法影响最大的一组，secondarySyndrome 与 method（2–8字治法）取该组。其余 decision=none。",
  "只输出 JSON：{\"groups\":[{\"syndrome\":\"…证\",\"items\":[\"…\",\"…\"],\"verdict\":\"independent|merged|single\"}],\"decision\":\"add|none\",\"secondarySyndrome\":\"…证\",\"method\":\"…\"}",
].join("\n");

const GROUP_VERIFIER_SYSTEM = [
  "你是资深中医，复核“第二个证候能否立为兼证”。系统已定主证；另一位医生认为病历里还有第二个成组证候，想立为兼证（proposedSecondary，支持表现 proposedEvidence）。",
  "",
  "判断标准是“特异性”：",
  "- 特异表现 = 对这个兼证有定性意义的表现，如脾虚的舌淡胖有齿痕、大便溏薄、食后腹胀；肾阳虚的畏寒肢冷、腰膝冷痛、夜尿频多；湿热的苔黄腻、口苦口黏、小便黄赤；血瘀的舌质紫暗或瘀斑、刺痛固定、脉涩；气虚的气短懒言、动则汗出、脉弱；阴虚的舌红少苔、五心烦热、盗汗。",
  "- 非特异表现 = 乏力、纳差、睡眠差、口干、烦躁、轻度便秘或便溏、轻微头晕这类几乎任何证候都会伴有的表现，以及主证自己的典型表现（primaryManifestations）。",
  "保留（keep）：proposedEvidence 里至少有两条是这个兼证的特异表现，且与主证不是同一个病机的不同说法。",
  "否决（drop）：支持表现多数是非特异表现，或本来就是主证的典型表现，或兼证与主证是同脏同类（如同为肾虚、同为痰湿）。",
  "只输出 JSON：{\"specific\":[\"特异的那几条原文\"],\"verdict\":\"keep|drop\"}",
].join("\n");

/** 找组小任务的输出 → 可用的兼证决定。只认被选中的那一组判 independent；摘录的逐字核对与通常的补兼证同一口径。 */
export function parseGroupFinderDecision(
  content: unknown,
  context: { recordText: string; primarySyndrome: string; editableText: string },
): Extract<SecondaryConsistencyDecision, { decision: "add" }> | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: Json | undefined;
  try { parsed = record(JSON.parse(content)); } catch { return undefined; }
  if (!parsed || text(parsed.decision) !== "add") return undefined;
  const name = text(parsed.secondarySyndrome).replace(/\s+/gu, "");
  const groups = Array.isArray(parsed.groups) ? parsed.groups.map(record).filter((item): item is Json => Boolean(item)) : [];
  const chosen = groups.find((group) => text(group.syndrome).replace(/\s+/gu, "") === name);
  if (!name || !chosen || text(chosen.verdict) !== "independent") return undefined;
  const decision = parseSecondaryConsistencyDecision(JSON.stringify({
    decision: "add", secondarySyndrome: name, method: text(parsed.method), evidence: Array.isArray(chosen.items) ? chosen.items : [],
  }), context);
  return decision?.decision === "add" ? decision : undefined;
}

/** 否决式复核的输出：只有明确 keep 才算保留（缺字段、乱写一律当否决）。 */
export function parseGroupVerifierVerdict(content: unknown): boolean {
  if (typeof content !== "string" || !content.trim()) return false;
  try { return text(record(JSON.parse(content))?.verdict) === "keep"; } catch { return false; }
}

async function smallJsonTask<T>(
  namespace: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens: number,
  parse: (content: unknown) => T | undefined,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return undefined;
  return memoizedSmallTask<T | undefined>(namespace, smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: namespace, stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const value = parse(response.choices[0]?.message?.content);
      return { value, cacheable: value !== undefined };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
}

/** 找组 → 否决式复核，两次都过才返回兼证决定。任何失败都是 undefined（原样返回）。 */
async function decideIndependentGroup(
  input: { recordText: string; primarySyndrome: string; method: string; textbookRow?: TextbookSyndromeRow; editableText: string },
  signal?: AbortSignal,
): Promise<Extract<SecondaryConsistencyDecision, { decision: "add" }> | undefined> {
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  if (!recordText.trim()) return undefined;
  const primaryManifestations = input.textbookRow
    ? [input.textbookRow.manifestations, input.textbookRow.tongue, input.textbookRow.pulse].filter(Boolean).join("；")
    : undefined;
  const context = { recordText: input.recordText, primarySyndrome: input.primarySyndrome, editableText: input.editableText };
  const proposal = await smallJsonTask("m03_secondary_group_find", [
    { role: "system", content: GROUP_FINDER_SYSTEM },
    { role: "user", content: JSON.stringify({ primarySyndrome: input.primarySyndrome, method: input.method, ...(primaryManifestations ? { primaryManifestations } : {}), record: recordText }) },
  ], 500, (content) => parseGroupFinderDecision(content, context), signal);
  if (!proposal) return undefined;
  const keep = await smallJsonTask("m03_secondary_group_verify", [
    { role: "system", content: GROUP_VERIFIER_SYSTEM },
    { role: "user", content: JSON.stringify({ primarySyndrome: input.primarySyndrome, ...(primaryManifestations ? { primaryManifestations } : {}), proposedSecondary: proposal.secondarySyndrome, proposedEvidence: proposal.evidence, record: recordText }) },
  ], 200, (content) => parseGroupVerifierVerdict(content), signal);
  return keep ? proposal : undefined;
}

async function decideSecondaryConsistency(
  input: { recordText: string; primarySyndrome: string; rationale: string; pathogenesis: string; method: string; claims: string[] },
  signal?: AbortSignal,
): Promise<SecondaryConsistencyDecision | undefined> {
  if (signal?.aborted) return undefined;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return undefined;
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  if (!recordText.trim()) return undefined;
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是中医主治医师，核对一份辨证结论的前后一致性，不改主证。",
        "辨证依据或病机里写到了主证以外的兼夹病机（见 claims），但兼证栏是空的。请按本例病历二选一：",
        "A. 病历里该兼夹病机另有至少两条相互印证、主证解释不了的表现（症状或舌脉）时，补成兼证：给出国标规范证名（以“证”结尾，如“脾气虚证”“血瘀证”“湿热内蕴证”“气阴两虚证”）、它的治法（2–8字，如“健脾益气”“活血化瘀”），以及逐字摘自病历的支持表现 2–4 条（每条不超过12字，只摘病历原文里肯定存在的表现，不摘否认的）。",
        "B. 只有一条表现、只是顺带提到、或主证本身已能解释时，不立兼证：列出辨证依据或病机里需要删去的分句（逐字摘录，以逗号分句为单位），删去后其余文字仍通顺。",
        "主证名里已经包含该病机（如主证“肝郁脾虚证”已含脾虚）时，返回 none。",
        "只输出 JSON：{\"decision\":\"add\",\"secondarySyndrome\":\"…证\",\"method\":\"…\",\"evidence\":[\"…\",\"…\"]} 或 {\"decision\":\"remove\",\"clauses\":[\"…\"]} 或 {\"decision\":\"none\"}",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        primarySyndrome: input.primarySyndrome,
        method: input.method,
        tcmDiagnosticRationale: input.rationale,
        overallPathogenesis: input.pathogenesis,
        claims: input.claims,
        record: recordText,
      }),
    },
  ];
  const editableText = `${input.rationale}\n${input.pathogenesis}`;
  return memoizedSmallTask<SecondaryConsistencyDecision | undefined>("m03_secondary_consistency", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "m03_secondary_consistency", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 300,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const value = parseSecondaryConsistencyDecision(response.choices[0]?.message?.content, {
        recordText: input.recordText,
        primarySyndrome: input.primarySyndrome,
        editableText,
      });
      return { value, cacheable: Boolean(value) };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
}

// ───── 兼证判据：《中医诊断学》辨证要点（2026-10-21 第十二轮） ─────
//
// 不论兼证从哪来（依据里自称兼夹、独立成组核对、模型自己写进兼证栏），立之前都按教材的【辨证要点】数一遍：
// 该证的特异表现至少 2 条（要点只列 1 条时那 1 条 + 共见类症状 2 条），要点写了「与X症状共见」的再要至少 1 条 X 类症状；
// 要点只是一串表现（「以……为主要表现」）的，要至少 3 条、其中 2 条是要点里的。主证教材证型自己的表现（主症、舌、脉）不算——
// 这就是「独立成组」：S161 燥热便秘补的「津亏证」（口干、便干就是热秘本身）、S128 胃肠湿热补的「风邪证」（风团瘙痒就是瘾疹本身）
// 因此不立；L 集心血瘀阻证病历里心悸气短、动则益甚、倦怠乏力、易汗出成组，心气虚证照立。
// 病历表现与教材条目的对应由小任务做（只许从给定条目里选、病历逐字摘录，同义写法算，如「食欲差」之于「纳少」），条数由服务端数。
// 查不到这个证名、或小任务失败：判 unknown，照旧（不因判据缺失而增删兼证）。开关 CDSS_M03_SECONDARY_CRITERIA=false。

type CriteriaEntry = {
  name: string;
  line: number;
  keyPointsText: string;
  specific: string[];
  category: string | null;
  categoryEntries: string[];
  manifestations: string[];
  /** 组合证（湿热、痰热、痰湿、寒湿）：由这几个证的证候表现合成，判定时每个组成证至少对上 1 条。 */
  components?: string[];
};
const CRITERIA_ENTRIES = new Map<string, CriteriaEntry>((criteriaJson.entries as CriteriaEntry[]).map((entry) => [entry.name, entry]));
const CRITERIA_ALIASES = criteriaJson.aliases as Record<string, string>;
const CRITERIA_SUFFIX_VARIANTS = criteriaJson.nameSuffixVariants as string[];

/** 证名 → 《中医诊断学》条目：原名、受治理的同义名，或「X不足证/X亏虚证」→「X虚证」。 */
export function diagnosticsCriteriaFor(name: string): CriteriaEntry | undefined {
  const clean = compact(name);
  if (!clean) return undefined;
  const withSuffix = clean.endsWith("证") ? clean : `${clean}证`;
  const lookup = (value: string) => CRITERIA_ENTRIES.get(value) ?? CRITERIA_ENTRIES.get(CRITERIA_ALIASES[value] || "");
  const direct = lookup(withSuffix);
  if (direct) return direct;
  for (const suffix of CRITERIA_SUFFIX_VARIANTS) {
    if (withSuffix.endsWith(suffix)) {
      const entry = lookup(`${withSuffix.slice(0, -suffix.length)}虚证`);
      if (entry) return entry;
    }
  }
  return undefined;
}

function criteriaCategoryItems(entry: CriteriaEntry): string[] {
  return [...new Set(entry.categoryEntries.flatMap((name) => {
    const category = CRITERIA_ENTRIES.get(name);
    return category ? [...category.specific, ...category.manifestations] : [];
  }))];
}

export function criteriaItemsFor(entry: CriteriaEntry): string[] {
  return [...new Set([...entry.specific, ...criteriaCategoryItems(entry), ...entry.manifestations])].slice(0, 40);
}

const sharesPrimaryManifestation = (quote: string, primaryTerms: readonly string[]): boolean => {
  const value = compact(quote);
  if (!value) return false;
  const grams = bigramsOf(value);
  return primaryTerms.some((raw) => {
    const term = compact(raw);
    if (term.length < 2) return false;
    if (value.includes(term) || term.includes(value)) return true;
    // 两三个字的摘录，每个字都在主证这条表现里（「头晕」之于「头痛而晕」）：同一表现的不同写法。
    if (value.length <= 3 && [...value].every((char) => term.includes(char))) return true;
    const termGrams = bigramsOf(term);
    let shared = 0;
    for (const gram of grams) if (termGrams.has(gram)) shared += 1;
    return grams.size > 0 && shared / grams.size >= FIT_BIGRAM_SHARE;
  });
};

/** quotes：计入判定的病历摘录（去重、已排除主证同一表现），证素核对给证据标签用。 */
export type CriteriaVerdict = { verdict: "pass" | "fail" | "unknown"; entry?: string; specific: number; category: number; listed: number; distinct: number; quotes?: string[] };

/** 小任务给出的对应 → 判定。纯函数，供测试。 */
export function evaluateCriteriaMatches(
  entry: CriteriaEntry,
  matches: ReadonlyArray<{ item: string; quote: string | null }>,
  context: { recordText: string; primaryTerms: readonly string[]; breadth?: boolean },
): CriteriaVerdict {
  const specificSet = new Set(entry.specific);
  const categorySet = new Set(criteriaCategoryItems(entry));
  const manifestSet = new Set(entry.manifestations);
  const affirmedClauses = affirmedClinicalSourceClauses(context.recordText).flatMap((clause) => clause.split(/[，,]/u)).map(compact).filter(Boolean);
  const seenQuotes = new Set<string>();
  const componentHits = new Map<string, number>();
  let specific = 0;
  // 特异表现病历里有、但与主证同脏同一表现而扣掉的条数（主证心血瘀阻、兼证心阳虚：心悸、胸闷两边都有）。
  let sharedSpecific = 0;
  let category = 0;
  let listed = 0;
  for (const match of matches) {
    const quote = compact(match.quote || "");
    if (quote.length < 2 || quote.length > 20 || seenQuotes.has(quote)) continue;
    if (!affirmedClauses.some((clause) => clause.includes(quote) || orderedWithin(clause, quote, quote.length + 3))) continue;
    if (sharesPrimaryManifestation(quote, context.primaryTerms)) {
      if (specificSet.has(match.item)) sharedSpecific += 1;
      continue;
    }
    if (specificSet.has(match.item)) specific += 1;
    else if (categorySet.has(match.item)) category += 1;
    else if (manifestSet.has(match.item)) listed += 1;
    else continue;
    seenQuotes.add(quote);
    for (const component of entry.components || []) {
      if (CRITERIA_ENTRIES.get(component)?.manifestations.includes(match.item)) componentHits.set(component, (componentHits.get(component) || 0) + 1);
    }
  }
  const distinct = seenQuotes.size;
  let pass: boolean;
  if (entry.components?.length) pass = distinct >= 3 && entry.components.every((component) => (componentHits.get(component) || 0) >= 1);
  else if (!entry.keyPointsText) pass = distinct >= 3;
  else if (entry.categoryEntries.length > 0) {
    const needSpecific = Math.min(2, entry.specific.length);
    const needCategory = entry.specific.length >= 2 ? 1 : 2;
    // 与主证同脏：该脏的特异表现两边共有（扣掉了），兼的其实是病性（阳虚、气虚…）。病性那一类症状至少 3 条、
    // 特异表现病历里确实有（独立的加共有的够数）时立——心血瘀阻兼心阳虚，阳虚是另一组证据。
    pass = (specific >= needSpecific && category >= needCategory) ||
      (specific + sharedSpecific >= needSpecific && category >= 3);
  } else if (entry.category) pass = specific >= Math.min(2, entry.specific.length) && distinct >= 2;
  else pass = specific >= Math.min(2, entry.specific.length) && distinct >= 3;
  // 证素核对的宽路径（2026-10-31，甲方 10.29 测评：面色萎黄、爪甲色淡、头晕目眩、毛发枯槁「明确的气血两虚表现」被判血虚不够数）：
  //《中医诊断学》血虚证辨证要点只列「面、睑、唇、舌色淡白，脉细」，萎黄、爪甲色淡、头晕眼花都在它的【证候表现】里。证候表现独立成组三条以上，
  // 这一证素就算有据。只用于证素（虚性要素是否有病历支持），立兼证仍按辨证要点。
  if (!pass && context.breadth && !entry.components?.length && distinct >= 3) pass = true;
  return { verdict: pass ? "pass" : "fail", entry: entry.name, specific, category, listed, distinct, quotes: [...seenQuotes] };
}

const CRITERIA_MATCH_SYSTEM = [
  "你是中医主治医师。下面是教材对某一证候列出的辨证条目（items）。逐条看病历里有没有这一表现。",
  "病历原文肯定写着这一表现时，给出病历里的逐字摘录（不超过16字）；意思相同的写法也算（如“食欲差”之于“纳少”，“大便时稀”之于“便溏”，“动则气短”之于“气短”）。",
  "病历否认的、没写到的、要靠推断的，quote 给 null。一处摘录只对应一条最贴切的条目。",
  "只输出 JSON：{\"matches\":[{\"item\":\"条目原文\",\"quote\":\"病历逐字摘录或null\"}]}",
].join("\n");

function parseCriteriaMatches(content: unknown, items: readonly string[]): Array<{ item: string; quote: string | null }> | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: Json | undefined;
  try { parsed = record(JSON.parse(content)); } catch { return undefined; }
  if (!parsed || !Array.isArray(parsed.matches)) return undefined;
  const allowed = new Set(items);
  return parsed.matches.map(record).flatMap((item) => {
    const name = text(item?.item);
    if (!allowed.has(name)) return [];
    const quote = item?.quote == null ? null : text(item.quote);
    return [{ item: name, quote: quote && quote !== "null" ? quote : null }];
  });
}

const CRITERIA_ORGAN_CHARS = /[心肝脾肺肾胃胆肠]/gu;

/**
 * 判据表里没有的合称（肺胃热盛证、心肝火旺证）按脏腑拆开：每个脏腑取表里同时写这个脏腑和这种病性的条目（肺热炽盛证、胃热炽盛证），取最短的一条。
 * 此前查不到条目就跳过核对，模型写什么留什么（2026-10-31 甲方 10.29 测评：肾阴亏虚证兼肺胃热盛证，舌红少津、苔薄、脉细数无力，「虚热之象」）。
 */
export function compoundCriteriaEntries(name: string): CriteriaEntry[] {
  const clean = compact(name).replace(/证$/u, "");
  const organs = [...new Set(clean.match(CRITERIA_ORGAN_CHARS) || [])];
  const natureChars = [...clean.replace(CRITERIA_ORGAN_CHARS, "").replace(/[盛炽壅蕴]/gu, "")];
  if (organs.length === 0 || natureChars.length === 0) return [];
  const entries = organs.map((organ) => [...CRITERIA_ENTRIES.values()]
    .filter((entry) => entry.name.includes(organ) && natureChars.some((char) => entry.name.includes(char)))
    .sort((left, right) => left.name.length - right.name.length)[0]);
  return entries.every(Boolean) ? entries : [];
}

/** 一个兼证名按辨证要点核一遍。查不到条目或小任务失败为 unknown。breadth：证素核对用的宽路径（见 evaluateCriteriaMatches）。 */
export async function verifySecondaryByCriteria(
  name: string,
  context: { recordText: string; primaryTerms: readonly string[]; breadth?: boolean },
  signal?: AbortSignal,
): Promise<CriteriaVerdict> {
  const unknown: CriteriaVerdict = { verdict: "unknown", specific: 0, category: 0, listed: 0, distinct: 0 };
  const entry = diagnosticsCriteriaFor(name);
  const verifyEntry = async (target: CriteriaEntry): Promise<CriteriaVerdict> => {
    const items = criteriaItemsFor(target);
    const recordText = context.recordText.slice(0, MAX_RECORD_CHARS);
    const matches = await smallJsonTask("m03_secondary_criteria", [
      { role: "system", content: CRITERIA_MATCH_SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome: target.name, keyPoints: target.keyPointsText, items, record: recordText }) },
    ], 700, (content) => parseCriteriaMatches(content, items), signal);
    return matches ? evaluateCriteriaMatches(target, matches, context) : { ...unknown, entry: target.name };
  };
  if (entry && (entry.specific.length > 0 || entry.manifestations.length > 0)) return verifyEntry(entry);
  const parts = compoundCriteriaEntries(name);
  if (parts.length === 0) return unknown;
  const verdicts = await Promise.all(parts.map(verifyEntry));
  if (verdicts.some((item) => item.verdict === "unknown")) return unknown;
  const failing = verdicts.find((item) => item.verdict === "fail");
  return failing ?? verdicts[0];
}

/** 主证教材证型自己的表现（主症短语 + 舌 + 脉），用来判兼证的支持表现是否独立。 */
export function primaryManifestationTerms(row: TextbookSyndromeRow | undefined): string[] {
  if (!row) return [];
  return [...textbookManifestationTerms(row), ...[row.tongue, row.pulse].flatMap((value) => String(value || "").split(/[，,、；;。]/u))]
    .map((item) => item.trim()).filter((item) => item.length >= 2);
}

// 证名寒热字样（受治理来源：src/data/tcm-secondary-syndrome-structure.source.json）。
const anyOf = (terms: readonly string[]) => new RegExp(terms.join("|"), "u");
const wholeNameOf = (terms: readonly string[]) => new RegExp(`^(?:${terms.join("|")})证?$`, "u");
const HEAT_SYNDROME = anyOf(secondaryStructureJson.heatSyndromeTerms);
const COLD_SYNDROME = anyOf(secondaryStructureJson.coldSyndromeTerms);
const MIXED_COLD_HEAT = anyOf(secondaryStructureJson.mixedColdHeatTerms);
const DEFICIENT_HEAT_SECONDARY = wholeNameOf(secondaryStructureJson.deficientHeatSecondaryNames);
const DEFICIENT_COLD_SECONDARY = wholeNameOf(secondaryStructureJson.deficientColdSecondaryNames);
const YIN_DEFICIENT_PRIMARY = anyOf(secondaryStructureJson.yinDeficiencyPrimaryTerms);
const YANG_DEFICIENT_PRIMARY = anyOf(secondaryStructureJson.yangDeficiencyPrimaryTerms);
/**
 * 模型自写的兼证与主证在结构上不成立（第二十四轮，甲方 10/26 K04「风热犯肺证」兼「风寒表证」、治法里还加了「散寒」；甲方标准病历 6
 * 一次生成「肾阴虚证」兼「虚热证」）：
 *   · 寒热相反：主证属热、兼证属寒（或反过来），而证名与依据都没有写成寒热错杂的那几种（表寒里热、寒包火、上热下寒…）；
 *   · 主证已经包含：兼证去掉「证」字后是主证名的一部分，或阴虚主证下的「虚热/虚火」、阳虚主证下的「虚寒」。
 * 证名词是封闭的病性字样（不靠模型），与辨证要点核对（verifySecondaryByCriteria）互不替代：这里只拦结构上自相矛盾或重复的。
 */
export function secondaryStructurallyInvalid(primary: string, secondary: string, rationaleText = ""): "cold_heat_conflict" | "entailed_by_primary" | "declared_not_independent" | undefined {
  const p = compact(primary).replace(/证$/u, "");
  const sRaw = compact(secondary);
  const s = sRaw.replace(/证$/u, "");
  if (!p || !s) return undefined;
  // 依据自己说这组表现「非独立病证」「不另立」，兼证栏却写了它（2026-10-26 甲方测评病历 10：兼证心火亢盛证，
  // 依据末句「夜寐不宁系火热扰心所致，非独立病证」，判「辨证依据与证候矛盾」）。兼证默认不立，按依据撤下兼证。
  // 那一分句须说到兼证名里至少两个字（「火热扰心」对「心火亢盛」），别的兼夹因素的否认句不算。
  const secondaryChars = new Set([...s].filter((character) => /[\u4e00-\u9fff]/u.test(character)));
  if (rationaleText.split(/[。；;\n]/u).some((clause) => deniesSeparateSecondaryPattern(clause) &&
    [...secondaryChars].filter((character) => clause.includes(character)).length >= 2)) return "declared_not_independent";
  // 依据把这一型明确排除了（「舌淡红、苔薄白示无明显寒热与湿浊，故不归寒凝或湿热」），兼证栏却写着它（第二十七轮甲方 100 例 C061：
  // 气滞血瘀证兼寒凝胞宫证）。排除语之后的那段说到兼证名里连续两个字即算；只看排除语之后，前半句讲别的不算。
  const corePairs = [...new Set([...s].slice(0, -1).map((character, index) => `${character}${s[index + 1]}`))].filter((pair) => /^[\u4e00-\u9fff]{2}$/u.test(pair));
  if (rationaleText.split(/[。；;\n]/u).some((clause) => {
    const at = ruleOutCueIndex(clause);
    return at >= 0 && corePairs.some((pair) => clause.slice(at).includes(pair));
  })) return "declared_not_independent";
  if (s.length >= 2 && p.includes(s)) return "entailed_by_primary";
  if (YIN_DEFICIENT_PRIMARY.test(p) && DEFICIENT_HEAT_SECONDARY.test(sRaw)) return "entailed_by_primary";
  if (YANG_DEFICIENT_PRIMARY.test(p) && DEFICIENT_COLD_SECONDARY.test(sRaw)) return "entailed_by_primary";
  if (MIXED_COLD_HEAT.test(`${p}${s}${rationaleText}`)) return undefined;
  // 病性字样按完整证名读（「肺热证」的「热证」去掉「证」字就认不出）。
  const pRaw = compact(primary);
  const primaryHeat = HEAT_SYNDROME.test(pRaw) && !COLD_SYNDROME.test(pRaw);
  const primaryCold = COLD_SYNDROME.test(pRaw) && !HEAT_SYNDROME.test(pRaw);
  const secondaryHeat = HEAT_SYNDROME.test(sRaw) && !COLD_SYNDROME.test(sRaw);
  const secondaryCold = COLD_SYNDROME.test(sRaw) && !HEAT_SYNDROME.test(sRaw);
  if ((primaryHeat && secondaryCold) || (primaryCold && secondaryHeat)) return "cold_heat_conflict";
  return undefined;
}

/**
 * 要补的兼证与模型自写兼证过同一道结构判据（寒热相反、主证已包含、依据自称非独立；secondaryStructurallyInvalid）。
 * 此前只有模型自写的那一栏过这一道，补兼证这条路（依据里的兼夹说法、找第二组）没有：甲方接口病例「风热犯肺证」被补成「兼风寒表证」、
 * 治法末尾多出「辛温解表」（第二十七轮 qwen 评审 api-641286fcfcbf）。不成立时与辨证要点不够数同样处理：依据里自称兼夹的那几句删掉，否则不动。
 */
export function structurallyAdmissibleSecondaryDecision(
  decision: SecondaryConsistencyDecision | undefined,
  claimDecision: SecondaryConsistencyDecision | undefined,
  context: { primarySyndrome: string; rationale: string; pathogenesis: string; claims: readonly string[] },
): { decision: SecondaryConsistencyDecision | undefined; rejected?: ReturnType<typeof secondaryStructurallyInvalid> } {
  if (decision?.decision !== "add") return { decision };
  const rejected = secondaryStructurallyInvalid(context.primarySyndrome, decision.secondarySyndrome, `${context.rationale}${context.pathogenesis}`);
  if (!rejected) return { decision };
  const removable = context.claims.filter((clause) => secondaryPatternClaims(clause).length > 0 || declaresSecondaryMechanism(clause));
  return {
    decision: claimDecision?.decision === "remove" ? claimDecision : removable.length > 0 ? { decision: "remove", clauses: removable } : undefined,
    rejected,
  };
}

/** 撤下模型自写的兼证：兼证栏去掉它，治法里只属于它的项去掉，依据与病机里「兼X」的字样去掉。纯函数，供测试。 */
export function withdrawSecondarySyndrome(root: Json, name: string, primaryTextbookMethod = ""): boolean {
  const overview = record(root.overview);
  if (!overview || !Array.isArray(overview.secondarySyndromes)) return false;
  const current = overview.secondarySyndromes as unknown[];
  const remaining = current.filter((item) => compact(text(item)) !== compact(name));
  if (remaining.length === current.length) return false;
  overview.secondarySyndromes = remaining;
  const primary = text(overview.primarySyndrome);
  const therapy = record(root.therapy);
  const method = text(therapy?.overallMethod);
  if (therapy && method) {
    const only = therapyItemsOnlyFor(method, name, primary, primaryTextbookMethod);
    const items = method.split(/[，,、；;]/u).map((item) => item.trim()).filter(Boolean);
    const kept = items.filter((item) => !only.includes(item));
    if (kept.length > 0 && kept.length < items.length) therapy.overallMethod = kept.join("，");
  }
  const core = compact(name).replace(/证$/u, "");
  if (core.length >= 2) {
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const claim = new RegExp(`[，,；;]?(?:兼|夹)(?:有|见|夹)?[\\u4e00-\\u9fff]{0,4}?${escaped}(?:之象|之候|之证|证)?`, "gu");
    for (const key of ["tcmDiagnosticRationale", "overallPathogenesis"] as const) {
      const value = text(overview[key]);
      const next = value.replace(claim, "").replace(/^[，,；;]+/u, "");
      if (next !== value && next.length >= (key === "tcmDiagnosticRationale" ? 20 : 10)) overview[key] = next;
    }
  }
  return true;
}

/** 把决定落到中医半上：补兼证（并列治法）或删分句。纯函数，供测试。 */
export function applySecondaryConsistencyDecision(root: Json, decision: SecondaryConsistencyDecision): boolean {
  const overview = record(root.overview);
  if (!overview) return false;
  if (decision.decision === "add") {
    overview.secondarySyndromes = [decision.secondarySyndrome];
    const therapy = record(root.therapy);
    const method = text(therapy?.overallMethod);
    // 并列治法后去掉同义重复（「和血通络，活血通络」SD-451922）。
    if (therapy && method && !compact(method).includes(compact(decision.method))) therapy.overallMethod = withoutRedundantTherapyPhrases(`${method}，${decision.method}`);
    // 依据与病机里「不另立兼证/主证可释」的分句与补上的兼证相抵，去掉（MTCMB-21、MTCMB-90）；去掉后太短就不动。
    for (const key of ["tcmDiagnosticRationale", "overallPathogenesis"] as const) {
      const value = text(overview[key]);
      const denials = value.split(/[，,。；;]/u).map((clause) => clause.trim()).filter((clause) => clause && deniesSeparateSecondaryPattern(clause));
      if (denials.length === 0) continue;
      const next = withoutClauses(value, denials);
      if (next.length >= (key === "tcmDiagnosticRationale" ? 20 : 10)) overview[key] = next;
    }
    return true;
  }
  if (decision.decision === "remove") {
    const rationale = text(overview.tcmDiagnosticRationale);
    const pathogenesis = text(overview.overallPathogenesis);
    const nextRationale = withoutClauses(rationale, decision.clauses);
    const nextPathogenesis = withoutClauses(pathogenesis, decision.clauses);
    // 删到只剩寥寥几字就不删（依据空了比矛盾更糟）。
    if (rationale && nextRationale.length < 20) return false;
    if (pathogenesis && nextPathogenesis.length < 10) return false;
    if (nextRationale === rationale && nextPathogenesis === pathogenesis) return false;
    overview.tcmDiagnosticRationale = nextRationale;
    overview.overallPathogenesis = nextPathogenesis;
    return true;
  }
  return false;
}

/**
 * 中医半返回后的收口：兼证栏为空、而辨证依据或病机写了兼夹病机时，补兼证或删说法。其余情况与任何失败都原样返回。
 */
export async function reconcileSecondarySyndromes(
  tcmContent: string,
  context: { recordText: string },
  signal?: AbortSignal,
): Promise<string> {
  if (!enabled()) return tcmContent;
  let root: Json | undefined;
  try { root = record(JSON.parse(tcmContent)); } catch { return tcmContent; }
  const overview = record(root?.overview);
  if (!root || !overview) return tcmContent;
  const secondary = Array.isArray(overview.secondarySyndromes) ? overview.secondarySyndromes.filter((item) => text(item)) : [];
  const primarySyndrome = text(overview.primarySyndrome);
  const rationale = text(overview.tcmDiagnosticRationale);
  const pathogenesis = text(overview.overallPathogenesis);
  if (!primarySyndrome) return tcmContent;
  const textbookRow = textbookRowForSyndrome(text(overview.tcmDiseaseName), primarySyndrome);
  const primaryTerms = primaryManifestationTerms(textbookRow);
  // 模型自己写进兼证栏的：先撤结构上不成立的（寒热相反、主证已包含，secondaryStructurallyInvalid），再按辨证要点逐个核
  //（evaluateCriteriaMatches），不够数的撤下（连同只为它写的治法与「兼X」字样）。
  if (secondary.length > 0) {
    let structural = 0;
    const structuralReasons: string[] = [];
    for (const name of secondary) {
      const reason = secondaryStructurallyInvalid(primarySyndrome, text(name), `${rationale}${pathogenesis}`);
      if (reason && withdrawSecondarySyndrome(root, text(name), textbookRow?.therapy || "")) {
        structural += 1;
        structuralReasons.push(reason);
      }
    }
    if (structural > 0) console.info("[tcm-cdss:telemetry] m03_secondary_structural", { withdrawn: structural, reasons: structuralReasons });
    const remainingSecondary = Array.isArray(overview.secondarySyndromes) ? overview.secondarySyndromes.filter((item) => text(item)) : [];
    if (remainingSecondary.length === 0 || !criteriaCheckEnabled()) return structural > 0 ? JSON.stringify(root) : tcmContent;
    const verdicts = await Promise.all(remainingSecondary.map((name) => verifySecondaryByCriteria(text(name), { recordText: context.recordText, primaryTerms }, signal)));
    let withdrawn = structural;
    remainingSecondary.forEach((name, index) => {
      if (verdicts[index].verdict === "fail" && withdrawSecondarySyndrome(root!, text(name), textbookRow?.therapy || "")) withdrawn += 1;
    });
    console.info("[tcm-cdss:telemetry] m03_secondary_criteria", {
      source: "model", candidates: secondary.length, withdrawn,
      verdicts: verdicts.map((item) => `${item.entry || "?"}:${item.verdict}:${item.specific}/${item.category}/${item.distinct}`),
    });
    return withdrawn > 0 ? JSON.stringify(root) : tcmContent;
  }
  // 自称兼夹的分句（「为X之兼象」「心脾同病」）也算；只用病机词解释某个伴随表现的分句（「纳差便溏为脾运不健」）默认不算——
  // 2026-10-19 离线量：宽判据在验收主集新触发 157 例、52 例补了兼证，其中有甲方标准病历 4（肝气犯胃证补成兼肝郁脾虚证，
  // 甲方标准答案无兼证，10/13 起的口径是伴随症状进加减、不进主方）。CDSS_M03_SECONDARY_BROAD_TRIGGER=all 打开宽判据，=false 只留兼/夹说法。
  const trigger = broadTrigger();
  const claims = [...new Set([
    ...secondaryPatternClaims(rationale, pathogenesis),
    ...(trigger === "off" ? [] : mechanismClaimsUncoveredBy(primarySyndrome, rationale, pathogenesis)
      .filter((clause) => trigger === "all" || declaresSecondaryMechanism(clause))),
  ])].slice(0, 6);
  const method = text(record(root.therapy)?.overallMethod);
  // 第二条路的闸门：主证对得上教材证型、且病历对它的吻合度达到 GROUP_CHECK_FIT_CEILING 时不另找第二组；对不上教材行时不设闸。
  // 未定主证（unresolved）不找。
  const fit = textbookRow ? textbookPatternFit(textbookRow, context.recordText) : undefined;
  const groupCheck = groupCheckEnabled() && text(overview.primarySyndromeResolution) !== "unresolved" &&
    (fit === undefined || fit < GROUP_CHECK_FIT_CEILING);
  if (claims.length === 0 && !groupCheck) return tcmContent;
  // 两条路并行（找组与依据里的兼夹说法核对各发一次小任务，互不等待）；第一条路补兼证优先，其次第二条路，最后才是第一条路的「删说法」。
  const [claimDecision, groupDecision] = await Promise.all([
    claims.length > 0
      ? decideSecondaryConsistency({ recordText: context.recordText, primarySyndrome, rationale, pathogenesis, method, claims }, signal)
      : Promise.resolve(undefined),
    groupCheck
      ? decideIndependentGroup({ recordText: context.recordText, primarySyndrome, method, textbookRow, editableText: `${rationale}\n${pathogenesis}` }, signal)
      : Promise.resolve(undefined),
  ]);
  let decision: SecondaryConsistencyDecision | undefined = claimDecision?.decision === "add" ? claimDecision : groupDecision || claimDecision;
  const structural = structurallyAdmissibleSecondaryDecision(decision, claimDecision, { primarySyndrome, rationale, pathogenesis, claims });
  decision = structural.decision;
  const structurallyInvalidAddition = structural.rejected;
  // 立之前按辨证要点核一遍（两条路同一判据）。不够数：依据里自称兼夹的那几句删掉（第一条路原本的「删说法」），否则不动。
  let criteria: CriteriaVerdict | undefined;
  if (decision?.decision === "add" && criteriaCheckEnabled()) {
    criteria = await verifySecondaryByCriteria(decision.secondarySyndrome, { recordText: context.recordText, primaryTerms }, signal);
    if (criteria.verdict === "fail") {
      const removable = claims.filter((clause) => secondaryPatternClaims(clause).length > 0 || declaresSecondaryMechanism(clause));
      decision = claimDecision?.decision === "remove" ? claimDecision : removable.length > 0 ? { decision: "remove", clauses: removable } : undefined;
    }
  }
  const applied = decision ? applySecondaryConsistencyDecision(root, decision) : false;
  console.info("[tcm-cdss:telemetry] m03_secondary_consistency", {
    claims: claims.length,
    decision: decision?.decision || "unavailable",
    applied,
    ...(groupCheck ? { group: groupDecision ? "add" : "none", fit: fit === undefined ? null : Math.round(fit * 100) / 100 } : {}),
    ...(criteria ? { criteria: `${criteria.entry || "?"}:${criteria.verdict}:${criteria.specific}/${criteria.category}/${criteria.distinct}` } : {}),
    ...(structurallyInvalidAddition ? { structural: structurallyInvalidAddition } : {}),
  });
  return applied ? JSON.stringify(root) : tcmContent;
}
