import "server-only";

import { affirmedClinicalSourceClauses } from "./clinical-polarity";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { claimsSecondaryPattern, declaresSecondaryMechanism, deniesSeparateSecondaryPattern, mechanismClaimsUncoveredBy, withoutRedundantTherapyPhrases } from "./tcm-therapy-phrasing";

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
  if (secondary.length > 0) return tcmContent;
  const primarySyndrome = text(overview.primarySyndrome);
  const rationale = text(overview.tcmDiagnosticRationale);
  const pathogenesis = text(overview.overallPathogenesis);
  if (!primarySyndrome) return tcmContent;
  // 自称兼夹的分句（「为X之兼象」「心脾同病」）也算；只用病机词解释某个伴随表现的分句（「纳差便溏为脾运不健」）默认不算——
  // 2026-10-19 离线量：宽判据在验收主集新触发 157 例、52 例补了兼证，其中有甲方标准病历 4（肝气犯胃证补成兼肝郁脾虚证，
  // 甲方标准答案无兼证，10/13 起的口径是伴随症状进加减、不进主方）。CDSS_M03_SECONDARY_BROAD_TRIGGER=all 打开宽判据，=false 只留兼/夹说法。
  const trigger = broadTrigger();
  const claims = [...new Set([
    ...secondaryPatternClaims(rationale, pathogenesis),
    ...(trigger === "off" ? [] : mechanismClaimsUncoveredBy(primarySyndrome, rationale, pathogenesis)
      .filter((clause) => trigger === "all" || declaresSecondaryMechanism(clause))),
  ])].slice(0, 6);
  if (claims.length === 0) return tcmContent;
  const decision = await decideSecondaryConsistency({
    recordText: context.recordText,
    primarySyndrome,
    rationale,
    pathogenesis,
    method: text(record(root.therapy)?.overallMethod),
    claims,
  }, signal);
  const applied = decision ? applySecondaryConsistencyDecision(root, decision) : false;
  console.info("[tcm-cdss:telemetry] m03_secondary_consistency", { claims: claims.length, decision: decision?.decision || "unavailable", applied });
  return applied ? JSON.stringify(root) : tcmContent;
}
