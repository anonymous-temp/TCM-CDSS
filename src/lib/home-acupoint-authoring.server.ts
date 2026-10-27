import pointsJson from "../data/tcm-home-acupressure-points.source.json";
import homeCareJson from "../data/tcm-home-acupoint-care.source.json";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { patientInstructionProhibitionsIn } from "./clinical-vocabulary";
import { PRECAUTION_DOSE_LIKE } from "./m04-proposal-compiler";

/**
 * 居家穴位保健由模型按本例选穴、写理由（2026-10-27 第二十五轮，用户：「不是那么机械和模版化的，而是真的 AI 模型参与计算推理的」）。
 *
 * 此前 nonPharma.acupointCare 由服务端按「证候→九种体质」查《老年人中医药健康管理服务技术规范》的固定段落拼出：71 份处方只有
 * 18 种写法，同一段「按揉气海、关元…也可以艾灸气海、关元」逐字出现在 15 份里，与本例的主诉、兼症无关。现在：
 *   · 候选穴是一张受治理的表（tcm-home-acupressure-points.source.json：34 个常用居家按揉穴，标准定位与主治逐字取自本地十三五教材，
 *     患者定位已在用的逐字沿用）；
 *   · 小模型读本例的病名、证候、治法与已记录的主要表现，从表里选 1～3 个穴并各写一句为什么选它（对应本例哪一项不适），
 *     气虚、阳虚体质且允许艾灸时可再选技术规范里的艾灸穴；
 *   · 服务端只认表里的穴名，去掉孕期禁用穴与部位、医师项目已用的穴，定位、手法、时长、注意事项全部用表与技术规范原文，
 *     理由过患者医嘱禁用语与剂量样式的核对；
 *   · 安全门（红旗、不出剂量、儿童年龄段、妊娠阳性/可疑、项目禁忌）仍由 compileHomeAcupointCare 那一套先判，
 *     那一套给不出时这里也不给；模型失败、超时或输出不合格时用原来的技术规范段落。
 * 开关：CDSS_HOME_ACUPOINT_AUTHORING=false 回到只用技术规范段落。
 */
