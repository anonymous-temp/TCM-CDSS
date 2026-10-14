import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { resolveTcmDiseaseDifferentialName } from "./tcm-disease-differential-normalization";
import { textbookDifferentialsForDisease } from "./tcm-textbook-syndromes";

/**
 * 中医病名级鉴别缺失时，只补写这一项（2026-10-14）。
 *
 * 中医鉴别诊断每例必出（甲方 10.12 测评 2.3）。模型没写病名级鉴别、或写的病名都不是中医病名被归一丢掉时，上一版在交付面用教材
 *【鉴别诊断】原文补齐：区分要点一栏是教材对那个病的整段定义（「白浊是泌尿生殖系统的化脓性感染，临床特征为…」），典型表现、
 * 核实两栏为空——独立评审：照搬教材定义，没有指出本例据以区分的那一点。
 *
 * 做法是 10.12 整改方案原定的「为空时只重写这一项」：鉴别对象仍取教材对该病列出的病证（闭集），由小任务模型对着本例病历写
 * 每一条的区分要点；教材原文作为它的知识来源，不再直接贴给医生。服务端只核对：病名在闭集里、区分要点确实在说本例。
 *
 * 边界：
 *  · 只在中医半没有任何可保留的病名级鉴别时调用（实测约 6% 的病例），其余病例不多一次调用；
 *  · 只写 overview.tcmDiseaseDifferentials 这一项，不动病名、证候与其余字段；之后照常走既有的归一、接地与签名；
 *  · 超时、未配置、输出非法都原样返回——交付面的教材原文兜底仍在，保证这一栏不为空。
 * 开关：CDSS_TCM_DIFFERENTIAL_AUTHORING=false 关闭。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.TCM_DIFFERENTIAL_AUTHORING_TIMEOUT_MS || 6_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 12_000 ? Math.round(value) : 6_000;
})();
const MAX_RECORD_CHARS = 1_800;
const MAX_ENTRIES = 2;

function enabled(): boolean {
  return process.env.CDSS_TCM_DIFFERENTIAL_AUTHORING !== "false";
}

export type AuthoredTcmDiseaseDifferential = {
  diseaseName: string;
  reason: string;
  typicalManifestation: string;
  distinguishingPoints: string;
  nextCheck: string | null;
};

const text = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/g, "") : "";

/** 模型输出 → 可用的鉴别条目：病名逐字在闭集里，区分要点以「本例」起头、确实在说本例，各栏长度合规。 */
export function parseAuthoredTcmDiseaseDifferentials(content: unknown, allowedNames: readonly string[]): AuthoredTcmDiseaseDifferential[] {
  if (typeof content !== "string" || !content.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }
  const list = parsed && typeof parsed === "object" ? (parsed as { differentials?: unknown }).differentials : undefined;
  if (!Array.isArray(list)) return [];
  const allowed = new Set(allowedNames);
  const out: AuthoredTcmDiseaseDifferential[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const diseaseName = text(item.diseaseName);
    const distinguishingPoints = text(item.distinguishingPoints);
    const typicalManifestation = text(item.typicalManifestation);
    const reason = text(item.reason);
    const nextCheck = text(item.nextCheck);
    if (!allowed.has(diseaseName) || out.some((entry) => entry.diseaseName === diseaseName)) continue;
    if (!/^本例/.test(distinguishingPoints) || distinguishingPoints.length < 8 || distinguishingPoints.length > 70) continue;
    if (typicalManifestation.length < 4 || typicalManifestation.length > 60) continue;
    if (reason.length < 2 || reason.length > 30) continue;
    if (/教材|原文|定义为/.test(`${distinguishingPoints}${reason}`)) continue;
    out.push({ diseaseName, reason, typicalManifestation, distinguishingPoints, nextCheck: nextCheck && nextCheck.length <= 30 ? nextCheck : null });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

/** 中医半里现有的病名级鉴别是否至少有一条能保留（病名归一得了）。 */
function hasRetainableDifferential(overview: Json, diseaseName: string): boolean {
  const rows = Array.isArray(overview.tcmDiseaseDifferentials) ? overview.tcmDiseaseDifferentials : [];
  return rows.some((row) => {
    const name = text(record(row)?.diseaseName);
    return Boolean(name) && resolveTcmDiseaseDifferentialName(name, diseaseName).action !== "drop";
  });
}

export async function authorTcmDiseaseDifferentials(
  input: { recordText: string; diseaseName: string; syndrome: string; candidates: ReadonlyArray<{ name: string; text: string }> },
  signal?: AbortSignal,
): Promise<AuthoredTcmDiseaseDifferential[]> {
  if (!enabled() || signal?.aborted || input.candidates.length === 0) return [];
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return [];
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  if (!recordText.trim()) return [];
  const names = input.candidates.map((item) => item.name);
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是中医教材鉴别要点的整理者，不负责诊断，也不改变已定的病名和证候。",
        "任务：本例已定中医病名，教材列出了需要与它鉴别的病证及教材原文。请对着本例病历，为每个鉴别病证写出本例据以区分的要点。",
        "规则：",
        "1. diseaseName 只能逐字取自给定的鉴别病证名，不得增加别的病名。",
        "2. typicalManifestation：该鉴别病证的典型表现，依据教材原文概括，不超过30字。",
        "3. distinguishingPoints：本例与它的区别，必须以“本例”开头，只引用病历已记录的表现；病历没有提到的表现写“未诉…”，不要写“无…”；不超过40字。不要复述教材对该病的定义。",
        "4. reason：为什么需要与它鉴别（两者相近之处），不超过15字。",
        "5. nextCheck：必要时需要核实的一项问诊、查体或检查，不超过15字；没有就写空字符串。",
        "只输出 JSON：{\"differentials\":[{\"diseaseName\":\"…\",\"reason\":\"…\",\"typicalManifestation\":\"…\",\"distinguishingPoints\":\"本例…\",\"nextCheck\":\"…\"}]}",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        tcmDisease: input.diseaseName,
        syndrome: input.syndrome || null,
        record: recordText,
        textbookDifferentials: input.candidates.map((item) => ({ diseaseName: item.name, textbook: item.text.slice(0, 260) })),
      }),
    },
  ];
  return memoizedSmallTask<AuthoredTcmDiseaseDifferential[]>("tcm_disease_differential_authoring", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "tcm_disease_differential_authoring", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 420,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      const value = parseAuthoredTcmDiseaseDifferentials(content, names);
      return { value, cacheable: value.length > 0 };
    } catch {
      return { value: [], cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, [], signal);
}

