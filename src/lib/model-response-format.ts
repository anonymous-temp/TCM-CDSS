import { z } from "zod";
import { ReasoningV2Schema } from "./diagnosis-types";
import { M04ProposalSchema } from "./m04-proposal-compiler";
import { textModelCapabilities } from "./text-model-capabilities";

export type StructuredOutputTask =
  | "m03_full"
  | "m03_western"
  | "m03_tcm"
  | "m04_proposal"
  /** M04 定向修复：只重写 candidate，其余字段由服务端从上一版提案逐字拼回（2026-09-20）。 */
  | "m04_candidate_patch";

type JsonSchema = Record<string, unknown>;

function nullableSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { anyOf: [schema, { type: "null" }] };
  }
  const objectSchema = schema as JsonSchema;
  const nullableEnum = Array.isArray(objectSchema.enum) && !objectSchema.enum.includes(null)
    ? { enum: [...objectSchema.enum, null] }
    : {};
  if (typeof objectSchema.type === "string") {
    return { ...objectSchema, ...nullableEnum, type: [objectSchema.type, "null"] };
  }
  if (Array.isArray(objectSchema.type)) {
    return objectSchema.type.includes("null")
      ? objectSchema
      : { ...objectSchema, ...nullableEnum, type: [...objectSchema.type, "null"] };
  }
  return { anyOf: [objectSchema, { type: "null" }] };
}

/**
 * Qwen strict mode follows the provider's constrained-decoding subset: every
 * object must reject unknown keys and list every property in `required`.
 * Optional application fields stay optional semantically by accepting null;
 * the existing Zod `.catch`/normalization layer then converts those nulls back
 * to their established defaults.
 */
function emptyProviderSchemaFor(propertyName: string | undefined): JsonSchema {
  if (propertyName === "structureRole") {
    return {
      type: ["string", "null"],
      enum: ["middle_jiao_support", "harmonize", "guide", "temper", null],
    };
  }
  if (["decoctionRequirement", "specification", "singleDose", "frequency", "route", "administrationTiming", "course"].includes(propertyName || "")) {
    return { type: ["string", "null"], maxLength: 300 };
  }
  if (propertyName === "targetPathogenesis") {
    return { type: ["string", "null"], maxLength: 600 };
  }
  if (propertyName === "riskNote") {
    return { type: ["string", "null"], maxLength: 1_200 };
  }
  throw new Error(`Unsupported empty JSON schema${propertyName ? ` for ${propertyName}` : ""}`);
}

