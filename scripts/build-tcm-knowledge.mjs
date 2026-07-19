import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourceRoot = process.env.RXAI_DATA_ROOT || path.resolve(projectRoot, "../../合理用药/重点整理数据表");
const releaseRoot = process.env.RXAI_RELEASE_ROOT || path.resolve(projectRoot, "../../合理用药/release");
const outputPath = path.join(projectRoot, "src/data/tcm-knowledge.json");

const sources = {
  doseRange: path.join(sourceRoot, "中药饮片剂量范围_中国药典2020一部_药材和饮片.csv"),
  routeDose: path.join(sourceRoot, "中药饮片分途径剂量规则表.csv"),
  incompatibility: path.join(sourceRoot, "中药饮片十八反十九畏规则矩阵.csv"),
  specialPopulation: path.join(sourceRoot, "中药饮片特殊人群禁慎用_全量规则表.csv"),
  decoction: path.join(sourceRoot, "中药饮片煎服医嘱自证与错误方法规则表.csv"),
  herbRisk: path.join(sourceRoot, "中药饮片功效风险类别映射表.csv"),
  patentRisk: path.join(sourceRoot, "中成药重点风险字段表_甲方HIS_20260627.csv"),
  westernInteraction: path.join(sourceRoot, "西药中成药高风险相互作用同类互斥规则表_20260627.csv"),
  currentMedicationConflict: path.join(sourceRoot, "当前用药新处方冲突同类互斥表.csv"),
  labThreshold: path.join(sourceRoot, "实验室肾肝功能电解质阈值风险表.csv"),
  hisRouteDictionary: path.join(sourceRoot, "HIS给药途径频次煎服方法标准化字典.csv"),
  hisSpecConversion: path.join(sourceRoot, "HIS药品规格剂量换算表_重点候选.csv"),
  clinicalStateDictionary: path.join(sourceRoot, "临床状态词典_否定时态过滤表.csv"),
  hisTcmMapping: path.join(sourceRoot, "中药标准名别名炮制品HIS本地映射补充_甲方HIS.csv"),
  curatedDose: path.join(releaseRoot, "tcm_curated_llm_candidates_20260626.json"),
};

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

