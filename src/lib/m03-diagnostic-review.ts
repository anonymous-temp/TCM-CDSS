import { createHash } from "node:crypto";

import { parseClinicalReviewJson } from "./clinical-review-contract";
import { clinicalClausePolarity } from "./clinical-polarity";
import { m03SemanticIssue } from "./diagnosis-stage-contract";
import { M03_CLINICAL_INFERENCE_AUTHORITY } from "./clinical-inference-authority";

export type M03DiagnosticReview =
  | { status: "accepted"; issueCode: "none" }
  | { status: "repair"; issueCode: M03DiagnosticRepairIssue; repairInstruction?: string }
  | { status: "unavailable"; issueCode: "review_unavailable" };

export type M03DiagnosticRepairIssue =
  | "criteria_not_met"
  | "diagnostic_label_overstated"
  | "supporting_fact_mismatch"
  | "tcm_reasoning_unsupported"
  | "formula_indication_mismatch";

const REPAIR_ISSUES = new Set([
  "criteria_not_met",
  "diagnostic_label_overstated",
  "supporting_fact_mismatch",
  "tcm_reasoning_unsupported",
  "formula_indication_mismatch",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function withoutEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEvidence);
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(Object.entries(source)
    .filter(([key, item]) => key !== "evidence" && item !== undefined)
    .map(([key, item]) => [key, withoutEvidence(item)]));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(Object.entries(source)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonicalize(item)]));
}

/**
 * Project only the diagnostic decisions owned by the independent M03 reviewer. Evidence
 * provenance, signatures, display synchronization, treatment projects and workflow metadata are
 * governed elsewhere and must not turn one accepted diagnosis into a second stochastic review.
 */
export function buildM03DiagnosticReviewPayload(reasoning: unknown): Record<string, unknown> {
  const source = record(reasoning) || {};
  return withoutEvidence({
    overview: source.overview,
    westernDiagnosis: source.westernDiagnosis,
    pathogenesis: source.pathogenesis,
    therapy: source.therapy,
  }) as Record<string, unknown>;
}

