import "server-only";

import { parseConfirmed, proposeThenVerify } from "./cross-model-small-task.server";
import { chiefComplaintLeadSegment } from "./m03-visit-reason-check.server";
import { isCleanWesternDiagnosisName, listedWesternDiagnosisNames, withoutTrailingCourse } from "./western-name-evidence-check.server";

/**
 * 西医主诊断要能解释本次就诊（2026-11-02 第三十六轮，甲方 11/2：主诉「肌肉拉伤」，过敏史写柳絮过敏、查体写鼻腔黏膜充血，
 * 三次生成主诊断都是「过敏性鼻炎」）。提示词早有「primary 必须优先解释本次主诉」，模型还是被写得最详细的那段带走。
 *
 * 做法同治法核对：deepseek-flash 提名、qwen3.8-flash 只对这一条答对错，两边都说解释不了才改；与病名核对并行，不增加串行等待。
 *  · 只问主诉和主诊断的关系，「常见原因、并发症、后果」都算解释得了（高血压解释头晕，第三十二轮的口径）；
 *  · 改成西医半自己列的能解释主诉的病，没有就用主诉本身的说法；原诊断留在鉴别里，写明是主诉之外另记录的情况；
 *  · 红旗病例不改（急危重的首要考虑不换）；主诉里写了病名本身或已是「待查」的不问；任何失败保持原样。
 * 开关：CDSS_WESTERN_VISIT_REASON_CHECK=false 关闭。
 */
const TIMEOUT_MS = 5_000;
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");

/** 主诉的主要问题：去掉伴随项（伴/兼/合并/括号之后）与病程。 */
export function chiefComplaintLeadProblem(chiefComplaint: string): string {
  const lead = chiefComplaintLeadSegment(chiefComplaint.normalize("NFKC")).split(/[，,；;。]/u)[0].replace(/^(?:反复|发现)/u, "");
  return withoutTrailingCourse(lead).trim();
}

function sharesTwoCharacters(left: string, right: string): boolean {
  const a = compact(left);
  for (let index = 0; index + 2 <= a.length; index += 1) if (compact(right).includes(a.slice(index, index + 2))) return true;
  return false;
}

export function visitReasonCheckApplies(primaryName: string, chiefComplaint: string, redFlag?: boolean): boolean {
  if (process.env.CDSS_WESTERN_VISIT_REASON_CHECK === "false" || redFlag) return false;
  const lead = chiefComplaintLeadProblem(chiefComplaint);
  if (lead.length < 2 || !primaryName.trim() || /待查$/u.test(primaryName.trim())) return false;
  return !sharesTwoCharacters(lead, primaryName);
}

const PROPOSE_SYSTEM = `你只判断一件事：西医主诊断能不能解释病人这次来看的问题。给你 chiefComplaint（主诉）、current（主诊断）、listed（候选与鉴别）和 record（病历）。
先写 relation：主诉的问题和这个诊断是什么关系（是它的表现、并发症、后果，或它是主诉的常见原因，就写出来）。
是这几种关系之一的，explains 为 true，哪怕诊断还不确定；主诉有几个问题时，能解释其中一个就算解释得了。只有主诉的问题和这个诊断毫无关系、这个诊断解释的是病历别处的内容（过敏史、既往史、别的部位的查体）时，explains 才为 false。
explains 为 false 时，在 listed 里找能解释主诉的病名写进 betterName，没有就写空字符串。不要写 listed 以外的病名。
只输出 JSON：{"relation":"≤30字","explains":true|false,"betterName":""}`;

const VERIFY_SYSTEM = `给你主诉 chiefComplaint 和西医诊断 current。判断：这个诊断确实解释不了这个主诉吗？该诊断的表现、并发症或后果里包含主诉的问题，或它是主诉的常见原因，就算解释得了，答 false；主诉有几个问题时，能解释其中一个也答 false；两者毫无关系才答 true。先写理由。只输出 JSON：{"why":"≤30字","confirmed":true|false}`;

export type WesternVisitReasonDecision = { checkedName: string; name: string; lead: string };