/**
 * 中医半返回后的收口：没有可保留的病名级鉴别、而教材对该病列有鉴别病证时，补写这一项。其余情况与任何失败都原样返回。
 */
export async function completeTcmDiseaseDifferentials(
  tcmContent: string,
  context: { recordText: string },
  signal?: AbortSignal,
): Promise<string> {
  if (!enabled()) return tcmContent;
  let root: Json | undefined;
  try { root = record(JSON.parse(tcmContent)); } catch { return tcmContent; }
  const overview = record(root?.overview);
  const diseaseName = text(overview?.tcmDiseaseName);
  if (!root || !overview || !diseaseName) return tcmContent;
  if (hasRetainableDifferential(overview, diseaseName)) return tcmContent;
  // 鉴别对象只取能留在交付结果里的中医病名（教材外科、妇科各节也列西医病名，那些归一时会被丢掉）。
  const candidates = textbookDifferentialsForDisease(diseaseName)
    .filter((item) => resolveTcmDiseaseDifferentialName(item.name, diseaseName).action === "keep")
    .slice(0, MAX_ENTRIES);
  if (candidates.length === 0) return tcmContent;
  const authored = await authorTcmDiseaseDifferentials({
    recordText: context.recordText,
    diseaseName,
    syndrome: text(overview.primarySyndrome),
    candidates,
  }, signal);
  console.info("[tcm-cdss:telemetry] tcm_disease_differential_authoring", { candidates: candidates.length, authored: authored.length });
  if (authored.length === 0) return tcmContent;
  overview.tcmDiseaseDifferentials = authored;
  return JSON.stringify(root);
}
