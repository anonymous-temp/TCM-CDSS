import { readFileSync } from "node:fs";
import type { CaseState } from "./diagnosis-types";
import { diagnoseReasoningFromState } from "./diagnosis-parse";

/**
 * 相似现代医案参考（2026-09-27）。
 *
 * 甲方确认 1.7 万例现代名医医案语料全部版权可在运行时使用。文献里证据最强的「外挂」是相似病例
 * 作示例（retrieve-then-select / 病例推理），而 9/27 本机实测：把「本病现代医案常用药」统计表被动地
 * 塞进 M04 长提示词，处方几乎不变（落在表内的药 45% vs 基线 46–52%）——模型不取用被动上下文。
 *
 * 所以这里做两件事：
 *  1. 按本例病历（M04 另加已签名的病名、证候、治法）检索最相似的 3 例，以完整的
 *     「主诉四诊 → 病机 → 治法 → 方药」示例呈现，而不是统计表；
 *  2. 「引导 + 问责」而非「强制采纳」：M04 须在 referenceCaseUse 里说明借鉴了哪一例的哪一点，
 *     或都不适用及其原因（见 m04-proposal-compiler 的 referenceCaseUse）。不要求必须采纳——强制采纳会让
 *     模型为凑数加入不对证的药味（组成合同与配伍风险随之上升、修复轮变多、响应变慢）；也不另起一次
 *     模型调用（串行再加 1.5–3s）。
 *
 * 纪律：只呈现辨证与组方思路（不含剂量与疗程），明确标注「参考，不是处方依据」；处方仍须通过全部
 * 确定性合同与剂量/配伍核验。检索是确定性的字符二元组 TF-IDF，不调用模型。
 * `CDSS_SIMILAR_CASES=false` 关闭（回滚开关，也是 A/B 基线臂）。
 */
type Exemplar = {
  id: string;
  dxW?: string;
  dxT?: string;
  cc: string;
  ex: string;
  pa: string;
  tp?: string;
  fm: string[];
  hb: string[];
};

export type SimilarModernCase = Exemplar & { label: string; score: number };

/**
 * 评测卫生（只在本机离线评测时设置，生产不设）：CDSS_SIMILAR_CASES_EXCLUDE_FILE 指向一个 JSON 数组（医案 id），
 * 这些医案不进入检索。用于排除与评测金标准同一医家、或药味高度相近（Jaccard≥0.4）的医案，
 * 防止「模仿同一位名医的其他医案」把对照金标准的分数抬高。仓库内的构建期排除名单
 * （tcm-modern-case-exemplar-exclusions.source.json）只排除近似重复，口径更宽。
 */
