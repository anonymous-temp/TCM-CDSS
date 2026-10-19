import "server-only";

import type { CaseState } from "./diagnosis-types";
import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { REPRODUCTIVE_RECORD_KEYS } from "./followup-conversation";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { textbookDiseaseNamesForCase } from "./tcm-textbook-syndromes";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

/**
 * 教材病名闭集选择（2026-10-13，甲方 10.12 测评整改）。
 *
 * 做什么：把病例的主诉与现病史对到规划教材里的病名（最多 3 个），供辨证提示词取这几个病的教材证型行。
 *
 * 为什么用模型：主诉的说法是开放的——「胃脘刺痛」「腰部冷痛」「不爱吃饭」「便后滴血」「排尿费力」。
 * 词表桥接（tcm-textbook-syndromes 的 COMPLAINT_DISEASE_BRIDGE）在 172 例带教材答案的合成病例上只把 79% 对到了
 * 正确的教材病名；对不上时模型看不到该病的教材证型，证名、治法、方名就由它自由书写，与教材字面不一致。
 *
 * 边界：
 *  · 只在闭集里选——输出的名字必须逐字等于清单里的教材病名，其余丢弃；
 *  · 结果只决定「把哪几个病的教材行写进提示词」，不产生诊断，不写病历，不参与任何安全判断；
 *  · 超时、未配置、输出非法都返回空数组，候选退回词表检索（与改动前一致）；
 *  · temperature 0，按实际请求内容缓存（M02 预取，M03 命中），同一份病历取到的候选相同。
 * 开关：CDSS_TEXTBOOK_DISEASE_PICK=false 关闭。
 */
const PICK_TIMEOUT_MS = (() => {
  const value = Number(process.env.TEXTBOOK_DISEASE_PICK_TIMEOUT_MS || 6_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 15_000 ? Math.round(value) : 6_000;
})();
const MAX_RECORD_CHARS = 700;
const MAX_PICKS = 3;

function enabled(): boolean {
  return process.env.CDSS_TEXTBOOK_DISEASE_PICK !== "false";
}

/** 只保留清单里有的名字，去重，按模型给出的先后，最多 MAX_PICKS 个。 */
export function parseTextbookDiseasePick(content: unknown, allowed: ReadonlySet<string>): string[] {
  if (typeof content !== "string" || !content.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }
  const list = parsed && typeof parsed === "object" ? (parsed as { diseases?: unknown }).diseases : undefined;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const name = typeof item === "string" ? item.trim() : "";
    if (name && allowed.has(name) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

function recordText(caseState: CaseState): string {
  const present = [caseState.hisRecord?.fields?.xianbingshi, caseState.symptoms?.presentHistory]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim())) || "";
  // 妇科病名要看经带胎产（「恶心呕吐」在停经 50 天的病历里是妊娠恶阻）：病历带月经史/婚育史时一并给出。
  const reproductive = Object.entries(caseState.symptoms || {})
    .filter(([key, value]) => REPRODUCTIVE_RECORD_KEYS.includes(key) && typeof value === "string" && value.trim())
    .map(([key, value]) => `${key}：${String(value).slice(0, 120)}`)
    .join("\n");
  return sanitizeFreeTextForModel(
    [`主诉：${caseState.chiefComplaint || ""}`, `现病史：${present}`.slice(0, MAX_RECORD_CHARS), reproductive].filter(Boolean).join("\n"),
  );
}

/** 调用参数。运行时与离线探针共用。 */
export function textbookDiseasePickCallParams(model: string) {
  return {
    model,
    temperature: 0,
    max_tokens: 120,
    stream: false as const,
    response_format: { type: "json_object" as const },
    ...textModelRequestTuning(model, { reasoningEffort: "low", thinkingEnabled: false }),
  };
}

/**
 * 选择请求的消息与闭集清单。运行时与离线探针（~/runlogs/r1018/work/r1021/diseasepick/probe.mjs）共用这一处，避免探针测的不是线上提示词。
 *
 * 2026-10-19 第九轮量过、没有采用的提示词改法（离线探针 deepseek-flash，112 例：甲方 10 + 留出 29 + X 集 26 + M 集 48）：
 *  · 清单每项附教材定义（「病名｜定义」）+ 「按整组表现、西医病名只作旁证、教材必备表现已否认则不选」：S151 排第一的由肺炎喘嗽变咳嗽，
 *    但「上腹不适伴反酸」这类主诉被定义里的词带走（胃痞 → 吐酸，胃痞掉出前三个 2 例）；
 *  · 名字清单 + 「主诉为起点、整组表现归病、既往史/辅助检查只作旁证、多系统慢性虚损考虑虚劳」：S078 虚劳排第一，
 *    但甲方病历 3（头痛，产后）排到产后身痛之后、S032（头晕 3 月，气血亏虚）虚劳排第一；
 *  · 只加既往史/辅助检查：前三含 gold 49 → 48，第一 42 → 42，没有收益。
 * 基线（本提示词）前三含 gold 107/112、第一 96/112；剩下的未命中多是数据集自身的出院诊断写法（头晕记 中风、胸闷记 心衰），
 * 不是提示词能修的。S078、S151 这一类改在候选一侧：tcm-textbook-syndromes 的 promoteBestFitPickedDisease 与候选里的教材定义、诊断依据。
 */
export function buildTextbookDiseasePickRequest(caseState: CaseState): {
  messages: Array<{ role: "system" | "user"; content: string }>;
  allowed: ReadonlySet<string>;
} | undefined {
  if (!(caseState.chiefComplaint || "").trim()) return undefined;
  const ageYears = typeof caseState.patient?.age === "number" ? caseState.patient.age : undefined;
  const names = textbookDiseaseNamesForCase({ sex: caseState.patient?.sex, ageYears });
  if (names.length === 0) return undefined;
  const allowed = new Set(names);
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是中医教材目录检索器，不负责诊断、处方或安全判断。",
        "任务：根据病例的主诉与现病史，从给定的教材病名清单里选出本次就诊最可能归入的病名。",
        "规则：",
        "1. 只能逐字复制清单里的病名，不得改写、不得给出清单外的名字。",
        "2. 以主诉（本次就诊的主要不适）为准选病名；伴随症状不单独立病。",
        `3. 最多 ${MAX_PICKS} 个，最可能的排在最前；只有一个明确归属时只给一个；清单里确实没有合适的就返回空数组。`,
        "4. 清单里的西医病名与中医病名都可以选，优先选中医病名。",
        "5. 「反复感冒、容易感冒」而本次没有恶寒发热、鼻塞流涕等外感表现的，说的是体质虚弱，选虚劳，不选感冒。",
        "只输出 JSON：{\"diseases\":[\"病名\"]}，不要解释。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        patient: { sex: caseState.patient?.sex || null, age: ageYears ?? null },
        record: recordText(caseState),
        textbookDiseaseNames: names,
      }),
    },
  ];
  return { messages, allowed };
}

export async function pickTextbookDiseasesForCase(caseState: CaseState, signal?: AbortSignal): Promise<string[]> {
  if (!enabled() || signal?.aborted) return [];
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return [];
  const request = buildTextbookDiseasePickRequest(caseState);
  if (!request) return [];
  const { messages, allowed } = request;
  return memoizedSmallTask<string[]>("textbook_disease_pick", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PICK_TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "textbook_disease_pick", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        ...textbookDiseasePickCallParams(config.model),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: parseTextbookDiseasePick(content, allowed), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: [], cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, [], signal);
}
