import { clinicalClausePolarity } from "./clinical-polarity";
import { clinicalRequiredFieldLabel } from "./clinical-governance-tables";

/**
 * 诊断依据的**三分类**与**事实来源**（甲方评测 2026-08-04 第 1.1.1 条）。
 *
 * ★ 甲方看到的是什么 ★
 * 生产实测（产后头痛例）西医诊断段落全文只有两行：
 *   **诊断倾向**：头痛（病因待查）
 *   **支持依据**：产后2月余，头痛反复发作1月；产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华
 * 「支持依据」下面是主诉与现病史的逐字复述，读者无法分辨哪一条在支持诊断、哪一条在排除鉴别、
 * 哪一条其实还没查——甲方原话「西医诊断下方仍复述主诉/现病史，应转为支持/排除/待查三类并显示事实来源」。
 *
 * ★ 三类全部来自已签名载荷，不新增任何推断 ★
 *   支持依据 ← primary.supportingFacts 中**肯定极性**的条目（clinicalClausePolarity=affirmed）；
 *   排除依据 ← primary.supportingFacts 中**否定极性**的条目（「否认高血压、糖尿病病史」这类，
 *              它们的临床作用正是排除鉴别方向，混在支持依据里读起来像在支持诊断）；
 *   待查依据 ← primary.limitations ∪ primary.suggestedChecks（「尚缺什么、下一步查什么」）。
 * 三类是对同一批既有字段的**重新归类**，不改签名内容，也不引入新事实。
 *
 * ★ 事实来源同样是派生的，不是新写的词表 ★
 * 字段名取自受治理的临床必填字段矩阵（clinical-required-field-matrix.json 的 label），
 * 落点靠病历接地正文（clinicalGroundingText）的行结构确定：首行恒为主诉（该函数的既有约定，
 * 见 tcm-chief-complaint-anchor.ts 的说明），带字段标签的行按标签归属，其余行归现病史。
 * 认不出来源的条目照常呈现，只是不带来源标注——fail-open，绝不因为标不出来源就删掉一条依据。
 */

export type ClinicalFactSource = {
  /** 受治理必填字段矩阵中的字段 ID。 */
  fieldId: string;
  /** 该字段的受治理中文名（矩阵 label，不在本文件写死）。 */
  label: string;
  /** 该来源在病历接地正文里的原文。 */
  text: string;
};

/**
 * 传输层字段前缀 → 受治理字段 ID。
 *
 * 这些前缀不是临床词表，而是**病历传输格式**里的段落标题：它们由 diagnosis-safety.ts 的
 * trustedInputText 逐行写出（`舌象：`、`脉象：`、`既往史：`…），本表只是把同一组标题读回来。
 * 中文显示名一律不在这里写死，统一走 clinicalRequiredFieldLabel(fieldId) 从受治理矩阵取。
 */
const TRANSPORT_PREFIX_FIELD_IDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^主诉[：:]/, "chief_complaint"],
  [/^(?:现病史|病情经过|问诊补充|四诊补充|症状补充|本轮追问补充)[：:]/, "present_illness"],
  [/^既往史[：:]/, "past_history"],
  [/^(?:用药史|当前用药)[：:]/, "medication_history"],
  [/^(?:过敏史|药物过敏史)[：:]/, "allergy_history"],
  [/^生命体征[：:]/, "vitals"],
  [/^(?:舌象|舌质|舌苔|舌象图像复核)[：:]/, "tongue"],
  [/^脉象[：:]/, "pulse"],
  [/^(?:面象|面色|神志)[：:]/, "face_and_other_tcm"],
  [/^(?:辅助检查|检验检查)[：:]/, "auxiliary_examinations"],
];

function labelFor(fieldId: string): string {
  return clinicalRequiredFieldLabel(fieldId, "");
}

/**
 * 把病历接地正文切成「来源 → 原文」。
 * 首行恒为主诉；带受治理字段标签的行按标签归属；其余行归现病史（基层/兼容调用方常常不带标签）。
 */
