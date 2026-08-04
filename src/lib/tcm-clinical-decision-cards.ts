import type { CaseState } from "./diagnosis-types";
// 导入属性不可省略：`node --experimental-strip-types` 下缺 `with { type: "json" }` 会直接
// ERR_IMPORT_ATTRIBUTE_MISSING（test:customer-evidence 走的正是该运行方式；jiti 不受影响，
// 所以只有那一个套件红）。src/lib 下其余 JSON 导入一律带该属性。
import cardSource from "../data/tcm-clinical-decision-cards.source.json" with { type: "json" };

/**
 * 甲方「中医相关卡片」临床决策卡片接入层。
 *
 * ── 定性(决定了下面每一处边界,改动前先读) ───────────────────────────────
 * 这批卡片是**厂商编写的二次综述型决策参考**,不是受治理规则:
 *   · 每份都带「参考文献」段,但全库 0 条 DOI / 0 条 PMID,机器无法核验到具体条目;
 *   · 卡片自述的底层证据多为「单中心、小样本 RCT」「方法学质量普遍偏低,存在发表偏倚」;
 *   · 内容里夹带剂量级建议与西药方案(生成物 summary.cardsWithDoseLevelContent 可查)。
 * 按项目「一切结论必须可追溯」的原则,它只能定级为 expert_decision_reference。
 *
 * ── 因此接入方式是「证据上下文里的**非引用**参考段」+「医生可见参考展示」 ─────────
 * 允许:作为 M03/M04 提示词里的辨证思路提示(与 EviMed 并列的一段,但**标注为不可引用**)。
 * 禁止:
 *   ① 不参与方证召回打分 —— relatedFormulas/relatedSyndromes 只是**索引提示**,
 *      不喂给任何候选方排序或一致性校验;
 *   ② 不作为剂量、配伍、禁忌或风险结论的依据 —— 这些仍由确定性规则层与灵犀审方裁定;
 *   ③ 不进入客户可见引用白名单 —— 卡片行统一带 CLINICAL_DECISION_CARD_LINE_MARKER,
 *      evidence-source-validation.ts 的 buildEvidenceScope **逐行跳过**这些行。
 *      于是卡片里的期刊题名、年份、URL 都不会被登记为可引用来源;模型即使复述,
 *      证据清洗层也会把它剥掉或把 evidence 降级为 insufficient。
 * 这条「注入可见、引用不可用」的分离,是本文件存在的全部理由。
 */

/** 每条卡片行的行内标记。buildEvidenceScope 依赖它把卡片行排除出可引用来源白名单。 */
export const CLINICAL_DECISION_CARD_LINE_MARKER = "CDSS_EXPERT_CARD";

export type ClinicalDecisionCardEvidenceTier = "expert_decision_reference";

export type ClinicalDecisionCard = {
  cardId: string;
  title: string;
  conclusion: string;
  rationale: string;
  topics: string[];
  relatedFormulas: string[];
  relatedSyndromes: string[];
  evidenceTier: ClinicalDecisionCardEvidenceTier;
  provenance: {
    referenceCount: number;
    hasPersistentIdentifier: boolean;
    hasReferenceUrl: boolean;
    hasEvidenceBoundarySection: boolean;
    containsDoseLevelContent: boolean;
  };
  sourceRef: {
    driveFileName: string;
    driveFolder: string;
    documentSha256: string;
  };
};

type ClinicalDecisionCardSource = {
  schemaVersion: string;
  governance: {
    status: string;
    runtimePolicy: string;
    evidenceTierRationale: string;
    citableAsCustomerEvidence: boolean;
    drivesDeterministicDecisions: boolean;
  };
  summary: Record<string, number>;
  cards: ClinicalDecisionCard[];
};

const source = cardSource as unknown as ClinicalDecisionCardSource;

export const CLINICAL_DECISION_CARD_GOVERNANCE = source.governance;

export function clinicalDecisionCards(): readonly ClinicalDecisionCard[] {
  return source.cards;
}

const CONTEXT_CARD_LIMIT = 6;
const CONCLUSION_CONTEXT_LIMIT = 160;

