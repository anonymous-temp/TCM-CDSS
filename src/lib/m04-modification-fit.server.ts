import "server-only";

import { parseConfirmed, proposeTwiceThenVerifyAll } from "./cross-model-small-task.server";
import { herbClaimReferenceText } from "./m04-formula-analysis-claim-check.server";
import { quoteGroundedInText } from "./verbatim-quote";

/**
 * 随证加减每一行与本例对不对得上（2026-10-31 起；第三十三轮扩到教材条目和条件与病历的关系）。
 * 条件与病历相反，规则判不完：舌脉那几个维度之外，便溏对大便干结、口不渴对口渴、痰白对痰黄、多食对食少都要读懂，22 组相反条件字面规则只抓到 6 组；
 * 药对不对症按功效字面比对错删居多（离线 563 张处方）。一个模型逐行列两次判断取并集（教材本证条目只判条件，模型自写的和借别的病的行连药一起判），每条由另一厂商的模型只对被点名的那一行答对错，说对才删。条件相反的一定删；药不对症的只在删后还剩至少两行时删，免得加减一栏被删空。
 * 超时、失败按原样交付。开关：CDSS_M04_MODIFICATION_FIT=false。
 */
const TIMEOUT_MS = 4_000;
const MIN_ROWS_AFTER_FIT = 2;
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

export function modificationFitEnabled(): boolean {
  return process.env.CDSS_M04_MODIFICATION_FIT !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const SYSTEM = [
  "你是中医主治医师，逐行核对随证加减。每行是「若某情况，加某药」，「若」说的是本例现在没有、之后可能出现的变化。",
  "每行写 verdict：",
  "contradicts：这个条件与病历已记录的情况相反，本例在现在的证候下不会这样（病历便溏对“若大便干结”、舌淡脉弱对“若舌红脉数”、口不渴对“若口渴”、多食易饥对“若食少”）。病历没提到的症状不算相反；quote 摘病历逐字原文。",
  "misfit：只在 kind 为 model 的行判。这味药的主要功效管不到这个症，或与本证方向相反（虚寒证单加苦寒药、阴虚证单加温燥药），或这个条件不是本病会出现的变化。不因为有更好的选择就判 misfit。",
  "ok：其余。",
  "只输出 JSON：{\"rows\":[{\"line\":0,\"verdict\":\"ok\",\"quote\":\"\"}]}",
].join("\n");

const VERIFY_SYSTEM = [
  "你是中医主治医师。有人认为下面这条随证加减不该留给本例，理由在 verdict 里（contradicts：条件与病历已记录的情况相反；misfit：这味药管不到这个症或与本证方向相反）。",
  "只判这一条。理由成立答 true。条件只是病历没提到、或者只是另有更好的药，答 false。",
  "只输出 JSON：{\"confirmed\":true} 或 {\"confirmed\":false}",
].join("\n");

type Finding = { line: number; verdict: "contradicts" | "misfit"; quote: string };

function parse(content: unknown): Finding[] | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const list = record(JSON.parse(content))?.rows;
    if (!Array.isArray(list)) return undefined;
    return list.flatMap((entry) => {
      const row = record(entry);
      const verdict = text(row?.verdict);
      return row && Number.isInteger(row.line) && (verdict === "contradicts" || verdict === "misfit")
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
  return Boolean(finding.quote) && quoteGroundedInText(finding.quote, recordText, { minChars: 2 });
}

/** 交付前去掉复核确认不该留的行。 */
export async function dropMisfitModifications(content: string, context: { recordText: string }, signal?: AbortSignal): Promise<string> {
  if (!modificationFitEnabled()) return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content.slice(start + START_MARKER.length, end).trim())); } catch { return content; }
  const formula = record(root?.formula);
  const overview = record(root?.overview);
  const rows = Array.isArray(formula?.modifications) ? formula.modifications.map(record).filter((row): row is Json => Boolean(row)) : [];
  if (!root || !formula || rows.length === 0) return content;
  const syndrome = text(overview?.primarySyndrome);
  const method = text(record(root.therapy)?.overallMethod);
  const disease = text(overview?.tcmDiseaseName);
  const payload = (row: Json, line: number) => ({ line, kind: isModelWritten(row, disease) ? "model" : "textbook", condition: text(row.trigger), herb: text(row.herbName), reference: herbClaimReferenceText(text(row.herbName)).slice(0, 160) });
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
    maxTokens: 40,
    parse: parseConfirmed,
  } : undefined, rows.length, TIMEOUT_MS, signal);
  if (findings.length === 0) return content;
  const contradicted = new Set(findings.filter((finding) => finding.verdict === "contradicts").map((finding) => finding.line));
  const bad = new Set(contradicted);
  for (const finding of findings) {
    if (finding.verdict === "misfit" && rows.length - bad.size > MIN_ROWS_AFTER_FIT) bad.add(finding.line);
  }
  formula.modifications = rows.filter((_, index) => !bad.has(index));
  console.info("[tcm-cdss:telemetry] m04_modification_fit", { dropped: bad.size, checked: rows.length, verdicts: findings.map((finding) => finding.verdict) });
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(root, null, 2)}\n${content.slice(end)}`;
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
