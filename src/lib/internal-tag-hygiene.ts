/**
 * Single sanitization boundary for doctor-visible clinical narrative.
 *
 * 甲方评测(2026-08-04) 呈现层第 1 条：「方义解析混入 L0/L1/L3 等工程标签」。
 *
 * 根因不是「模型偶尔多写了三个字符串」，而是**工程分层词表被逐字放进了模型上下文**：
 * `clinical-inference-authority.ts` 的推理权威合同用 L0–L4 给语义层编号并注入 M03 生成/复核
 * /裁决三个 prompt，模型可以把这些记号写回 `pathogenesis.chain[].pathogenesis` 和
 * `therapyDirection`；这些字段又被 M04 prompt 原样中继、被 `buildFormulaAnalysis` 加引号
 * 抄进方义解析（甲方看到的形态是 `L0/L1/L3`）。同类问题还有确定性侧的 `tier=canon` /
 * `anchorLevel=tiaowen` / `evidenceLevel=kb_entry`——它们是内部枚举，却被直接 `${}` 进
 * 医生可见 Markdown；这一类在归档产出里可以逐条复现（见测试的 tier/anchorLevel 断言）。
 *
 * 因此本模块**按类治理，不按实例**：
 *  1. 生成侧已把 L0–L4 改成「第N层「层名」」（见 clinical-inference-authority.ts），模型上下文里
 *     不再存在可被回声的 `L\d` 记号；确定性打印点改用中文标签映射。本模块是这两条根修之上的兜底网。
 *  2. 兜底网的记号集合**从各内部词表推导**：层名直接从推理权威合同正文里解析出来（改名即自动跟随，
 *     不会漂移），枚举记号从 EVIDENCE_LEVELS、经典证据 tier/anchorLevel、方内结构角色推导。
 *     新增一个内部枚举值，`scripts/test-visible-output-hygiene.mjs` 会自动把它纳入断言。
 *  3. 只清洗**叙述性字段**。机器取值字段（targetKind / evidenceLevel / candidateId / coding.code …）
 *     由 `isMachineValuedKey` 豁免：它们本来就该是英文枚举或代码，是下游合同、签名与 HIS 的输入。
 *
 * ─── 为什么净化必须比「见到 L\d 就删」保守 ────────────────────────────────────────────
 * 对 artifacts/ 下 1440 份归档产出做过一次全量形态普查，`\bL\d+\b` 命中 180 处，
 * **全部是 ICD-10 皮肤科编码**（L50.801 荨麻疹 / L30.901 皮炎 / L23.900 接触性皮炎），
 * 零处是层号。同一形态还覆盖椎体节段（L1椎体、L4/L5、T12-L1）与检验项（T3/T4、补体C3/C4）。
 * 无条件删除会把 `L50.801` 改成 `801`、把「L1椎体压缩性骨折」改成「椎体压缩性骨折」——
 * 那是**篡改临床事实**，比漏一个工程标签严重得多。本模块因此：
 *  · 绝不触碰更长代码里的片段（前后紧邻 `[A-Za-z0-9._/-]` 一律放行）；
 *  · 裸 `L\d` 只在同一段文本里**存在层号证据**时才删（见 legacyLayerTagEvidence）；
 *  · 不再对 `T\d` 做通用清洗——受治理表编号 T1–T12 与 T3/T4 甲功、C3/C4 补体形态完全重合，
 *    该类的真实泄漏会由 snake_case / camelCase / 层名三条规则接住。
 */

import { M03_CLINICAL_INFERENCE_AUTHORITY } from "./clinical-inference-authority";
import { EVIDENCE_LEVELS } from "./cdss-vocab";

/**
 * 经典证据分级与锚点级别的医生可见标签。枚举本身定义在 `tcm-classic-evidence.server.ts` /
 * `tcm-classic-inference.ts`（服务端模块），标签放在这里以便可见层与测试共用同一张表。
 */
export const CLASSIC_EVIDENCE_TIER_LABELS: Record<string, string> = {
  canon: "经典原文",
  common: "通行注疏",
  experience: "临床经验",
};

export const CLASSIC_EVIDENCE_ANCHOR_LABELS: Record<string, string> = {
  tiaowen: "条文",
  chapter_paragraph: "篇章段落",
  page_paragraph: "页段",
};

/** 方内结构角色枚举的可见标签（枚举在 herb-target-contract.ts）。 */
export const FORMULA_STRUCTURE_ROLE_LABELS: Record<string, string> = {
  middle_jiao_support: "顾护中焦",
  harmonize: "调和诸药",
  guide: "引经载药",
  temper: "制约峻烈",
};