function caseKeywordText(caseState: CaseState): string {
  const parts: unknown[] = [
    caseState.chiefComplaint,
    caseState.tongue,
    caseState.pulse,
    caseState.tongueImageDesc,
    ...Object.values(caseState.symptoms || {}),
    caseState.reasoningDiagnose?.overview?.primarySyndrome,
    ...(caseState.reasoningDiagnose?.overview?.primarySyndromeBasis || []),
    caseState.reasoningDiagnose?.westernDiagnosis?.primary?.name,
  ];
  return parts
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("；");
}

/**
 * 按本例文本与卡片索引词的重合度挑卡片。纯字符串包含,不做模糊推断——
 * 这里选出来的只是“给医生和模型看的参考”,选错的代价是噪声,不是错误结论,
 * 所以宁可用最笨、最可解释的规则,也不引入会被误当成召回信号的打分。
 */
export function selectClinicalDecisionCards(
  caseState: CaseState,
  limit = CONTEXT_CARD_LIMIT,
): ClinicalDecisionCard[] {
  const text = caseKeywordText(caseState);
  if (!text.trim()) return [];
  const scored = source.cards
    .map((card) => {
      const hits = [...new Set([...card.relatedSyndromes, ...card.relatedFormulas, ...card.topics])]
        .filter((term) => term.length >= 2 && text.includes(term));
      return { card, score: hits.length, hits };
    })
    .filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score || a.card.cardId.localeCompare(b.card.cardId));
  return scored.slice(0, Math.max(0, limit)).map((item) => item.card);
}

const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

function contextLine(card: ClinicalDecisionCard): string {
  const conclusion = singleLine(card.conclusion);
  const clipped = conclusion.length > CONCLUSION_CONTEXT_LIMIT
    ? `${conclusion.slice(0, CONCLUSION_CONTEXT_LIMIT)}…`
    : conclusion;
  const fields = [
    `${CLINICAL_DECISION_CARD_LINE_MARKER} 卡片：${singleLine(card.title)}`,
    `结论：${clipped}`,
    card.relatedSyndromes.length ? `关联证候：${card.relatedSyndromes.join("、")}` : "",
    card.relatedFormulas.length ? `关联方剂：${card.relatedFormulas.join("、")}` : "",
    `等级：${card.evidenceTier}（不可引用）`,
    `来源：${card.sourceRef.driveFileName}`,
  ].filter(Boolean);
  return `- ${fields.join(" ｜ ")}`;
}

/**
 * 供 M03/M04 提示词使用的卡片参考段。整段的每一行卡片都带行内标记,
 * 保证 buildEvidenceScope 不会把卡片内容登记成可引用来源。
 */
export function buildClinicalDecisionCardContext(caseState: CaseState): string {
  const cards = selectClinicalDecisionCards(caseState);
  if (cards.length === 0) return "";
  return [
    "## 厂商临床决策卡片（专家决策参考，非证据来源）",
    "使用要求：以下卡片由甲方提供，属二次综述型专家参考，证据等级 expert_decision_reference——" +
      "带参考文献但无 DOI/PMID，无法机器核验，其底层研究多为单中心小样本。" +
      "只能用作辨证与鉴别的思路提示；" +
      "**不得**写入客户可见的证据依据/引用来源字段，**不得**作为剂量、配伍、禁忌或风险结论的依据，" +
      "**不得**据此替代受治理方剂目录与确定性规则。结论仍须回到患者事实、确定性规则与受治理知识库。",
    ...cards.map(contextLine),
  ].join("\n");
}

/** 医生侧参考展示(接入方式 c):标注等级与来源，供人工查阅，不参与任何自动判定。 */
export function clinicalDecisionCardsForClinicianReference(
  caseState: CaseState,
  limit = CONTEXT_CARD_LIMIT,
): Array<{
  cardId: string;
  title: string;
  conclusion: string;
  evidenceTier: ClinicalDecisionCardEvidenceTier;
  evidenceNote: string;
  sourceLabel: string;
}> {
  return selectClinicalDecisionCards(caseState, limit).map((card) => ({
    cardId: card.cardId,
    title: card.title,
    conclusion: card.conclusion,
    evidenceTier: card.evidenceTier,
    evidenceNote: card.provenance.hasPersistentIdentifier
      ? "厂商决策卡片；含可核验文献标识，仍为专家参考，不作为确定性依据。"
      : "厂商决策卡片；所附文献无 DOI/PMID，无法机器核验，仅供医生参考，不作为确定性依据。",
    sourceLabel: `${card.sourceRef.driveFolder}｜${card.sourceRef.driveFileName}`,
  }));
}