export function clinicalFactSourcesFromContext(clinicalContext: string): ClinicalFactSource[] {
  const lines = (clinicalContext || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const sources: ClinicalFactSource[] = [];
  const push = (fieldId: string, text: string) => {
    const label = labelFor(fieldId);
    if (!label || !text) return;
    sources.push({ fieldId, label, text });
  };
  lines.forEach((line, index) => {
    const matched = TRANSPORT_PREFIX_FIELD_IDS.find(([pattern]) => pattern.test(line));
    if (matched) {
      push(matched[1], line.replace(matched[0], "").trim());
      return;
    }
    // 首行无标签时恒为主诉（clinicalGroundingText 把 state.chiefComplaint 放在最前且不带标签）。
    push(index === 0 ? "chief_complaint" : "present_illness", line);
  });
  return sources;
}

const CASE_STATE_FIELD_PATHS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["chief_complaint", ["chiefComplaint", "hisRecord.fields.zhushu"]],
  ["present_illness", ["hisRecord.fields.xianbingshi"]],
  ["past_history", ["pastHistory", "hisRecord.fields.jiwangshi"]],
  ["medication_history", ["medicationHistory", "hisRecord.fields.yongyaoshi"]],
  ["allergy_history", ["allergyHistory", "hisRecord.fields.guomin"]],
  ["tongue", ["tongue", "hisRecord.fields.tcmTongue"]],
  ["pulse", ["pulse", "hisRecord.fields.tcmPulse"]],
  ["face_and_other_tcm", ["faceNote", "hisRecord.fields.tcmFace"]],
  ["auxiliary_examinations", ["hisRecord.fields.fuzhuJiancha"]],
];

function valueAtPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) =>
    (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), root);
}

/**
 * 客户端侧的来源解析：直接读病例状态的**受治理字段路径**（clinical-required-field-matrix 的
 * casePaths），比解析接地正文更可靠。symptoms 是自由键的 Record（HIS 直传时键名就是「现病史」
 * 「既往史」这类中文字段名）：键名与某个受治理字段名相同则归该字段，否则归现病史。
 */
export function clinicalFactSourcesFromCaseState(caseState: unknown): ClinicalFactSource[] {
  const sources: ClinicalFactSource[] = [];
  const push = (fieldId: string, value: unknown) => {
    const text = typeof value === "string" ? value.trim() : "";
    const label = labelFor(fieldId);
    if (!text || !label) return;
    sources.push({ fieldId, label, text });
  };
  for (const [fieldId, paths] of CASE_STATE_FIELD_PATHS) {
    for (const path of paths) push(fieldId, valueAtPath(caseState, path));
  }
  const symptoms = valueAtPath(caseState, "symptoms");
  if (symptoms && typeof symptoms === "object" && !Array.isArray(symptoms)) {
    for (const [key, value] of Object.entries(symptoms as Record<string, unknown>)) {
      const matched = CASE_STATE_FIELD_PATHS.find(([fieldId]) => labelFor(fieldId) === key.trim());
      push(matched ? matched[0] : "present_illness", value);
    }
  }
  const vitals = valueAtPath(caseState, "vitals");
  if (vitals && typeof vitals === "object" && !Array.isArray(vitals)) {
    for (const [key, value] of Object.entries(vitals as Record<string, unknown>)) {
      push("vitals", typeof value === "string" ? `${key}:${value}` : value);
    }
  }
  return sources;
}

/**
 * 一条依据的来源字段名。逐字包含即归属；同时命中多个来源时取**最短**的那条原文——
 * 最短即最贴合，避免整段现病史把一条主诉级事实吸走。认不出返回空串（不标注）。
 */
export function clinicalFactSourceLabel(fact: unknown, sources: readonly ClinicalFactSource[]): string {
  const text = typeof fact === "string" ? fact.trim() : "";
  if (!text) return "";
  const hits = sources.filter((source) => source.text.includes(text) || text.includes(source.text));
  if (hits.length === 0) return "";
  return hits.reduce((best, item) => (item.text.length < best.text.length ? item : best)).label;
}