function strictProviderSchema(value: unknown, propertyName?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => strictProviderSchema(item, propertyName));
  if (!value || typeof value !== "object") return value;

  const source = value as JsonSchema;
  if (Object.keys(source).length === 0) return emptyProviderSchemaFor(propertyName);
  const normalized = Object.fromEntries(
    Object.entries(source).map(([key, child]) => [key, strictProviderSchema(child, key)]),
  ) as JsonSchema;
  if (Array.isArray(normalized.type) && normalized.type.includes("null") &&
      Array.isArray(normalized.enum) && !normalized.enum.includes(null)) {
    normalized.enum = [...normalized.enum, null];
  }
  const rawProperties = source.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return normalized;
  }

  const requiredBeforeStrict = new Set(
    Array.isArray(source.required)
      ? source.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const properties = Object.fromEntries(
    Object.entries(rawProperties as Record<string, unknown>).map(([key, child]) => {
      const strictChild = strictProviderSchema(child, key);
      return [key, requiredBeforeStrict.has(key) ? strictChild : nullableSchema(strictChild)];
    }),
  );
  return {
    ...normalized,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export function supportsStrictJsonSchema(model: string): boolean {
  return textModelCapabilities(model).strictJsonSchema;
}

let reasoningSchema: JsonSchema | undefined;
let proposalSchema: JsonSchema | undefined;

function fullReasoningSchema(): JsonSchema {
  reasoningSchema ||= z.toJSONSchema(ReasoningV2Schema, {
    unrepresentable: "any",
    reused: "ref",
  }) as JsonSchema;
  return reasoningSchema;
}

function m04ProposalJsonSchema(): JsonSchema {
  proposalSchema ||= z.toJSONSchema(M04ProposalSchema, {
    unrepresentable: "any",
    reused: "ref",
  }) as JsonSchema;
  return proposalSchema;
}

function reasoningHalfSchema(keys: readonly string[]): JsonSchema {
  const full = fullReasoningSchema();
  const properties = full.properties && typeof full.properties === "object"
    ? full.properties as Record<string, unknown>
    : {};
  const selected = Object.fromEntries(keys.flatMap((key) => key in properties ? [[key, properties[key]]] : []));
  const required = Array.isArray(full.required)
    ? full.required.filter((key): key is string => typeof key === "string" && key in selected)
    : [];
  return {
    ...(typeof full.$schema === "string" ? { $schema: full.$schema } : {}),
    ...(full.$defs ? { $defs: full.$defs } : {}),
    type: "object",
    properties: selected,
    required,
    additionalProperties: false,
  };
}

/**
 * C+ready M03 generation must return at least one clinical chain node. Keep this constraint on the
 * provider response schema rather than the shared Zod model: deterministic limited fallbacks
 * intentionally carry an empty chain, while model-generated full/TMC halves never may.
 */
function requireGeneratedM03Chain(schema: JsonSchema): JsonSchema {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : undefined;
  const pathogenesis = properties?.pathogenesis && typeof properties.pathogenesis === "object" && !Array.isArray(properties.pathogenesis)
    ? properties.pathogenesis as JsonSchema
    : undefined;
  const pathogenesisProperties = pathogenesis?.properties && typeof pathogenesis.properties === "object" && !Array.isArray(pathogenesis.properties)
    ? pathogenesis.properties as Record<string, unknown>
    : undefined;
  const chain = pathogenesisProperties?.chain && typeof pathogenesisProperties.chain === "object" && !Array.isArray(pathogenesisProperties.chain)
    ? pathogenesisProperties.chain as JsonSchema
    : undefined;
  if (!properties || !pathogenesis || !pathogenesisProperties || !chain) return schema;
  const chainWithoutDefault = { ...chain };
  const pathogenesisWithoutDefault = { ...pathogenesis };
  delete chainWithoutDefault.default;
  delete pathogenesisWithoutDefault.default;
  return {
    ...schema,
    properties: {
      ...properties,
      pathogenesis: {
        ...pathogenesisWithoutDefault,
        properties: {
          ...pathogenesisProperties,
          chain: { ...chainWithoutDefault, minItems: 1 },
        },
      },
    },
  };
}

/**
 * 生成侧「必须有内容」约束（2026-09-19，换回 Qwen strict 的前置条件）。
 *
 * 约束解码对「可空 + 缺省 []」与「必填但允许空数组」的数组一律走最短路径。同一请求体配对重放
 * （3 例 × 2 次，qwen3.8-flash strict）：中医半主证候依据 1/6 有内容、病名鉴别与证候鉴别各 1/6、
 * 病位与病性 2/6、子治法 2/6、待核实信息 0/6——同时把证候/病位/病性的 resolution 写成
 * resolved，即「零依据的已明确」。同一请求体 DeepSeek 全部 6/6。只改成必填不可空仍 0/6，
 * 加 minItems:1 才 6/6。
 *
 * 与 requireGeneratedM03Chain 同一分工：只收紧下发给模型的那份 schema，共享 zod 契约一个字不动
 * ——确定性兜底合法地带空数组。有意不在此列的：recommendedFormulaNames（提示词明定检索短名单
 * 无匹配时为 []）、secondarySyndromes / rootDeficiency / branchExcess / symptomClusters（临床上
 * 可以没有，提示词写 0–6 组）、各 References（只许抄检索结果，强制非空会逼出编造引用）。
 */
const M03_GENERATED_NON_EMPTY_ARRAYS: readonly (readonly string[])[] = [
  ["overview", "primarySyndromeBasis"],
  ["overview", "tcmDiseaseDifferentials"],
  ["overview", "tcmDifferentials"],
  ["pathogenesis", "locationDifferentiation", "items"],
  ["pathogenesis", "locationDifferentiation", "details"],
  ["pathogenesis", "natureDifferentiation", "items"],
  ["pathogenesis", "uncertainties"],
  ["therapy", "subTherapies"],
];

function requireGeneratedM03Content(schema: JsonSchema): JsonSchema {
  // reasoningHalfSchema 与缓存的完整 schema 共享嵌套节点，先克隆，免得改到缓存。
  const clone = structuredClone(schema);
  for (const path of M03_GENERATED_NON_EMPTY_ARRAYS) {
    let parent: JsonSchema | undefined = clone;
    for (const key of path.slice(0, -1)) parent = schemaProperties(parent)?.[key];
    const leafKey = path[path.length - 1];
    const leaf = schemaProperties(parent)?.[leafKey];
    if (!parent || !leaf || leaf.type !== "array") continue;
    delete leaf.default;
    leaf.minItems = Math.max(1, typeof leaf.minItems === "number" ? leaf.minItems : 0);
    // 不在 required 里的属性会被 strictProviderSchema 改成可空，模型就能用 null 绕过 minItems。
    const required = Array.isArray(parent.required) ? parent.required as unknown[] : [];
    if (!required.includes(leafKey)) parent.required = [...required, leafKey];
  }
  return clone;
}

/**
 * 生成侧合同裁剪（P2）。
 *
 * 校验用的 `ReasoningV2Schema` **一个字段都不动**——签名载荷、HIS 出口、页面投影、M04 输入
 * 的形状全部保持逐字不变。这里只裁「下发给模型的那份 schema」：把服务端本来就要覆盖或
 * 补齐的字段从生成契约里去掉，模型少写这些 token，解码时间跟着变短。
 * 服务端在校验与签名之前用 `applyServerOwnedM03Fields` 确定性补齐它们。
 *
 * 裁掉的字段与理由（逐字段复证过消费方，见该模块顶部注释）：
 *  · schemaVersion / stage / formula / nonPharma —— 服务端常量，合并层本就强制写死；
 *  · pathogenesis.summary —— 被 normalizeM03PathogenesisSummaryProjection 无条件投影覆盖；
 *  · 各处 evidence —— 模板预填 model_inference，而呈现层第一个排除的就是它
 *    （归档 2280 条里 2177 条是这个值，「指南/文献依据」一栏自诞生起产出 0 条）。
 *
 * $def 按**形状**识别，不按 `__schemaN` 这种自动生成的名字——名字会随 zod 契约任何改动漂移，
 * 按名字写死等于埋一颗静默失效的雷。
 */
const M03_SERVER_OWNED_TOP_LEVEL = ["schemaVersion", "stage", "formula", "nonPharma"] as const;

function schemaProperties(node: unknown): Record<string, JsonSchema> | undefined {
  const record = node && typeof node === "object" ? node as JsonSchema : undefined;
  return record?.properties && typeof record.properties === "object"
    ? record.properties as Record<string, JsonSchema>
    : undefined;
}

/** 从 properties 与 required 中同时删除；strictProviderSchema 要求两者一致。 */
function removeSchemaProperty(node: unknown, key: string): void {
  const record = node && typeof node === "object" ? node as JsonSchema & { required?: unknown } : undefined;
  const properties = schemaProperties(record);
  if (!record || !properties || !(key in properties)) return;
  delete properties[key];
  if (Array.isArray(record.required)) {
    record.required = (record.required as unknown[]).filter((entry) => entry !== key);
  }
}

function hasAllProperties(node: unknown, keys: readonly string[]): boolean {
  const properties = schemaProperties(node);
  return Boolean(properties) && keys.every((key) => key in properties!);
}

/**
 * Only the provider projection is reduced; M04ProposalSchema remains the full legacy parser.
 * normalizeM04ProposalInput owns the version, modification accounting and acupointCare=null.
 * Required doseCount/dosesPerDay determine course; compilation owns therapyMatch via the M03 lock.
 * Keep isToxic: the compiler preserves a model's conservative true flag in addition to KB flags.
 * Keep individualized prose (including method/followUpNode), which the compiler can preserve.
 */
function stripServerOwnedM04Fields(schema: JsonSchema): JsonSchema {
  const clone = structuredClone(schema);
  const definitions = (clone.$defs || {}) as Record<string, JsonSchema>;
  const resolve = (node: JsonSchema | undefined): JsonSchema | undefined => {
    if (typeof node?.$ref !== "string") return node;
    const name = node.$ref.startsWith("#/$defs/") ? node.$ref.slice("#/$defs/".length) : "";
    return definitions[name];
  };
  for (const key of ["schemaVersion", "modificationReview"]) removeSchemaProperty(clone, key);
  const properties = schemaProperties(clone);
  const candidate = resolve(properties?.candidate);
  removeSchemaProperty(candidate, "therapyMatch");
  removeSchemaProperty(resolve(schemaProperties(candidate)?.decoction), "course");
  removeSchemaProperty(resolve(properties?.nonPharma), "acupointCare");
  return clone;
}

function stripServerOwnedM03Fields(schema: JsonSchema): JsonSchema {
  const clone = structuredClone(schema);
  for (const key of M03_SERVER_OWNED_TOP_LEVEL) removeSchemaProperty(clone, key);
  const properties = schemaProperties(clone) || {};
  removeSchemaProperty(properties.overview, "evidence");
  removeSchemaProperty(schemaProperties(properties.westernDiagnosis)?.primary, "evidence");
  const pathogenesis = properties.pathogenesis;
  removeSchemaProperty(pathogenesis, "summary");
  const pathogenesisProperties = schemaProperties(pathogenesis) || {};
  removeSchemaProperty(pathogenesisProperties.locationDifferentiation, "evidence");
  removeSchemaProperty(pathogenesisProperties.natureDifferentiation, "evidence");
  // lineageAdaptation 是 anyOf:[object, null]；对象分支里那几个常量子字段同样由服务端写定。
  // 不裁的话严格 schema 会把它们标成 required，与提示词里「不要输出」直接冲突，
  // 解码器会拒掉整份输出。
  const lineageVariants = Array.isArray((properties.lineageAdaptation as { anyOf?: unknown })?.anyOf)
    ? ((properties.lineageAdaptation as { anyOf: JsonSchema[] }).anyOf)
    : [];
  for (const variant of lineageVariants) {
    for (const key of ["schemaVersion", "lineageCode", "label", "applicable", "unaffectedBySafety", "safetyDeference"]) {
      removeSchemaProperty(variant, key);
    }
  }
  // 病机节点与子治法各自只有一个引用方（已核），因此在克隆里删属性不会波及别处。
  for (const definition of Object.values((clone.$defs || {}) as Record<string, JsonSchema>)) {
    if (hasAllProperties(definition, ["nodeId", "patientFact", "syndromeEvidence", "therapyDirection"])
      || hasAllProperties(definition, ["therapy", "targetPathogenesis", "priority"])) {
      removeSchemaProperty(definition, "evidence");
    }
  }
  return clone;
}


/**
 * 只保留可达的 `$defs`（P2）。
 *
 * `reasoningHalfSchema` 只裁顶层 properties，`$defs` 原样整份带上：实测 m03_tcm 下发的
 * schema 共 59 个定义、实际可达只有 18 个，41 个死定义占掉约 2 万字符——两个半区各带一份，
 * 每个修复轮再带一份。裁掉它们对解码语义零影响（不可达定义永远不会被引用），
 * 纯粹是体积。
 */
function pruneUnreachableDefs(schema: JsonSchema): JsonSchema {
  const defs = schema.$defs && typeof schema.$defs === "object"
    ? schema.$defs as Record<string, JsonSchema>
    : undefined;
  if (!defs) return schema;
  const reachable = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // 不从 $defs 容器本身出发，否则每个定义都「可达」，闭包退化成全集。
      if (key === "$defs") continue;
      if (key === "$ref" && typeof value === "string") {
        const name = value.split("/").pop();
        if (name && defs[name] && !reachable.has(name)) {
          reachable.add(name);
          visit(defs[name]);
        }
        continue;
      }
      visit(value);
    }
  };
  visit({ properties: schema.properties, required: schema.required, items: (schema as { items?: unknown }).items });
  if (reachable.size === Object.keys(defs).length) return schema;
  return {
    ...schema,
    $defs: Object.fromEntries(Object.entries(defs).filter(([name]) => reachable.has(name))),
  };
}