type PointEntry = { name: string; region: string; selfReachable: boolean; indications: string; patientLocation: string };
const POOL = pointsJson as unknown as {
  methods: { finger: string; palm: string; dose: string };
  palmRegions: string[];
  moxibustionPoints: string[];
  points: PointEntry[];
};
const CARE = homeCareJson as unknown as {
  constitutions: Record<string, { moxibustion?: { method: string; dose: string } }>;
  cautions: { acupressure: string; moxibustion: string };
  pregnancyUnresolved: { excludedPoints: string[]; excludedRegions: string[] };
};
const POINTS = new Map(POOL.points.map((point) => [point.name, point]));
const TIMEOUT_MS = (() => {
  const value = Number(process.env.HOME_ACUPOINT_AUTHORING_TIMEOUT_MS || 6_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 12_000 ? Math.round(value) : 6_000;
})();
const MAX_REASON_CHARS = 30;

export function homeAcupointAuthoringEnabled(): boolean {
  return process.env.CDSS_HOME_ACUPOINT_AUTHORING !== "false";
}

export type HomeAcupointAuthoringInput = {
  disease: string;
  primarySyndrome: string;
  secondarySyndromes: string[];
  method: string;
  /** 本例已记录的主要表现（主诉 + 辨证依据清单），按原话。 */
  findings: string[];
  ageYears: number;
  sex: string;
  /** 妊娠状态未写明的育龄女性：去掉孕期禁用穴与腹部、腰骶部穴位（与技术规范段落同一张表）。 */
  pregnancyUnresolved: boolean;
  /** 艾灸这一段在技术规范路径里本例是否允许（体质有艾灸方案、无烫伤风险与项目禁忌、未妊娠待查）。 */
  moxibustionAllowed: boolean;
};
export type AuthoredHomeAcupoint = {
  points: Array<{ name: string; reason: string }>;
  moxibustion?: { points: string[]; reason: string };
};

export function homeAcupointCandidatePool(input: Pick<HomeAcupointAuthoringInput, "pregnancyUnresolved">): PointEntry[] {
  const rule = CARE.pregnancyUnresolved;
  return POOL.points.filter((point) => !input.pregnancyUnresolved ||
    (!rule.excludedPoints.includes(point.name) && !rule.excludedRegions.includes(point.region)));
}

function buildMessages(input: HomeAcupointAuthoringInput) {
  const pool = homeAcupointCandidatePool(input);
  const moxibustionPoints = input.moxibustionAllowed ? POOL.moxibustionPoints.filter((name) => pool.some((point) => point.name === name)) : [];
  return [
    {
      role: "system" as const,
      content: "你是中医针灸科主治医师，为本例患者挑选回家自己按揉的保健穴位。只输出 JSON：{\"points\":[{\"name\":\"穴名\",\"reason\":\"理由\"}],\"moxibustion\":null 或 {\"points\":[\"穴名\"],\"reason\":\"理由\"}}。",
    },
    {
      role: "user" as const,
      content: [
        `患者：${input.sex || "性别未写"}，${Math.round(input.ageYears)}岁`,
        `中医诊断：${input.disease || "（未写）"}；证候：${input.primarySyndrome}${input.secondarySyndromes.length > 0 ? `，兼${input.secondarySyndromes.join("、")}` : ""}；治法：${input.method || "（未写）"}`,
        `本例记录的主要表现：${input.findings.join("、") || "（见诊断）"}`,
        "可选穴位（只能从这里选，后面是教材主治）：",
        ...pool.map((point) => `- ${point.name}（${point.selfReachable ? "可自己按" : "需家人帮忙"}）：${point.indications.slice(0, 80)}`),
        moxibustionPoints.length > 0
          ? `本例可以另加居家艾灸，只能在 ${moxibustionPoints.join("、")} 里选（只在证属虚寒、气虚、阳虚时选，否则 moxibustion 写 null）。`
          : "本例不加艾灸，moxibustion 写 null。",
        "要求：",
        "1. 选 1～3 个穴，按教材主治对上本例的主诉和主要不适、与证候治法方向一致；优先能自己按到的穴；不要为凑数多选。",
        "2. 每个穴写一句理由（不超过20字），用患者能懂的话说它对本例哪一项不适有帮助，点出这项不适（如「和胃止痛，帮助缓解胃脘胀痛」）；不写剂量、时长、疗效保证，不写「治愈」「根治」。",
        "3. 艾灸理由同样不超过20字。",
      ].join("\n"),
    },
  ];
}

function validReason(value: unknown): string | undefined {
  const reason = typeof value === "string" ? value.trim().replace(/[。；;\s]+$/u, "") : "";
  if (reason.length < 4 || reason.length > MAX_REASON_CHARS) return undefined;
  // 理由只说为什么选这个穴，不写时长、次数、剂量：带阿拉伯数字的一律不收。
  if (PRECAUTION_DOSE_LIKE.test(reason) || /\d/u.test(reason)) return undefined;
  if (patientInstructionProhibitionsIn(reason).length > 0) return undefined;
  return reason;
}

export function parseAuthoredHomeAcupoint(raw: string | null | undefined, input: HomeAcupointAuthoringInput): AuthoredHomeAcupoint | undefined {
  let parsed: Record<string, unknown> | undefined;
  try { parsed = JSON.parse(raw || "") as Record<string, unknown>; } catch { return undefined; }
  const allowed = new Set(homeAcupointCandidatePool(input).map((point) => point.name));
  const points: AuthoredHomeAcupoint["points"] = [];
  for (const item of Array.isArray(parsed?.points) ? parsed.points : []) {
    const name = typeof (item as { name?: unknown })?.name === "string" ? String((item as { name: string }).name).trim() : "";
    const reason = validReason((item as { reason?: unknown })?.reason);
    if (!allowed.has(name) || !reason || points.some((point) => point.name === name)) return undefined;
    points.push({ name, reason });
  }
  if (points.length < 1 || points.length > 3) return undefined;
  const moxa = parsed?.moxibustion as { points?: unknown; reason?: unknown } | null | undefined;
  if (!moxa) return { points };
  if (!input.moxibustionAllowed) return { points };
  const moxaPoints = Array.isArray(moxa.points) ? moxa.points.map((name) => String(name).trim()) : [];
  const moxaReason = validReason(moxa.reason);
  if (moxaPoints.length === 0 || !moxaReason || moxaPoints.some((name) => !POOL.moxibustionPoints.includes(name) || !allowed.has(name))) return { points };
  return { points, moxibustion: { points: [...new Set(moxaPoints)], reason: moxaReason } };
}

export async function authorHomeAcupointCare(input: HomeAcupointAuthoringInput, signal?: AbortSignal): Promise<AuthoredHomeAcupoint | undefined> {
  if (!homeAcupointAuthoringEnabled() || signal?.aborted || !input.primarySyndrome) return undefined;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return undefined;
  const messages = buildMessages(input);
  const authored = await memoizedSmallTask<AuthoredHomeAcupoint | undefined>("m04_home_acupoint_authoring", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "m04_home_acupoint_authoring", stage: "prescribe", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 400,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const value = parseAuthoredHomeAcupoint(response.choices[0]?.message?.content, input);
      return { value, cacheable: Boolean(value) };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
  console.info("[tcm-cdss:telemetry] home_acupoint_authoring", { authored: Boolean(authored), points: authored?.points.length ?? 0, moxibustion: Boolean(authored?.moxibustion) });
  return authored;
}

/**
 * 写给患者的一段：按揉（腹部用掌根、其余用指腹，手法与时长取技术规范原文）→ 每个穴为什么选 → 可选的艾灸 → 注意事项原文。
 * clinicianPointText：本例医师项目卡已用的穴位文字，这些穴不再让患者自己按；艾灸在医师已开灸法卡或本例不允许时不写。
 * 剩下一个穴也没有时返回 null（调用方改用技术规范段落）。
 */
export function renderAuthoredHomeAcupointCare(
  authored: AuthoredHomeAcupoint,
  options: { clinicianPointText?: string; moxibustionAllowed: boolean; constitutionMoxibustion?: { method: string; dose: string } },
): string | null {
  const clinician = options.clinicianPointText || "";
  const known = authored.points.filter((point) => POINTS.has(point.name));
  // 医师项目已用的穴不再重复让患者按；但选的穴全在项目卡上时照给——同一穴回家自己按揉是常规做法，
  // 换回技术规范的固定段落反而与本例无关（第二十五轮本机实测：心悸·心血不足，针刺卡已含内关、神门、足三里，
  // 此前因此退回「按揉气海、关元…也可以艾灸」）。
  const fresh = known.filter((point) => !clinician.includes(point.name));
  const points = fresh.length > 0 ? fresh : known;
  if (points.length === 0) return null;
  // 定位本身常带括号（「两横指（食指、中指并拢的宽度）」），写成「穴名（定位）」会括号套括号：先列穴名，取穴另起一句。
  const where = (name: string) => `${name}在${POINTS.get(name)!.patientLocation}`;
  const palmNames = points.filter((point) => POOL.palmRegions.includes(POINTS.get(point.name)!.region)).map((point) => point.name);
  const fingerNames = points.filter((point) => !POOL.palmRegions.includes(POINTS.get(point.name)!.region)).map((point) => point.name);
  const parts: string[] = [];
  parts.push(`按揉${points.map((point) => point.name).join("、")}。取穴：${points.map((point) => where(point.name)).join("；")}。`);
  const technique = palmNames.length === 0
    ? POOL.methods.finger
    : fingerNames.length === 0
      ? POOL.methods.palm
      : `${fingerNames.join("、")}${POOL.methods.finger}；${palmNames.join("、")}${POOL.methods.palm}`;
  parts.push(`手法：${technique}，${POOL.methods.dose}。`);
  parts.push(`${points.map((point) => `${point.name}：${point.reason}`).join("；")}。`);
  const moxaMethod = options.constitutionMoxibustion || Object.values(CARE.constitutions).find((entry) => entry.moxibustion)?.moxibustion;
  const moxa = options.moxibustionAllowed && authored.moxibustion && moxaMethod
    ? authored.moxibustion.points.filter((name) => !clinician.includes(name))
    : [];
  if (moxa.length > 0 && moxaMethod && authored.moxibustion) {
    const described = new Set(points.map((point) => point.name));
    const newSites = moxa.filter((name) => !described.has(name));
    parts.push(`也可以艾灸${moxa.join("、")}（${authored.moxibustion.reason}）${newSites.length > 0 ? `，取穴：${newSites.map(where).join("；")}` : ""}。${moxaMethod.method}，${moxaMethod.dose}。`);
  }
  parts.push(CARE.cautions.acupressure);
  if (moxa.length > 0) parts.push(CARE.cautions.moxibustion);
  return parts.join("");
}
