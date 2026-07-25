import outputContractJson from "../data/clinical-output-contract-registry.json" with { type: "json" };
import engineeringJargonJson from "../data/engineering-jargon-lexicon.json" with { type: "json" };

type OutputContractEntry = {
  id: string;
  stage: string;
  path: string;
  label: string;
  requiredStatus: string;
  evidenceBinding: string;
  visibility: "visible" | "internal_only";
  unknownPolicy: string;
  rendererId?: string;
};

type EngineeringJargonEntry = {
  id: string;
  terms: string[];
  replacement: string;
  severity: string;
};

type ClinicalOutputSurface = {
  id: string;
  label: string;
  sectionOrder: string[];
  copyContract?: string;
};

type OutputRegistry = {
  entries: OutputContractEntry[];
  surfaces: ClinicalOutputSurface[];
  limitedStateCopy: {
    requiredParts: string[];
    templates: { knownFacts: string; unavailableConclusion: string; nextAction: string };
    policy: string;
  };
};

const OUTPUT_REGISTRY = outputContractJson as OutputRegistry;
const OUTPUT_CONTRACTS = OUTPUT_REGISTRY.entries as readonly OutputContractEntry[];
const OUTPUT_CONTRACT_BY_ID = new Map(OUTPUT_CONTRACTS.map((entry) => [entry.id, entry]));
const JARGON_ENTRIES = engineeringJargonJson.entries as readonly EngineeringJargonEntry[];
const JARGON_REPLACEMENTS = JARGON_ENTRIES.flatMap((entry) => entry.terms.map((term) => ({
  id: entry.id,
  term,
  replacement: entry.replacement,
}))).sort((left, right) => right.term.length - left.term.length);
const AMBIGUOUS_PLAIN_TERMS = new Set(["前端", "后端", "权重", "槽位", "门控", "病机关联"]);

const AMBIGUOUS_ENGINEERING_CONTEXT: Readonly<Record<string, RegExp>> = {
  前端: /前端(?=(?:页面|界面|展示|渲染|组件|代码|逻辑|报错|请求|传参|状态))/gu,
  后端: /后端(?=(?:服务|接口|代码|逻辑|报错|请求|返回|处理|校验|模型))/gu,
  权重: /(?:(?:模型|评分|排序|算法|检索|证据|规则|节点|字段)[^，。；;\n]{0,8})权重|权重(?=(?:值|参数|调整|配置|排序|计算))/gu,
  槽位: /槽位(?=(?:值|字段|缺失|补全|抽取|映射|状态|校验))/gu,
  门控: /门控(?=(?:通过|未通过|拦截|放行|锁定|解锁|状态|结果|规则|原因|失败|检查|校验|策略|逻辑))/gu,
  病机关联: /病机关联(?=(?:字段|节点|映射|校验|规则|结果|标识|ID))/gu,
};

const NON_VISIBLE_BLOCK = /<!--\s*DIAGNOSIS_JSON_START\s*-->[\s\S]*?<!--\s*DIAGNOSIS_JSON_END\s*-->|<!--[\s\S]*?-->/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function governedTermPattern(term: string): RegExp {
  const escaped = escapeRegExp(term);
  if (/^[A-Za-z0-9_-]+$/.test(term)) {
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi");
  }
  if (AMBIGUOUS_PLAIN_TERMS.has(term)) {
    const isolated = `(?<![\\p{Script=Han}A-Za-z0-9_])${escaped}(?![\\p{Script=Han}A-Za-z0-9_])`;
    const contextual = AMBIGUOUS_ENGINEERING_CONTEXT[term]?.source;
    return new RegExp(contextual ? `(?:${isolated}|${contextual})` : isolated, "gu");
  }
  return new RegExp(escaped, "gu");
}

function sanitizeVisibleSegment(value: string): string {
  let output = value;
  // A replacement may contain another governed term. Resolve to a stable visible vocabulary with
  // a small fixed bound; the table itself is also regression-tested for idempotence.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = output;
    for (const item of JARGON_REPLACEMENTS) {
      output = output.replace(governedTermPattern(item.term), item.replacement);
    }
    if (output === before) break;
  }
  return output;
}

/**
 * T7 owns customer-visible engineering vocabulary. Signed structured blocks are never rewritten;
 * only the Markdown around them is normalized, preserving hashes and downstream parsing.
 */