function schemaForTask(task: StructuredOutputTask): JsonSchema {
  if (task === "m03_full") {
    return pruneUnreachableDefs(stripServerOwnedM03Fields(requireGeneratedM03Content(requireGeneratedM03Chain(fullReasoningSchema()))));
  }
  if (task === "m04_proposal") return pruneUnreachableDefs(stripServerOwnedM04Fields(m04ProposalJsonSchema()));
  if (task === "m04_candidate_patch") {
    const full = stripServerOwnedM04Fields(m04ProposalJsonSchema());
    const candidate = schemaProperties(full)?.candidate;
    return pruneUnreachableDefs({ ...full, properties: { candidate }, required: ["candidate"], additionalProperties: false });
  }
  if (task === "m03_western") {
    return pruneUnreachableDefs(stripServerOwnedM03Fields(
      reasoningHalfSchema(["schemaVersion", "stage", "westernDiagnosis", "management"]),
    ));
  }
  return pruneUnreachableDefs(stripServerOwnedM03Fields(requireGeneratedM03Content(requireGeneratedM03Chain(reasoningHalfSchema([
    "schemaVersion", "stage", "overview", "pathogenesis", "therapy", "formula", "nonPharma", "lineageAdaptation",
  ])))));
}

/**
 * 任意 zod 契约的严格结构化输出格式（2026-08-25，为 M02 interpret 而设）。
 * interpret 此前用弱一档的 json_object，两轮 model_output_invalid 后整条路由 502——
 * 5 次同一合成回答仅 1 次成功。schema 交给解码器强制后，"字段形状不合契约"这一整类
 * 失败在解码层消失。不支持严格模式的模型自动回落 json_object。
 */
