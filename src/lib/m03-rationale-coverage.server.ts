import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

/**
 * 辨证依据漏讲已记录表现时，按病历把这一段重写一遍（2026-10-27 第二十五轮，甲方 10.26 测评「证候分析不全面」三份：病历 3 产后头痛
 * 没讲神疲、纳差、小便清长、大便稀溏；病历 11 只罗列「鼻塞流清涕、咽痒」再接一句「为风寒袭肺」；病历 2 混进证名以外的病机）。
 *
 * 第二十四轮已在中医半提示词里逐项列出「辨证依据要交代的已记录表现」（rationale-findings-checklist.ts），生产上仍有一次漏讲——
 * 漏项靠提示词与模型自评收不住。这里是生成之后的逐项核对：清单里有两项以上在依据里一个字也没提到时，交小模型按「表现→病机」
 * 逐组重写；重写稿要提到全部清单项、证名不出主证与兼证以外的名称、流派那句原样保留，否则用原稿。重写稿随后照常经过
 *「本例说法有无病历依据」的核对（m03-patient-claim-check.server.ts），由调用方负责。
 * 只改 overview.tcmDiagnosticRationale 一个字段；超时、未配置、输出不合格都原样返回。开关：CDSS_M03_RATIONALE_COVERAGE=false 关闭。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.M03_RATIONALE_COVERAGE_TIMEOUT_MS || 6_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 12_000 ? Math.round(value) : 6_000;
})();
const MAX_RECORD_CHARS = 2_400;
const MAX_RATIONALE_CHARS = 320;

export function rationaleCoverageEnabled(): boolean {
  return process.env.CDSS_M03_RATIONALE_COVERAGE !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const compact = (value: string) => value.normalize("NFKC").replace(/[\s，,。．.；;：:、（）()“”"'‘’！!？?]/gu, "");

/**
 * 依据有没有提到这一项：整词出现，或这一项里按先后取的两个字（中间最多隔一个字）在依据里连着出现
 *（「大便稀溏」与依据里的「便溏」、「食欲下降」与「食欲」）。宽一点只会少触发重写，不会多改。
 */
export function rationaleMentionsFinding(rationale: string, finding: string): boolean {
  const body = compact(rationale);
  const term = compact(finding);
  if (term.length === 0) return true;
  if (body.includes(term)) return true;
  for (let first = 0; first < term.length - 1; first += 1) {
    for (let second = first + 1; second <= first + 2 && second < term.length; second += 1) {
      if (body.includes(`${term[first]}${term[second]}`)) return true;
    }
  }
  return false;
}

export function missingRationaleFindings(rationale: string, findings: readonly string[]): string[] {
  return findings.filter((finding) => !rationaleMentionsFinding(rationale, finding));
}

/**
 * 依据有没有讲到主症（2026-10-27：甲方病历 10 有一次依据只讲经量、经色，没讲主症「月经周期缩短」，评审按甲方 10.12「不能遗漏主症」
 * 判不通过）。主症里任意两个字按先后在依据里相距不超过 6 个字（「胃痛」与「胃脘胀痛」、「牙痛」与「牙持续性胀痛」），
 * 或两个字倒过来紧挨着（「多汗」与「汗多」）。只在一个字也对不上时才算漏讲（病历 10「月经周期缩短」对「经量多、色紫红」）。
 */
export function rationaleMentionsChiefSymptom(rationale: string, phrase: string): boolean {
  const body = compact(rationale);
  const term = compact(phrase);
  if (term.length < 2) return true;
  for (let first = 0; first < term.length - 1; first += 1) {
    for (let second = first + 1; second < term.length; second += 1) {
      if (term[first] === term[second]) continue;
      if (body.includes(`${term[second]}${term[first]}`)) return true;
      for (let at = body.indexOf(term[first]); at >= 0; at = body.indexOf(term[first], at + 1)) {
        const next = body.indexOf(term[second], at + 1);
        if (next > at && next - at <= 6) return true;
      }
    }
  }
  return false;
}

/** 漏了两项以上（清单只有两三项时漏一项）才重写。 */
export function rationaleNeedsCoverageRewrite(missing: readonly string[], findings: readonly string[]): boolean {
  return missing.length >= 2 || (missing.length >= 1 && findings.length <= 3);
}

/** 流派视角那一句（「从…看，…」「…看…，本例…，以下按常规辨证处理」）：重写稿必须原样保留。 */
function lineageLensSentence(rationale: string): string | undefined {
  return rationale.split(/(?<=[。；;])/u).map((part) => part.trim()).find((part) => /以下按常规辨证处理|^从[^，,。]{1,16}看/u.test(part));
}

