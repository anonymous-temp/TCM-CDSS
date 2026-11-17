import "server-only";

import { recordMentionPolarityAt, sanitizeFreeTextForModel } from "./diagnosis-safety";
import { proposeThenVerify } from "./cross-model-small-task.server";
import { alignQuoteToSource } from "./source-quote-alignment";
import { diseaseDefiningFindingStatus, textbookDiseaseRefinement } from "./tcm-disease-defining-findings";
import pointsCheckSource from "../data/tcm-disease-points-check.source.json" with { type: "json" };
import { diseaseNameWithRecordSubtype, textbookDiseaseDefinition, textbookDiseaseDiagnosisPoints } from "./tcm-textbook-syndromes";
import chiefConceptSource from "../data/tcm-differential-chief-concepts.source.json" with { type: "json" };
import { chiefComplaintPhrase } from "./rationale-findings-checklist";

/**
 * 中医病名与教材诊断要点的核对（2026-11-11 第四十二轮）。
 *
 * 线上盲评 new40 m02：教材内痔的诊断要点写「血液与大便不相混合」，指诊或窥肛镜可见痔核；病历是「血色鲜红偏暗、与大便相混」
 *「肛门外观未见外痔及裂口，患者暂拒绝直肠指诊」，辨证半仍定内痔，评审评为错（应为血证·便血）。选病闭集与「解释就诊原因」的核对都看不到
 * 病名与要点原文是否相反：内痔确实解释便血这个就诊原因。
 *
 * 做法照「提名＋另一家复核」（cross-model-small-task）：deepseek-flash 对照教材诊断要点读病历，只在病历原文与某条要点相反、
 * 或病历写明该病必需的体征/检查所见没有（拒绝检查、未见）时提名，并从候选里选一个更合适的病；qwen3.8-flash 只对这一条答对错。
 * 服务端核对：要点原文逐字出自教材要点、病历原文逐字出自病历且是本人的、问到了的记载（拒绝检查、未见…这类写法本身就是记载），
 * 更合适的病在候选里。三项都过、复核说对，才让辨证半按那个病重写一次（与就诊原因核对同一条重抽路径）；结论不改病名、不参与安全判断。
 * 拿不准、失败、超时都当相符。开关：CDSS_M03_DISEASE_POINTS_CHECK=false 关闭。
 * 离线量过再打开（第四十二轮，第四十一轮已存的 173 份诊断）：触发 5 份（2.9%），4 份是盲评点名要改的（内痔→血证便血、胸痹→真心痛、
 * 无抽搐的急惊风、血小板 68 的葡萄疫），1 份存疑（郁证→癫证，缺体征一类，已按上面的要点限制挡掉）；每份约 1 秒，与收口并行。
 */
const TIMEOUT_MS = 4_000;