export function responseFormatForZodSchema(model: string, name: string, schema: z.ZodTypeAny): Record<string, unknown> {
  if (!supportsStrictJsonSchema(model)) return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: { name, strict: true, schema: strictProviderSchema(z.toJSONSchema(schema) as JsonSchema) },
  };
}

export function supportsStrictToolArguments(model: string): boolean {
  return textModelCapabilities(model).strictToolArguments;
}

export function responseFormatForTask(model: string, task: StructuredOutputTask): Record<string, unknown> {
  if (!supportsStrictJsonSchema(model)) return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: task,
      strict: true,
      schema: strictProviderSchema(schemaForTask(task)),
    },
  };
}

/**
 * 非严格供应商（DeepSeek json_object）的同一份结构合同（2026-09-24，提速第三批）。
 *
 * 严格 schema 在百炼上由解码器强制；DeepSeek 只有 json_object，只保证「像 JSON」。9/11–9/19
 * 线上用 DeepSeek 时，西医半把 supportingFactKinds 写成字符串、括号错位，中医半写出枚举外的
 * pathogenesisType——zod 层的 `.catch` 把它们静默换成缺省值，页面上就是少了一块内容，日志里
 * 什么都没有。所以换 DeepSeek 的前提是两件事一起做：
 *  1. 把**下发给严格供应商的那份 schema** 原样写进系统消息（可空字段不列入 required，允许省略，
 *     省掉 DeepSeek 把几十个 null 逐个写出来的 token）。真实提示词配对重放：西医半合规
 *     0/6 → 6/6；
 *  2. 服务端用同一份 schema 逐项校验（下方 providerSchemaViolations）；不合规就交给严格供应商
 *     重生成，而不是让 zod 的缺省值顶替。
 *
 * 两处用的是同一个 providerJsonSchemaForTask，所以「提示里说的」和「校验时查的」不会分叉。
 */
