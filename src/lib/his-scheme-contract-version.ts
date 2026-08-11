import type { HisAiSchemePayload } from "./his-scheme";

/**
 * HIS 方案的**契约版本协商**（2026-08-11）。
 *
 * ── 这条为什么必须存在 ─────────────────────────────────────────────────────────
 *
 * V1.4 给 `nonPharma.tcmTreatments[].protocolStatus` 加了第三个枚举值
 * `governed_class_template_not_syndrome_tailored`，理由是对的（把「病种模板」冒充成
 * 「个体化方案」是在说谎），实现也是安全的（`adoptable:false`、页面标注正确）。
 * 但它是在 **`schemaVersion` 不变** 的前提下加的——对用 Java enum / Kotlin sealed /
 * TypeScript union / Jackson `FAIL_ON_UNKNOWN` 反序列化的集成方，这是**破坏性变更**：
 * 他们的解析会直接抛异常，而不是"忽略未知值"。
 *
 * 在变更记录里登记「这是破坏性变更」不等于没有破坏它。正确做法是让 V1 继续是 V1：
 *
 *   · **V1（默认）**：`protocolStatus` 只回旧两态。第三态**向下映射**为
 *     `assessment_only_no_patient_specific_protocol`——这是安全方向的映射：
 *     「未按证型加减」在旧词汇里最接近的语义就是「尚未形成患者级方案」，
 *     旧集成方按它处理只会更保守，不会把未加减的模板当成个体化方案采纳。
 *   · **两版都新增**非破坏字段 `tailoringStatus`：三态的**真实值**在这里，
 *     旧集成方忽略即可，新集成方读它就能区分「病种模板」与「纯评估」。
 *   · **V2（显式请求）**：`protocolStatus` 开放真三态。
 *
 * 三个字段的关系写死在下表里，任何一处改动都会被 test:his-contract-version 逐条比对。
 *
 * ── 边界 ───────────────────────────────────────────────────────────────────────
 * 只做**投影**，不改任何安全判定：`adoptable` 恒为 false、`protocolGap` 原样下发、
 * 未终审条目的降级发生在更上游（tcm-treatment-capabilities），这里不参与。
 * 映射方向是单向的（三态 → 两态），绝不会把评估态提升成个体化方案。
 */
export const HIS_SCHEME_CONTRACT_VERSIONS = ["v1", "v2"] as const;
export type HisSchemeContractVersion = (typeof HIS_SCHEME_CONTRACT_VERSIONS)[number];

export const HIS_SCHEME_VERSION_IDS: Record<HisSchemeContractVersion, string> = {
  v1: "tcm-cdss-his-ai-scheme-v1",
  v2: "tcm-cdss-his-ai-scheme-v2",
};

/** 方案加减状态的**真实值**。与 protocolStatus 三态一一对应，永不做兼容映射。 */
export type TcmTreatmentTailoringStatus =
  | "syndrome_tailored"
  | "class_template_only"
  | "assessment_only";

const TAILORING_BY_PROTOCOL_STATUS: Record<string, TcmTreatmentTailoringStatus> = {
  governed_patient_specific_plan: "syndrome_tailored",
  governed_class_template_not_syndrome_tailored: "class_template_only",
  assessment_only_no_patient_specific_protocol: "assessment_only",
};

/** V1 只认这两个值；第三态向**更保守**的一侧映射。 */
const V1_PROTOCOL_STATUS: Record<string, string> = {
  governed_patient_specific_plan: "governed_patient_specific_plan",
  governed_class_template_not_syndrome_tailored: "assessment_only_no_patient_specific_protocol",
  assessment_only_no_patient_specific_protocol: "assessment_only_no_patient_specific_protocol",
};

/**
 * 逐穴角色的 V1 折叠（2026-08-11）。conditional_point 是本轮新增的第四个值
 *（既非主穴也非证型加减，而是本例当前症状触发的条件加穴，如风寒咳嗽兼鼻窍症状加风池）。
 *
 * 新增枚举值不得破坏 V1——这条教训就是本轮 protocolStatus 第三态的那条：
 * 我们在自己的载荷里加一个值，对面按旧枚举做 switch 就落到 default。
 * V1 折叠到 syndrome_refinement（同样是"主穴之外按本例加的穴"，语义最近且不更宽），
 * V2 才开放真实值。真实值另有非折叠落点：pointProvenance[].conflictNote 与穴位标注里的触发说明。
 */
