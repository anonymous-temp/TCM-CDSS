import { readFileSync } from "node:fs";
import formulaAliasesJson from "../data/tcm-formula-aliases.json" with { type: "json" };

export type ClassicFormulaEvidence = {
  evidenceId: string;
  citation: string;
  anchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
  clauseNumber?: number;
  excerpt: string;
  tier: "canon" | "common" | "experience";
};

type ClassicEvidenceRecord = {
  evidenceId: string;
  sourceName?: string;
  module?: string;
  anchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
  clauseNumber?: number;
  text: string;
  formulas: string[];
  citation: string;
  tier: "canon" | "common" | "experience";
  safetyClass: "standard" | "restricted" | "quarantine";
};

const aliasToCanonical = new Map<string, string>();
for (const entry of formulaAliasesJson.entries) {
  aliasToCanonical.set(entry.canonical, entry.canonical);
  for (const alias of entry.aliases) aliasToCanonical.set(alias, entry.canonical);
}

function normalizedFormulaName(value: string): string {
  const compact = value
    .replace(/[（(]?\s*《[^》]+》\s*[）)]?/g, "")
    .replace(/(?:加减|化裁|加味)方?$/g, "")
    .replace(/\s+/g, "")
    .trim();
  return aliasToCanonical.get(compact) || compact;
}

const CLASSIC_RUNTIME_DANGEROUS_CONTENT =
  /童子尿|人尿|生硫磺|服硫磺|拒绝.{0,12}(?:急诊|手术|化疗|放疗)|自行.{0,8}(?:服|用|煎|灸|针)|生附子.{0,30}(?:使用|用到|剂量|钱|克|煎|服)/i;
const CLASSIC_RUNTIME_DOSE_OR_OPERATION =
  /(?:(?:\d+(?:\.\d+)?|[〇零一二三四五六七八九十百半]+)\s*(?:克|g|钱|两|升|合|铢)|每日.{0,8}(?:服|次)|(?:先煎|后下|久煎|水煎服)|(?:针|刺|灸).{0,16}(?:穴|分钟|寸))/gi;

function sanitizeClassicRuntimeExcerpt(value: string): string {
  return value
    .replace(CLASSIC_RUNTIME_DOSE_OR_OPERATION, "[具体剂量或操作已隔离]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

let fullClassicEvidenceRecords: ClassicEvidenceRecord[] | undefined;

function loadFullClassicEvidenceRecords(): ClassicEvidenceRecord[] {
  if (fullClassicEvidenceRecords) return fullClassicEvidenceRecords;
  const raw = readFileSync(new URL("../data/tcm-classic-text-evidence.jsonl", import.meta.url), "utf8");
  fullClassicEvidenceRecords = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ClassicEvidenceRecord);
  return fullClassicEvidenceRecords;
}

/** T15 runtime lookup scans every safe/restricted source record; no compact sample index is used. */
export function classicEvidenceForFormulaNames(formulaNames: string[]): ClassicFormulaEvidence[] {
  const names = new Set(formulaNames.map(normalizedFormulaName).filter(Boolean));
  if (names.size === 0) return [];
  const records = loadFullClassicEvidenceRecords();
  const anchorRank = { tiaowen: 0, chapter_paragraph: 1, page_paragraph: 2 } as const;
  const tierRank = { canon: 0, common: 1, experience: 2 } as const;
  return records
    .filter((record) =>
      record.safetyClass === "standard" &&
      record.formulas.some((formula) => names.has(normalizedFormulaName(formula))) &&
      !CLASSIC_RUNTIME_DANGEROUS_CONTENT.test(record.text))
    .sort((left, right) =>
      tierRank[left.tier] - tierRank[right.tier] ||
      anchorRank[left.anchorLevel] - anchorRank[right.anchorLevel] ||
      left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, 12)
    .map((record) => ({
      evidenceId: record.evidenceId,
      citation: record.citation,
      anchorLevel: record.anchorLevel,
      ...(record.clauseNumber ? { clauseNumber: record.clauseNumber } : {}),
      excerpt: sanitizeClassicRuntimeExcerpt(record.text),
      tier: record.tier,
    }));
}