export function providerJsonSchemaForTask(task: StructuredOutputTask): JsonSchema {
  return strictProviderSchema(schemaForTask(task)) as JsonSchema;
}

function schemaAdmitsNull(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const schema = node as JsonSchema;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some(schemaAdmitsNull);
}

/** 严格 schema 把可选字段写成「必填 + 可空」；给非严格供应商看时改回「可省略」。 */
function omittableOptionalProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omittableOptionalProjection);
  if (!value || typeof value !== "object") return value;
  const source = value as JsonSchema;
  const projected = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => key !== "$schema")
      .map(([key, child]) => [key, key === "properties" && child && typeof child === "object"
        ? Object.fromEntries(Object.entries(child as JsonSchema).map(([name, node]) => [name, omittableOptionalProjection(node)]))
        : omittableOptionalProjection(child)]),
  ) as JsonSchema;
  const properties = source.properties && typeof source.properties === "object" ? source.properties as JsonSchema : undefined;
  if (properties && Array.isArray(source.required)) {
    projected.required = source.required.filter((key) => typeof key === "string" && !schemaAdmitsNull(properties[key]));
  }
  return projected;
}

/**
 * 哪些阶段给非严格模型附 schema，按实测定（2026-09-24，生产机直连 DeepSeek，同一批真实提示词，
 * 用下方 checkNonStrictStructuredContent 判定）：
 *  · M03 西医半：不附 0/18 合规（supportingFactKinds 写成字符串）→ 附后 18/18；
 *  · M03 中医半：不附 12/18（pathogenesisType 枚举外取值）→ 附后 18/18；
 *  · M04 首轮：不附 14/14 → 附后反而 11/14（括号提前闭合、多出 schema 外的键）。M04 提示词
 *    自带逐字段示例，再叠一份 schema 只会干扰，所以不附；校验与严格兜底照样生效。
 */
