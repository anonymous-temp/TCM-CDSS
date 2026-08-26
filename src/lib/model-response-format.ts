import { z } from "zod";
import { ReasoningV2Schema } from "./diagnosis-types";
import { M04ProposalSchema } from "./m04-proposal-compiler";

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
  return /^qwen3\.(?:7-(?:plus|max)|8-max)(?:$|[-_])/i.test(model.trim());
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
      enum: ["none", "formula_composition_mismatch", "herb_plan_mismatch", "dose_rationale_concern", "patient_context_mismatch"],
    },
    repairFocus: {
      enum: ["formula_core_composition", "emperor_role", "herb_direction", "modification_logic", "dose_strength", "patient_dependency"],
    },
    candidateIndex: { type: "integer", minimum: 0, maximum: 4 },
    implicatedHerbs: { type: "array", items: { type: "string", maxLength: 24 }, maxItems: 6, uniqueItems: true },
  },
  required: ["status", "issueCode"],
  additionalProperties: false,
};

function schemaForTask(task: StructuredOutputTask): JsonSchema {
  if (task === "m03_full") return requireGeneratedM03Chain(fullReasoningSchema());
  if (task === "m04_proposal") return m04ProposalJsonSchema();
  if (task === "m03_review") return M03_REVIEW_SCHEMA;
  if (task === "m04_review") return M04_REVIEW_SCHEMA;
  if (task === "m03_western") {
    return reasoningHalfSchema(["schemaVersion", "stage", "westernDiagnosis", "management"]);
  }
  return requireGeneratedM03Chain(reasoningHalfSchema([
    "schemaVersion", "stage", "overview", "pathogenesis", "therapy", "formula", "nonPharma", "lineageAdaptation",
  ]));
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