function parseProposal(listed: readonly string[]) {
  return (content: unknown): { betterName: string } | null | undefined => {
    if (typeof content !== "string") return undefined;
    try {
      const parsed = record(JSON.parse(content));
      if (parsed?.explains === true) return null;
      if (parsed?.explains !== false) return undefined;
      const better = typeof parsed.betterName === "string" ? parsed.betterName.trim() : "";
      return { betterName: listed.some((item) => compact(item) === compact(better)) ? better : "" };
    } catch {
      return undefined;
    }
  };
}

export async function westernVisitReasonDecision(
  westernContent: string,
  context: { recordText: string; chiefComplaint: string; redFlag?: boolean },
  signal?: AbortSignal,
): Promise<WesternVisitReasonDecision | undefined> {
  let current = "";
  let listed: string[] = [];
  try {
    const western = record(record(JSON.parse(westernContent))?.westernDiagnosis);
    current = String(record(western?.primary)?.name || "").trim();
    listed = listedWesternDiagnosisNames(western);
  } catch {
    return undefined;
  }
  if (!visitReasonCheckApplies(current, context.chiefComplaint, context.redFlag)) return undefined;
  const lead = chiefComplaintLeadProblem(context.chiefComplaint);
  const proposal = await proposeThenVerify<{ betterName: string } | null>("western_visit_reason", "diagnose", {
    messages: [
      { role: "system", content: PROPOSE_SYSTEM },
      { role: "user", content: JSON.stringify({ chiefComplaint: context.chiefComplaint, current, listed, record: context.recordText.slice(0, 2_400) }) },
    ],
    maxTokens: 120,
    parse: parseProposal(listed),
  }, () => ({
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      { role: "user", content: JSON.stringify({ chiefComplaint: context.chiefComplaint, current }) },
    ],
    maxTokens: 80,
    parse: parseConfirmed,
  }), TIMEOUT_MS, signal);
  if (!proposal) return undefined;
  const name = proposal.betterName || lead;
  if (!isCleanWesternDiagnosisName(name) || compact(name) === compact(current)) return undefined;
  console.info("[tcm-cdss:telemetry] western_visit_reason_check", { currentName: current.slice(0, 30), name: name.slice(0, 30) });
  return { checkedName: current, name, lead };
}

/** 落到最终内容上：核对的那个病名已被别的核对改掉时不动。 */
export function applyWesternVisitReasonDecision(westernContent: string, decision: WesternVisitReasonDecision | undefined): string {
  if (!decision) return westernContent;
  try {
    const root = record(JSON.parse(westernContent));
    const western = record(root?.westernDiagnosis);
    const primary = record(western?.primary);
    if (!root || !western || !primary || String(primary.name || "").trim() !== decision.checkedName) return westernContent;
    const previous = decision.checkedName;
    primary.name = decision.name;
    primary.clinicalRationale = decision.name === decision.lead
      ? `本次就诊的问题是${decision.lead}，先按此诊断；病历另记录的表现提示${previous}，它解释不了本次主诉，单独考虑。`
      : `本次就诊的问题是${decision.lead}，考虑${decision.name}；病历另记录的表现提示${previous}，它解释不了本次主诉，单独考虑。`;
    const others = (key: string) => (Array.isArray(western[key]) ? western[key] as unknown[] : [])
      .filter((item) => { const name = record(item)?.name; return name !== previous && name !== decision.name; });
    const adopted = (Array.isArray(western.candidates) ? western.candidates as unknown[] : []).find((item) => record(item)?.name === decision.name);
    western.candidates = [
      adopted || { name: decision.name, likelihood: "中", keyEvidence: [], againstEvidence: [] },
      { name: previous, likelihood: "低", keyEvidence: [], againstEvidence: [] },
      ...others("candidates"),
    ].slice(0, 3);
    western.differentials = [
      { name: previous, reason: "主诉之外另记录的情况", distinguishingPoints: "解释不了本次主诉，按其本身的表现另行评估", nextCheck: "必要时相关专科评估" },
      ...others("differentials"),
    ].slice(0, 8);
    return JSON.stringify(root);
  } catch {
    return westernContent;
  }
}