const NON_STRICT_SCHEMA_INSTRUCTION_TASKS: ReadonlySet<StructuredOutputTask> = new Set(["m03_full", "m03_western", "m03_tcm"]);

/**
 * 非严格模型的系统消息附加段；严格模型返回空串（schema 已在 response_format 里，
 * 再写一遍只会多付 token）。内容只随 task 变化，是固定前缀，供应商前缀缓存可以命中。
 */
export function structuredOutputSchemaInstruction(model: string, task: StructuredOutputTask): string {
  if (supportsStrictJsonSchema(model) || !NON_STRICT_SCHEMA_INSTRUCTION_TASKS.has(task)) return "";
  return [
    "【输出 JSON Schema（必须逐项满足）】",
    "只输出一个满足下列 JSON Schema 的 JSON 对象：required 列出的键一个都不能少；不在 required 里的可选字段没有内容时直接省略该键；",
    "标了 minItems 的数组必须至少给出相应条数的实质内容；enum 字段只能取列出的值之一；不得输出 schema 未定义的键；",
    "数组元素是对象的，必须写成对象（含其 required 键），不能写成字符串。",
    JSON.stringify(omittableOptionalProjection(providerJsonSchemaForTask(task))),
    ...(task === "m03_western" ? [] : [NON_STRICT_RESOLUTION_RULE]),
  ].join("\n");
}

/**
 * 重申提示词里已有的 resolution 定档规则（diagnosis-prompts 的 M03 合同段）。DeepSeek 在
 * 同一批真实提示词上把证候写成 bounded 16/18（Qwen 18/18 resolved）——临床结论相同，但页面会
 * 给几乎每一例加一行「辨证边界」。在系统消息里重申后 resolved 2/18 → 7/18，结构合规仍 18/18。
 * 只对非严格模型、只对含中医推理的任务附加；不改共享提示词。
 */
const NON_STRICT_RESOLUTION_RULE = "【resolution 定档】证候、病位、病性三轴各自独立定档，不得三个一起填同一个值。本轴依据已能从病历逐字摘出、且与舌脉及主要鉴别点相符时填 resolved；bounded 只用于本轴确实缺少会改变结论的关键信息，并在 resolutionReason 写明缺的是什么。";

export type ProviderSchemaViolation = { path: string; keyword: string };