const SYNDROME_NAME = /[一-鿿]{2,8}证/gu;
/** 证名前常见的连接字：「属/为/于…」之后才是证名本身；「立/辨/按/与」之后是「另立证」「常规辨证」「与他证相别」这类说法。 */
const SYNDROME_SPAN_CONNECTOR = /[属为是系乃之的于即故示与及或立成按据从见辨证]/gu;

/**
 * 「…证」片段里真正的证名（2026-10-27：重写稿 19 份里 16 份被「无兼证」「以下按常规辨证」「可佐证」「属湿热中阻之主证」
 * 「属痰浊阻肺兼证」这类片段判成了外来证名）。「X之证」「X的主证」取 X；其余去掉证字前的「主/兼」；再从最后一个连接字之后取。
 * 只剩一个字（他证、主证）、以「无/非/另…」「不列/不立」起头（另无兼证、不列证）或以「佐/印/论/本/此」结尾（佐证、支持本证）的
 * 是说法不是证名，返回 undefined。
 */
export function syndromeNameInSpan(span: string): string | undefined {
  const possessive = /^(.*)[之的][主兼]?证$/u.exec(span);
  const head = possessive ? possessive[1] : span.replace(/[主兼]?证$/u, "");
  let cut = 0;
  for (const match of head.matchAll(SYNDROME_SPAN_CONNECTOR)) cut = (match.index ?? 0) + 1;
  const core = head.slice(cut);
  // 以「无/非/未/另/他/本/此/该」起头的是「另无兼证」「本证」这类说法；证名里的「不」（脾不统血、心肾不交）不能当否定词。
  if (core.length < 2 || /[佐印论本此该他]$/u.test(core) || /^[无非未另他本此该]/u.test(core) || /^不[列立成属]/u.test(core)) return undefined;
  return `${core}证`;
}

/** 重写稿里主证、兼证以外的证名；流派那句（原样保留、另行核对）不看，原依据、病名、病历里已有的说法不算外来。 */
export function foreignSyndromeNames(candidate: string, input: { rationale: string; primary: string; secondary: string[]; disease?: string; recordText?: string }): string[] {
  const allowed = [input.primary, ...input.secondary].map((name) => compact(name)).filter(Boolean);
  // 病名接「证」（心悸证、哮病证、绝经前后诸证）与病历原话接「证」不是新立的证候。
  const original = compact(`${input.rationale}${input.disease || ""}${input.recordText || ""}`);
  const body = candidate.split(/(?<=[。；;])/u)
    .filter((part) => !/以下按常规辨证处理|^从[^，,。]{1,16}看/u.test(part.trim()))
    .join("");
  const names = [...body.matchAll(SYNDROME_NAME)]
    .map((match) => syndromeNameInSpan(compact(match[0])))
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)].filter((name) => {
    if (allowed.some((item) => item.endsWith(name) || name.endsWith(item) || item.includes(name))) return false;
    return !original.includes(name.slice(0, -1));
  });
}

export function buildRationaleCoverageMessages(input: { recordText: string; disease: string; primary: string; secondary: string[]; rationale: string; findings: string[]; missing: string[] }) {
  const lens = lineageLensSentence(input.rationale);
  return [
    {
      role: "system" as const,
      content: "你是中医内科主治医师，只做一件事：把一段辨证依据按病历重写完整。只输出 JSON：{\"rationale\":\"…\"}。",
    },
    {
      role: "user" as const,
      content: [
        `病历：\n${input.recordText.slice(0, MAX_RECORD_CHARS)}`,
        `病名：${input.disease || "（未写）"}；主证：${input.primary}${input.secondary.length > 0 ? `；兼证：${input.secondary.join("、")}` : "；无兼证"}`,
        `原辨证依据：${input.rationale}`,
        `病历记录的这些表现必须逐项讲到：${input.findings.join("、")}（原依据漏了：${input.missing.join("、")}）。`,
        "重写要求：",
        "1. 不超过250字；先一句讲主诉主症为什么属于主证，再按「表现→病机」逐组讲清每一项属于哪一病机（舌象、脉象也要写进去，说明它们支持哪一病机）（如「大便稀溏、小便清长为脾肾阳气不足、运化失司」），不只罗列表现再接一句结论；有兼证时另用一句讲兼证依据。",
        "2. 主证能解释的表现说明怎样解释；主证解释不了的写它的病机归属，但不立新证、不出现主证与兼证以外的证名。这些要求本身不写进依据：不写「不立新证」「无兼证」「主证解释不了」「主诉主症」一类的话。",
        "3. 只写病历里有的表现，用病历原话，不补写病历没有的症状、舌脉或检查；不改证名，不写治法、方药，不写「未记录」以外的系统用语。",
        lens ? `4. 原依据里流派那一句原样放在最后：${lens}` : "4. 不写流派。",
      ].join("\n"),
    },
  ];
}

