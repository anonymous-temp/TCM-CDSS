import crosswalkJson from "../data/tcm-western-disease-crosswalk.json" with { type: "json" };
import abbreviationsJson from "../data/western-diagnosis-abbreviations.source.json" with { type: "json" };
import { governedTcmDiseaseCode, resolveTcmDiseaseName } from "./clinical-terminology";

/**
 * 中医病名鉴别栏只收中医病名（2026-09-29，甲方 9.24/9.27 测评 1.1：风寒感冒例的中医鉴别写了「流感」）。
 *
 * 合同侧此前只拦「把证型写进病名鉴别」，词表外写法一律放行，西医病名就这样原样出去了。
 * 这里对每一条病名鉴别：
 *   · 是受治理中医病名（GB/T 15657 正名/别名/临床扩展）→ 原样保留；
 *   · 不是 → 先把西医简称还原成全称，再按教材原句对照表（tcm-western-disease-crosswalk.json）
 *     归一到中医病名：流行性感冒 → 时行感冒。多个候选时取与当前病名不同、且更具体（编码更深）的那个；
 *   · 归一不了 → 这一条丢掉（不能让西医病名冒充中医病名鉴别）。
 */

type CrosswalkRow = { westernName: string; tcmDisease: string };

const CROSSWALK = new Map<string, string[]>();
for (const row of (crosswalkJson as { entries: CrosswalkRow[] }).entries) {
  const list = CROSSWALK.get(row.westernName) || [];
  if (!list.includes(row.tcmDisease)) list.push(row.tcmDisease);
  CROSSWALK.set(row.westernName, list);
}
const ABBREVIATIONS = new Map((abbreviationsJson as { entries: Array<{ abbreviation: string; fullName: string }> }).entries
  .map((entry) => [entry.abbreviation, entry.fullName] as const));

function governedCanonical(value: string): string {
  const resolved = resolveTcmDiseaseName(value);
  return resolved && resolved.status !== "unverified" && !resolved.temporary ? resolved.canonical : "";
}

export type TcmDiseaseDifferentialNameResolution =
  | { action: "keep"; name: string }
  | { action: "rename"; name: string; from: string }
  | { action: "drop"; from: string };

export function resolveTcmDiseaseDifferentialName(rawName: string, currentDisease = ""): TcmDiseaseDifferentialNameResolution {
  const name = rawName.trim();
  if (!name) return { action: "drop", from: rawName };
  const currentCanonical = governedCanonical(currentDisease);
  const direct = governedCanonical(name);
  if (direct) {
    // 与当前病名是同一病名（含别名，如「伤风」对「感冒」之外的同一条目）不构成鉴别。
    if (currentCanonical && direct === currentCanonical) return { action: "drop", from: name };
    // GB/T 15657 把「带状疱疹」「荨麻疹」「湿疹」「偏头痛」收为别名：鉴别栏写正名（蛇串疮/瘾疹/湿疮/偏头风）。
    const compact = (value: string) => value.replace(/\s+/g, "").replace(/病$/, "");
    return compact(direct) === compact(name) ? { action: "keep", name } : { action: "rename", name: direct, from: name };
  }
  const stripped = name.replace(/（[^（）]*）|\([^()]*\)/g, "").replace(/(?:可能|待排|待排除|待鉴别)$/, "").trim();
  const expanded = [name, stripped, ABBREVIATIONS.get(stripped) || "", ABBREVIATIONS.get(name) || ""].filter(Boolean);
  // 教材写「慢性荨麻疹」「急性胃炎」，模型常写不带病程前缀的「荨麻疹」「胃炎」：前缀不改变归属。
  const withCourse = [...CROSSWALK.keys()].filter((key) =>
    expanded.some((value) => key !== value && key.replace(/^(?:急慢性|急性|慢性)/, "") === value));
  const keys = [...new Set([...expanded, ...withCourse])];
  const current = governedCanonical(currentDisease);
  const currentCode = current ? governedTcmDiseaseCode(current) : "";
  const candidates = [...new Set(keys.flatMap((key) => CROSSWALK.get(key) || []).map(governedCanonical).filter(Boolean))]
    .filter((candidate) => candidate !== current);
  if (candidates.length === 0) return { action: "drop", from: name };
  // 更具体者优先：当前病名的下位病名 > 编码更深者 > 表中先出现者。
  const ranked = candidates
    .map((candidate, index) => {
      const code = governedTcmDiseaseCode(candidate);
      const underCurrent = Boolean(currentCode && code.startsWith(`${currentCode}.`));
      return { candidate, index, underCurrent, depth: code ? code.split(".").length : 0 };
    })
    .sort((left, right) => Number(right.underCurrent) - Number(left.underCurrent) ||
      right.depth - left.depth || left.index - right.index);
  return { action: "rename", name: ranked[0].candidate, from: name };
}

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/** M03 载荷投影：逐条归一 overview.tcmDiseaseDifferentials[].diseaseName，归一不了的条目丢弃。 */
export function normalizeM03TcmDiseaseDifferentialNames(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const overview = reasoning.overview && typeof reasoning.overview === "object" && !Array.isArray(reasoning.overview)
      ? reasoning.overview as Record<string, unknown>
      : undefined;
    const rows = Array.isArray(overview?.tcmDiseaseDifferentials) ? overview.tcmDiseaseDifferentials : [];
    if (!overview || rows.length === 0) return content;
    const currentDisease = typeof overview.tcmDiseaseName === "string" ? overview.tcmDiseaseName : "";
    let changed = false;
    const seen = new Set<string>();
    const kept = rows.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [raw];
      const row = raw as Record<string, unknown>;
      const name = typeof row.diseaseName === "string" ? row.diseaseName : "";
      const resolution = resolveTcmDiseaseDifferentialName(name, currentDisease);
      if (resolution.action === "drop") {
        changed = true;
        console.info("[tcm-cdss:telemetry] tcm_disease_differential_normalized", { action: "drop" });
        return [];
      }
      const finalName = resolution.name;
      if (seen.has(finalName)) {
        changed = true;
        return [];
      }
      seen.add(finalName);
      if (resolution.action === "rename") {
        changed = true;
        console.info("[tcm-cdss:telemetry] tcm_disease_differential_normalized", { action: "rename" });
        const replaceName = (value: unknown) => typeof value === "string" ? value.split(resolution.from).join(finalName) : value;
        return [{ ...row, diseaseName: finalName, reason: replaceName(row.reason), distinguishingPoints: replaceName(row.distinguishingPoints) }];
      }
      return [row];
    });
    if (!changed) return content;
    overview.tcmDiseaseDifferentials = kept;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}