export type ClassifiedDiagnosticEvidence = {
  /** 支持本诊断成立的肯定性事实（= symptom ∪ sign ∪ exam，保留给既有调用方）。 */
  supporting: string[];
  /** 患者自述的症状。 */
  symptom: string[];
  /** 查体所见的体征（含生命体征）。 */
  sign: string[];
  /** 检验检查结果。 */
  exam: string[];
  /** 用于排除鉴别方向的否定性事实。 */
  excluding: string[];
  /** 尚未取得、需进一步确认的事项（资料限制 + 建议检查）。 */
  pending: string[];
};

/**
 * 支持依据的**四分类**（甲方 2026-08-10）：症状依据 / 体征依据 / 排除依据 / 指南依据。
 *
 * 甲方原话是把「支持依据」「待查依据」两栏删掉，改成「有啥列啥」的分类呈现，
 * 并给了三份示例（急性支气管炎写四类、急性咽炎只写两类、上感只写一条「依据」）。
 *
 * 【谁来分类】「这条事实是症状还是体征」需要临床理解——咽部充血(++)记在现病史里
 * 也仍然是体征——所以由模型标注（supportingFactKinds），确定性层只做两件事：
 *  1) 校验：标注只对**确实存在于 supportingFacts 里**的条目生效，模型无法借此新增事实；
 *  2) 兜底：模型没标或标了本例没有的条目，按该事实在病历里的**落点字段**归类，
 *     字段来源本来就是确定性算出来的（clinicalFactSourcesFromContext）。
 * 「指南依据」不在这里产生——引用必须有 KB/证据层条目背书，呈现层只印真检索到的，
 * 检索不到就不出这一栏，绝不让模型自己写《内科学》第10版。
 */
const FIELD_ID_EVIDENCE_KIND: Readonly<Record<string, "symptom" | "sign" | "exam">> = {
  chief_complaint: "symptom",
  present_illness: "symptom",
  past_history: "symptom",
  medication_history: "symptom",
  allergy_history: "symptom",
  vitals: "sign",
  tongue: "sign",
  pulse: "sign",
  face_and_other_tcm: "sign",
  auxiliary_examinations: "exam",
};

function modelDeclaredKinds(value: unknown): Map<string, "symptom" | "sign" | "exam"> {
  const kinds = new Map<string, "symptom" | "sign" | "exam">();
  if (!Array.isArray(value)) return kinds;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as { fact?: unknown; kind?: unknown };
    const fact = typeof item.fact === "string" ? item.fact.trim() : "";
    const kind = item.kind;
    if (!fact) continue;
    if (kind === "symptom" || kind === "sign" || kind === "exam") kinds.set(fact, kind);
  }
  return kinds;
}

/**
 * 病历**传输格式**的段落标题（「其他四诊/问诊补充：」「现病史：」…）不是依据内容。
 *
 * 2026-08-12 甲方线上实测：症状依据里出现「其他四诊/问诊补充：畏光」——
 * 真正的依据只有「畏光」两个字，前面那截是我方喂给模型的字段标题，模型顺手抄了回来。
 * 这些标题由 diagnosis-safety 的 trustedInputText 逐行写出，TRANSPORT_PREFIX_FIELD_IDS
 * 已经把同一组标题登记在案；这里复用它，不另写第二份词表。
 */
function strippedTransportPrefix(value: string): string {
  let text = value.trim();
  for (let round = 0; round < 3; round += 1) {
    const before = text;
    for (const [pattern] of TRANSPORT_PREFIX_FIELD_IDS) text = text.replace(pattern, "").trim();
    // 复合标题（「其他四诊/问诊补充：」）：斜杠拼起来的两截各自都在表里，逐段剥。
    text = text.replace(/^(?:[^：:\s]{2,10}\/)+(?=[^：:\s]{2,10}[：:])/, "").trim();
    if (text === before) break;
  }
  return text || value.trim();
}