export function sanitizeAuthoritativeClinicalOutput(content: string): string {
  let output = "";
  let cursor = 0;
  for (const match of content.matchAll(NON_VISIBLE_BLOCK)) {
    const start = match.index ?? 0;
    output += sanitizeVisibleSegment(content.slice(cursor, start));
    output += match[0];
    cursor = start + match[0].length;
  }
  return output + sanitizeVisibleSegment(content.slice(cursor));
}

export function visibleClinicalOutputGovernanceIssues(content: string): string[] {
  const visibleOnly = content.replace(NON_VISIBLE_BLOCK, "");
  return [...new Set(JARGON_REPLACEMENTS
    .filter((item) => governedTermPattern(item.term).test(visibleOnly))
    .map((item) => `${item.id}:${item.term}`))];
}

// Doctor-facing prose is assembled from model-authored fragments that already carry their own
// terminal punctuation, so a plain `join("；")` or a trailing `+ "。"` emits "。；" / "。。".
// T7 owns customer-visible wording, so every visible clause assembly goes through these helpers
// and the defect is fixed as a class instead of one call site at a time. Prose only: never apply
// them to regex sources, sentinel JSON transport text, or verbatim patient source quotes, where
// the trailing character is load-bearing.
const TRAILING_CLINICAL_CLAUSE_PUNCTUATION = /[\s。；;，,、]+$/u;

/** One doctor-facing clause with its own trailing punctuation removed; non-strings become "". */
export function clinicalClauseText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(TRAILING_CLINICAL_CLAUSE_PUNCTUATION, "") : "";
}

/**
 * Join model-authored clauses into one doctor-facing line: every part loses its own trailing
 * punctuation, empty parts are dropped, and `separator` appears exactly once between survivors.
 * Adds no characters of its own, so grounded quotes stay substrings of the chart text.
 */
export function joinClinicalClauses(parts: readonly unknown[], separator = "；"): string {
  return parts.map(clinicalClauseText).filter(Boolean).join(separator);
}

/** `joinClinicalClauses` closed with exactly one full stop; empty input stays empty. */
export function clinicalSentence(parts: readonly unknown[], separator = "；"): string {
  const joined = joinClinicalClauses(parts, separator);
  return joined ? `${joined}。` : "";
}

export function clinicalOutputContract(id: string): OutputContractEntry | undefined {
  return OUTPUT_CONTRACT_BY_ID.get(id);
}

export function clinicalOutputLabel(id: string, fallback: string): string {
  return OUTPUT_CONTRACT_BY_ID.get(id)?.label || fallback;
}

export function visibleClinicalOutputContractsForStage(stage: string): OutputContractEntry[] {
  return OUTPUT_CONTRACTS.filter((entry) =>
    entry.visibility === "visible" && entry.stage.split("|").includes(stage));
}

export function clinicalOutputRendererId(id: string): string | undefined {
  return OUTPUT_CONTRACT_BY_ID.get(id)?.rendererId;
}

export function clinicalOutputRendererCoverageIssues(): string[] {
  return OUTPUT_CONTRACTS
    .filter((entry) => entry.visibility === "visible" && !entry.rendererId)
    .map((entry) => entry.id);
}

export function clinicalOutputSurface(id: string): ClinicalOutputSurface | undefined {
  return OUTPUT_REGISTRY.surfaces.find((surface) => surface.id === id);
}

export function buildThreePartLimitedStateCopy(input: {
  knownFacts: string;
  unavailableConclusion: string;
  reason: string;
  nextAction: string;
}): string {
  const templates = OUTPUT_REGISTRY.limitedStateCopy.templates;
  return [
    templates.knownFacts.replace("{knownFacts}", input.knownFacts),
    templates.unavailableConclusion
      .replace("{unavailableConclusion}", input.unavailableConclusion)
      .replace("{reason}", input.reason),
    templates.nextAction.replace("{nextAction}", input.nextAction),
  ].join("\n");
}

/**
 * Bind a limited-state message to one of T11's governed output surfaces. This prevents callers
 * from copying the three-part wording while silently bypassing the surface contract itself.
 */
export function buildThreePartLimitedStateCopyForSurface(
  surfaceId: string,
  input: Parameters<typeof buildThreePartLimitedStateCopy>[0],
): string {
  const surface = clinicalOutputSurface(surfaceId);
  if (!surface || surface.copyContract !== "limitedStateCopy") {
    throw new Error(`Clinical output surface ${surfaceId} does not authorize limited-state copy`);
  }
  return buildThreePartLimitedStateCopy(input);
}