const V1_POINT_PROVENANCE_ROLE: Record<string, string> = {
  base_point: "base_point",
  syndrome_refinement: "syndrome_refinement",
  syndrome_removal: "syndrome_removal",
  conditional_point: "syndrome_refinement",
};

/**
 * 从请求里读契约版本。三处都认，优先级 query > header > body；一律缺省 v1。
 * 认不出的值**不报错**——集成方拼错版本号时应当拿到最保守的 V1，而不是 400。
 */
export function hisSchemeContractVersionFromRequest(
  req: Request,
  body?: unknown,
): HisSchemeContractVersion {
  const fromQuery = new URL(req.url).searchParams.get("schemaVersion");
  const fromHeader = req.headers.get("x-cdss-his-scheme-version");
  const fromBody = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).hisSchemeVersion ?? (body as Record<string, unknown>).schemaVersion
    : undefined;
  for (const raw of [fromQuery, fromHeader, fromBody]) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (!value) continue;
    if (value === "v2" || value === HIS_SCHEME_VERSION_IDS.v2) return "v2";
    if (value === "v1" || value === HIS_SCHEME_VERSION_IDS.v1) return "v1";
  }
  return "v1";
}

type TcmProject = HisAiSchemePayload["treatments"]["tcmProjects"][number];
type ProjectedProject = Omit<TcmProject, "protocolStatus" | "pointProvenance"> & {
  protocolStatus: string;
  tailoringStatus: TcmTreatmentTailoringStatus;
  pointProvenance?: Array<Omit<NonNullable<TcmProject["pointProvenance"]>[number], "role"> & { role: string }>;
};

/**
 * 把内部规范载荷投影成指定契约版本。**纯函数、幂等**：对已投影过的载荷再跑一次结果不变
 * （tailoringStatus 由 protocolStatus 派生，V1 下第三态已被折叠，再折叠仍是同一个值）。
 */
export function projectHisSchemeForContractVersion<T extends { schemaVersion: string; treatments?: { tcmProjects?: unknown } }>(
  payload: T,
  version: HisSchemeContractVersion,
  /** 规范三态的原始值。投影 V1 时 protocolStatus 会被折叠，真实值只能从这里取。 */
  canonicalStatuses?: readonly string[],
): T & { schemaVersion: string } {
  const projects = Array.isArray(payload.treatments?.tcmProjects)
    ? payload.treatments.tcmProjects as TcmProject[]
    : [];
  const projected: ProjectedProject[] = projects.map((project, index) => {
    const canonical = canonicalStatuses?.[index] || project.protocolStatus;
    return {
      ...project,
      protocolStatus: version === "v1" ? (V1_PROTOCOL_STATUS[canonical] ?? canonical) : canonical,
      tailoringStatus: TAILORING_BY_PROTOCOL_STATUS[canonical] ?? "assessment_only",
      ...(project.pointProvenance?.length
        ? {
          pointProvenance: project.pointProvenance.map((entry) => ({
            ...entry,
            role: version === "v1" ? (V1_POINT_PROVENANCE_ROLE[entry.role] ?? entry.role) : entry.role,
          })),
        }
        : {}),
    };
  });
  return {
    ...payload,
    schemaVersion: HIS_SCHEME_VERSION_IDS[version],
    ...(projects.length > 0 || payload.treatments
      ? { treatments: { ...(payload.treatments || {}), tcmProjects: projected } }
      : {}),
  };
}

/** 规范三态：投影前先取出来，V1 折叠之后就再也拿不到了。 */
export function canonicalTcmProjectProtocolStatuses(
  payload: { treatments?: { tcmProjects?: unknown } },
): string[] {
  return Array.isArray(payload.treatments?.tcmProjects)
    ? (payload.treatments.tcmProjects as Array<{ protocolStatus?: unknown }>)
      .map((project) => String(project?.protocolStatus || ""))
    : [];
}