function resolveSchemaRef(root: JsonSchema, node: JsonSchema): JsonSchema {
  if (typeof node.$ref !== "string") return node;
  const name = node.$ref.replace(/^#\/(?:\$defs|definitions)\//, "");
  const defs = (root.$defs || root.definitions || {}) as Record<string, JsonSchema>;
  return defs[name] || {};
}

function jsonTypeMatches(expected: string, value: unknown): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

const compiledSchemaPatterns = new Map<string, RegExp | null>();
function schemaPattern(source: string): RegExp | null {
  if (!compiledSchemaPatterns.has(source)) {
    try {
      compiledSchemaPatterns.set(source, new RegExp(source, "u"));
    } catch {
      compiledSchemaPatterns.set(source, null);
    }
  }
  return compiledSchemaPatterns.get(source) || null;
}

/**
 * 下发 schema 里被裁掉、由服务端确定性覆盖的字段名（stripServerOwnedM03Fields /
 * stripServerOwnedM04Fields）。非严格模型多写了这些键无害——服务端本来就要改写它们，
 * zod 对象也会丢弃未知键——不应为此触发一次严格兜底。其余 schema 外的键照报：
 * 那通常是写错了键名（重放实测 M04 把 decoction 写成 decoctionMethod）。
 */
const SERVER_OWNED_FIELD_NAMES: ReadonlySet<string> = new Set([
  ...M03_SERVER_OWNED_TOP_LEVEL, "evidence", "summary",
  "lineageCode", "label", "applicable", "unaffectedBySafety", "safetyDeference",
  "modificationReview", "therapyMatch", "course", "acupointCare",
]);

function collectSchemaViolations(
  root: JsonSchema,
  rawNode: JsonSchema,
  value: unknown,
  path: string,
  out: ProviderSchemaViolation[],
  limit: number,
  tolerated: ReadonlySet<string> = new Set(),
): void {
  if (out.length >= limit) return;
  const node = resolveSchemaRef(root, rawNode);
  const fail = (keyword: string) => { if (out.length < limit) out.push({ path: path || "/", keyword }); };
  if (Array.isArray(node.anyOf)) {
    const matched = node.anyOf.some((branch) => {
      const trial: ProviderSchemaViolation[] = [];
      collectSchemaViolations(root, branch as JsonSchema, value, path, trial, 1, tolerated);
      return trial.length === 0;
    });
    if (!matched) fail("anyOf");
    return;
  }
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type as string[] : [node.type as string];
    if (!types.some((type) => jsonTypeMatches(type, value))) return fail("type");
  }
  if ("const" in node && value !== node.const) return fail("const");
  if (Array.isArray(node.enum) && !node.enum.includes(value as never)) return fail("enum");
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof node.minLength === "number" && length < node.minLength) fail("minLength");
    if (typeof node.maxLength === "number" && length > node.maxLength) fail("maxLength");
    const pattern = typeof node.pattern === "string" ? schemaPattern(node.pattern) : null;
    if (pattern && !pattern.test(value)) fail("pattern");
    return;
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) fail("minimum");
    if (typeof node.maximum === "number" && value > node.maximum) fail("maximum");
    return;
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) fail("minItems");
    if (typeof node.maxItems === "number" && value.length > node.maxItems) fail("maxItems");
    if (node.items && typeof node.items === "object" && !Array.isArray(node.items)) {
      value.forEach((item, index) => collectSchemaViolations(root, node.items as JsonSchema, item, `${path}/${index}`, out, limit, tolerated));
    }
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = (node.properties || {}) as Record<string, JsonSchema>;
    for (const key of Array.isArray(node.required) ? node.required as string[] : []) {
      // 严格 schema 的「必填 + 可空」= 语义上可选：省略与 null 等价（zod 层同样把 null 还原成缺省）。
      if (!(key in record) && !schemaAdmitsNull(properties[key])) fail(`required:${key}`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties[key];
      if (!childSchema) {
        if (node.additionalProperties === false && !tolerated.has(key)) fail(`additionalProperties:${key}`);
        continue;
      }
      // 可空字符串字段写成空串：zod 契约是 `.min(1).optional().catch(undefined)`，与省略同义。
      if (typeof child === "string" && !child.trim() && schemaAdmitsNull(childSchema)) continue;
      collectSchemaViolations(root, childSchema, child, `${path}/${key}`, out, limit, tolerated);
    }
  }
}

/**
 * 用严格供应商的同一份 schema 校验非严格供应商的输出；返回空数组即合规。
 * 只报路径与关键字，不回显内容（日志里不出现患者文本）。
 */
export function providerSchemaViolations(task: StructuredOutputTask, value: unknown, limit = 12): ProviderSchemaViolation[] {
  const schema = providerJsonSchemaForTask(task);
  const out: ProviderSchemaViolation[] = [];
  collectSchemaViolations(schema, schema, value, "", out, limit);
  return out;
}