export function m03DiagnosticReviewSemanticHash(reasoning: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(buildM03DiagnosticReviewPayload(reasoning))))
    .digest("hex")}`;
}

/**
 * `pathogenesis.summary` is a server-owned projection, not a second clinical conclusion. The
 * reviewer receives this deterministic invariant so it cannot spend a repair round disputing a
 * byte-exact projection while leaving the real diagnostic decisions unreviewed.
 */
export function m03PathogenesisSummaryIsExactProjection(reasoning: unknown): boolean {
  const source = record(reasoning);
  const overview = record(source?.overview);
  const pathogenesis = record(source?.pathogenesis);
  if (!overview || !pathogenesis || typeof pathogenesis.summary !== "string") return false;
  const chain = Array.isArray(pathogenesis.chain) ? pathogenesis.chain : [];
  const chainProjection = [...new Set(chain.flatMap((rawNode) => {
    const node = record(rawNode);
    return node && typeof node.pathogenesis === "string" && node.pathogenesis.trim()
      ? [node.pathogenesis.trim()]
      : [];
  }))].join("；");
  const fallback = typeof overview.overallPathogenesis === "string" ? overview.overallPathogenesis.trim() : "";
  const projection = chainProjection || fallback;
  return Boolean(projection) && pathogenesis.summary.trim() === projection;
}

const SERVER_GROUNDED_DIFFERENTIAL_REASON = /^(?:当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。|.+；该方向需结合临床表现及相关检查继续鉴别。)$/;

function m03DiagnosticReviewRebindPayloads(
  reviewedReasoning: unknown,
  finalReasoning: unknown,
): [Record<string, unknown>, Record<string, unknown>] {
  const reviewed = structuredClone(buildM03DiagnosticReviewPayload(reviewedReasoning));
  const final = structuredClone(buildM03DiagnosticReviewPayload(finalReasoning));
  const reviewedWestern = record(reviewed.westernDiagnosis);
  const finalWestern = record(final.westernDiagnosis);
  const reviewedDifferentials = Array.isArray(reviewedWestern?.differentials) ? reviewedWestern.differentials : [];
  const finalDifferentials = Array.isArray(finalWestern?.differentials) ? finalWestern.differentials : [];
  for (let index = 0; index < Math.min(reviewedDifferentials.length, finalDifferentials.length); index += 1) {
    const before = record(reviewedDifferentials[index]);
    const after = record(finalDifferentials[index]);
    if (!before || !after || typeof after.reason !== "string" || !SERVER_GROUNDED_DIFFERENTIAL_REASON.test(after.reason)) continue;
    // The grounding pass can only reduce an already-reviewed differential rationale to an exact
    // chart quote plus a standard caution, or to the standard evidence-limited fallback. Mask that
    // one server-owned reduction on both sides; names, checks, ordering and every other diagnostic
    // or TCM decision remain hash-bound below.
    before.reason = "__server_grounded_differential_reason__";
    after.reason = "__server_grounded_differential_reason__";
  }
  return [reviewed, final];
}

export function canRebindM03DiagnosticReview(reviewedReasoning: unknown, finalReasoning: unknown): boolean {
  const [reviewed, final] = m03DiagnosticReviewRebindPayloads(reviewedReasoning, finalReasoning);
  return JSON.stringify(canonicalize(reviewed)) === JSON.stringify(canonicalize(final));
}

export function m03DiagnosticReviewDiffPaths(reviewedReasoning: unknown, finalReasoning: unknown): string[] {
  const before = canonicalize(buildM03DiagnosticReviewPayload(reviewedReasoning));
  const after = canonicalize(buildM03DiagnosticReviewPayload(finalReasoning));
  const paths: string[] = [];
  const visit = (left: unknown, right: unknown, path: string) => {
    if (paths.length >= 40 || Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) paths.push(`${path}.length`);
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        visit(left[index], right[index], `${path}[${index}]`);
      }
      return;
    }
    if (record(left) && record(right)) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()) {
        if (!(key in leftRecord) || !(key in rightRecord)) paths.push(`${path}.${key}`);
        else visit(leftRecord[key], rightRecord[key], `${path}.${key}`);
      }
      return;
    }
    paths.push(path);
  };
  visit(before, after, "m03Review");
  return [...new Set(paths)];
}

/**
 * Structural/fact invariants are deterministic reviewer preconditions, not stochastic clinical
 * judgements. Keeping this check in the review module lets health probes and live calibrations test
 * the same composite reviewer boundary used before an M03 result can be signed.
 */
export function preflightM03DiagnosticReview(
  reasoning: unknown,
  clinicalContext = "",
): M03DiagnosticReview | undefined {
  const issue = m03SemanticIssue(reasoning as Parameters<typeof m03SemanticIssue>[0], clinicalContext);
  if (!issue) return undefined;
  const issueCode: M03DiagnosticRepairIssue = issue.startsWith("western_")
    ? "supporting_fact_mismatch"
    : "tcm_reasoning_unsupported";
  return {
    status: "repair",
    issueCode,
    repairInstruction: `deterministic_contract:${issue}`,
  };
}

export function buildM03DiagnosticReviewPrompt(
  clinicalContext: string,
  reasoning: unknown,
  evidenceContext = "",
): string {
  const payload = buildM03DiagnosticReviewPayload(reasoning);
  const hasAdditionalPositiveFacts = m03GroundingHasCurrentPositiveFacts(clinicalContext);
  const summaryProjectionExact = m03PathogenesisSummaryIsExactProjection(reasoning);
  const depthMode = hasAdditionalPositiveFacts
    ? [
        "服务端事实极性分类：情形二（主诉外存在可用的当前阳性临床事实）。",
        "应用情形二的深度要求：使用这些阳性事实形成最小闭环，但不得推出它们不能支持的病位、病性或具体证型。",
        "若额外阳性事实仅补充同一主症的次数、时程、性状或诱发规律，尚不足以区分寒热虚实等证型时，应接受由已成立中医工作病名推导的最浅层基础功能病机，而不得因缺少更深四诊要求补造或拒收。",
      ].join("\n")
    : [
        "服务端事实极性分类：情形一（追问后仍稀疏；否定式、未知回答、流程请求和主诉重复均不是新的阳性临床事实）。",
        "应用情形一的接受标准：只要候选逐字锚定主诉，形成低置信度、症状层、中性且非空的病机—治法闭环，病位病性保持 unresolved 且不推荐命名方，就必须 accepted。不得再以“只有主诉”、“缺少其他四诊”或“推理深度不足”拒收。",
        "胃肠主诉在没有更深事实时，可接受“胃失和降、气机不畅”这类由腹胀、嗳气、反酸等直接支持的中性有限病机；不得据此加出肝郁、食积、痰湿、寒热虚实。",
      ].join("\n");
  return [
    "你是独立的中西医临床推理复核器，不负责重新生成整份报告。核对 westernDiagnosis.primary、中医证候与病机治法、以及候选经方方向是否被当前病例事实充分支持。",
    M03_CLINICAL_INFERENCE_AUTHORITY,
    depthMode,
    summaryProjectionExact
      ? "服务端投影不变量：pathogenesis.summary 已与非空 pathogenesis.chain[].pathogenesis 按顺序去重后用分号连接的文本完全一致。该事实由服务端确定，本轮禁止返回 pathogenesis_summary_drift；若核心病机本身越界，必须指向具体核心字段和无依据概念。"
      : "服务端投影不变量：pathogenesis.summary 尚未证实为精确投影，可按下述规则审查。",
    "核对医生可见分析是否真正完成推理而非复述病历：westernDiagnosis.primary.name 不得夹带痰湿型、肝火型、气虚证等中医证型；clinicalRationale 必须解释事实如何支持诊断并说明为何没有采用更具体病因标签。西医 differentials 必须有可区分主诊断的要点，不能只列病史。",
    "核对中医诊断分析与鉴别：tcmDiagnosticRationale 必须从已取得的望闻问切事实推导病名和主证，不能把缺CT、MRI、化验、量表或通用查体当作中医辨证不能成立的理由；资料允许比较时应给出有区分点的 tcmDifferentials。情形二的具体证型、寒热虚实和子病机必须使用全案阳性四诊，不能只由主诉关键词机械映射；但已由主症成立的中医工作病名，允许使用该病名定义中不增加证型归属的最浅层基础功能病机形成闭环。情形一则按上述服务端稀疏标准审查，不得反向要求候选补造四诊。",
    "按七阶段做一次方证深度审计：病位至少有两类相互独立患者证据才可锁定；整体状态须覆盖已有病程、精神、饮食、睡眠与二便；明确寒热时至少有寒热、口渴饮水、二便、舌、脉、四肢温度中的两个维度；虚实须区分正虚与邪实；病机链必须逐节点闭环；命名方须有至少一个相邻方鉴别点和能改变选择的核实项；总治法须覆盖 P1/P2。资料未取得必须保持 unknown 或 uncertainties，绝不能按 absent/阴性处理。七阶段是证据充足度约束，不得反向要求稀疏病例补造事实或强行套入六经。",
    "病位与病性按治理表正交编码：locationDifferentiation.items 写心、脾等病位，natureDifferentiation.items 写气虚、血虚、气滞、痰湿、寒、热等标准基本病性；具体‘脾气亏虚、心血失养’关系写在 pathogenesis.chain、basis 或 resolutionReason。只要主证候、总体病机或病机节点已经明确使用受控病位，该病位就必须同步进入 locationDifferentiation.items，不能以资料有限为由一边使用病位推理一边留空。只要患者事实分别支持病位和基本病性，不得把标准项‘气虚’或‘血虚’误解为全身性结论，也不得要求改成非标准复合项‘脾气虚’‘心血虚’。natureDifferentiation.items 不能写胃失和降、肺失宣降、脾失健运等病机短语。therapy.overallPrinciple 必须是正治/反治、治病求本、标本缓急、扶正祛邪、三因制宜等治则层原则，具体疏肝、清热、健脾、化痰、安神写入 overallMethod；两栏不得同句。subTherapies 必须逐项对应病机节点，多节点时分治方向和对应病机不得整段重复。",
    "先执行硬性完整性检查：pathogenesis.chain 为空，或主证候、总体病机、总治法以‘待辨、待定、资料不足、无法判断’等占位内容代替临床结论时，一律返回 tcm_reasoning_unsupported，绝不能 accepted。总体病机若只是复制主诉或症状列表，治则与治法同句，多个病机节点/分治方向整段重复，也必须修复。修复方向必须是基于已有阳性事实形成低置信度、最小且中性的非空闭环；不得要求清空病机链，也不得为了补全而推断阴虚、阳虚、寒热、痰湿、血瘀等未获事实支持的证型。病位或病性确实无法由现有事实归属时，允许 items 为空，但必须使用 resolution=unresolved并说明原因；但只要同一份推理已明确写出胃、肺、心等受控病位，就必须同步归类，绝不能一边使用病位一边留空。",
    "对于有正式诊断标准的疾病，逐项核对病程阈值、必备核心症状、必要排除条件和已有客观依据。缺少任何必备条件时必须返回 repair；不能因为疾病‘看起来像’就接受。",
    "呼吸与睡眠疾病要额外校准：单有夜间憋醒不能诊断阻塞性睡眠呼吸暂停，缺少已确诊史或睡眠监测阳性依据时，OSA 只能列入 differentials；单有活动后喘鸣、胸口呼呼响或夜间症状，缺少已确诊史、气流可逆性客观依据或支气管舒张剂明确反应时，不得把支气管哮喘作为 primary。上述情形应使用与主导症状精确一致的症状级工作诊断，并将疾病标签保留在鉴别诊断中：病历只记录喘鸣、胸口呼呼响而未明确气不够用时应写喘息症状，不得改写成劳力性呼吸困难或气短；只有病历明确记录气短、气促或呼吸困难时才使用相应标签。",
    "同时执行呼吸—心源性交叉鉴别审计：病例同时记录劳力相关气短、喘鸣、胸闷或呼吸不适与夜间憋醒、不能平卧或端坐呼吸时，differentials 必须覆盖呼吸系统、心功能不全和冠心病/心肌缺血等心源性方向，且不得重复同一诊断；management.followupSafetyNet 必须明确说明这些线索持续或加重时需尽快排除心源性原因，以及静息呼吸困难、不能平卧、胸痛、晕厥或发绀时立即急诊。这里只要求鉴别和行动边界，缺少客观依据时绝不能把心衰或冠心病写成 primary 或确诊。",
    "对中老年新发或进行性排便习惯改变做患者特异的报警征象审计：年龄>40岁的初诊便秘患者，特别是近期新发、进行性加重或既往筛查史未知时，westernDiagnosis.primary.suggestedChecks 不能再用‘若年龄>40岁/50岁’这种未实例化的假设句；必须明确写出本例已满足的年龄与病程条件，建议消化专科评估并结合既往筛查史决定结肠镜检查，以排除结直肠器质性病变。该要求不等同于把肿瘤写成确诊，也不能把已明确阴性的便血或消瘦改成阳性。",
    "症状性工作诊断只有准确反映主诉中的主导症状和病程才可接受；证据不足的疾病应放入 differentials，不能占用 primary。不得让次要伴随症状抢占 primary，例如主诉以大便解不出来、排便费劲或数日一次为核心时，应使用便秘症状，不能因同时腹胀就改写成腹胀症状。",
    "不得把尚未满足标准的病因或疾病藏进症状性诊断的括号、后缀或‘可能’限定中（例如‘某症状（某疾病可能）’）；这种写法仍属于过度诊断，必须返回 diagnostic_label_overstated，并把该疾病移入 differentials。",
    "检查 supportingFacts 是否来自病例且确实支持该主诊断。不要因为缺少非必需检查而否定合理的症状性工作诊断。",
    "supportingFacts 只保留与当前主诊断直接相关的现代医学患者事实：不得混入舌苔脉象、证候病机等中医推理，不得用年龄性别或一组正常生命体征充当诊断支持，也不得堆入与本次主诉无关的既往病名。",
    "严格区分当前问题与历史背景。既往稳定疾病、后遗症、已缓解事件或当前明确无新发症状，只能作为背景或鉴别边界；除非病例有当前活动性变化，不得把它们升级成本次 primary、主证候锚点或主要病机治疗目标。",
    "核对中医主证、病位病性、病机链和治法是否由阳性患者事实支撑。不能把未询问、未知、条件句或待鉴别方向当作已经存在的证候锚点。",
    "单独执行一次‘病机总结投影一致性审计’：pathogenesis.summary 是服务端从核心病机字段生成的只读投影，只能归纳 overview.primarySyndrome、overview.overallPathogenesis、pathogenesis.natureDifferentiation 和 pathogenesis.chain[].pathogenesis 中已成立的结论。若 summary 与非空 pathogenesis.chain[].pathogenesis 按顺序用分号连接的文本完全一致，或在链为空时与 overview.overallPathogenesis 完全一致，就不得返回 pathogenesis_summary_drift；若这些核心结论本身超出患者事实，应针对核心字段返回对应的病位、病性或具体 overreach 问题，不能把核心问题误报为摘要漂移。只有 summary 单独额外引入核心字段均不存在的病因、病位、寒热虚实、气血津液、痰湿瘀血或治法方向时，才返回 tcm_reasoning_unsupported，repairInstruction 以 pathogenesis_summary_drift 开头并只要求删除总结中的额外断言，不得倒向补造核心推理。",
    "单独执行一次‘当前阳性事实覆盖审计’：逐条读取患者事实边界中的当前阳性症状、体征和检查结果，再核对它们是否已进入 westernDiagnosis 的依据/鉴别，或 overview.primarySyndromeBasis、pathogenesis.chain.patientFact、pathogenesis.uncertainties 中至少一个与其临床作用相符的位置。只有可能实质改变诊断、风险分层、证候深度、治法方向或随访安排的事实属于必审项；无关偶发信息、历史背景、明确阴性、未知项以及已被同义概括的事实不要求逐字重复。若遗漏了必审阳性事实，尤其是活动后气喘、夜间症状、体重变化、出血、神经功能改变、用药反应或异常检查等会改变方向的线索，必须返回 tcm_reasoning_unsupported，repairInstruction 以 positive_fact_omission 开头并只指出需要补入的结构路径；可以将尚不能归入主证的事实放入 uncertainties，不得为了覆盖而强行推出气虚、阴虚、痰湿等具体证型。",
    "逐条复核 pathogenesis.uncertainties 的 item、reason 与 affects 是否自洽并符合患者事实边界。病历未提供的既往史、用药史、过敏史、舌脉、生命体征或检查不得在 reason 中写成‘已记录、已提供、已确认’；已知事实只有某个属性仍未知时，reason 必须点明已知事实和具体缺失属性。‘该症状已在病历中明确记录’等没有事实对象、不能解释该不确定项的套话必须返回 tcm_reasoning_unsupported，repairInstruction 以 uncertainty_state_mismatch 开头，只修正冲突的不确定项，不得新增患者事实。",
    "把病因、诱因、脏腑归属和传变路径逐项当作需要证据的临床结论复核，不能因某症状常见于某证就接受。尤其是：只有反酸、烧心、腹胀等胃肠表现时，最多支持胃失和降、气机不畅等中性有限病机；若患者事实中没有情绪相关加重、胸胁或乳房胀痛、善太息、月经相关变化、脉弦等依据，却写入肝气郁结、肝郁气滞、肝郁犯胃或相应疏肝治法，必须返回 tcm_reasoning_unsupported。食积、外感、痰湿、血瘀、寒热虚实等方向同理：缺少对应阳性事实时要求删除并降为症状直接支持的最浅机制，不得用‘低置信度’或 uncertainties 为超事实主结论免责。",
    "事实边界中同一观察项（舌象、脉象、面色、体征或检验）出现直接矛盾的多条记录时（如不同段落分别记录舌红与舌淡红、脉弦与脉细平），该观察项一律按不可靠证据处理：它既不能支持任何具体病位、病性或证型归属，也不能据此认定候选‘编造事实’。病机链、supportingFacts 与病位病性依据均不得引用矛盾观察项的任一条作为锚点；候选引用了其中一条时，应要求删除该引用并按其余一致事实降级，按无依据归属处理而不按编造处理。辨证深度只由其余一致的阳性事实判定：去掉矛盾观察项后若事实不再支持具体归属，情形一的有界中性形态可以接受，不得再以‘仍存在阳性舌脉’为由要求具体证型。矛盾本身必须要求候选写入 uncertainties 或 resolutionReason，绝不能由你或候选挑选某一条作为事实采信。",
    "同时核对辨证是否形成了足以指导后续组方的临床闭环，判定深度只能与患者事实支持的层级一致。情形一（追问后仍稀疏）：患者事实边界中除主诉外没有其他当前阳性发现时，可以形成低置信度、症状层的工作证候；病机链逐字锚定主诉，只描述该症状或已成立中医工作病名直接定义的节律、通降、传导、濡养或活动功能变化，不额外引入寒热虚实、气血津液或痰湿瘀等证型结论，病位病性 items 为空且 resolution=unresolved 并附原因，不推荐命名方。不得使用‘功能失调候’‘调护功能’这类跨病例套话，也不得为了显得具体补出阴虚、阳虚、寒热、痰湿或血瘀。情形二（主诉之外仍有当前阳性事实）：主证候必须由当前阳性事实锚定，要求的深度以事实实际支持的层级为限；当额外事实只是主症的次数、时程、性状或诱发规律时，使用中医工作病名的最浅层基础功能病机不属于‘症状复述’，只要不借此升级为具体证型就应接受。现有事实不足以支持具体病性时允许保持 unresolved，但总体病机和至少一个患者事实锚定的病机节点不得留空。任何超出当前阳性患者事实支持的寒热虚实、气血津液、痰湿瘀、典型证型或命名方都必须拒绝。高血压、房颤、湿疹、类风湿、红斑狼疮等疾病标签只能作为背景，不能单独推出眩晕、心气虚或其他中医证候。",
    "核对 recommendedFormulaNames 中每个命名方是否列在证据上下文的【M03经典方检索】受控候选中，并核对其核心适应证是否在阳性患者事实中成立。未进入本例候选、只在 uncertainties/假设句/‘若有则’中出现、或定义性症状明确缺失时，必须返回 formula_indication_mismatch；此时应让生成模型改选有方证依据的受控候选，或退回本例辨证组方，不能勉强套用经方名。",
    "只输出一个 JSON 对象，不要代码块或解释。格式：accepted 时 {\"status\":\"accepted\",\"issueCode\":\"none\"}；需修复时 status=repair，issueCode 只能是 criteria_not_met、diagnostic_label_overstated、supporting_fact_mismatch、tcm_reasoning_unsupported、formula_indication_mismatch 之一，并增加 repairInstruction。一次只返回最关键的问题。按上述规则可以接受的候选必须输出 accepted，绝不允许用 repair 表达‘应接受、请重新检查’；repair 只用于确实需要生成模型修改的候选。supportingFacts 的内容问题（混入舌苔脉象等中医推理、非患者事实、与主诊断无关）只能使用 supporting_fact_mismatch，不得并入 tcm_reasoning_unsupported；westernDiagnosis 的标签或依据问题也不得使用 tcm_reasoning_unsupported。",
    "repairInstruction 限 300 字：必须明确指出需改的结构路径、当前结论为什么超出阳性患者事实、应删除或降级的推理方向；不得给药味剂量，不得新增患者事实，不得要求绕过结构/事实/证据合同。它只是给生成模型的定向复核意见，最终结果仍会重新校验和复核。",
    `患者事实边界：${clinicalContext.slice(0, 12_000)}`,
    evidenceContext.trim()
      ? `本轮可用证据（仅用于核对诊断标准、方证和医学依据，绝不能当作患者事实）：${evidenceContext.slice(0, 12_000)}`
      : "本轮未提供额外外部证据；不得因此编造指南、文献或方剂出处。",
    `待复核M03临床投影：${JSON.stringify(payload).slice(0, 24_000)}`,
  ].join("\n\n");
}

/**
 * Every TCM semantic rejection receives one independent adjudication after the deterministic M03
 * contract has proved the candidate is structurally complete and fact-grounded. This is not an
 * automatic acceptance path: the adjudicator applies the same evidence ladder and can confirm any
 * real overreach. It prevents one stochastic reviewer from collapsing legitimate L0→L2→L3 clinical
 * inference into an impossible "every mechanism word must be verbatim in the chart" requirement.
 */
export function m03DiagnosticReviewNeedsAdjudication(review: M03DiagnosticReview): boolean {
  return review.status === "repair" && review.issueCode === "tcm_reasoning_unsupported";
}

export function buildM03DiagnosticReviewAdjudicationPrompt(
  clinicalContext: string,
  reasoning: unknown,
  evidenceContext: string,
  firstReview: M03DiagnosticReview,
): string {
  return [
    buildM03DiagnosticReviewPrompt(clinicalContext, reasoning, evidenceContext),
    "这是对首轮复核结论的独立争议裁决，不是要求你迁就候选，也不是重新生成报告。",
    `首轮复核结论：${JSON.stringify(firstReview)}`,
    "裁决时必须按统一临床推理权威合同逐层判断：L0 事实必须接地；L2 证候可由多项相互独立事实收敛；L3 病机治法是受证候约束的临床解释，不要求机制词逐字出现在病例。不得把 L0 的逐字要求错误施加到 L2-L3。",
    "服务端已确定性验证：overview.tcmDiseaseName、overview.primarySyndrome、overview.overallPathogenesis、overview.overallTherapy、therapy.overallPrinciple 以及至少一个逐字锚定患者事实的 pathogenesis.chain 节点均为非空且通过结构合同。不得再把上述必填字段误判为空。",
    "请只裁决首轮指出的深度问题：病位或病性的 items=[] 且 resolution=unresolved 是有限信息下允许的边界，不等于总体病机或病机链为空；症状层工作证候及中医工作病名直接定义的最浅层基础功能病机，只要没有新增寒热虚实、气血津液、痰湿瘀、病因传变或命名方，也不等于机械复述。符合这些条件必须 accepted。",
    "若候选实际仍含无患者事实组合支持的具体病位、病性、证型、病因、传变、治法或命名方，或患者事实锚点与原文不符，仍必须 repair；不得以有限信息为由放行越界推断。首轮若声称‘心神、气血、脏腑病机词未在原文出现’，必须核对全案症状组合、舌脉和面色是否已在 L2 支持相应证候，不能仅做字符串比对。",
    "只输出原合同 JSON。accepted 时输出 {\"status\":\"accepted\",\"issueCode\":\"none\"}；repair 时保留准确 issueCode 和不超过300字的 repairInstruction。",
  ].join("\n\n");
}

/**
 * Reviewer prose is untrusted repair advice, not part of the signed clinical contract. For a TCM
 * semantic rejection the free-text instruction can contradict the mandatory non-empty bounded
 * reasoning contract (for example, asking the generator to clear the chain or invent a specific
 * deficiency pattern). The issue code still selects the server-owned repair policy; only the
 * narrower western/formula guidance is forwarded verbatim.
 *
 * The quarantine shape below is the same bounded neutral shape the reviewer prompt documents as
 * acceptable whenever the available facts cannot support deeper attribution (genuinely sparse
 * cases, and active cases whose positive findings are too shallow for any 病位/病性 归属):
 * symptom-level working syndrome, verbatim-anchored neutral chain nodes,
 * unresolved/empty location and nature, and no named formulas. Reviewer and repair policy must
 * stay aligned on this single shape so the same candidate cannot flip accepted/rejected across
 * runs; matchesM03QuarantineShape is the code-level mirror used by the orchestrator.
 *
 * The policy mode is chosen by m03TcmRepairMode from the review's PHI-safe guidance codes:
 * genuinely sparse overreach rejections take quarantine mode. When additional current positive
 * facts exist, both overreach and under-depth rejections take the fact-anchored minimal-syndrome
 * mode: the same overreach bans stay in force, while the remaining supported facts must anchor the
 * replacement so the reviewer does not reject a symptom-only rewrite on the next round.
 */
export function boundedM03DiagnosticRepairGuidance(
  review: M03DiagnosticReview,
  opts: { hasCurrentPositiveFacts?: boolean } = {},
): string {
  if (review.status !== "repair") return "";
  if (review.issueCode !== "tcm_reasoning_unsupported") return review.repairInstruction || "";

  const codes = m03DiagnosticRepairGuidanceCodes(review);
  // A summary-only drift is safely repaired in place. If the reviewer also found unsupported
  // concepts in the authoritative syndrome/nature/chain, the broader fact-anchored policy must
  // remain active; treating the summary label as dominant would leave the real overreach intact
  // and redraw the same rejection until the orchestration deadline.
  if (codes.length === 1 && codes[0] === "pathogenesis_summary_drift") {
    return [
      "独立复核的受控定位标签：pathogenesis_summary_drift。该标签不是患者事实。",
      "只修正 pathogenesis.summary：它只能归纳 overview.primarySyndrome、overview.overallPathogenesis、pathogenesis.natureDifferentiation 和 pathogenesis.chain[].pathogenesis 中已成立的结论。",
      "删除总结中额外引入的病因、病位、寒热虚实、气血津液、痰湿瘀血或治法断言；不得为保留该断言而补造患者事实或倒向改写其他核心字段。",
      "保持已通过校验的西医诊断、中医主证、病位病性、病机链、治法、方向和管理建议不变。",
    ].join("\n");
  }
  const prohibitedConcepts = [
    "阴虚、阳虚、气虚、血虚、津亏、阴阳两虚及对应补益治法",
    "寒、热、火、痰、湿、瘀、食积、水饮及对应祛邪治法",
    "未经患者事实或已成立中医工作病名的定义性基础病机直接支持的脏腑、经络、气血津液、营卫、卫气、心神归属",
    "未经患者事实直接支持的病因、诱因和传变路径，包括肝郁、情志内伤、食积及外感",
  ];
  // The mode is selected from the review's PHI-safe guidance codes plus the deterministic
  // sparse/active signal — see m03TcmRepairMode. Active cases use the fact-anchored policy while
  // retaining the same hard deletion list for every unsupported concept.
  if (m03TcmRepairMode(review, Boolean(opts.hasCurrentPositiveFacts)) === "fact_anchored") {
    return [
      `独立复核的受控定位标签：${codes.length > 0 ? codes.join(",") : "generic_tcm_overreach"}。这些标签不是患者事实。`,
      `硬性删减：仅从主证候、病位病性、总体病机、病机链、总治法和方义方向中删除未获本例阳性事实直接支持的以下概念及同义改写：${prohibitedConcepts.join("；")}。有直接原文依据（舌脉、伴随症状、体征、检验）的结论可以保留，但保持低置信度并逐字标注依据；不得删除患者事实本身。`,
      "本例主诉之外仍有当前阳性事实，禁止退回到症状复述或疾病标签改写：overview.primarySyndrome 必须由这些阳性事实锚定，primarySyndromeBasis 逐字引用患者原文，形成最小、低置信度的非空闭环；只使用原文直接支持的最浅结论层级，拿不准的证型归属写入 uncertainties，不得补造未出现的事实、舌脉或阴性史。",
      "如果这些额外事实只是主症的次数、时程、性状或诱发规律，尚不支持寒热虚实等具体证型，则使用 overview.tcmDiseaseName 所定义的最浅层基础功能病机形成闭环；这不是症状复述，也不授权补出痰湿瘀、气血阴阳或寒热虚实。",
      "覆盖修复：逐条复核会实质改变诊断、风险、证候深度、治法或随访的当前阳性事实；每项至少进入 westernDiagnosis 依据/鉴别、primarySyndromeBasis、pathogenesis.chain.patientFact 或 uncertainties 之一。不能支持主证的事实放 uncertainties，不得为覆盖事实而强行推出具体证型。",
      "locationDifferentiation 与 natureDifferentiation 只填写有直接原文依据的分类；无依据的维度保持分类数组为空、resolution=unresolved 并填写 resolutionReason，不得为凑分类新增脏腑、经络或寒热虚实。",
      "pathogenesis.chain 至少一条并逐字锚定患者阳性原文；每个节点的 pathogenesis 与 therapyDirection 不得超出该原文直接支持的机制层级，不得把总体病机和治法原句机械复制到节点。",
      "recommendedFormulaNames 只保留已进入本例受控候选、且方证定义性症状在阳性事实中成立的命名方；不成立则清空并保持 formulaSelectionMode=self_devised，recommendedFormulaDirection 只写“按已锁定病机与治法辨证组方”。",
    ].join("\n");
  }

  // Once the independent reviewer rejects the TCM reasoning, replacing one unsupported named
  // pattern with another is not a valid repair. Enter a symptom-grounded quarantine mode with a
  // closed semantic vocabulary; later M03/M04 review can only add specificity from a fresh case,
  // never from this failed candidate. This neutral quarantine shape is only legitimate for
  // genuinely sparse cases (情形一); active cases take the fact-anchored branch above.
  const lines = [
    `独立复核的受控定位标签：${codes.length > 0 ? codes.join(",") : "generic_tcm_overreach"}。这些标签不是患者事实。`,
    `进入语义隔离模式。硬性删减：从主证候、病位病性、总体病机、病机链、总治法和方义方向中删除以下概念及同义改写：${prohibitedConcepts.join("；")}。不得删掉一种后换成另一种，待鉴别方向只能放入 uncertainties。`,
    "清空 recommendedFormulaNames，formulaSelectionMode 改为 self_devised，recommendedFormulaDirection 只写“按已锁定病机与治法辨证组方”，不得推荐任何命名方。",
    "locationDifferentiation 与 natureDifferentiation 的分类数组全部置空，resolution 明确设为 unresolved，并分别填写 resolutionReason；不要用 bounded 配空数组，也不要为凑分类新增脏腑、经络或寒热虚实。",
    "pathogenesis.chain 仍须至少一条并逐字锚定患者阳性原文。每个节点的 pathogenesis 只能写该原文或 overview.tcmDiseaseName 直接定义的最浅层基础功能病机（如通降、传导、濡养、宣降或活动功能受扰），therapyDirection 只能写对应的功能恢复方向；不得引入寒热虚实、气血津液、痰湿瘀等证型概念，不得把总体病机和治法原句机械复制到节点。",
    "overview.primarySyndrome 使用症状层、低置信度的临床工作表述，primarySyndromeResolution 设为 bounded；overview.overallPathogenesis、overallTherapy 与 therapy.overallPrinciple 必须具体承接主诉本身体现的功能变化，不得出现‘功能失调候’‘调护功能’或待辨、资料不足等套话。",
  ];
  return lines.join("\n");
}

const M03_REPAIR_GUIDANCE_CODE_RULES: Array<[string, RegExp]> = [
  ["pathogenesis_summary_drift", /pathogenesis_summary_drift/i],
  ["positive_fact_omission", /positive_fact_omission|(?:遗漏|漏用|未纳入|未覆盖|未体现)[^。；]{0,24}(?:当前|本例|管理相关|有鉴别意义)?(?:阳性事实|阳性症状|阳性体征|检查异常)/i],
  ["empty_or_unresolved", /(?:清空|留空|删除)[^。；]{0,16}(?:病机链|chain|病位|病性)|待辨|待定|无法(?:完成|形成|判断)|资料不足/],
  ["symptom_restatement", /(?:重复|复述|改写)[^。；]{0,16}(?:主诉|症状|患者事实)|只是[^。；]{0,16}(?:主诉|症状)/],
  ["location_unsupported", /病位(?![^。；]{0,16}(?:不得留空|不能留空|需同步|必须(?:写入|列出|保留)))[^。；]{0,24}(?:无依据|缺乏|不足以|超出|不能支持|不得写入)/],
  ["nature_unsupported", /病性(?![^。；]{0,16}(?:不得留空|不能留空|需同步|必须(?:写入|列出|保留)))[^。；]{0,24}(?:无依据|缺乏|不足以|超出|不能支持|不得写入)/],
  ["chain_not_closed", /(?:病机链|pathogenesis\.chain|chain)[^。；]{0,28}(?:(?<!非)空|未|无|不足|缺乏|重复|不完整|未形成)/],
  ["yin_deficiency_overreach", /阴虚|津亏|滋阴|虚火/],
  ["yang_cold_overreach", /阳虚|温阳|寒证|散寒|畏寒|肢冷/],
  ["heat_overreach", /热证|实热|清热|泻火|火热/],
  ["phlegm_damp_overreach", /痰湿|痰浊|湿阻|化痰|祛湿/],
  ["blood_stasis_overreach", /血瘀|瘀阻|活血|化瘀/],
  ["qi_blood_deficiency_overreach", /气虚|血虚|气血(?:两)?虚|益气|养血/],
  ["ying_wei_overreach", /营卫|卫气/],
  ["heart_spirit_overreach", /心神|安神|宁心/],
  ["etiology_overreach", /肝气郁结|肝郁气滞|肝郁犯胃|情志(?:内伤|不畅|诱因)|忧思伤脾|食积|外感/],
  ["named_formula_overreach", /命名方|经方|方剂|方名/],
];

/** PHI-safe diagnostic labels for telemetry; never returns reviewer prose or patient facts. */
export function m03DiagnosticRepairGuidanceCodes(review: M03DiagnosticReview): string[] {
  if (review.status !== "repair" || !review.repairInstruction) return [];
  return M03_REPAIR_GUIDANCE_CODE_RULES
    .flatMap(([code, pattern]) => pattern.test(review.repairInstruction || "") ? [code] : []);
}

const M03_QUARANTINE_OVERREACH_CODES = new Set([
  "yin_deficiency_overreach",
  "yang_cold_overreach",
  "heat_overreach",
  "phlegm_damp_overreach",
  "blood_stasis_overreach",
  "qi_blood_deficiency_overreach",
  "ying_wei_overreach",
  "heart_spirit_overreach",
  "etiology_overreach",
]);

function quarantineOverreachText(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return M03_REPAIR_GUIDANCE_CODE_RULES.some(([code, pattern]) =>
    M03_QUARANTINE_OVERREACH_CODES.has(code) && pattern.test(value));
}

/**
 * The quarantine repair policy (boundedM03DiagnosticRepairGuidance) can only produce one bounded
 * neutral shape: location/nature unresolved-or-empty, no named formulas, a non-empty chain whose
 * mechanisms stay within neutral functional language, and a symptom-level primary syndrome. When
 * the independent reviewer keeps rejecting that exact shape with the same issue code, re-injecting
 * the identical guidance redraws the same stochastic accept/reject lottery. The M03 orchestrator
 * uses this predicate to detect that fixpoint and exit early to the signed limited fallback
 * instead of burning another full model round. This is an orchestration-efficiency signal only;
 * it never weakens any deterministic contract check.
 */
export function matchesM03QuarantineShape(reasoning: unknown): boolean {
  const source = record(reasoning);
  const overview = record(source?.overview);
  const pathogenesis = record(source?.pathogenesis);
  const therapy = record(source?.therapy);
  if (!source || !overview || !pathogenesis || !therapy) return false;
  const unresolvedOrEmpty = (value: unknown): boolean => {
    const differentiation = record(value);
    if (!differentiation) return false;
    const items = Array.isArray(differentiation.items) ? differentiation.items : [];
    // Quarantine guidance requires the attribution arrays themselves to be empty. Merely labelling
    // a non-empty unsupported attribution as unresolved is not convergence.
    return items.every((item) => typeof item !== "string" || !item.trim()) &&
      (differentiation.resolution === "unresolved" || differentiation.resolution === "bounded");
  };
  const location = record(pathogenesis.locationDifferentiation);
  const nature = record(pathogenesis.natureDifferentiation);
  if (!unresolvedOrEmpty(location) || !unresolvedOrEmpty(nature)) return false;
  for (const attributionList of [nature?.rootDeficiency, nature?.branchExcess]) {
    if (Array.isArray(attributionList) && attributionList.some((item) => typeof item === "string" && item.trim())) return false;
  }
  const formulaNames = Array.isArray(overview.recommendedFormulaNames) ? overview.recommendedFormulaNames : [];
  if (formulaNames.some((name) => typeof name === "string" && name.trim())) return false;
  const chain = Array.isArray(pathogenesis.chain) ? pathogenesis.chain : [];
  if (chain.length === 0) return false;
  const semanticAttributions = [
    overview.primarySyndrome,
    overview.overallPathogenesis,
    overview.overallTherapy,
    overview.recommendedFormulaDirection,
    pathogenesis.summary,
    nature?.basis,
    nature?.resolutionReason,
    location?.resolutionReason,
    therapy.overallPrinciple,
    therapy.overallMethod,
    ...(Array.isArray(therapy.subTherapies)
      ? therapy.subTherapies.flatMap((item) => {
          const sub = record(item);
          return sub ? [sub.therapy, sub.targetPathogenesis] : [];
        })
      : []),
  ];
  if (semanticAttributions.some(quarantineOverreachText)) return false;
  return chain.every((node) => {
    const item = record(node);
    if (!item) return false;
    return typeof item.patientFact === "string" && Boolean(item.patientFact.trim()) &&
      !quarantineOverreachText(item.pathogenesis) &&
      !quarantineOverreachText(item.therapyDirection);
  });
}

const M03_HISTORY_LINE_PREFIX = /^(?:既往史|个人史|家族史|婚育史|月经史|孕产史|用药史|过敏史|药物过敏史|食物过敏史|手术史|外伤史|输血史|预防接种史|流行病学史)\s*[：:]/;
const M03_GROUNDING_WRAPPER_PREFIX = /^(?:患者\/医生已确认补充|基层接诊初始记录|本轮追问补充|问诊补充|患者回答|医生补充|现病史|症状\.[^：:]+|主诉)\s*[：:]\s*/;
const M03_UNKNOWN_PLACEHOLDER_CLAUSE = /(?:(?:本次|本轮|当前|目前)?(?:未取得(?:该|相关)?信息|未能确认|不清楚|不确定|不知道|说不清|记不清|答不上来|没法说|别的说不清)|未提供|未记录|未询问|未采集|未提及|未诉|不详|未知|暂无)/;
const M03_NON_CLINICAL_REQUEST_CLAUSE = /^(?:你)?(?:就|先)?按(?:现在|目前|已有|这些)[^\n]{0,16}(?:分析|推理|看|判断)(?:吧|一下)?$|^(?:继续|先分析|先看看|按现有信息处理)(?:吧)?$|^(?:请)?(?:继续|尽快|进一步)?(?:现场)?(?:评估|核实|补充|确认|观察|判断)(?:相关情况|后再说)?$/;
const M03_ANAPHORIC_CHIEF_RESTATEMENT = /^(?:这样|这种情况|上述情况|这个|这些)(?:已|有|持续|反复)?(?:了)?(?:约|大概|差不多)?(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半数几多]+)(?:小时|天|日|周|月|年)(?:多|余|来)?$/;
const M03_COLLOQUIAL_NEGATED_EVENT = /^(?:没|没有)(?:[^，,。；;\n]{0,24}过[^，,。；;\n]{0,12}|[^，,。；;\n]{0,18}(?:发生|出现|发作|再发)(?:[了的]|吗|么)?)$/;
const M03_NEGATIVE_FORM_POSITIVE_SYMPTOM = /^(?:没|没有)(?:精神|力气|胃口|食欲)|^(?:睡不着|吃不下|咽不下|解不出|拉不出|喘不上气)/;

function normalizeGroundingLine(value: string): string {
  return value.normalize("NFKC").replace(/[\s，,。；;：:、→\-—_（）()[\]【】.]+/g, "");
}

/**
 * Deterministic sparse/active signal for the reviewer 情形一/情形二 split, computed on the same
 * deidentified grounding text the reviewer sees. "Current positive facts beyond the chief
 * complaint" means at least one substantive line that is not a history-only entry, not an
 * unknown/placeholder entry, and not a restatement of the chief-complaint line. Both error
 * directions degrade safely: a false "sparse" sends quarantine guidance into one bounded
 * rejection plus the identical-guidance early exit; a false "active" only asks the generator to
 * anchor to whatever positive facts exist (possibly just the chief complaint).
 */
export function m03GroundingHasCurrentPositiveFacts(clinicalContext: string): boolean {
  const lines = clinicalContext.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return false;
  const chief = normalizeGroundingLine(lines[0].replace(M03_GROUNDING_WRAPPER_PREFIX, ""));
  return lines.slice(1).some((line) => {
    if (M03_HISTORY_LINE_PREFIX.test(line)) return false;
    return line.split(/[，,。；;\n]+/).some((rawClause) => {
      let clause = rawClause.trim();
      let previous = "";
      while (clause && clause !== previous) {
        previous = clause;
        clause = clause.replace(M03_GROUNDING_WRAPPER_PREFIX, "").trim();
      }
      if (clause.length < 2 || M03_UNKNOWN_PLACEHOLDER_CLAUSE.test(clause) || M03_NON_CLINICAL_REQUEST_CLAUSE.test(clause) || M03_ANAPHORIC_CHIEF_RESTATEMENT.test(clause)) return false;
      const normalized = normalizeGroundingLine(clause);
      if (normalized.length < 4) return false;
      if (chief && (normalized.includes(chief) || chief.includes(normalized))) return false;
      if (M03_NEGATIVE_FORM_POSITIVE_SYMPTOM.test(clause)) return true;
      if (M03_COLLOQUIAL_NEGATED_EVENT.test(clause)) return false;
      return clinicalClausePolarity(clause) === "affirmed";
    });
  });
}

const M03_REPAIR_UNDER_DEPTH_CODES = new Set([
  "positive_fact_omission",
  "symptom_restatement",
  "chain_not_closed",
  "empty_or_unresolved",
]);
const M03_REPAIR_OVERREACH_CODES = new Set([
  "location_unsupported",
  "nature_unsupported",
  "named_formula_overreach",
  ...M03_QUARANTINE_OVERREACH_CODES,
]);

/**
 * Selects which server-owned repair policy a tcm_reasoning_unsupported rejection gets. The
 * reviewer's free-text instruction is untrusted, but its PHI-safe guidance codes classify the
 * rejection direction: an overreach rejection (unsupported location/nature/concept/formula
 * attribution) takes quarantine only when the case is genuinely sparse. If additional current
 * positive facts exist, the fact-anchored policy still deletes the unsupported attribution but
 * uses those remaining facts to form the minimal replacement. Under-depth rejections follow the
 * same sparse/active split. This mirrors the reviewer rule: depth is demanded only to the level the
 * facts support, so reviewer and repair policy stop pulling in opposite directions.
 */
export function m03TcmRepairMode(
  review: M03DiagnosticReview,
  hasCurrentPositiveFacts: boolean,
): "quarantine" | "fact_anchored" {
  if (review.status !== "repair" || review.issueCode !== "tcm_reasoning_unsupported") return "quarantine";
  const codes = new Set(m03DiagnosticRepairGuidanceCodes(review));
  for (const code of codes) {
    if (M03_REPAIR_OVERREACH_CODES.has(code)) return hasCurrentPositiveFacts ? "fact_anchored" : "quarantine";
  }
  for (const code of codes) {
    if (M03_REPAIR_UNDER_DEPTH_CODES.has(code)) return hasCurrentPositiveFacts ? "fact_anchored" : "quarantine";
  }
  return hasCurrentPositiveFacts ? "fact_anchored" : "quarantine";
}

export function parseM03DiagnosticReview(content: string): M03DiagnosticReview {
  const parsed = parseClinicalReviewJson(content);
  if (parsed) {
    if (parsed.status === "accepted" && parsed.issueCode === "none") {
      return { status: "accepted", issueCode: "none" };
    }
    if (parsed.status === "repair" && typeof parsed.issueCode === "string" && REPAIR_ISSUES.has(parsed.issueCode)) {
      const repairInstruction = typeof parsed.repairInstruction === "string"
        ? parsed.repairInstruction.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 800)
        : "";
      return {
        status: "repair",
        issueCode: parsed.issueCode as M03DiagnosticRepairIssue,
        ...(repairInstruction ? { repairInstruction } : {}),
      };
    }
  }
  return { status: "unavailable", issueCode: "review_unavailable" };
}