/**
 * 值本身就是内部枚举/标识符/代码的字段：这些字段**不做叙述清洗**。
 *
 * 用「显式集合 ∪ 结构后缀」而不是纯白名单：`candidateId` 这类字段每加一个就要有人记得登记，
 * 忘了登记的后果是 ICD-10 编码 `L50.801` 被洗成 `801`（本模块上一版的真实缺陷）。
 * 凡以 Id/Code/Ref/Hash/Signature/Version/Fingerprint/Kind/Level/Status 结尾的键，
 * 按约定就是机器取值，一律豁免。
 */
export const MACHINE_VALUED_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "stage",
  "tier",
  "anchorLevel",
  "evidenceTier",
  "targetKind",
  "structureRole",
  "constructionType",
  "resolution",
  "priority",
  "outcome",
  "acceptanceScope",
  "reviewer",
  "provider",
  "model",
  "source",
  "citation",
  "id",
  "code",
  "icd10",
  "namespace",
  "canonical",
  "resolvedBy",
]);

const MACHINE_VALUED_KEY_SUFFIX =
  /(?:Id|Ids|Code|Codes|Ref|Refs|Hash|Signature|Version|Fingerprint|Kind|Level|Status|Type|Path|Url|At)$/;

export function isMachineValuedKey(key: string | undefined): boolean {
  if (!key) return false;
  return MACHINE_VALUED_KEYS.has(key) || MACHINE_VALUED_KEY_SUFFIX.test(key);
}

/**
 * 推理层名**从合同正文解析**，不在这里重抄一遍。
 *
 * 单一来源的意义不只是少写一处：层名一旦被重命名（本轮就从 `L2 证候归纳层` 改成
 * `第三层「证候归纳」`），手抄的兜底表会静默失效——净化器还在找旧名字，新名字照样漏出去，
 * 而所有测试仍然是绿的。解析合同则改名即自动跟随。
 */
const CONTRACT_LAYER_NAMES: readonly string[] = [
  ...new Set([...M03_CLINICAL_INFERENCE_AUTHORITY.matchAll(/第[一二三四五六七八九十]层「([^」]{2,8})」/g)]
    .map((match) => match[1])),
];

/** 层序标记（第N层）。临床正文不会用「第三层」指代结论，出现即内部推理纪律泄漏。 */
const ORDINAL_LAYER_MARKER = /第[一二三四五六七八九十]层/g;

/**
 * 带「层」后缀的层名（旧合同形态 `证候归纳层`）。只认带后缀的形态：
 * 裸的「病机治法」可能是医生正文里的正常表述，「病机治法层」不可能是。
 */
const DERIVED_LAYER_NAME = CONTRACT_LAYER_NAMES.length > 0
  ? new RegExp(`(?:${CONTRACT_LAYER_NAMES.join("|")})层`, "g")
  : /(?!)/g;

/** 更长的拉丁代码片段（ICD-10、椎体节段、检验缩写）：命中即整体放行。 */
const CODE_NEIGHBOUR = /[A-Za-z0-9._/\-]/;

/** 旧层号 `L\d`（含 `L0-L3` 这类区间）。是否真的清洗由 legacyLayerTagEvidence 决定。 */
const LEGACY_LAYER_TAG = /L\d{1,2}(?:\s*[-–—~/]\s*L\d{1,2})*(?:\s*[层级])?/g;

/** snake_case ASCII 标识符在本仓库里一律是内部枚举/驳回码，中文临床正文不会出现。 */
const SNAKE_CASE_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * `字段名` 形态的裸 camelCase 内部字段名。
 * 真实医学缩写的大小写混排（HbA1c / SpO2 / mmHg）由 CLINICAL_ABBREVIATION_GUARD 放行。
 */
const CAMEL_CASE_FIELD = /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g;

/**
 * 内部标定元数据的**赋值形态**（`confidence: 0.82`、`score=3`）。
 * 只认 ASCII 键名：中文的「置信度：低」是医生可见的证据强度表述（evidence.confidence
 * 本来就渲染成 低/中/高），删它等于删临床信息。
 */
const ASCII_METADATA_ASSIGNMENT = /\b(?:confidence|score|weight|threshold|probability|rank)\s*[:=]\s*[0-9]+(?:\.[0-9]+)?%?/gi;

/** 允许留在临床正文里的拉丁记号（真实医学缩写/单位/检验项）。 */
const CLINICAL_ABBREVIATION_GUARD = /^(?:mg|ml|mL|g|kg|mmHg|bpm|IU|pH|CT|MRI|MR|BP|HR|RR|SpO2|ECG|EKG|HbA1c|eGFR|BMI|COPD|OSA|TSH|ALT|AST|CRP|WBC|RBC|PLT|LDL|HDL|BUN|Cr|Hb|PSA|PET|DR|US|IgE|IgG)$/i;