function evaluationExclusions(): Set<string> {
  const file = process.env.CDSS_SIMILAR_CASES_EXCLUDE_FILE;
  if (!file) return new Set();
  try {
    const ids = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}
const EVALUATION_EXCLUDED = evaluationExclusions();

/**
 * 运行时读取（不走静态 import）：7.7MB 的医案索引若静态 import，会被 webpack 打进 diagnose 与
 * prescribe 两条路由的服务端产物、并在 terser 阶段抬高构建内存（本机 7.7GB 机器上预编译两次被
 * OOM 杀掉）。readFileSync 的 URL 必须保持字面量，文件追踪才会把它收进 standalone（同
 * tcm-classic-evidence.server.ts 的写法）。读不到时功能静默关闭，不影响诊断链路。
 */
let exemplarCache: Exemplar[] | undefined;
function exemplars(): Exemplar[] {
  if (exemplarCache) return exemplarCache;
  try {
    const raw = readFileSync(new URL("../data/tcm-modern-case-exemplars.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { exemplars?: Exemplar[] };
    exemplarCache = (parsed.exemplars || []).filter((item) => !EVALUATION_EXCLUDED.has(item.id));
  } catch {
    console.warn("[tcm-cdss:knowledge] modern-case exemplars unavailable; similar-case reference disabled");
    exemplarCache = [];
  }
  return exemplarCache;
}
const SIMILAR_CASE_LIMIT = 3;

export function similarModernCasesEnabled(): boolean {
  return process.env.CDSS_SIMILAR_CASES !== "false";
}

/** 问责模式：accountable（默认，M04 须填 referenceCaseUse）/ guided（只呈现）/ mandatory（须至少采纳一例；仅供对照评测）。 */
export function similarCaseUseMode(): "accountable" | "guided" | "mandatory" {
  const raw = (process.env.CDSS_SIMILAR_CASES_MODE || "").trim();
  return raw === "guided" || raw === "mandatory" ? raw : "accountable";
}

function bigrams(text: string): string[] {
  const compact = text.replace(/[\s，,。；;：:、（）()【】\[\]“”"'!！?？…·\-—\d]/g, "");
  const out: string[] = [];
  for (let index = 0; index < compact.length - 1; index += 1) out.push(compact.slice(index, index + 2));
  return out;
}

type Index = { postings: Map<string, Int32Array>; idf: Map<string, number>; lengths: Float64Array; averageLength: number };
let index: Index | undefined;

function exemplarText(item: Exemplar): string {
  return [item.dxW, item.dxT, item.cc, item.ex, item.pa, item.tp].filter(Boolean).join("；");
}

function buildIndex(): Index {
  const lists = new Map<string, number[]>();
  const EXEMPLARS = exemplars();
  const lengths = new Float64Array(EXEMPLARS.length);
  EXEMPLARS.forEach((item, docId) => {
    const unique = new Set(bigrams(exemplarText(item)));
    lengths[docId] = unique.size;
    for (const gram of unique) {
      const list = lists.get(gram);
      if (list) list.push(docId);
      else lists.set(gram, [docId]);
    }
  });
  const postings = new Map<string, Int32Array>();
  const idf = new Map<string, number>();
  for (const [gram, list] of lists) {
    postings.set(gram, Int32Array.from(list));
    idf.set(gram, Math.log(1 + (EXEMPLARS.length - list.length + 0.5) / (list.length + 0.5)));
  }
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length);
  return { postings, idf, lengths, averageLength };
}

function queryTextFor(caseState: CaseState, stage: "diagnose" | "prescribe"): { text: string; chiefComplaint: string; diseaseNames: string[] } {
  const fields = caseState.hisRecord?.fields;
  const symptoms = caseState.symptoms && typeof caseState.symptoms === "object" ? Object.values(caseState.symptoms).map(String) : [];
  const chiefComplaint = String(fields?.zhushu || caseState.chiefComplaint || "").slice(0, 120);
  const base = [
    chiefComplaint,
    fields?.xianbingshi,
    ...symptoms,
    fields?.tcmTongue || caseState.tongue,
    fields?.tcmPulse || caseState.pulse,
  ];
  if (stage === "diagnose") return { text: base.filter(Boolean).join("；").slice(0, 1200), chiefComplaint, diseaseNames: [] };
  const reasoning = diagnoseReasoningFromState(caseState);
  const overview = reasoning?.overview as { primarySyndrome?: string; secondarySyndromes?: unknown; tcmDiseaseName?: string; overallPathogenesis?: string } | undefined;
  const secondary = Array.isArray(overview?.secondarySyndromes) ? overview?.secondarySyndromes.map(String) : [];
  const western = reasoning?.westernDiagnosis?.primary?.name;
  const tcmDisease = overview?.tcmDiseaseName;
  return {
    text: [
      western, tcmDisease, overview?.primarySyndrome, ...secondary, overview?.overallPathogenesis,
      reasoning?.therapy?.overallMethod, ...base,
    ].filter(Boolean).join("；").slice(0, 1600),
    chiefComplaint,
    diseaseNames: [western, tcmDisease].filter((name): name is string => typeof name === "string" && name.trim().length >= 2)
      .map((name) => name.replace(/[（(].*$/, "").trim()),
  };
}

/** 确定性检索：字符二元组 BM25 式打分 + 病名一致加权 + 同方同药去重。 */
export function retrieveSimilarModernCases(caseState: CaseState, stage: "diagnose" | "prescribe"): SimilarModernCase[] {
  if (!similarModernCasesEnabled()) return [];
  const EXEMPLARS = exemplars();
  if (EXEMPLARS.length === 0) return [];
  const { text, chiefComplaint, diseaseNames } = queryTextFor(caseState, stage);
  // 主诉是全案锚点（与 M03 提示词「主诉主症是全案锚点」同一口径）：主诉里的字对权重加倍，
  // 并按主诉相似度再加权，避免长病史里的旁支信息（月经、既往病）把检索带偏。
  const chiefGrams = new Set(bigrams(chiefComplaint));
  const queryGrams = [...new Set(bigrams(text))];
  if (queryGrams.length < 4) return [];
  index ||= buildIndex();
  const scores = new Map<number, number>();
  const k1 = 1.2;
  const b = 0.75;
  for (const gram of queryGrams) {
    const docs = index.postings.get(gram);
    if (!docs) continue;
    const weight = (index.idf.get(gram) || 0) * (chiefGrams.has(gram) ? 2 : 1);
    for (const docId of docs) {
      const norm = k1 * (1 - b + b * index.lengths[docId] / index.averageLength);
      scores.set(docId, (scores.get(docId) || 0) + weight * (k1 + 1) / (1 + norm));
    }
  }
  if (chiefGrams.size > 0) {
    for (const [docId, score] of scores) {
      const exemplarChief = new Set(bigrams(EXEMPLARS[docId].cc));
      let shared = 0;
      for (const gram of chiefGrams) if (exemplarChief.has(gram)) shared += 1;
      scores.set(docId, score * (1 + shared / Math.max(chiefGrams.size, exemplarChief.size, 1)));
    }
  }
  if (diseaseNames.length > 0) {
    for (const [docId, score] of scores) {
      const item = EXEMPLARS[docId];
      const named = [item.dxW, item.dxT].filter(Boolean).join("；");
      if (diseaseNames.some((name) => named.includes(name) || (item.dxT && name.includes(item.dxT)))) scores.set(docId, score * 1.25);
    }
  }
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  const picked: SimilarModernCase[] = [];
  const seenSignatures = new Set<string>();
  for (const [docId, score] of ranked) {
    const item = EXEMPLARS[docId];
    const signature = `${item.fm[0] || ""}|${item.hb.slice(0, 4).join(",")}`;
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    picked.push({ ...item, label: `MC-${picked.length + 1}`, score: Number(score.toFixed(2)) });
    if (picked.length >= SIMILAR_CASE_LIMIT) break;
  }
  return picked;
}

function renderCaseLine(item: SimilarModernCase, withHerbs: boolean): string {
  const disease = [item.dxT, item.dxW].filter(Boolean).join("／");
  return [
    `[${item.label}] 病名：${disease || "未记"}`,
    `主诉与四诊：${item.cc}${item.ex ? `；${item.ex}` : ""}`,
    `病机：${item.pa}`,
    item.tp ? `治法：${item.tp}` : "",
    item.fm.length > 0 ? `方：${item.fm.join("合")}` : "方：自拟",
    withHerbs ? `药味：${item.hb.join("、")}` : "",
  ].filter(Boolean).join("｜");
}

export function buildSimilarModernCaseContext(caseState: CaseState, stage: "diagnose" | "prescribe"): { context: string; cases: SimilarModernCase[] } {
  const cases = retrieveSimilarModernCases(caseState, stage);
  if (cases.length === 0) return { context: "", cases };
  const header = "【相似现代医案参考（现代名医验案，按本例病历检索；只作辨证与组方思路参考，不是金标准，也不是处方依据）】";
  if (stage === "diagnose") {
    return {
      cases,
      context: [
        header,
        ...cases.map((item) => renderCaseLine(item, false)),
        "使用纪律：先按本例病历独立辨证，再对照上列医案检验自己的主证与兼证是否遗漏关键病机；只有本例病历里能逐字找到对应阳性事实时才可借鉴其辨证思路，病机不符的不得套用。",
      ].join("\n"),
    };
  }
  const mode = similarCaseUseMode();
  const rule = mode === "guided"
    ? "使用纪律：可参考上列医案的选方与随证加减思路；只采用与本例已锁定证候、治法相符且本例病历有对应事实的药味，不得照搬剂量。"
    : mode === "mandatory"
      ? "使用纪律（必须执行）：必须从上列医案中至少采纳一例的选方或随证加减思路，并在输出 JSON 顶层增加 referenceCaseUse 字段，写明编号与借鉴了什么，形如 {\"adoptedCaseIds\":[\"MC-1\"],\"note\":\"借鉴其随证加减思路\"}；所采药味仍须与本例已锁定证候、治法相符，不得照搬剂量。"
      : "使用纪律：逐例判断上列医案与本例是否对证。对证的，可借鉴其选方或随证加减药味（仍须符合本例已锁定证候与治法，不得照搬剂量）；不对证的不要采用。无论是否采用，都必须在输出 JSON 顶层增加 referenceCaseUse 字段交代：adoptedCaseIds 列出实际借鉴的编号（都不适用则为 []），note 用一句话写明借鉴了哪一点或为何都不适用，形如 {\"adoptedCaseIds\":[],\"note\":\"三例均为湿热证，与本例寒湿不符\"}。";
  return { cases, context: [header, ...cases.map((item) => renderCaseLine(item, true)), rule].join("\n") };
}