export function diseasePointsCheckEnabled(): boolean {
  return process.env.CDSS_M03_DISEASE_POINTS_CHECK !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
const MISSING_SIGN_WORDS: readonly string[] = (pointsCheckSource as { signPointWords: string[] }).signPointWords;
const MISSING_SIGN_POINT = { test: (point: string) => MISSING_SIGN_WORDS.some((word) => point.includes(word)) };
const sameDisease = (left: string, right: string) => compact(left).replace(/类病$/u, "") === compact(right).replace(/类病$/u, "");

export type DiseasePointsInput = {
  disease: string;
  recordText: string;
  chiefComplaint: string;
  /** 闭集选病结果与本病的教材鉴别病名（去重后），更合适的病只能从这里选。 */
  candidates: readonly string[];
  ageYears?: number;
};

export type DiseasePointsProposal = { kind: "contradicted" | "missing_sign" | "defining_missing" | "refinement"; point: string; recordQuote: string; better: string; reason: string };
export type DiseasePointsVerdict = { status: "fits" } | ({ status: "mismatch" } & DiseasePointsProposal);

const PROPOSE_SYSTEM = [
  "你核对一个中医病名与教材诊断要点是否相符，不负责诊断，也不评价证型与治法。",
  "给你病名、它的教材定义与诊断要点原文、病历、候选病名（附教材定义）。只在下面两种情况下判 mismatch：",
  "- contradicted：病历原文写的与某条诊断要点正好相反（例：要点「血液与大便不相混合」，病历「血与大便相混」）；",
  "- missing_sign：该病按定义要靠某个体征或检查所见确立（痔核、肿块、皮损、特定查体），病历写明没有看到或没有做（「未见」「拒绝检查」），而主诉能由候选里另一个病解释。",
  "病历只是没写到某条要点、要点里的伴随症状不全、病程或诱因不同，都不算 mismatch。拿不准判 fits。",
  "mismatch 时：point 逐字复制相关的那条要点里的一段（≤40字）；recordQuote 逐字复制病历里那一段（≤40字）；better 从候选里逐字选一个与病历相符、能解释主诉的病名（分类病名带括号写的分型也算），没有就写 null；reason ≤30字。",
  "只输出 JSON：{\"verdict\":\"fits|mismatch\",\"kind\":\"contradicted|missing_sign\",\"point\":\"\",\"recordQuote\":\"\",\"better\":\"\",\"reason\":\"\"}",
].join("\n");

const VERIFY_SYSTEM = [
  "核对一条说法：病历与这个中医病名的教材诊断要点不符，另一个病更合适。给你病名与要点原文、病历、说法（point 要点、recordQuote 病历原文、better 更合适的病及其定义）。",
  "说法成立的条件：病历原文确实与要点相反，或该病必需的体征病历写明没有看到/没有做；给了 better 时它还要能解释主诉、与病历不矛盾。病历只是没写到、伴随症状不全不算。",
  "先写 why（≤40字），再写 confirmed。只输出 JSON：{\"why\":\"\",\"confirmed\":false}",
].join("\n");

export function diseasePointsCheckApplies(input: DiseasePointsInput): boolean {
  if (!diseasePointsCheckEnabled() || !compact(input.disease) || !compact(input.recordText)) return false;
  if (!input.candidates.some((name) => !sameDisease(name, input.disease))) return false;
  return Boolean(textbookDiseaseDiagnosisPoints(input.disease, input.ageYears));
}

/** 第四十九轮：定义缺项无需模型提名。候选只按同一张表的肯定表现推荐，表外病不算「已成立」。 */
export function deterministicDiseasePointsVerdict(input: DiseasePointsInput): DiseasePointsVerdict {
  if (!compact(input.disease) || !compact(input.recordText)) return { status: "fits" };
  const refined = textbookDiseaseRefinement(input.disease, input.recordText, input.candidates);
  if (refined) return { status: "mismatch", kind: "refinement", point: "便时疼痛、出血、便秘", recordQuote: "", better: refined, reason: "教材局部病名细分需核对" };
  const result = diseaseDefiningFindingStatus(input.disease, input.recordText);
  if (result.status !== "missing" || !result.rule) return { status: "fits" };
  const explainsChief = (name: string) => {
    const chief = chiefComplaintPhrase(input.chiefComplaint);
    const definition = textbookDiseaseDefinition(name, input.ageYears) || "";
    // 只比较病名定义，不借某一证型的兼见症（例如呕吐某型兼发热）替代本次主诉。
    return chiefConceptSource.concepts.some((group) => group.forms.some((form) => chief.includes(form)) && group.forms.some((form) => definition.includes(form)));
  };
  const better = input.candidates.find((name) => !sameDisease(name, input.disease) && diseaseDefiningFindingStatus(name, input.recordText).status === "supported" && explainsChief(name)) || "";
  return { status: "mismatch", kind: "defining_missing", point: result.rule.missing, recordQuote: "", better, reason: `${result.rule.sourceRef.book}:${result.rule.sourceRef.line}` };
}

/** 模型提名 → 合格的提名：要点逐字出自教材要点，病历原文逐字出自病历且是本人的、问到了的记载，更合适的病在候选里。否则 undefined。 */
export function parseDiseasePointsProposal(content: unknown, input: DiseasePointsInput): DiseasePointsProposal | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(content) as Record<string, unknown>; } catch { return undefined; }
  if (parsed?.verdict !== "mismatch") return undefined;
  const kind = parsed.kind === "missing_sign" ? "missing_sign" : parsed.kind === "contradicted" ? "contradicted" : undefined;
  const point = typeof parsed.point === "string" ? parsed.point.trim() : "";
  const recordQuote = typeof parsed.recordQuote === "string" ? parsed.recordQuote.trim() : "";
  const better = typeof parsed.better === "string" ? parsed.better.trim() : "";
  // 病历与要点正相反（contradicted）时不要求点名更合适的病：分类病名（血证）核对器常不愿点名（离线 m02），辨证半按教材候选重定；
  // 缺必需体征（missing_sign）证据弱一些，仍要点名候选里的病。
  const named = better && better !== "null" ? better : "";
  if (!kind || compact(point).length < 4 || compact(recordQuote).length < 2 || (!named && kind !== "contradicted")) return undefined;
  const reference = textbookDiseaseDiagnosisPoints(input.disease, input.ageYears);
  const pointSource = compact([reference?.definition || "", ...(reference?.points || [])].join(""));
  if (!pointSource.includes(compact(point))) return undefined;
  // 缺必需体征只认写的是体征或检查所见的要点（指诊、窥肛镜、触及、可见…）；以「主要表现」立论的要点不算（离线 x04-24：
  // 郁证要点「以心情抑郁、情绪不宁…为主要临床表现」被当成缺体征，提名改成癫证）。
  if (kind === "missing_sign" && !MISSING_SIGN_POINT.test(point)) return undefined;
  const aligned = alignQuoteToSource(recordQuote, input.recordText);
  // 病历原文是本人的、问到了的记载（他人的、尚未询问的不算）。否认与拒绝检查本身就是证据（「无抽搐」「拒绝直肠指诊」），不排除。
  if (!aligned || recordMentionPolarityAt(input.recordText, aligned.start) === "excluded") return undefined;
  // 分型病名（血证）给核对器看的是带分型的写法（「血证（便血）」），答回来两种写法都认。
  const candidate = named ? input.candidates.find((name) => sameDisease(name, named) || sameDisease(diseaseNameWithRecordSubtype(name, input.recordText), named)) : "";
  if (named && (!candidate || sameDisease(candidate, input.disease))) return undefined;
  return { kind, point, recordQuote: input.recordText.slice(aligned.start, aligned.end), better: candidate || "", reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 40) : "" };
}

