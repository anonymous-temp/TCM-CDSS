import { scrubInternalVocabularyFromVisibleText } from "./diagnosis-visible-summary";
import { completedTopLevelKeys, completedTopLevelValueJson } from "./diagnosis-stream-modules";
import type { M03DraftModule, StreamModuleDraftFrame } from "./diagnosis-stream-protocol";

const WATERMARK = "> 生成中 · 未定稿；最终结论以本阶段完成后的签名报告为准。";

const MODULE_BY_KEY = {
  westernDiagnosis: "m03.western",
  overview: "m03.syndrome",
  pathogenesis: "m03.pathogenesis",
  therapy: "m03.therapy",
} as const satisfies Record<string, M03DraftModule>;

const FORBIDDEN_DRAFT_CONTENT = /(?:\d+(?:\.\d+)?\s*(?:mg|g|ml|mL|克|毫克|毫升|片|粒|丸|袋|支)|\b(?:bid|tid|qid|qd)\b|DOI|PMID|https?:\/\/|参考文献|指南引用|审方结论|安全总评|红旗结论|contractSignature|attestation|reasonCode)/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, max = 600): string {
  return typeof value === "string"
    ? value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function strings(value: unknown, maxItems = 8, maxChars = 600): string[] {
  return Array.isArray(value)
    ? value.map((item) => text(item, maxChars)).filter(Boolean).slice(0, maxItems)
    : [];
}

function bulletList(values: readonly string[]): string[] {
  return values.map((value) => `- ${value}`);
}

function renderWestern(value: Record<string, unknown>): string | undefined {
  const primary = record(value.primary);
  const name = text(primary?.name, 120);
  const facts = strings(primary?.supportingFacts, 8, 300);
  if (!name || facts.length === 0) return undefined;
  const limitations = strings(primary?.limitations, 4, 300);
  const differentials = (Array.isArray(value.differentials) ? value.differentials : [])
    .flatMap((item) => {
      const row = record(item);
      const differentialName = text(row?.name, 120);
      const reason = text(row?.reason, 300);
      const distinguishing = text(row?.distinguishingPoints, 300);
      if (!differentialName || (!reason && !distinguishing)) return [];
      return [`**${differentialName}**：${[reason, distinguishing].filter(Boolean).join("；")}`];
    })
    .slice(0, 3);
  return [
    WATERMARK,
    "",
    "## 西医判断",
    `**诊断倾向**：${name}`,
    "",
    "**当前支持依据**",
    ...bulletList(facts),
    ...(limitations.length > 0 ? ["", "**仍需补充**", ...bulletList(limitations)] : []),
    ...(differentials.length > 0 ? ["", "**鉴别方向**", ...bulletList(differentials)] : []),
  ].join("\n");
}

function renderSyndrome(value: Record<string, unknown>): string | undefined {
  const syndrome = text(value.primarySyndrome, 120);
  const basis = strings(value.primarySyndromeBasis, 8, 300);
  if (!syndrome || basis.length === 0) return undefined;
  return [
    WATERMARK,
    "",
    "## 中医辨证",
    `**证型**：${syndrome}`,
    "",
    "**辨证依据**",
    ...bulletList(basis),
  ].join("\n");
}

function renderPathogenesis(value: Record<string, unknown>): string | undefined {
  const nodes = (Array.isArray(value.chain) ? value.chain : [])
    .flatMap((item, index) => {
      const row = record(item);
      const patientFact = text(row?.patientFact, 300);
      const syndromeEvidence = text(row?.syndromeEvidence, 300);
      const pathogenesis = text(row?.pathogenesis, 400);
      const therapyDirection = text(row?.therapyDirection, 300);
      if (!patientFact || !syndromeEvidence || !pathogenesis || !therapyDirection) return [];
      return [[
        `### 子病机 ${index + 1}`,
        `**患者事实**：${patientFact}`,
        `**辨证关键依据**：${syndromeEvidence}`,
        `**病机演变**：${pathogenesis}`,
        `**对应治法**：${therapyDirection}`,
      ].join("\n")];
    })
    .slice(0, 6);
  if (nodes.length === 0) return undefined;
  const summary = text(value.summary, 500);
  return [
    WATERMARK,
    "",
    "## 病机链",
    ...(summary ? [`**总体病机**：${summary}`, ""] : []),
    ...nodes.flatMap((node, index) => index === 0 ? [node] : ["", node]),
  ].join("\n");
}

function renderTherapy(value: Record<string, unknown>): string | undefined {
  const principle = text(value.overallPrinciple, 400);
  const method = text(value.overallMethod, 400);
  const subTherapies = (Array.isArray(value.subTherapies) ? value.subTherapies : [])
    .flatMap((item) => {
      const row = record(item);
      const target = text(row?.targetPathogenesis, 300);
      const therapy = text(row?.therapy, 300);
      return target && therapy ? [`${target}：${therapy}`] : [];
    })
    .slice(0, 6);
  if (!principle && !method) return undefined;
  return [
    WATERMARK,
    "",
    "## 治则治法",
    ...(principle ? [`**治则**：${principle}`] : []),
    ...(method ? [`**治法**：${method}`] : []),
    ...(subTherapies.length > 0 ? ["", "**分病机治法**", ...bulletList(subTherapies)] : []),
  ].join("\n");
}

const RENDERER_BY_KEY: Record<keyof typeof MODULE_BY_KEY, (value: Record<string, unknown>) => string | undefined> = {
  westernDiagnosis: renderWestern,
  overview: renderSyndrome,
  pathogenesis: renderPathogenesis,
  therapy: renderTherapy,
};

export function m03ModuleDraftFrame(partial: string, key: string): StreamModuleDraftFrame | undefined {
  if (!(key in MODULE_BY_KEY)) return undefined;
  const valueJson = completedTopLevelValueJson(partial, key);
  if (!valueJson) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    return undefined;
  }
  const parsed = record(value);
  if (!parsed) return undefined;
  const typedKey = key as keyof typeof MODULE_BY_KEY;
  const projected = RENDERER_BY_KEY[typedKey](parsed);
  if (!projected) return undefined;
  const content = scrubInternalVocabularyFromVisibleText(projected).trim();
  if (!content || FORBIDDEN_DRAFT_CONTENT.test(content)) return undefined;
  return {
    type: "module_draft",
    module: MODULE_BY_KEY[typedKey],
    revision: 1,
    content,
  };
}

export function newM03ModuleDraftFrames(partial: string, emitted: Set<string>): StreamModuleDraftFrame[] {
  const frames: StreamModuleDraftFrame[] = [];
  for (const key of completedTopLevelKeys(partial)) {
    if (!(key in MODULE_BY_KEY) || emitted.has(key)) continue;
    const frame = m03ModuleDraftFrame(partial, key);
    if (!frame) continue;
    emitted.add(key);
    frames.push(frame);
  }
  return frames;
}
