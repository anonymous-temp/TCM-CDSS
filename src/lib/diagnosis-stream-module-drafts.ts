import { completedTopLevelKeys, completedTopLevelValueJson } from "./diagnosis-stream-modules";
import type { M03DraftModule, StreamModuleDraftFrame } from "./diagnosis-stream-protocol";

const WATERMARK = "> 生成中 · 未定稿；最终结论以本阶段完成后的签名报告为准。";

const MODULE_BY_KEY = {
  westernDiagnosis: "m03.western",
  overview: "m03.syndrome",
  pathogenesis: "m03.pathogenesis",
  therapy: "m03.therapy",
} as const satisfies Record<string, M03DraftModule>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function presentText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function presentTextList(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => presentText(item));
}

const MODULE_STATUS_BY_KEY: Record<keyof typeof MODULE_BY_KEY, { heading: string; status: string }> = {
  westernDiagnosis: { heading: "西医判断", status: "西医判断已生成，正在校验。" },
  overview: { heading: "中医辨病辨证", status: "中医辨病辨证已生成，正在校验。" },
  pathogenesis: { heading: "病机分析", status: "病机分析已生成，正在校验。" },
  therapy: { heading: "治则治法", status: "治则治法已生成，正在校验。" },
};

function moduleContractComplete(key: keyof typeof MODULE_BY_KEY, value: Record<string, unknown>): boolean {
  if (key === "westernDiagnosis") {
    const primary = record(value.primary);
    return Boolean(primary && presentText(primary.name) && presentTextList(primary.supportingFacts));
  }
  if (key === "overview") {
    return presentText(value.primarySyndrome) && presentTextList(value.primarySyndromeBasis);
  }
  if (key === "pathogenesis") {
    return Array.isArray(value.chain) && value.chain.some((item) => {
      const node = record(item);
      return Boolean(node && [node.patientFact, node.syndromeEvidence, node.pathogenesis, node.therapyDirection]
        .every((field) => presentText(field)));
    });
  }
  return presentText(value.overallPrinciple) || presentText(value.overallMethod);
}

function fixedModuleStatus(key: keyof typeof MODULE_BY_KEY): string {
  const moduleStatus = MODULE_STATUS_BY_KEY[key];
  return [WATERMARK, "", `## ${moduleStatus.heading}`, moduleStatus.status].join("\n");
}

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
  if (!moduleContractComplete(typedKey, parsed)) return undefined;
  return {
    type: "module_draft",
    module: MODULE_BY_KEY[typedKey],
    revision: 1,
    content: fixedModuleStatus(typedKey),
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
