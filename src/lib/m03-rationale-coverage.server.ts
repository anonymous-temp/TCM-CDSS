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

/** 漏了两项以上（清单只有两三项时漏一项）才重写。 */
export function rationaleNeedsCoverageRewrite(missing: readonly string[], findings: readonly string[]): boolean {
  return missing.length >= 2 || (missing.length >= 1 && findings.length <= 3);
}

/** 流派视角那一句（「从…看，…」「…看…，本例…，以下按常规辨证处理」）：重写稿必须原样保留。 */
function lineageLensSentence(rationale: string): string | undefined {
  return rationale.split(/(?<=[。；;])/u).map((part) => part.trim()).find((part) => /以下按常规辨证处理|^从[^，,。]{1,16}看/u.test(part));
}

const SYNDROME_NAME = /[一-鿿]{2,8}证/gu;

function buildMessages(input: { recordText: string; disease: string; primary: string; secondary: string[]; rationale: string; findings: string[]; missing: string[] }) {
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
        "1. 不超过250字；先一句讲主诉主症为什么属于主证，再按「表现→病机」逐组讲清每一项属于哪一病机（如「大便稀溏、小便清长为脾肾阳气不足、运化失司」），不只罗列表现再接一句结论；有兼证时另用一句讲兼证依据。",
        "2. 主证能解释的表现说明怎样解释；主证解释不了的写它的病机归属，但不立新证、不出现主证与兼证以外的证名。",
        "3. 只写病历里有的表现，用病历原话，不补写病历没有的症状、舌脉或检查；不改证名，不写治法、方药，不写「未记录」以外的系统用语。",
        lens ? `4. 原依据里流派那一句原样放在最后：${lens}` : "4. 不写流派。",
      ].join("\n"),
    },
  ];
}

export type RewriteRejection = "length" | "missing" | "lost" | "foreign_syndrome" | "lineage";
export let lastRewriteRejection: RewriteRejection | undefined;
function acceptedRewrite(candidate: string, input: { rationale: string; findings: string[]; missing: string[]; primary: string; secondary: string[] }): string | undefined {
  const value = candidate.trim().replace(/\s+/gu, "");
  lastRewriteRejection = undefined;
  if (value.length < 40 || value.length > MAX_RATIONALE_CHARS) { lastRewriteRejection = "length"; return undefined; }
  // 漏讲的必须都补上；原稿已讲到的最多丢一项（清单九项时要求一字不漏，九项全写进去的稿子大多超长或漏一项，实测一例都采不上）。
  if (missingRationaleFindings(value, input.missing).length > 0) { lastRewriteRejection = "missing"; return undefined; }
  const covered = input.findings.filter((finding) => !input.missing.includes(finding));
  if (missingRationaleFindings(value, covered).length > 1) { lastRewriteRejection = "lost"; return undefined; }
  const allowed = [input.primary, ...input.secondary].map((name) => compact(name));
  const foreign = [...value.matchAll(SYNDROME_NAME)].map((match) => compact(match[0]))
    .filter((name) => !allowed.some((item) => item.endsWith(name) || name.endsWith(item) || item.includes(name)));
  if (foreign.length > 0) { lastRewriteRejection = "foreign_syndrome"; return undefined; }
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
  context: { recordText: string; findings: readonly string[] },
  signal?: AbortSignal,
): Promise<string> {
  if (!rationaleCoverageEnabled() || signal?.aborted || context.findings.length < 2) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content)); } catch { return content; }
  const overview = record(root?.overview);
  if (!root || !overview) return content;
  const rationale = text(overview.tcmDiagnosticRationale);
  const primary = text(overview.primarySyndrome);
  if (!rationale || !primary) return content;
  const findings = [...context.findings];
  const missing = missingRationaleFindings(rationale, findings);
  if (!rationaleNeedsCoverageRewrite(missing, findings)) return content;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return content;
  const secondary = Array.isArray(overview.secondarySyndromes) ? overview.secondarySyndromes.map(text).filter(Boolean) : [];
  const input = { recordText: context.recordText, disease: text(overview.tcmDiseaseName), primary, secondary, rationale, findings, missing };
  const messages = buildMessages(input);
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
      const value = acceptedRewrite(text(parsed?.rationale), input);
      return { value, cacheable: Boolean(value) };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
  console.info("[tcm-cdss:telemetry] m03_rationale_coverage", { findings: findings.length, missing: missing.length, rewritten: Boolean(rewritten), rejected: rewritten ? undefined : lastRewriteRejection });
  if (!rewritten) return content;
  overview.tcmDiagnosticRationale = rewritten;
  return JSON.stringify(root);
}
