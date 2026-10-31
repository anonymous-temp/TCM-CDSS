import "server-only";

import { crossModelJsonTask } from "./cross-model-small-task.server";
import { herbClaimReferenceText } from "./m04-formula-analysis-claim-check.server";

/**
 * 模型自拟的加减行：这味药对这个症吗（2026-10-31，甲方 10.29 测评：「若头晕目眩较甚加白芍」不符合临床用药逻辑）。
 * 教材条目不走这里，规则也判不了（离线试过按功效字面比对，563 张处方错删居多）。只问两个不同厂商的模型一个窄问题，给每行的条件、药名、
 * 这味药的参考功效（知识库 + 《中药学》）和已定证型；两边都说不对症才去掉这一行。超时、失败按原样交付。开关：CDSS_M04_MODIFICATION_FIT=false。
 */
const TIMEOUT_MS = 4_000;
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

export function modificationFitEnabled(): boolean {
  return process.env.CDSS_M04_MODIFICATION_FIT !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const SYSTEM = [
  "你是中医主治医师，核对随证加减的用药。每行是「若某症，加某药」。只判这一件事：按这味药的功效和本证病机，临床上会不会为这个症加这味药。",
  "功效对得上、或是常见用法的都算对症；只有这味药的主要功效管不到这个症时才算不对症。不评价剂量，不因为有更好的选择就判不对症。",
  "只输出 JSON：{\"misfit\":[行号]}，全部对症时为空数组。",
].join("\n");

function parse(content: unknown): number[] | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const list = record(JSON.parse(content))?.misfit;
    return Array.isArray(list) ? list.filter((item): item is number => Number.isInteger(item)) : undefined;
  } catch {
    return undefined;
  }
}

const isModelWritten = (row: Json) => record(row.evidence)?.evidenceLevel !== "kb_entry" && row.action === "加";

/** 交付前去掉两边都判不对症的模型自拟行；教材条目不动。 */
export async function dropMisfitModifications(content: string, signal?: AbortSignal): Promise<string> {
  if (!modificationFitEnabled()) return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content.slice(start + START_MARKER.length, end).trim())); } catch { return content; }
  const formula = record(root?.formula);
  const overview = record(root?.overview);
  const rows = Array.isArray(formula?.modifications) ? formula.modifications.map(record).filter((row): row is Json => Boolean(row)) : [];
  const checked = rows.flatMap((row, index) => (isModelWritten(row) ? [{ index, row }] : []));
  if (!root || !formula || checked.length === 0) return content;
  const pair = await crossModelJsonTask("m04_modification_fit", "prescribe", [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify({
      syndrome: text(overview?.primarySyndrome),
      method: text(record(root.therapy)?.overallMethod),
      rows: checked.map(({ index, row }) => ({ line: index, condition: text(row.trigger), herb: text(row.herbName), reference: herbClaimReferenceText(text(row.herbName)).slice(0, 200) })),
    }) },
  ], { maxTokens: 120, timeoutMs: TIMEOUT_MS }, parse, signal);
  if (!pair) return content;
  const bad = new Set(pair[0].filter((line) => pair[1].includes(line) && checked.some((item) => item.index === line)));
  if (bad.size === 0) return content;
  formula.modifications = rows.filter((_, index) => !bad.has(index));
  console.info("[tcm-cdss:telemetry] m04_modification_fit", { dropped: bad.size, checked: checked.length });
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
