import { z } from "zod";
import { ReasoningV2Schema } from "./diagnosis-types";
import { M04ProposalSchema } from "./m04-proposal-compiler";
import { textModelCapabilities } from "./text-model-capabilities";

export type StructuredOutputTask =
  | "m03_full"
  | "m03_western"
  | "m03_tcm"
  | "m04_proposal"
  | "m03_review"
  | "m04_review";

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

const M03_REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    status: { enum: ["accepted", "repair"] },
    issueCode: {
      enum: [
        "none",
        "criteria_not_met",
        "diagnostic_label_overstated",
        "supporting_fact_mismatch",
        "tcm_reasoning_unsupported",
        "formula_indication_mismatch",
      ],
    },
    repairInstruction: { type: "string", maxLength: 800 },
  },
  required: ["status", "issueCode"],
  additionalProperties: false,
};

const M04_REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    status: { enum: ["accepted", "repair"] },
    issueCode: {
      enum: ["none", "herb_plan_mismatch", "dose_rationale_concern", "patient_context_mismatch"],
    },
    repairFocus: {
      enum: ["emperor_role", "herb_direction", "modification_logic", "dose_strength", "patient_dependency"],
    },
    candidateIndex: { type: "integer", minimum: 0, maximum: 4 },
    implicatedHerbs: { type: "array", items: { type: "string", maxLength: 24 }, maxItems: 6, uniqueItems: true },
  },
  required: ["status", "issueCode"],
  additionalProperties: false,
};


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
  if (task === "m03_full") return pruneUnreachableDefs(stripServerOwnedM03Fields(requireGeneratedM03Chain(fullReasoningSchema())));
  if (task === "m04_proposal") return m04ProposalJsonSchema();
  if (task === "m03_review") return M03_REVIEW_SCHEMA;
  if (task === "m04_review") return M04_REVIEW_SCHEMA;
  if (task === "m03_western") {
    return pruneUnreachableDefs(stripServerOwnedM03Fields(
      reasoningHalfSchema(["schemaVersion", "stage", "westernDiagnosis", "management"]),
    ));
  }
  return pruneUnreachableDefs(stripServerOwnedM03Fields(requireGeneratedM03Chain(reasoningHalfSchema([
    "schemaVersion", "stage", "overview", "pathogenesis", "therapy", "formula", "nonPharma", "lineageAdaptation",
  ]))));
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