function parseConfirmedVerdict(content: unknown): boolean | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const value = (JSON.parse(content) as { confirmed?: unknown })?.confirmed;
    return typeof value === "boolean" ? value : undefined;
  } catch { return undefined; }
}

export async function checkDiseaseAgainstDiagnosisPoints(input: DiseasePointsInput, signal?: AbortSignal): Promise<DiseasePointsVerdict> {
  if (signal?.aborted || !diseasePointsCheckEnabled()) return { status: "fits" };
  const deterministic = deterministicDiseasePointsVerdict(input);
  if (deterministic.status === "mismatch") return deterministic;
  if (!diseasePointsCheckApplies(input)) return { status: "fits" };
  const reference = textbookDiseaseDiagnosisPoints(input.disease, input.ageYears)!;
  const candidates = input.candidates.filter((name) => !sameDisease(name, input.disease));
  const describe = (name: string) => ({ name: diseaseNameWithRecordSubtype(name, input.recordText), definition: textbookDiseaseDefinition(name, input.ageYears) || null });
  const record = sanitizeFreeTextForModel(input.recordText).slice(0, 2_400);
  const proposal = await proposeThenVerify<DiseasePointsProposal | undefined>(
    "m03_disease_points_check",
    "diagnose",
    {
      messages: [
        { role: "system", content: PROPOSE_SYSTEM },
        { role: "user", content: JSON.stringify({ disease: input.disease, book: reference.book, definition: reference.definition, diagnosisPoints: reference.points, chiefComplaint: sanitizeFreeTextForModel(input.chiefComplaint), record, candidates: candidates.map(describe) }) },
      ],
      maxTokens: 220,
      parse: (content) => parseDiseasePointsProposal(content, input),
    },
    (item) => ({
      messages: [
        { role: "system", content: VERIFY_SYSTEM },
        { role: "user", content: JSON.stringify({ disease: input.disease, diagnosisPoints: reference.points, record, claim: { kind: item.kind, point: item.point, recordQuote: item.recordQuote, better: describe(item.better) } }) },
      ],
      maxTokens: 120,
      parse: parseConfirmedVerdict,
    }),
    TIMEOUT_MS,
    signal,
  ).catch(() => undefined);
  return proposal ? { status: "mismatch", ...proposal, better: proposal.better ? diseaseNameWithRecordSubtype(proposal.better, input.recordText) : "" } : { status: "fits" };
}

/** 重抽辨证半时附在中医半提示词末尾的一段（只在 mismatch 时用）。 */
export function diseasePointsRedrawInstruction(disease: string, verdict: Extract<DiseasePointsVerdict, { status: "mismatch" }>): string {
  if (verdict.kind === "defining_missing" || verdict.kind === "refinement") return [
    "【病名须符合教材定义性表现】",
    verdict.kind === "defining_missing" ? `上一稿病名「${disease}」所需的「${verdict.point}」在病历中尚无肯定记载，不能把教材定义写成本例所见。` : `请核对「${disease}」与「${verdict.better}」的教材判别表现，只依据本例原文细分病名。`,
    `在原有【教材病证候选】闭集内重定病名${verdict.better ? `，优先核对「${verdict.better}」` : "，没有更合适的病则保留原名并写清待核实的定义性表现"}；根据病历重写本半，不补造症状、体征或检查。`,
  ].join("\n");
  const why = verdict.kind === "contradicted"
    ? `病历「${verdict.recordQuote}」与教材${disease}的诊断要点「${verdict.point}」相反`
    : `${disease}要靠「${verdict.point}」确立，病历写的是「${verdict.recordQuote}」`;
  return [
    "【病名须符合教材诊断要点（服务端核对）】",
    `上一稿把中医病名写成「${disease}」：${why}${verdict.reason ? `（${verdict.reason}）` : ""}，不作本次病名（可列入病名鉴别）。`,
    `请在【教材病证候选】里按病历另定病名${verdict.better ? `（如「${verdict.better}」）` : ""}，并据此重写本半全部内容：辨病依据、病名与证候鉴别、证候、病机与治法都按新的病名写。`,
  ].join("\n");
}