/**
 * 只补**末尾缺失**的闭合括号：DeepSeek json_object 实测会漏掉最后一个 `}`（M04 重放 2/14，
 * 其余内容完整）。只在文本以字符串外的位置结束、未闭合层数很浅时补，补完仍须能解析——
 * 括号错位（前面提前闭合）不在此列，那一类交给严格兜底。
 */
function completeTrailingJsonClosers(text: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
    }
  }
  if (inString || stack.length === 0 || stack.length > 3) return undefined;
  return text + stack.reverse().join("");
}

/**
 * 超过 maxItems 的数组截到上限。严格解码器本来就写不出第 9 条；而 zod 契约对超长数组是
 * `.max(8)...catch([])`——整组清空（中医半主证候依据重放 2/18 次）。保留前 N 条严格优于全丢。
 */
function clampArraysToSchemaMaxItems(root: JsonSchema, rawNode: JsonSchema, value: unknown, clamped: string[], path = ""): unknown {
  const node = resolveSchemaRef(root, rawNode);
  if (Array.isArray(node.anyOf)) {
    const branch = node.anyOf.find((candidate) => {
      const resolved = resolveSchemaRef(root, candidate as JsonSchema);
      const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
      return types.some((type) => typeof type === "string" && jsonTypeMatches(type, value));
    });
    return branch ? clampArraysToSchemaMaxItems(root, branch as JsonSchema, value, clamped, path) : value;
  }
  if (Array.isArray(value)) {
    const limited = typeof node.maxItems === "number" && value.length > node.maxItems ? value.slice(0, node.maxItems) : value;
    if (limited !== value) clamped.push(path || "/");
    const itemSchema = node.items && typeof node.items === "object" && !Array.isArray(node.items) ? node.items as JsonSchema : undefined;
    return itemSchema ? limited.map((item) => clampArraysToSchemaMaxItems(root, itemSchema, item, clamped, `${path}/N`)) : limited;
  }
  if (value && typeof value === "object") {
    const properties = (node.properties || {}) as Record<string, JsonSchema>;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      properties[key] ? clampArraysToSchemaMaxItems(root, properties[key], child, clamped, `${path}/${key}`) : child,
    ]));
  }
  return value;
}

export type NonStrictStructuredCheck = {
  /** 规范化之后的内容；没有任何修补时与输入逐字相同。 */
  content: string;
  violations: ProviderSchemaViolation[];
  /** 做过的确定性修补（只含路径，不含内容），供遥测。 */
  repairs: string[];
};

/**
 * 非严格供应商结构化输出的入口：解析 →（仅在必要时）补末尾括号 → 截超长数组 → 严格 schema 校验。
 * 两项修补都只可能让结果更接近严格解码器的产物，不改任何字段的取值；其余一切不合规照报。
 */
export function checkNonStrictStructuredContent(task: StructuredOutputTask, content: string): NonStrictStructuredCheck {
  const repairs: string[] = [];
  const text = content.trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const completed = completeTrailingJsonClosers(text);
    try {
      if (!completed) throw new Error("unrecoverable");
      value = JSON.parse(completed);
      repairs.push("trailing_closers");
    } catch {
      return { content, violations: [{ path: "/", keyword: "json" }], repairs };
    }
  }
  return checkNonStrictStructuredValue(task, value, repairs, content);
}

/** 已解析的值（如西医半经过错位归位之后）走同一套截断与校验。 */
export function checkNonStrictStructuredValue(
  task: StructuredOutputTask,
  value: unknown,
  priorRepairs: readonly string[] = [],
  originalContent?: string,
): NonStrictStructuredCheck {
  const schema = providerJsonSchemaForTask(task);
  const clamped: string[] = [];
  const normalized = clampArraysToSchemaMaxItems(schema, schema, value, clamped);
  const repairs = [...priorRepairs, ...clamped.map((path) => `max_items:${path}`)];
  const violations: ProviderSchemaViolation[] = [];
  collectSchemaViolations(schema, schema, normalized, "", violations, 12, SERVER_OWNED_FIELD_NAMES);
  return {
    content: repairs.length === 0 && originalContent !== undefined ? originalContent : JSON.stringify(normalized),
    violations,
    repairs,
  };
}