/** 从内部词表推导出的裸枚举记号（非 snake_case 的单词形态）。 */
const DERIVED_BARE_ENUM_TOKENS: readonly string[] = [
  ...EVIDENCE_LEVELS,
  ...Object.keys(CLASSIC_EVIDENCE_TIER_LABELS),
  ...Object.keys(CLASSIC_EVIDENCE_ANCHOR_LABELS),
  ...Object.keys(FORMULA_STRUCTURE_ROLE_LABELS),
  "resolved",
  "bounded",
  "unresolved",
  "unrestricted",
  "accepted",
  "repair",
  "advisory",
  "block",
].filter((token) => !token.includes("_"));

const BARE_ENUM_TOKEN = new RegExp(`\\b(?:${[...new Set(DERIVED_BARE_ENUM_TOKENS)].join("|")})\\b`, "g");

/**
 * 这段文本里是否存在**层号证据**——只有存在时才清洗裸 `L\d`。
 *
 * 证据的三种形态，都是临床正文不可能出现的：
 *  · `L0`：椎体从 L1 起、ICD-10 皮肤科从 L00 起（三位），裸 `L0` 只可能是层号；
 *  · `L\d` 紧跟「层」或「级」；
 *  · 同段文本里已出现层序标记或带后缀的层名（`第三层` / `证候归纳层`）。
 * 三者皆无时，`L1`–`L5` 按椎体节段/编码处理，原样保留。
 */
function legacyLayerTagEvidence(text: string): boolean {
  if (/(?<![A-Za-z0-9.])L0(?![0-9.])/.test(text)) return true;
  if (/(?<![A-Za-z0-9._/-])L\d{1,2}\s*[层级]/.test(text)) return true;
  return new RegExp(ORDINAL_LAYER_MARKER.source).test(text) ||
    new RegExp(DERIVED_LAYER_NAME.source).test(text);
}

type TagRule = {
  id: string;
  pattern: RegExp;
  /** 该规则是否在这段文本上生效（默认恒生效）。 */
  active?: (text: string) => boolean;
};

/**
 * 完整的内部记号形态清单。测试直接消费它，因此「新增一类记号」与「测试覆盖该类」是同一处改动。
 */
export const INTERNAL_TAG_RULES: readonly TagRule[] = [
  { id: "ordinal_layer_marker", pattern: ORDINAL_LAYER_MARKER },
  { id: "inference_layer_name", pattern: DERIVED_LAYER_NAME },
  { id: "legacy_layer_tag", pattern: LEGACY_LAYER_TAG, active: legacyLayerTagEvidence },
  { id: "snake_case_token", pattern: SNAKE_CASE_TOKEN },
  { id: "bare_enum_token", pattern: BARE_ENUM_TOKEN },
  { id: "ascii_metadata_assignment", pattern: ASCII_METADATA_ASSIGNMENT },
  { id: "camel_case_field", pattern: CAMEL_CASE_FIELD },
];

/** 该命中是否应当被当作内部记号处理（拉丁代码片段与真实医学缩写放行）。 */
function isInternalTagHit(id: string, text: string, hit: string, index: number): boolean {
  const before = index > 0 ? text[index - 1] : "";
  const after = index + hit.length < text.length ? text[index + hit.length] : "";
  if (CODE_NEIGHBOUR.test(before) || CODE_NEIGHBOUR.test(after)) return false;
  const bare = hit.replace(/[^A-Za-z0-9_]/g, "");
  if (CLINICAL_ABBREVIATION_GUARD.test(bare)) return false;
  // camelCase 规则会命中真实缩写的大小写混排（HbA1c、SpO2、mmHg），上面的 guard 已放行；
  // 其余混排（targetPathogenesis…）保留为命中。三字符以内不足以判定为字段名。
  if (id === "camel_case_field" && bare.length <= 3) return false;
  return true;
}

function ruleHits(rule: TagRule, text: string): Array<{ hit: string; index: number }> {
  if (rule.active && !rule.active(text)) return [];
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
  const found: Array<{ hit: string; index: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (!isInternalTagHit(rule.id, text, match[0], index)) continue;
    found.push({ hit: match[0], index });
  }
  return found;
}

/**
 * 报告一段医生可见文本里残留的内部工程记号。返回空数组即「本段可见文本干净」。
 * 渲染层测试对最终可见正文调用它——断言的是医生真正看到的字，不是中间函数返回值。
 */