function assertReadableSource(filePath, alias) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing knowledge source "${alias}". Set RXAI_DATA_ROOT and RXAI_RELEASE_ROOT before running build:tcm-knowledge.`
    );
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    if (row.some((item) => item.trim())) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((item) => stripBom(item.trim()));
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = (cells[index] || "").trim();
    });
    return obj;
  });
}

function readCsv(filePath) {
  assertReadableSource(filePath, path.basename(filePath));
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function asNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pushMap(map, key, value) {
  if (!key) return;
  const current = map.get(key) || [];
  current.push(value);
  map.set(key, current);
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const doseRows = readCsv(sources.doseRange);
const routeRows = readCsv(sources.routeDose);
const incompatRows = readCsv(sources.incompatibility);
const specialRows = readCsv(sources.specialPopulation);
const decoctionRows = readCsv(sources.decoction);
const herbRiskRows = readCsv(sources.herbRisk);
const patentRiskRows = readCsv(sources.patentRisk);
const westernInteractionRows = readCsv(sources.westernInteraction);
const currentMedicationConflictRows = readCsv(sources.currentMedicationConflict);
const labThresholdRows = readCsv(sources.labThreshold);
const hisRouteRows = readCsv(sources.hisRouteDictionary);
const hisSpecRows = readCsv(sources.hisSpecConversion);
const clinicalStateRows = readCsv(sources.clinicalStateDictionary);
const hisTcmMappingRows = readCsv(sources.hisTcmMapping);

const byHerb = new Map();

for (const row of doseRows) {
  const herb = row.title;
  pushMap(byHerb, herb, {
    type: "dose",
    herb,
    doseText: firstNonEmpty(row.dosage_text, row.dosage_text_original),
    minG: asNumber(row.dose_min_g),
    maxG: asNumber(row.dose_max_g),
    usageFlags: row.usage_flags || "",
    basis: row.source_version || "中华人民共和国药典2020年版一部",
    sourceUrl: row.source_url || "",
  });
}

for (const row of routeRows) {
  pushMap(byHerb, row.title, {
    type: "routeDose",
    herb: row.title,
    routeForm: row.route_form,
    method: row.administration_method,
    doseText: row.dose_text,
    minG: asNumber(row.dose_min_g),
    maxG: asNumber(row.dose_max_g),
    methodCodes: row.method_codes,
    basis: row.source_basis,
    sourceUrl: row.source_url,
    note: row.note,
  });
}

for (const row of incompatRows) {
  const item = {
    type: "incompatibility",
    category: row.category,
    formula: row.formula,
    ruleType: row.rule_type,
    leftDrug: row.left_drug,
    rightDrug: row.right_drug,
    severity: row.severity,
    basis: row.source_basis,
    note: row.note,
  };
  pushMap(byHerb, row.left_drug, item);
  pushMap(byHerb, row.right_drug, item);
}

for (const row of specialRows) {
  pushMap(byHerb, row.standard_name, {
    type: "specialPopulation",
    herb: row.standard_name,
    population: row.population_or_state,
    ruleType: row.rule_type,
    riskLevel: row.risk_level,
    severity: row.severity,
    quote: row.source_quote,
    basis: row.source_basis,
    sourceUrl: row.source_url,
    action: row.audit_action,
  });
}

for (const row of decoctionRows) {
  pushMap(byHerb, row.standard_name, {
    type: "decoction",
    herb: row.standard_name,
    methodCode: row.method_rule_code,
    allowedMethod: row.expected_or_allowed_method,
    wrongMethods: row.forbidden_or_wrong_his_methods,
    action: row.audit_action,
    basis: row.source_basis,
  });
}

for (const row of herbRiskRows) {
  pushMap(byHerb, row.title, {
    type: "herbRisk",
    herb: row.title,
    riskCode: row.risk_category_code,
    riskName: row.risk_category_name,
    primaryCategory: row.category_primary,
    secondaryCategory: row.category_secondary,
    functionText: row.function_text,
    toxicity: row.chp_toxicity_level,
    pregnancyRule: row.pregnancy_rule_level,
    pregnancySeverity: row.pregnancy_severity,
    lactationRule: row.lactation_rule_level,
    lactationSeverity: row.lactation_severity,
    basis: row.source_basis,
    sourceUrl: row.source_url,
    confidence: row.confidence,
  });
}

assertReadableSource(sources.curatedDose, "curatedDose");
const curatedJson = JSON.parse(fs.readFileSync(sources.curatedDose, "utf8"));
if (!Array.isArray(curatedJson.items)) {
  throw new Error("Invalid curatedDose source: expected JSON object with items array.");
}
const curated = curatedJson.items;

for (const item of curated) {
  pushMap(byHerb, item.name, {
    type: "curatedDose",
    herb: item.name,
    minG: asNumber(item.min_g),
    maxG: asNumber(item.max_g),
    methods: Array.isArray(item.methods) ? item.methods : [],
    riskTags: Array.isArray(item.risk_tags) ? item.risk_tags : [],
    basis: item.reason || "常用药典用量/调剂规范待人工复核",
  });
}

const herbs = Array.from(byHerb.entries()).map(([name, entries]) => ({
  name,
  aliases: [],
  entries: uniqBy(entries, (entry) => JSON.stringify(entry)),
}));

const commonHerbs = curated.slice(0, 120).map((item) => ({
  name: item.name,
  minG: asNumber(item.min_g),
  maxG: asNumber(item.max_g),
  methods: Array.isArray(item.methods) ? item.methods : [],
  riskTags: Array.isArray(item.risk_tags) ? item.risk_tags : [],
  basis: item.reason || "常用药典用量/调剂规范待人工复核",
}));

const patentRisks = patentRiskRows.map((row) => ({
  productOrGroup: row.product_or_group,
  matchedHisDrugs: row.matched_his_drugs,
  keyRiskFields: row.key_risk_fields,
  triggerCondition: row.trigger_condition,
  severity: row.severity,
  action: row.audit_action,
  sourceIds: row.source_ids,
}));

const westernInteractions = westernInteractionRows.map((row) => ({
  ruleId: row.rule_id,
  left: row.left_class_or_drug,
  right: row.right_class_or_drug,
  matchedLeft: row.matched_his_left,
  matchedRight: row.matched_his_right,
  condition: row.context_condition,
  severity: row.severity,
  action: row.audit_action,
  sourceIds: row.source_ids,
}));

const currentMedicationConflicts = currentMedicationConflictRows.map((row) => ({
  ruleId: row.rule_id,
  ruleName: row.rule_name,
  existingMedClass: row.existing_med_class,
  newMedClass: row.new_med_class,
  existingExamples: row.existing_examples,
  newExamples: row.new_examples,
  condition: row.context_condition,
  severity: row.severity,
  action: row.audit_action,
  sourceIds: row.source_ids,
}));

const labThresholds = labThresholdRows.map((row) => ({
  ruleId: row.rule_id,
  domain: row.domain,
  lab: row.trigger_lab,
  normalizedLabCode: row.normalized_lab_code,
  condition: row.condition_label,
  operator: row.operator,
  thresholdValue: row.threshold_value,
  thresholdUnit: row.threshold_unit,
  severity: row.severity,
  drugOrClass: row.drug_or_class,
  representativeDrugs: row.representative_drugs,
  action: row.audit_action,
  missingLabPolicy: row.missing_lab_policy,
  sourceIds: row.source_ids,
  hisPriority: row.his_priority,
}));

const hisRouteDictionary = hisRouteRows.map((row) => ({
  hisValue: row.his_value,
  normalizedCode: row.normalized_code,
  valueType: row.value_type,
  routeClass: row.route_class,
  allowedContext: row.allowed_context,
  riskContext: row.forbidden_or_risk_context,
  frequencyPerDay: row.frequency_per_day,
  auditEffect: row.audit_effect,
  sourceBasis: row.source_basis,
}));

const hisSpecConversions = hisSpecRows.slice(0, 300).map((row) => ({
  category: row.category,
  queriedDrug: row.queried_drug,
  goodsName: row.goods_name,
  goodsId: row.goods_id,
  goodsSpec: row.goods_spec,
  goodsForm: row.goods_form,
  defaultUse: row.default_use,
  defaultFrequency: row.default_frequency,
  strengthValue: row.parsed_strength_value,
  strengthUnit: row.parsed_strength_unit,
  conversionStatus: row.conversion_status,
  ruleUse: row.rule_use,
  remainingDataGaps: row.remaining_data_gaps,
}));

const clinicalStateDictionary = clinicalStateRows.map((row) => ({
  stateCode: row.state_code,
  stateName: row.state_name,
  positiveTerms: row.positive_terms,
  negationTerms: row.negation_terms,
  temporalOrScopeTerms: row.temporal_or_scope_terms,
  triggerPolicy: row.trigger_policy,
  defaultSeverity: row.default_severity,
  sourceIds: row.source_ids,
}));

const hisTcmMappings = hisTcmMappingRows.slice(0, 500).map((row) => ({
  queriedDrug: row.his_queried_drug,
  goodsName: row.his_goods_name,
  goodsId: row.his_goods_id,
  goodsSpec: row.his_goods_spec,
  goodsForm: row.his_goods_form,
  mappedStandardNames: row.mapped_standard_names,
  variants: row.name_variants_used,
  status: row.mapping_status,
  priority: row.priority_level,
  remainingDataGaps: row.remaining_data_gaps,
}));

const payload = {
  schemaVersion: "tcm-knowledge-v1",
  generatedAt: new Date().toISOString(),
  provenance: {
    dataPackage: "rxai-medication-review-derived-tcm-knowledge",
    sourceAliases: Object.keys(sources),
    configuredByEnv: {
      RXAI_DATA_ROOT: Boolean(process.env.RXAI_DATA_ROOT),
      RXAI_RELEASE_ROOT: Boolean(process.env.RXAI_RELEASE_ROOT),
    },
  },
  summary: {
    herbCount: herbs.length,
    commonHerbCount: commonHerbs.length,
    patentRiskCount: patentRisks.length,
    westernInteractionCount: westernInteractions.length,
    currentMedicationConflictCount: currentMedicationConflicts.length,
    labThresholdCount: labThresholds.length,
    hisRouteDictionaryCount: hisRouteDictionary.length,
    hisSpecConversionCount: hisSpecConversions.length,
    clinicalStateDictionaryCount: clinicalStateDictionary.length,
    hisTcmMappingCount: hisTcmMappings.length,
  },
  herbs,
  commonHerbs,
  patentRisks,
  westernInteractions,
  currentMedicationConflicts,
  labThresholds,
  hisSupport: {
    routeDictionary: hisRouteDictionary,
    specConversions: hisSpecConversions,
    clinicalStateDictionary,
    tcmMappings: hisTcmMappings,
  },
  globalRules: [
    "中药饮片处方风险提示只做医生复核提示，不做硬拦截或自动通过裁决。",
    "十八反十九畏、药典禁忌、毒性/监管目录、妊娠哺乳儿童等特殊人群规则优先于疗效类加减。",
    "本地剂量、炮制、煎服法规则含《中国药典2020年版一部》历史基线；正式采纳前必须按现行2025年版药典、说明书及院内高置信规则复核，无法核验时不得输出来源字段。",
    "中药饮片与西药/中成药可联合或替代展示，但必须说明存在意义、对应问题、证据依据和联用风险。",
  ],
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);
console.log(payload.summary);