function cleanedList(values: unknown): string[] {
  return (Array.isArray(values) ? values : [])
    .map((item) => (typeof item === "string" ? strippedTransportPrefix(item) : ""))
    .filter(Boolean);
}

/**
 * 把西医主诊断的既有字段重新归为三类。极性判定复用确定性极性层（clinical-polarity），
 * 不做任何关键词猜测；`possible/unknown` 等非明确否定一律留在支持依据，宁可少归一条排除依据，
 * 也不把一条阳性事实误读成排除依据。
 */
/**
 * 同一临床事件的**不同粒度**折叠（2026-08-12 甲方要求「合并，保留详细的那条」）。
 *
 * 实测形态：症状依据里同时列着
 *   · 突发剧烈头痛伴呕吐1小时（来源：主诉）
 *   · 1小时前活动中突然出现从未有过的最剧烈爆炸样头痛，数秒达峰，伴恶心、呕吐2次及颈项僵硬（来源：现病史）
 * 这是同一次发作的两种写法。既有的 uniqueClinicalFacts 按**包含关系**折叠，两条措辞不同、
 * 互不包含，折不掉。
 *
 * 判据刻意**不引入症状词表**——仓库里没有通用症状词表（红旗词表只有 115 条、
 * 连「头痛/发热/咳嗽」都不收），手写一份会被 test:clinical-vocabulary 判为新增代码内词表，
 * 而且那正是「靠枚举自然语言」的老路。改用两条与病历结构本身有关的事实：
 *   ① **主诉按定义就是现病史的浓缩**——两条分别来自这两个字段时，天然是同一事件的粗细两版；
 *   ② 二字片段重叠——「剧烈/头痛/呕吐/小时」同时出现，才认为讲的是同一件事。
 * 取不到来源字段时（离线调用）只靠 ②，且把门槛提高，宁可不折。
 *
 * 折叠方向恒为**保留更长的那条**：短的那条的信息是长条的子集，反过来不成立。
 */
/**
 * 二字片段：只取**两个字都是汉字**的片段。
 *
 * 这里刻意不列停用词——列一份「的了及并以在中后前时」就是代码内手写词表，
 * test:clinical-vocabulary 会判红，而且那正是「靠枚举自然语言」的老路（本仓库的既定禁忌）。
 * 判据改成纯结构的：跨数字与标点的片段（「吐1」「1小」）本来就不该算语义重叠，
 * 数值是否一致另有 numericTokensCovered 单独把关。
 * 虚词片段偶尔会被算进来，但下游要求 2–3 个片段同时命中，单个虚词撑不起一次误折。
 */
const CJK_CHAR = /[\u4e00-\u9fff]/;

function meaningfulBigrams(text: string): Set<string> {
  const normalized = text.normalize("NFKC");
  const grams = new Set<string>();
  for (let index = 0; index + 2 <= normalized.length; index += 1) {
    const gram = normalized.slice(index, index + 2);
    if (!CJK_CHAR.test(gram[0]) || !CJK_CHAR.test(gram[1])) continue;
    grams.add(gram);
  }
  return grams;
}

/** 短条里出现的数值/计量必须在长条里也有，否则折叠会丢掉一个具体数（如「38.5℃」）。 */
function numericTokensCovered(shorter: string, longer: string): boolean {
  const tokens = shorter.match(/\d+(?:\.\d+)?/g) || [];
  return tokens.every((token) => longer.includes(token));
}

function fieldIdOfFact(fact: string, sources: readonly ClinicalFactSource[]): string {
  return sources.find((source) => source.text.includes(fact) || fact.includes(source.text))?.fieldId || "";
}