export type RewriteRejection = "length" | "missing" | "lost" | "foreign_syndrome" | "lineage";
export let lastRewriteRejection: RewriteRejection | undefined;
export let lastForeignSyndromeNames: string[] = [];
export function acceptedRationaleRewrite(candidate: string, input: { rationale: string; findings: string[]; missing: string[]; primary: string; secondary: string[]; disease?: string; recordText?: string }): string | undefined {
  const value = candidate.trim().replace(/\s+/gu, "");
  lastRewriteRejection = undefined;
  lastForeignSyndromeNames = [];
  if (value.length < 40 || value.length > MAX_RATIONALE_CHARS) { lastRewriteRejection = "length"; return undefined; }
  // 漏讲的必须都补上；原稿已讲到的最多丢一项（清单九项时要求一字不漏，九项全写进去的稿子大多超长或漏一项，实测一例都采不上）。
  if (missingRationaleFindings(value, input.missing).length > 0) { lastRewriteRejection = "missing"; return undefined; }
  const covered = input.findings.filter((finding) => !input.missing.includes(finding));
  if (missingRationaleFindings(value, covered).length > 1) { lastRewriteRejection = "lost"; return undefined; }
  const foreign = foreignSyndromeNames(value, input);
  if (foreign.length > 0) { lastRewriteRejection = "foreign_syndrome"; lastForeignSyndromeNames = foreign.slice(0, 3); return undefined; }
  const lens = lineageLensSentence(input.rationale);
  if (lens && !value.includes(lens.replace(/\s+/gu, ""))) { lastRewriteRejection = "lineage"; return undefined; }
  return value;
}

/**
 * 中医半内容（JSON 文本）→ 漏讲时重写辨证依据后的内容；不需要或不合格时原样返回。
 * findings 来自 rationaleFindingsChecklist（事实层「明确存在」且引文在病历原文里的表现，去掉主诉已有的）。
 */
export async function completeRationaleCoverage(
  content: string,
  context: { recordText: string; findings: readonly string[]; chiefFindings?: readonly string[] },
  signal?: AbortSignal,
): Promise<string> {
  const chiefFindings = [...(context.chiefFindings || [])];
  if (!rationaleCoverageEnabled() || signal?.aborted || (context.findings.length < 2 && chiefFindings.length === 0)) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content)); } catch { return content; }
  const overview = record(root?.overview);
  if (!root || !overview) return content;
  const rationale = text(overview.tcmDiagnosticRationale);
  const primary = text(overview.primarySyndrome);
  if (!rationale || !primary) return content;
  // 主症没讲到时单凭这一项也重写，排在漏项最前；其余照「漏两项以上」。
  const chiefMissing = chiefFindings.filter((item) => !rationaleMentionsChiefSymptom(rationale, item));
  const findings = [...new Set([...chiefFindings, ...context.findings])];
  const missing = [...chiefMissing, ...missingRationaleFindings(rationale, context.findings.filter((item) => !chiefFindings.includes(item)))];
  if (chiefMissing.length === 0 && (context.findings.length < 2 || !rationaleNeedsCoverageRewrite(missing, findings))) return content;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return content;
  const secondary = Array.isArray(overview.secondarySyndromes) ? overview.secondarySyndromes.map(text).filter(Boolean) : [];
  const input = { recordText: context.recordText, disease: text(overview.tcmDiseaseName), primary, secondary, rationale, findings, missing };
  const messages = buildRationaleCoverageMessages(input);
  const rewritten = await memoizedSmallTask<string | undefined>("m03_rationale_coverage", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "m03_rationale_coverage", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 600,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      let parsed: Json | undefined;
      try { parsed = record(JSON.parse(response.choices[0]?.message?.content || "")); } catch { parsed = undefined; }
      const value = acceptedRationaleRewrite(text(parsed?.rationale), input);
      return { value, cacheable: Boolean(value) };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
  console.info("[tcm-cdss:telemetry] m03_rationale_coverage", { findings: findings.length, missing: missing.length, chiefMissing: chiefMissing.length, rewritten: Boolean(rewritten), rejected: rewritten ? undefined : lastRewriteRejection });
  if (!rewritten) return content;
  overview.tcmDiagnosticRationale = rewritten;
  return JSON.stringify(root);
}