export function findInternalEngineeringTags(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const found: string[] = [];
  for (const rule of INTERNAL_TAG_RULES) {
    for (const { hit } of ruleHits(rule, text)) found.push(hit);
  }
  return [...new Set(found)];
}

/** 清洗后残留的标点碎屑（连续分隔符、空括号、行首行尾分隔符）。 */
function tidyClinicalPunctuation(text: string): string {
  return text
    .replace(/[（(]\s*[）)]/g, "")
    // 整个事实值被清掉后不能留下「（来源：现病史）」这种无主语来源壳。
    // 只处理被分号/行边界包围的独立来源短语，不动正常事实后的来源标注。
    .replace(/(?:^|[；;])\s*[（(]来源\s*[：:][^）)]*[）)]\s*(?=[；;。]|$)/gm, "")
    .replace(/「\s*」/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/([，,；;、])\s*(?=[，,；;、。.])/g, "")
    .replace(/^[\s，,；;、。.:：]+/gm, (match) => (match.includes("\n") ? match.replace(/[，,；;、。.:：]/g, "") : ""))
    .replace(/([，,；;、])\s*$/gm, "")
    .trim();
}

/**
 * 从一段**叙述性**临床文本里剔除内部工程记号。
 * 只做减法：不新增结论、不改写临床词，剔除后由 `tidyClinicalPunctuation` 收敛标点碎屑。
 */
export function stripInternalEngineeringTags(text: string): string {
  if (typeof text !== "string" || !text) return typeof text === "string" ? text : "";
  const cuts: Array<{ start: number; end: number }> = [];
  for (const rule of INTERNAL_TAG_RULES) {
    for (const { hit, index } of ruleHits(rule, text)) cuts.push({ start: index, end: index + hit.length });
  }
  if (cuts.length === 0) return text;
  cuts.sort((left, right) => left.start - right.start);
  let next = "";
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start < cursor) {
      cursor = Math.max(cursor, cut.end);
      continue;
    }
    next += text.slice(cursor, cut.start);
    cursor = cut.end;
  }
  next += text.slice(cursor);
  const tidied = tidyClinicalPunctuation(next);
  // 清洗后若只剩标点或空串，说明该字段本来就整段是内部记号；返回空串让调用方按「无内容」处理，
  // 而不是留下一个孤零零的句号糊在医生页面上。
  return /[一-龥A-Za-z0-9]/.test(tidied) ? tidied : "";
}

/** 医生可见的叙述性字段一定含中文；不含中文的字符串是标识符、枚举、代码、URL 或哈希。 */
const CJK_NARRATIVE = /[一-龥]/;

/**
 * 递归清洗结构化推理载荷里的叙述性字符串。
 *
 * 这是**唯一**的净化点：`synchronizeVisibleClinicalSummary` 在投影可见 Markdown 之前调用它，
 * 并把清洗后的载荷写回 sentinel，于是服务端 Markdown、客户端结构化渲染和 HIS 方案读到的是同一份
 * 干净数据。
 *
 * ─── 判据是「值的形态」，不是「键名白名单」 ────────────────────────────────────────────
 * 本函数最初按 `isMachineValuedKey` 的键名清单豁免机器字段，实测直接把合同打烂：
 * `status:"accepted"`、`doseSource:"governed_boundary"`、`kind:"western_supporting_fact"`、
 * `recommendationMode:"candidate_review"` 全部被 snake_case / 裸枚举规则清成空串，
 * `normalizeReasoningV2` 随即整份拒收——医生看到的是**一张空白处方页**。
 * 键名白名单的失败模式是结构性的：schema 每加一个枚举字段就要有人记得登记，忘了就炸，
 * 而且炸在合同层，比漏一个标签严重得多。
 *
 * 因此改用值形态判据：**只清洗含中文的字符串**。医生可见叙述在本产品里必然是中文，
 * 而纯 ASCII 值必然是标识符/枚举/编码/URL。含中文的机器字段（canonical、citation…）
 * 由 `isMachineValuedKey` 兜住。这样「新增一个英文枚举字段」不再需要任何登记动作。
 */
export function sanitizeReasoningNarratives<T>(value: T, key?: string): T {
  if (typeof value === "string") {
    if (!CJK_NARRATIVE.test(value)) return value;
    if (isMachineValuedKey(key)) return value;
    return stripInternalEngineeringTags(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReasoningNarratives(item, key)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      next[childKey] = sanitizeReasoningNarratives(childValue, childKey);
    }
    return next as unknown as T;
  }
  return value;
}