function foldSameClinicalEvent(facts: readonly string[], sources: readonly ClinicalFactSource[]): string[] {
  const kept: string[] = [];
  for (const fact of [...facts].sort((left, right) => right.length - left.length)) {
    const duplicate = kept.some((existing) => {
      if (existing.length < fact.length * 1.3) return false;
      if (!numericTokensCovered(fact, existing)) return false;
      const shared = [...meaningfulBigrams(fact)].filter((gram) => existing.includes(gram));
      const fields = [fieldIdOfFact(fact, sources), fieldIdOfFact(existing, sources)].sort().join("|");
      // 主诉 × 现病史：天然是同一事件的粗细两版，两个共同片段即可判同。
      const chiefAndPresent = fields === "chief_complaint|present_illness";
      return shared.length >= (chiefAndPresent ? 2 : 3);
    });
    if (!duplicate) kept.push(fact);
  }
  // 折叠只做去重，不改原有顺序。
  return facts.filter((fact) => kept.includes(fact));
}

export function classifyWesternDiagnosticEvidence(
  primary: {
    supportingFacts?: unknown;
    supportingFactKinds?: unknown;
    limitations?: unknown;
    suggestedChecks?: unknown;
  } | null | undefined,
  sources: readonly ClinicalFactSource[] = [],
): ClassifiedDiagnosticEvidence {
  const facts = cleanedList(primary?.supportingFacts);
  const excluding = facts.filter((fact) => clinicalClausePolarity(fact) === "negative");
  const supporting = facts.filter((fact) => !excluding.includes(fact));
  const declared = modelDeclaredKinds(primary?.supportingFactKinds);
  const symptom: string[] = [];
  const sign: string[] = [];
  const exam: string[] = [];
  for (const fact of supporting) {
    // 模型的标注只在该条事实确实存在时生效——它不能借标注新增一条依据。
    const kind = declared.get(fact)
      // 兜底：按这条事实在病历里的落点字段归类。字段来源本身是确定性算出来的。
      ?? FIELD_ID_EVIDENCE_KIND[sources.find((source) =>
        source.text.includes(fact) || fact.includes(source.text))?.fieldId || ""]
      ?? "symptom";
    (kind === "sign" ? sign : kind === "exam" ? exam : symptom).push(fact);
  }
  return {
    supporting,
    // 逐组折叠：同一事件的粗细两版只留详细的那条。跨组不折——那是分类问题不是重复问题。
    symptom: foldSameClinicalEvent(symptom, sources),
    sign: foldSameClinicalEvent(sign, sources),
    exam: foldSameClinicalEvent(exam, sources),
    excluding: foldSameClinicalEvent(excluding, sources),
    pending: uniqueClinicalFacts([...cleanedList(primary?.limitations), ...cleanedList(primary?.suggestedChecks)]),
  };
}

/**
 * 病历事实去重：剥掉标点后按**包含关系**折叠，保留信息更全的那一条。
 *
 * 本函数原先私有在 diagnosis-visible-summary 里，只服务于服务端 Markdown。
 * 2026-08-11 线上实测暴露出「待查依据」同时出现
 *   · 未提供血常规、CRP等炎症指标   ← limitations
 *   · 血常规、CRP等炎症指标         ← suggestedChecks
 * 两条讲同一件事——因为那一路只用 `new Set` 去重，而 Set 只认逐字节相等。
 * 判据本来就有、而且就在同一个仓库里，只是没接到这一路上；移到这里导出，两侧共用同一个。
 * 不新增任何语义猜测：只做标点归一 + 包含判定，不合并两个不同的临床子句、不改极性。
 */
export function uniqueClinicalFacts(values: readonly string[]): string[] {
  const result: Array<{ key: string; value: string }> = [];
  for (const value of values) {
    const key = value.normalize("NFKC").replace(/[\s，,。；;：:、()（）【】\[\]]+/g, "");
    if (!key || result.some((item) => item.key === key || item.key.includes(key))) continue;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      if (key.includes(result[index].key)) result.splice(index, 1);
    }
    result.push({ key, value });
  }
  return result.map((item) => item.value);
}

/**
 * 西医诊断依据的**唯一**分组投影（2026-08-11）。
 *
 * 甲方 2026-08-10 要求把笼统的「支持依据 / 待查依据」改成「有啥列啥」的分类呈现，
 * 这个改动当时只落到了服务端 Markdown（diagnosis-visible-summary），**医生页面没跟上**：
 * 页面继续渲染「支持依据 / 排除依据 / 待查依据」三组，而甲方读的正是页面。
 * 这是本仓库反复出现的同一形状——同一个呈现口径在两个出口各写各的。
 * 现在两个出口都调用本函数，分组、标题与「只有一类时写『依据』」的规则只有这一处。
 */
/**
 * 指南/文献依据的**唯一**呈现投影（2026-08-11 甲方线上实测：「指南引用要能点开看原文」）。
 *
 * 该条目本来就带 url——它由 resolveGovernedGuidelineReferences 从本轮真检索到的条目字段回填，
 * 模型只能写一句 appliesTo。服务端 Markdown 一直在印这个 url，**医生页面在拼展示串时把它丢了**：
 * 页面写的是 `${citation}（${appliesTo}）`，没有第三段。于是同一份载荷，一个出口有出处、
 * 另一个出口没有——与本轮其余几条同形。
 *
 * 现在两个出口都从这里取：text 是文字部分，href 是可点击地址（没有就没有，绝不编）。
 */
export function guidelineReferenceDisplay(
  reference: { citation?: unknown; appliesTo?: unknown; url?: unknown },
): { text: string; href?: string } {
  const text = (typeof reference.citation === "string" ? reference.citation : "").trim();
  const appliesTo = (typeof reference.appliesTo === "string" ? reference.appliesTo : "").trim();
  const url = (typeof reference.url === "string" ? reference.url : "").trim();
  return {
    text: `${text}${appliesTo ? `（${appliesTo}）` : ""}`,
    // 只认 https 绝对地址：相对路径或 http 明文都不做成可点链接，避免把医生点到非预期位置。
    ...(/^https:\/\//.test(url) ? { href: url } : {}),
  };
}

export function westernDiagnosticEvidenceGroups(
  evidence: Pick<ClassifiedDiagnosticEvidence, "symptom" | "sign" | "exam" | "excluding">,
  guidelineReferences: readonly { text: string; href?: string }[] = [],
): Array<{ label: string; items: Array<{ text: string; href?: string }>; withSource: boolean }> {
  const groups = [
    { label: "症状依据", items: [...evidence.symptom].map((text) => ({ text })), withSource: true },
    { label: "体征依据", items: [...evidence.sign].map((text) => ({ text })), withSource: true },
    { label: "检查依据", items: [...evidence.exam].map((text) => ({ text })), withSource: true },
    { label: "排除依据", items: [...evidence.excluding].map((text) => ({ text })), withSource: true },
    // **不出「待查依据」栏**：甲方 2026-08-10 的原话是「删掉笼统的『支持依据』与『待查依据』，
    // 改成有啥列啥」。服务端 Markdown 当时照做了，医生页面没跟上——这正是本次「支持依据没生效」
    // 的现象来源。`evidence.pending` 仍然计算并去重，供 HIS 的
    // westernDetail.limitations / suggestedChecks 两个**分列**字段与结构化载荷使用；
    // 只是不再在医生页面上占一栏笼统的「待查」。
    // 指南/文献依据本身就是来源，不再标来源。
    { label: "指南/文献依据", items: [...guidelineReferences], withSource: false },
  ].filter((group) => group.items.length > 0);
  // 只有一类支持性依据时不写分类名，直接写「依据」（甲方示例三：上感只有一条依据）。
  const supportive = groups.filter((group) => group.withSource);
  if (supportive.length === 1 && groups.length === 1) return [{ ...supportive[0], label: "依据" }];
  return groups;
}

/** 依据条目 + 来源标注的呈现文本（无来源时原样返回）。 */
export function clinicalFactWithSource(fact: string, sources: readonly ClinicalFactSource[]): string {
  const label = clinicalFactSourceLabel(fact, sources);
  return label ? `${fact}（来源：${label}）` : fact;
}
