import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crossCheckFusionAssets } from "./ingest/cross-check-fusion-assets.mjs";
import { buildDiagnosticRuleAsset } from "./ingest/diagnostic-rule-parser.mjs";
import { buildFormulaRuleAssets } from "./ingest/formula-rule-parser.mjs";
import { compileFormulaMentionMatcher } from "./lib/formula-mention-hits.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nishiRoot = resolve(root, "参考/nihaisha-nishi-tcm-main");
const stableRoot = resolve(root, "参考/nihaixia-StableV2026.5.23");
const sourceCardsPath = resolve(nishiRoot, "references/pdf-evidence/evidence-cards.jsonl");
const sourceManifestPath = resolve(nishiRoot, "references/pdf-evidence/source-manifest.json");
const formulaPatternsPath = resolve(nishiRoot, "references/formula-patterns.md");
const symptomIndexPath = resolve(nishiRoot, "references/symptom-index.md");
const beginnerQuestionsPath = resolve(nishiRoot, "references/beginner-questions.md");
const sixChannelPath = resolve(nishiRoot, "references/six-channel.md");
const correctionDecisionsPath = resolve(nishiRoot, "references/pdf-evidence/correction-decisions.md");
const stableSkillPath = resolve(stableRoot, "SKILL.md");
const stableShanghanPath = resolve(stableRoot, "modules/01_shanghan_sun.md");
const stableYianPath = resolve(stableRoot, "modules/03_yian.md");
const stableCasesDir = resolve(stableRoot, "cases");
const governedFormulaPath = resolve(root, "src/data/tcm-formula-governed-catalog.json");
const outputDir = resolve(root, "src/data");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourceManifestRaw = readFileSync(sourceManifestPath);
const sourceManifest = JSON.parse(sourceManifestRaw);
const governedFormulaRaw = readFileSync(governedFormulaPath);
const governedFormulaCatalog = JSON.parse(governedFormulaRaw);
const sourceById = new Map(sourceManifest.map((source) => [source.doc_id, source]));
const formulaPatternMarkdown = readFileSync(formulaPatternsPath, "utf8");
const symptomIndexMarkdown = readFileSync(symptomIndexPath, "utf8");
const beginnerQuestionsMarkdown = readFileSync(beginnerQuestionsPath, "utf8");
const sixChannelMarkdown = readFileSync(sixChannelPath, "utf8");
const correctionDecisionsMarkdown = readFileSync(correctionDecisionsPath, "utf8");
const stableSkillMarkdown = readFileSync(stableSkillPath, "utf8");
const stableShanghanMarkdown = readFileSync(stableShanghanPath, "utf8");
const stableYianMarkdown = readFileSync(stableYianPath, "utf8");

const formulaAliasesSeed = {
  schemaVersion: "tcm-formula-aliases-v1",
  generatedFrom: [
    "参考/nihaisha-nishi-tcm-main/references/formula-patterns.md",
    "参考/nihaixia-StableV2026.5.23/SKILL.md",
  ],
  entries: [
    { canonical: "麻杏甘石汤", aliases: ["麻杏石甘汤", "麻黄杏仁甘草石膏汤"], sourceRefs: ["formula-patterns.md"] },
    { canonical: "葛根黄芩黄连汤", aliases: ["葛芩连汤", "葛根芩连汤"], sourceRefs: ["formula-patterns.md"] },
    { canonical: "茯苓桂枝白术甘草汤", aliases: ["苓桂术甘汤"], sourceRefs: ["formula-patterns.md"] },
    { canonical: "茯苓桂枝甘草大枣汤", aliases: ["苓桂甘枣汤"], sourceRefs: ["formula-patterns.md"] },
    { canonical: "炙甘草汤", aliases: ["复脉汤"], sourceRefs: ["nihaixia-StableV2026.5.23/SKILL.md"] },
    { canonical: "金匮肾气丸", aliases: ["肾气丸", "八味肾气丸"], sourceRefs: ["nihaisha-nishi-tcm-main/references/jingui.md"] },
    { canonical: "大黄䗪虫丸", aliases: ["大黄蛰虫丸", "大黄蟅虫丸"], sourceRefs: ["nihaixia-StableV2026.5.23/SKILL.md"] },
    { canonical: "桂枝加葛根汤", aliases: ["桂枝汤加葛根"], sourceRefs: ["formula-patterns.md"] },
    { canonical: "白虎加人参汤", aliases: ["人参白虎汤"], sourceRefs: ["formula-patterns.md"] },
  ],
};

const differentiationRulesSeed = {
  schemaVersion: "tcm-differentiation-rules-v1",
  advisoryOnly: true,
  systematicReviewDimensions: [
    { id: "sleep", label: "睡眠", safetyClass: "standard" },
    { id: "appetite", label: "胃口与进食", safetyClass: "standard" },
    { id: "stool", label: "大便", safetyClass: "standard" },
    { id: "urination", label: "小便", safetyClass: "standard" },
    { id: "thirst", label: "口渴与饮水", safetyClass: "standard" },
    { id: "hot_cold", label: "寒热", safetyClass: "standard" },
    { id: "sweating", label: "汗出", safetyClass: "standard" },
    { id: "energy", label: "体力与精神", safetyClass: "standard" },
    { id: "reproductive", label: "月经/生育相关（仅在病例相关且适宜时询问）", safetyClass: "sensitive_context_only" },
  ],
  coldHeatEvidenceDimensions: [
    "面色与精神", "口鼻气息", "舌象", "脉象", "胸腹感觉", "小便", "口渴与饮水偏好", "大便",
  ],
  tonguePulseConflictPolicy: {
    sourceClaim: "参考材料含“脉舌冲突时以舌为准”的经验规则",
    runtimePolicy: "不得机械择一；冲突时两者均降为待复核证据，写入 uncertainties，并核实采集质量、时序和重复检查。",
    tier: "experience",
  },
  sixChannelDimensions: ["太阳", "少阳", "阳明", "太阴", "少阴", "厥阴"],
  rules: [
    {
      id: "T13-SOLAR-SWEAT",
      triggerTerms: ["发热", "恶寒", "恶风", "身痛", "项背强"],
      question: "发作时是有汗还是无汗？更偏恶风还是恶寒？",
      resolves: ["桂枝汤", "麻黄汤", "葛根汤", "大青龙汤"],
      dimensions: ["表里", "寒热", "津液"],
      sourceRefs: ["symptom-index.md#发热、恶寒、汗出", "six-channel.md#太阳病"],
    },
    {
      id: "T13-SHAOYANG",
      triggerTerms: ["往来寒热", "胸胁", "口苦", "恶心"],
      question: "寒热是交替发作还是持续发热？有无胸胁苦满、口苦或恶心？",
      resolves: ["小柴胡汤", "柴胡桂枝汤", "桂枝麻黄各半汤"],
      dimensions: ["病位", "表里"],
      sourceRefs: ["symptom-index.md#往来寒热、胸胁苦满、恶心", "six-channel.md#少阳病"],
    },
    {
      id: "T13-YANGMING-BOWEL",
      triggerTerms: ["高热", "口渴", "便秘", "腹痛", "腹胀"],
      question: "大便是否通、能否排气，腹部喜按还是拒按，小便颜色如何？",
      resolves: ["白虎汤", "小承气汤", "大承气汤", "调胃承气汤"],
      dimensions: ["寒热", "虚实", "津液"],
      sourceRefs: ["symptom-index.md#便秘", "six-channel.md#阳明病"],
    },
    {
      id: "T13-DIARRHEA-COLD-HEAT",
      triggerTerms: ["腹泻", "下利", "便溏"],
      question: "大便清稀还是臭秽灼热？口渴、小便颜色、腹部喜按或拒按分别如何？",
      resolves: ["葛根黄芩黄连汤", "桂枝人参汤", "四逆汤"],
      dimensions: ["寒热", "虚实"],
      sourceRefs: ["symptom-index.md#下利、腹泻、假水泻"],
    },
    {
      id: "T13-WATER-METABOLISM",
      triggerTerms: ["小便不利", "尿频", "口渴", "水肿", "眩晕"],
      question: "小便不利还是尿频？有无口渴欲饮、饮后呕吐、血尿或起立眩晕？",
      resolves: ["五苓散", "猪苓汤", "真武汤", "茯苓桂枝白术甘草汤"],
      dimensions: ["病位", "寒热", "津液"],
      sourceRefs: ["symptom-index.md#小便不利、尿频、尿血、结石"],
    },
    {
      id: "T13-COLD-EXTREMITIES",
      triggerTerms: ["手足冷", "四肢冷", "厥冷", "厥逆"],
      question: "冷仅到手足末端，还是超过腕踝甚至肘膝？有无下利、脉微、嗜睡、胸痛或意识异常？",
      resolves: ["当归四逆汤", "四逆汤", "四逆散", "通脉四逆汤"],
      dimensions: ["寒热", "虚实", "病位", "现代急症"],
      sourceRefs: ["symptom-index.md#手足冷、厥逆", "six-channel.md#厥阴病"],
    },
    {
      id: "T13-RESTLESSNESS",
      triggerTerms: ["失眠", "烦躁", "心悸"],
      question: "症状是否发生在汗、吐、下之后？是虚烦、昼间烦躁，还是心中烦不得卧？",
      resolves: ["栀子豉汤", "干姜附子汤", "黄连阿胶汤", "桂枝甘草汤"],
      dimensions: ["寒热", "虚实", "病程"],
      sourceRefs: ["symptom-index.md#睡眠、烦躁、心悸"],
    },
  ],
};

const formulaDiscriminationGraphSeed = {
  schemaVersion: "tcm-formula-discrimination-graph-v1",
  advisoryOnly: true,
  edges: [
    ["桂枝汤", "麻黄汤", "有汗/无汗、脉缓/脉紧", "T13-SOLAR-SWEAT"],
    ["麻黄汤", "大青龙汤", "是否兼明显烦躁与里热", "T13-SOLAR-SWEAT"],
    ["桂枝加葛根汤", "葛根汤", "项背强伴有汗或无汗", "T13-SOLAR-SWEAT"],
    ["葛根黄芩黄连汤", "桂枝人参汤", "热利灼热或寒利清稀", "T13-DIARRHEA-COLD-HEAT"],
    ["白虎汤", "大承气汤", "大便是否腑实、腹部是否拒按", "T13-YANGMING-BOWEL"],
    ["小承气汤", "大承气汤", "能否进食排气及腹痛拒按程度", "T13-YANGMING-BOWEL"],
    ["五苓散", "猪苓汤", "水逆气化不利或兼阴伤血尿", "T13-WATER-METABOLISM"],
    ["五苓散", "真武汤", "口渴水逆或下焦阳虚寒湿", "T13-WATER-METABOLISM"],
    ["茯苓桂枝白术甘草汤", "茯苓桂枝甘草大枣汤", "起则头眩或脐下悸欲奔豚", "T13-WATER-METABOLISM"],
    ["四逆汤", "四逆散", "里寒下利脉微或气机郁滞", "T13-COLD-EXTREMITIES"],
    ["四逆汤", "当归四逆汤", "厥冷达肘膝伴全身衰弱或仅末梢血脉寒凝", "T13-COLD-EXTREMITIES"],
    ["栀子豉汤", "干姜附子汤", "虚烦余热或阳虚昼日烦躁", "T13-RESTLESSNESS"],
    ["干姜附子汤", "黄连阿胶汤", "阳虚烦躁或阴虚火扰", "T13-RESTLESSNESS"],
    ["桂枝甘草汤", "炙甘草汤", "发汗后心下悸或脉结代、心动悸", "T13-RESTLESSNESS"],
    ["小柴胡汤", "桂枝麻黄各半汤", "有无胸胁苦满、恶心等少阳证", "T13-SHAOYANG"],
  ].map(([from, to, discriminator, ruleId], index) => ({
    id: `T14-${String(index + 1).padStart(3, "0")}`,
    from,
    to,
    discriminator,
    ruleId,
    sourceRefs: ["参考/nihaisha-nishi-tcm-main/references/formula-patterns.md"],
  })),
};

const parsedFormulaAssets = buildFormulaRuleAssets({
  seedAliases: formulaAliasesSeed,
  seedGraph: formulaDiscriminationGraphSeed,
  formulaPatternMarkdown,
  correctionMarkdown: correctionDecisionsMarkdown,
});
const formulaAliases = parsedFormulaAssets.formulaAliases;
const formulaDiscriminationGraph = parsedFormulaAssets.formulaDiscriminationGraph;
// T14 鉴别图谱治理扩展并入（与温病规则同通道：受控源文件 + 构建期合并，不手改产物）。
// 既有 61 节点/77 边全部出自参考仓六经素材，时方/温病/补益等高频方族没有鉴别轨道；
// 扩展经 ADJ-20260727-T14-GRAPH-EXPANSION 裁定，续编 T14-NODE-###/T14-### 合并。
const graphExtensionsPath = resolve(root, "src/data/tcm-formula-discrimination-extensions.source.json");
if (existsSync(graphExtensionsPath)) {
  const graphExtensions = JSON.parse(readFileSync(graphExtensionsPath, "utf8"));
  const maxSeq = (ids, pattern) => ids.reduce((max, id) => {
    const match = pattern.exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const nodeIds = new Set(formulaDiscriminationGraph.nodes.map((node) => node.id));
  const nodeNames = new Set(formulaDiscriminationGraph.nodes.map((node) => node.formulaName));
  let nodeSeq = maxSeq([...nodeIds], /^T14-NODE-(\d+)$/);
  for (const node of graphExtensions.nodes || []) {
    if (nodeNames.has(node.formulaName)) continue;
    nodeSeq += 1;
    const id = `T14-NODE-${String(nodeSeq).padStart(3, "0")}`;
    if (nodeIds.has(id)) throw new Error(`鉴别图谱扩展节点 id 冲突：${id}`);
    formulaDiscriminationGraph.nodes.push({ id, sixChannelSection: "时方温病方族扩展", ...node });
    nodeNames.add(node.formulaName);
    nodeIds.add(id);
  }
  const edgeIds = new Set(formulaDiscriminationGraph.edges.map((edge) => edge.id));
  const edgePairs = new Set(formulaDiscriminationGraph.edges.map((edge) => [edge.from, edge.to].sort().join("↔")));
  let edgeSeq = maxSeq([...edgeIds], /^T14-(\d+)$/);
  for (const edge of graphExtensions.edges || []) {
    const pair = [edge.from, edge.to].sort().join("↔");
    if (edgePairs.has(pair)) continue;
    edgeSeq += 1;
    const id = `T14-${String(edgeSeq).padStart(3, "0")}`;
    if (edgeIds.has(id)) throw new Error(`鉴别图谱扩展边 id 冲突：${id}`);
    formulaDiscriminationGraph.edges.push({ id, ...edge });
    edgePairs.add(pair);
    edgeIds.add(id);
  }
}
const differentiationRules = buildDiagnosticRuleAsset({
  seed: differentiationRulesSeed,
  symptomMarkdown: symptomIndexMarkdown,
  beginnerMarkdown: beginnerQuestionsMarkdown,
  sixChannelMarkdown,
  stableMarkdown: stableSkillMarkdown,
});
// 温病轨道并入。参考仓（six-channel.md 等）只有六经素材，没有对标的温病结构化源，
// 因此温病规则以受控源文件形式维护在 src/data/，在这里合并——**产物仍由生成器产出**，
// 不手改 tcm-differentiation-rules.json。
// 此前 53 条规则全是六经维度，温病轨道为 0；而规则经 rankedDifferentiationRules 取 top-4
// 注入 M03/M04 提示词，缺轨道意味着湿温类病例模型没有推理轨道可走，只能靠检索结果猜。
const warmDiseaseRules = JSON.parse(readFileSync(resolve(root, "src/data/tcm-warm-disease-rules.source.json"), "utf8"));
const warmDiseaseIds = new Set(warmDiseaseRules.rules.map((rule) => rule.id));
if (warmDiseaseIds.size !== warmDiseaseRules.rules.length) {
  throw new Error("温病规则源存在重复 id");
}
for (const rule of differentiationRules.rules) {
  if (warmDiseaseIds.has(rule.id)) throw new Error(`温病规则 id 与既有规则冲突：${rule.id}`);
}
// groundingExcerpt 只是治理留痕，不进运行时资产——运行时只认 T13 规则契约的字段。
differentiationRules.rules.push(...warmDiseaseRules.rules.map((rule) => {
  const runtimeRule = { ...rule };
  delete runtimeRule.groundingExcerpt;
  return runtimeRule;
}));
differentiationRules.warmDiseaseDimensions = ["卫分", "气分", "营分", "血分", "湿热"];
const fusionCoverage = crossCheckFusionAssets({
  differentiationRules,
  formulaDiscriminationGraph,
  formulaAliases,
});

const formulaCompositionRulesSeed = {
  schemaVersion: "tcm-formula-composition-rules-v1",
  advisoryOnly: true,
  entries: [
    {
      formulaName: "桂枝汤",
      summary: "桂枝与芍药一散一收，配合生姜、大枣、炙甘草调和营卫并顾护中焦；是否适用仍取决于汗出、恶风和脉象等患者事实。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#太阳病方证", "pdf-evidence:58423f817a06"],
    },
    {
      formulaName: "麻黄汤",
      summary: "麻黄、桂枝协同解表，杏仁宣降肺气，炙甘草调和；发汗方向必须先核实津液、汗出与禁汗线索。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#太阳病方证", "six-channel.md#太阳病"],
    },
    {
      formulaName: "小柴胡汤",
      summary: "柴胡疏解少阳，黄芩清少阳郁热，半夏、生姜和胃降逆，人参、大枣、甘草顾护中气；不得由单个“寒热”词机械锁方。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#少阳与变证方证", "six-channel.md#少阳病"],
    },
    {
      formulaName: "白虎汤",
      summary: "石膏与知母清解阳明气分热，粳米、甘草顾护胃津；须与存在燥屎腑实的承气汤方向严格鉴别。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#阳明病方证", "six-channel.md#阳明病"],
    },
    {
      formulaName: "五苓散",
      summary: "泽泻、猪苓、茯苓、白术协同利水渗湿，桂枝助气化；重点是水液气化不利，不可与兼阴伤、血尿线索的猪苓汤混同。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#太阳病方证", "symptom-index.md#小便不利、尿频、尿血、结石"],
    },
    {
      formulaName: "猪苓汤",
      summary: "猪苓、茯苓、泽泻利水，滑石通淋，阿胶兼顾阴血；须核对血尿、阴伤与热象，不得仅凭小便不利锁方。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#阳明病方证", "symptom-index.md#小便不利、尿频、尿血、结石"],
    },
    {
      formulaName: "四逆汤",
      summary: "附子、干姜温复阳气，炙甘草益气和中并调和峻烈药性；属于高风险回阳方向，只能在现代急症处置和药师审方边界内讨论。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#三阴病方证", "six-channel.md#少阴病"],
    },
    {
      formulaName: "黄连阿胶汤",
      summary: "黄连、黄芩清热，阿胶、芍药与鸡子黄养阴和血；用于阴虚火扰方向的辨证讨论，须与阳虚烦躁方向相鉴别。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#三阴病方证", "symptom-index.md#睡眠、烦躁、心悸"],
    },
    {
      formulaName: "半夏泻心汤",
      summary: "辛开、苦降与甘补并用以调和寒热、和胃消痞；必须由心下痞、呕吐、肠鸣下利等症状组合支持，不能由单一胃部不适套方。",
      tier: "common",
      sourceRefs: ["参考/nihaixia-StableV2026.5.23/SKILL.md#方剂辨证"],
    },
    {
      formulaName: "乌梅丸",
      summary: "酸收、辛温、苦降与益气药同用以处理寒热错杂；含多味高风险药，必须以受控目录、患者事实和处方后审方为准。",
      tier: "common",
      sourceRefs: ["formula-patterns.md#三阴病方证", "six-channel.md#厥阴病"],
    },
  ],
};

const seededCompositionNames = new Set(formulaCompositionRulesSeed.entries.map((entry) => entry.formulaName));
const governedFormulaByName = new Map(governedFormulaCatalog.entries.flatMap((entry) =>
  [entry.name, ...(entry.aliases || [])].map((name) => [name, entry])));
const formulaCompositionRules = {
  ...formulaCompositionRulesSeed,
  schemaVersion: "tcm-formula-composition-rules-v2",
  entries: [
    ...formulaCompositionRulesSeed.entries,
    ...formulaDiscriminationGraph.nodes.flatMap((node) => {
      if (seededCompositionNames.has(node.formulaName)) return [];
      const governed = governedFormulaByName.get(node.formulaName);
      if (!governed || !Array.isArray(governed.ingredients) || governed.ingredients.length === 0) return [];
      return [{
        formulaName: node.formulaName,
        summary:
          `受控目录组成：${governed.ingredients.join("、")}。` +
          `目录来源为${governed.source || governed.sourceCatalog || "本地受控方剂目录"}；` +
          `方证定位为“${node.pattern}”，仍须逐项核对患者事实、鉴别边与禁忌后才能进入处方编译。`,
        ingredients: governed.ingredients,
        source: governed.source || governed.sourceCatalog || "本地受控方剂目录",
        tier: "common",
        sourceRefs: [
          ...(governed.verification || []).map((item) => item.url || item.sourceRef).filter(Boolean),
          ...node.sourceRefs,
        ],
      }];
    }),
  ],
};

const textualModificationSeeds = [
  {
    id: "T14-MOD-GUIZHI-GEGEN",
    baseFormula: "桂枝汤",
    triggerTerms: ["项背强", "汗出", "恶风"],
    triggerMode: "all",
    resultingFormula: "桂枝加葛根汤",
    addHerbs: ["葛根"],
    removeHerbs: [],
    evidencePattern: /太阳病.{0,16}项背强.{0,24}汗出.{0,16}恶风.{0,20}桂枝加葛根汤/,
  },
  {
    id: "T14-MOD-GUIZHI-HOUPU-XINGREN",
    baseFormula: "桂枝汤",
    triggerTerms: ["喘", "咳嗽"],
    triggerMode: "any",
    resultingFormula: "桂枝加厚朴杏子汤",
    addHerbs: ["厚朴", "杏仁"],
    removeHerbs: [],
    evidencePattern: /若喘家作.{0,24}桂枝汤加厚朴[、，]?杏(?:子仁|仁)/,
  },
  {
    id: "T14-MOD-XIAOQINGLONG-URINATION",
    baseFormula: "小青龙汤",
    triggerTerms: ["小便不利", "少腹满"],
    triggerMode: "all",
    addHerbs: ["茯苓"],
    removeHerbs: ["麻黄"],
    evidencePattern: /小便不利.{0,16}少腹满.{0,20}去麻黄.{0,12}加茯苓/,
  },
  {
    id: "T14-MOD-XIAOQINGLONG-WHEEZE",
    baseFormula: "小青龙汤",
    triggerTerms: ["喘"],
    triggerMode: "all",
    addHerbs: ["杏仁"],
    removeHerbs: ["麻黄"],
    evidencePattern: /若喘.{0,16}去麻黄.{0,12}加杏仁/,
  },
  {
    id: "T14-MOD-GUIZHI-CHEST-FULLNESS",
    baseFormula: "桂枝汤",
    triggerTerms: ["下后", "脉促", "胸满"],
    triggerMode: "all",
    resultingFormula: "桂枝去芍药汤",
    addHerbs: [],
    removeHerbs: ["芍药"],
    evidencePattern: /下后.{0,12}脉促.{0,12}胸满.{0,20}桂枝去(?:白)?芍/,
  },
  {
    id: "T14-MOD-XIAOQINGLONG-THIRST",
    baseFormula: "小青龙汤",
    triggerTerms: ["口渴"],
    triggerMode: "all",
    addHerbs: ["栝蒌根"],
    removeHerbs: ["半夏"],
    evidencePattern: /若渴.{0,20}去半夏.{0,16}加(?:栝|瓜)蒌根/,
  },
  {
    id: "T14-MOD-XIAOCHAIHU-CHEST-VEXATION",
    baseFormula: "小柴胡汤",
    triggerTerms: ["胸中烦", "不呕"],
    triggerMode: "all",
    addHerbs: ["栝蒌实"],
    removeHerbs: ["半夏", "人参"],
    evidencePattern: /若胸中烦而不呕.{0,24}去半夏[、，]?人参.{0,16}加(?:栝|瓜)蒌实/,
  },
  {
    id: "T14-MOD-XIAOCHAIHU-THIRST",
    baseFormula: "小柴胡汤",
    triggerTerms: ["口渴"],
    triggerMode: "all",
    addHerbs: ["人参", "栝蒌根"],
    removeHerbs: ["半夏"],
    evidencePattern: /若渴.{0,20}去半夏.{0,20}加人参.{0,24}(?:栝|瓜)蒌/,
  },
  {
    id: "T14-MOD-XIAOCHAIHU-ABDOMINAL-PAIN",
    baseFormula: "小柴胡汤",
    triggerTerms: ["腹痛"],
    triggerMode: "all",
    addHerbs: ["芍药"],
    removeHerbs: ["黄芩"],
    evidencePattern: /若腹中痛.{0,20}去黄芩.{0,16}加芍药/,
  },
  {
    id: "T14-MOD-XIAOCHAIHU-HYPOCHONDRIAC-FULLNESS",
    baseFormula: "小柴胡汤",
    triggerTerms: ["胁下痞硬"],
    triggerMode: "all",
    addHerbs: ["牡蛎"],
    removeHerbs: ["大枣"],
    evidencePattern: /若胁下痞[鞭硬].{0,20}去大枣.{0,16}加牡蛎/,
  },
  {
    id: "T14-MOD-XIAOCHAIHU-PALPITATION-URINATION",
    baseFormula: "小柴胡汤",
    triggerTerms: ["心下悸", "小便不利"],
    triggerMode: "all",
    addHerbs: ["茯苓"],
    removeHerbs: ["黄芩"],
    evidencePattern: /若心下悸.{0,12}小便不利.{0,20}去黄芩.{0,16}加茯苓/,
  },
  {
    id: "T14-MOD-XIAOCHAIHU-EXTERIOR-HEAT",
    baseFormula: "小柴胡汤",
    triggerTerms: ["不渴", "微热"],
    triggerMode: "all",
    addHerbs: ["桂枝"],
    removeHerbs: ["人参"],
    evidencePattern: /若不渴.{0,16}外有微热.{0,20}去人参.{0,16}加桂枝/,
  },
  {
    id: "T14-MOD-XIAOCHAIHU-COUGH",
    baseFormula: "小柴胡汤",
    triggerTerms: ["咳嗽"],
    triggerMode: "all",
    addHerbs: ["五味子", "干姜"],
    removeHerbs: ["人参", "大枣", "生姜"],
    evidencePattern: /若咳.{0,20}去人参[、，]?大枣[、，]?生姜.{0,24}加五味子.{0,16}干姜/,
  },
  {
    id: "T14-MOD-GUIPITANG-CHRONIC-BLEEDING",
    baseFormula: "归脾汤",
    triggerTerms: ["血崩", "面色萎黄", "惊悸不寐"],
    triggerMode: "all",
    addHerbs: ["熟地", "白芍"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1237-r001",
    evidencePattern: /久患血崩.{0,120}惊悸不寐.{0,100}归脾汤加熟地、白芍/,
  },
  {
    id: "T14-MOD-GUIPITANG-LIVER-SPLEEN-PHLEGM-HEAT",
    baseFormula: "归脾汤",
    triggerTerms: ["胸痞内热", "喉中若有一核", "月经不调"],
    triggerMode: "all",
    addHerbs: ["半夏", "山栀", "升麻", "柴胡"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1240-r001",
    evidencePattern: /胸痞内热.{0,100}月经不调.{0,100}归脾汤加半夏、山栀、升麻、柴胡/,
  },
  {
    id: "T14-MOD-GUIPITANG-CONSTRAINED-DEFICIENCY",
    baseFormula: "归脾汤",
    triggerTerms: ["郁怒伤阴", "胀闷", "大小便不利"],
    triggerMode: "all",
    addHerbs: ["山栀", "木香"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1258-r001",
    evidencePattern: /妊娠大小便不利.{0,180}郁怒伤阴.{0,100}归脾汤加山栀、木香/,
  },
  {
    id: "T14-MOD-GUIPITANG-DAMP-HEAT-ITCHING",
    baseFormula: "归脾汤",
    triggerTerms: ["阴内痛", "作痒", "食少体倦"],
    triggerMode: "all",
    addHerbs: ["生白芍", "牡丹皮", "黑山栀", "生甘草"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1246-r001",
    evidencePattern: /阴内痛甚作痒.{0,80}食少体倦.{0,100}归脾汤加生白芍、牡丹皮、黑山栀、生甘草/,
  },
  {
    id: "T14-MOD-ERCHENTANG-LIVER-SPLEEN-QI-STAGNATION",
    baseFormula: "二陈汤",
    triggerTerms: ["心腹作痛", "胸胁膨胀", "吞酸不食"],
    triggerMode: "all",
    addHerbs: ["山楂", "山栀", "青皮", "木香"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1252-r001",
    evidencePattern: /心腹作痛.{0,60}胸胁膨胀.{0,20}吞酸不食.{0,120}二陈汤加山楂、山栀、青皮、木香/,
  },
  {
    id: "T14-MOD-ERCHENTANG-QI-MOVEMENT-DEFICIENCY",
    baseFormula: "二陈汤",
    triggerTerms: ["气动"],
    triggerMode: "all",
    addHerbs: ["人参"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0157-r009",
    evidencePattern: /气动.{0,12}二陈汤加人参/,
  },
  {
    id: "T14-MOD-LIUJUNZI-MEAT-FOOD-INJURY",
    baseFormula: "六君子汤",
    triggerTerms: ["肉食所伤"],
    triggerMode: "all",
    addHerbs: ["山楂"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /伤肉食.{0,12}加山楂/,
  },
  {
    id: "T14-MOD-LIUJUNZI-RICE-FOOD-INJURY",
    baseFormula: "六君子汤",
    triggerTerms: ["米食所伤"],
    triggerMode: "all",
    addHerbs: ["麦芽", "枳壳"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /伤米食.{0,12}加麦芽、枳壳/,
  },
  {
    id: "T14-MOD-LIUJUNZI-FLOUR-FOOD-INJURY",
    baseFormula: "六君子汤",
    triggerTerms: ["面食所伤"],
    triggerMode: "all",
    addHerbs: ["莱菔子"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /伤面食.{0,12}加萝卜子/,
  },
  {
    id: "T14-MOD-LIUJUNZI-SPLEEN-QI-STAGNATION-PHLEGM",
    baseFormula: "六君子汤",
    triggerTerms: ["心腹作痛", "吐痰食少", "脾虚气滞"],
    triggerMode: "all",
    addHerbs: ["柴胡", "枳壳"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1252-r001",
    evidencePattern: /心腹作痛.{0,24}吐痰食少.{0,80}脾虚气滞.{0,80}六君子汤加柴胡、枳壳/,
  },
  {
    id: "T14-MOD-LIUJUNZI-ANGER-HYPOCHONDRIAC-DISTENSION",
    baseFormula: "六君子汤",
    triggerTerms: ["怒气", "两胁作胀", "中脘疼痛"],
    triggerMode: "all",
    addHerbs: ["柴胡", "升麻", "木香"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1252-r001",
    evidencePattern: /怒气两胁作胀.{0,24}中脘疼痛.{0,100}六君子汤加柴胡、升麻、木香/,
  },
  {
    id: "T14-MOD-LIUJUNZI-FOOD-INJURY-ACID-REGURGITATION",
    baseFormula: "六君子汤",
    triggerTerms: ["饮食所伤", "胸膈胀满", "咽酸嗳气"],
    triggerMode: "all",
    addHerbs: ["神曲", "山楂"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1282-r001",
    evidencePattern: /饮食所伤.{0,40}脾胃不能克化.{0,20}六君汤加神曲、山楂/,
  },
  {
    id: "T14-MOD-BUZHONGYIQI-MALARIA-DISCHARGE",
    baseFormula: "补中益气汤",
    triggerTerms: ["久疟", "发热口渴", "体倦食少"],
    triggerMode: "all",
    addHerbs: ["茯苓", "半夏"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1240-r001",
    evidencePattern: /久疟患带.{0,20}发热口渴.{0,20}体倦食少.{0,100}补中益气汤加茯苓、半夏/,
  },
  {
    id: "T14-MOD-BUZHONGYIQI-SPLEEN-STOMACH-DAMP-HEAT",
    baseFormula: "补中益气汤",
    triggerTerms: ["吞酸饱满", "食少便泄", "湿热下注"],
    triggerMode: "all",
    addHerbs: ["半夏", "茯苓", "炮姜"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1240-r001",
    evidencePattern: /吞酸饱满.{0,20}食少便泄.{0,100}湿热下注.{0,20}补中益气汤.{0,20}加半夏、茯苓、炮姜/,
  },
  {
    id: "T14-MOD-BUZHONGYIQI-DAMP-HEAT-BLEEDING",
    baseFormula: "补中益气汤",
    triggerTerms: ["带下赤白", "痰喘胸满", "大便下血"],
    triggerMode: "all",
    addHerbs: ["炮姜", "白芍", "茯苓", "半夏"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1240-r001",
    evidencePattern: /带下赤白.{0,100}痰喘胸满.{0,20}大便下血.{0,100}补中益气汤加炮姜、白芍、茯苓、半夏/,
  },
  {
    id: "T14-MOD-BUZHONGYIQI-PREGNANCY-CHRONIC-DYSENTERY",
    baseFormula: "补中益气汤",
    triggerTerms: ["妊娠", "久痢", "腹内重坠", "胎气不安"],
    triggerMode: "all",
    addHerbs: ["白芍", "木香"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1258-r001",
    evidencePattern: /怀娠久痢.{0,40}腹内重坠.{0,20}胎气不安.{0,120}补中益气汤加白芍、木香/,
  },
  {
    id: "T14-MOD-XIAOYAO-WOOD-CONSTRAINT",
    baseFormula: "逍遥散",
    triggerTerms: ["木郁"],
    triggerMode: "all",
    addHerbs: ["牡丹皮", "栀子"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /丹皮、栀子.{0,12}木郁/,
  },
  {
    id: "T14-MOD-XIAOYAO-FIRE-CONSTRAINT",
    baseFormula: "逍遥散",
    triggerTerms: ["火郁"],
    triggerMode: "all",
    addHerbs: ["黄连"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /黄连.{0,12}火郁/,
  },
  {
    id: "T14-MOD-XIAOYAO-METAL-CONSTRAINT",
    baseFormula: "逍遥散",
    triggerTerms: ["金郁"],
    triggerMode: "all",
    addHerbs: ["黄芩", "苏叶"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /黄芩、苏叶.{0,12}金郁/,
  },
  {
    id: "T14-MOD-XIAOYAO-EARTH-CONSTRAINT",
    baseFormula: "逍遥散",
    triggerTerms: ["土郁"],
    triggerMode: "all",
    addHerbs: ["石膏", "知母"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /石膏、知母.{0,12}土郁/,
  },
  {
    id: "T14-MOD-XIAOYAO-WATER-CONSTRAINT",
    baseFormula: "逍遥散",
    triggerTerms: ["水郁"],
    triggerMode: "all",
    addHerbs: ["泽泻", "猪苓"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /泽泻、猪苓.{0,12}水郁/,
  },
  {
    id: "T14-MOD-XIAOYAO-LIVER-QI-PAIN",
    baseFormula: "逍遥散",
    triggerTerms: ["善怒多郁", "小腹痛胀", "胁肋痞满"],
    triggerMode: "all",
    addHerbs: ["木香", "香附"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1243-r001",
    evidencePattern: /善怒多郁.{0,20}小腹痛胀.{0,50}胁肋痞满.{0,120}逍遥散加木香、香附/,
  },
  {
    id: "T14-MOD-XIAOYAO-PREGNANCY-DEFICIENCY-CONSTIPATION",
    baseFormula: "逍遥散",
    triggerTerms: ["妊娠", "大小便不利", "郁怒伤阴"],
    triggerMode: "all",
    addHerbs: ["生地"],
    removeHerbs: ["牡丹皮"],
    sourceEvidenceId: "T15-d2b093656655-p1258-r001",
    evidencePattern: /妊娠大小便不利.{0,180}郁怒伤阴.{0,160}加味逍遥散去丹皮加生地/,
  },
  {
    id: "T14-MOD-XIAOYAO-POST-DYSENTERY-FLUID-DEFICIENCY",
    baseFormula: "逍遥散",
    triggerTerms: ["妊娠痢疾愈后", "二便不通", "津液无以下润"],
    triggerMode: "all",
    addHerbs: ["车前子"],
    removeHerbs: ["牡丹皮"],
    sourceEvidenceId: "T15-d2b093656655-p1258-r001",
    evidencePattern: /妊娠痢疾，愈后二便不通.{0,160}津液无以下润.{0,120}加味逍遥散去丹皮加车前子/,
  },
  {
    id: "T14-MOD-SIWU-HEMATEMESIS",
    baseFormula: "四物汤",
    triggerTerms: ["吐血"],
    triggerMode: "all",
    addHerbs: ["麦冬", "甘草"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /吐血宜加麦冬、甘草/,
  },
  {
    id: "T14-MOD-SIWU-HEMATOCHEZIA",
    baseFormula: "四物汤",
    triggerTerms: ["便血"],
    triggerMode: "all",
    addHerbs: ["地榆", "黄芩"],
    removeHerbs: [],
    sourceEvidenceId: "T15-a60ecf5c4021-p0175-r001",
    evidencePattern: /便血宜加地榆、黄芩/,
  },
  {
    id: "T14-MOD-SIWU-SEVERE-BLOOD-STASIS",
    baseFormula: "四物汤",
    triggerTerms: ["瘀血较重"],
    triggerMode: "all",
    resultingFormula: "桃红四物汤",
    addHerbs: ["桃仁", "红花"],
    removeHerbs: [],
    sourceEvidenceId: "T15-57bd28cae94e-p0233-r005",
    evidencePattern: /瘀血比较严重.{0,80}桃红四物汤.{0,60}加上桃仁红花/,
  },
  {
    id: "T14-MOD-SIWU-LIVER-QI-STAGNATION-PAIN",
    baseFormula: "四物汤",
    triggerTerms: ["善怒多郁", "小腹痛胀", "胁肋痞满"],
    triggerMode: "all",
    addHerbs: ["柴胡", "青皮", "橘核", "延胡索"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1243-r001",
    evidencePattern: /善怒多郁.{0,20}小腹痛胀.{0,50}胁肋痞满.{0,80}四物汤加柴胡、青皮、橘核、延胡/,
  },
  {
    id: "T14-MOD-BAZHEN-SPLEEN-QI-BLOOD-DEFICIENCY-FEVER",
    baseFormula: "八珍汤",
    triggerTerms: ["脾经气血虚", "发热烦躁", "脉洪大而虚"],
    triggerMode: "all",
    addHerbs: ["炮姜"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1237-r001",
    evidencePattern: /发热烦躁.{0,30}脉洪大而虚.{0,60}脾经气血虚.{0,30}八珍汤加炮姜/,
  },
  {
    id: "T14-MOD-BAZHEN-SPLEEN-DAMP-HEAT",
    baseFormula: "八珍汤",
    triggerTerms: ["脾气亏损", "湿热", "大便下血"],
    triggerMode: "all",
    addHerbs: ["柴胡", "山栀"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1240-r001",
    evidencePattern: /脾气亏损.{0,20}挟湿热.{0,80}大便下血.{0,180}八珍汤加柴胡、山栀/,
  },
  {
    id: "T14-MOD-BAZHEN-LIVER-CHANNEL-DAMP-HEAT",
    baseFormula: "八珍汤",
    triggerTerms: ["小腹痞胀", "小水不利", "气血两虚", "湿热郁于肝经"],
    triggerMode: "all",
    addHerbs: ["柴胡", "山栀", "龙胆", "车前子"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1243-r001",
    evidencePattern: /小腹痞胀.{0,40}小水不利.{0,60}气血两虚.{0,20}湿热郁于肝经.{0,20}八珍汤加柴胡、山栀、龙胆、车前/,
  },
  {
    id: "T14-MOD-BAZHEN-FLUID-DEFICIENCY-CONSTIPATION",
    baseFormula: "八珍汤",
    triggerTerms: ["妊娠痢疾愈后", "二便不通", "气血两虚", "津液无以下润"],
    triggerMode: "all",
    addHerbs: ["火麻仁", "杏仁"],
    removeHerbs: [],
    sourceEvidenceId: "T15-d2b093656655-p1258-r001",
    evidencePattern: /妊娠痢疾，愈后二便不通.{0,160}气血两虚.{0,20}津液无以下润.{0,20}八珍汤加麻仁、杏仁/,
  },
  // 《伤寒论》《金匮》原文自带的方后加减法。Patterns stay whitespace-tolerant because the source
  // pages break clauses across lines (e.g. 「若下\n利者」「加茯苓五\n分」).
  {
    id: "T14-MOD-ZHENWU-COUGH",
    baseFormula: "真武汤",
    triggerTerms: ["咳"],
    triggerMode: "any",
    addHerbs: ["五味子", "细辛", "干姜"],
    removeHerbs: [],
    evidencePattern: /真武汤加减[：:]\s*若咳者[，,]\s*加五味子/,
  },
  {
    id: "T14-MOD-SINISAN-COUGH",
    baseFormula: "四逆散",
    triggerTerms: ["咳"],
    triggerMode: "any",
    addHerbs: ["五味子", "干姜"],
    removeHerbs: [],
    evidencePattern: /咳者[，,]\s*加五味子[、,，]\s*干姜各五分/,
  },
  {
    id: "T14-MOD-SINISAN-PALPITATION",
    baseFormula: "四逆散",
    triggerTerms: ["悸"],
    triggerMode: "any",
    addHerbs: ["桂枝"],
    removeHerbs: [],
    evidencePattern: /悸者[，,]\s*加桂枝五分/,
  },
  {
    id: "T14-MOD-SINISAN-URINATION",
    baseFormula: "四逆散",
    triggerTerms: ["小便不利"],
    triggerMode: "any",
    addHerbs: ["茯苓"],
    removeHerbs: [],
    evidencePattern: /小便不利者[，,]\s*加茯苓五\s*分/,
  },
  {
    id: "T14-MOD-SINISAN-TENESMUS",
    baseFormula: "四逆散",
    triggerTerms: ["泄利下重"],
    triggerMode: "any",
    addHerbs: ["薤白"],
    removeHerbs: [],
    evidencePattern: /泄利下重者[，,]\s*先以水五升[，,]\s*煮薤白/,
  },
  {
    id: "T14-MOD-LIZHONG-NAVEL-THROB",
    baseFormula: "理中丸",
    triggerTerms: ["脐上筑"],
    triggerMode: "any",
    addHerbs: ["桂枝"],
    removeHerbs: ["白术"],
    evidencePattern: /若脐上筑者[，,]\s*肾气动也[，,]\s*去术加桂/,
  },
  {
    id: "T14-MOD-LIZHONG-VOMIT",
    baseFormula: "理中丸",
    triggerTerms: ["吐多"],
    triggerMode: "any",
    addHerbs: ["生姜"],
    removeHerbs: ["白术"],
    evidencePattern: /吐多者[，,]\s*去术加生姜/,
  },
  {
    id: "T14-MOD-TONGMAI-RED-FACE",
    baseFormula: "通脉四逆汤",
    triggerTerms: ["面色赤"],
    triggerMode: "any",
    addHerbs: ["葱白"],
    removeHerbs: [],
    evidencePattern: /面色赤者[，,]\s*加葱九茎/,
  },
];

const contraindicationRules = {
  schemaVersion: "tcm-contraindication-rules-v1",
  advisoryOnly: true,
  rules: [
    {
      id: "T14-MAHUANG-SWEAT-DEPLETION",
      formulaNames: ["麻黄汤", "大青龙汤", "葛根汤"],
      contraindicationTerms: ["汗出不止", "大汗", "津液不足", "咽干", "尺脉迟微", "淋家", "疮家"],
      message: "发汗法存在课程禁忌或津液受损线索，不能直接承接为剂量级候选。",
      severity: "block",
      sourceRefs: ["six-channel.md#太阳病", "formula-patterns.md#太阳病方证"],
    },
    {
      id: "T14-PURGE-DEFICIENCY",
      formulaNames: ["大承气汤", "小承气汤", "调胃承气汤", "桃核承气汤"],
      contraindicationTerms: ["喜按", "自利不渴", "脉弱", "虚寒", "孕妇", "妊娠"],
      message: "攻下或破血方向与虚寒/特殊人群线索冲突，必须停止自动编译并人工复核。",
      severity: "block",
      sourceRefs: ["six-channel.md#阳明病", "formula-patterns.md#阳明病方证"],
    },
    {
      id: "T14-FUZI-HIGH-RISK",
      formulaNames: ["四逆汤", "通脉四逆汤", "白通汤", "白通加猪胆汁汤", "真武汤", "麻黄附子细辛汤", "干姜附子汤"],
      contraindicationTerms: ["孕妇", "妊娠", "心律失常", "室性早搏", "肝功能异常", "肾功能异常"],
      message: "附子类高风险方与特殊人群或心肝肾风险并存，禁止自动形成可执行处方。",
      severity: "block",
      sourceRefs: ["formula-patterns.md#三阴病方证", "nihaixia-StableV2026.5.23/SKILL.md#禁忌规则"],
    },
    {
      id: "T14-BLOOD-BREAKING-BLEEDING",
      formulaNames: ["抵当汤", "抵当丸", "桃核承气汤", "大黄䗪虫丸"],
      contraindicationTerms: ["活动性出血", "月经过多", "妊娠", "孕妇", "抗凝药", "华法林"],
      message: "破血逐瘀方向存在出血或妊娠风险，必须人工复核且不得自动处方。",
      severity: "block",
      sourceRefs: ["formula-patterns.md#少阳与变证方证", "nihaixia-StableV2026.5.23/SKILL.md#禁忌规则"],
    },
    {
      id: "T14-GUIZHI-NO-SWEAT",
      formulaNames: ["桂枝汤", "桂枝加葛根汤"],
      contraindicationTerms: ["无汗", "脉浮紧", "脉紧"],
      message: "无汗或脉紧与桂枝汤类的太阳中风方证不符，禁止由方名直接承接为处方。",
      severity: "block",
      sourceRefs: ["formula-patterns.md:17", "nihaixia-StableV2026.5.23/SKILL.md:6151"],
    },
    {
      id: "T14-EPHEDRA-SPONTANEOUS-SWEAT",
      formulaNames: ["麻黄汤", "大青龙汤", "葛根汤"],
      contraindicationTerms: ["有汗", "自汗", "汗出", "脉微弱", "恶风"],
      message: "已有汗出、恶风或脉弱时，发汗方方向存在方证冲突，必须停止自动编译。",
      severity: "block",
      sourceRefs: ["formula-patterns.md:22", "nihaixia-StableV2026.5.23/SKILL.md:951"],
    },
    {
      id: "T14-SHAOYIN-FORBID-STRONG-SWEATING",
      formulaNames: ["麻黄汤", "大青龙汤", "葛根汤"],
      contraindicationTerms: ["少阴", "脉微细", "但欲寐", "手足厥冷"],
      message: "少阴里证或亡阳线索不可按普通太阳表证强发汗；特殊微汗语境也必须由医师辨证。",
      severity: "block",
      sourceRefs: ["six-channel.md#少阴病", "correction-decisions.md#少阴禁汗语境"],
    },
    {
      id: "T14-EXTERIOR-FORBID-PURGING",
      formulaNames: ["大承气汤", "小承气汤", "调胃承气汤", "桃核承气汤", "大陷胸汤", "大陷胸丸"],
      contraindicationTerms: ["表证", "恶寒", "脉浮", "头项强痛"],
      message: "表证未解时攻里可能造成误治，未完成表里鉴别前禁止自动编译攻下方向。",
      severity: "block",
      sourceRefs: ["nihaixia-StableV2026.5.23/SKILL.md:6151", "formula-patterns.md:65"],
    },
    {
      id: "T14-GUIZHI-ALCOHOL-RISK",
      formulaNames: ["桂枝汤", "桂枝加葛根汤"],
      contraindicationTerms: ["酒客", "长期饮酒", "大量饮酒"],
      message: "参考资料把长期大量饮酒列为桂枝汤课程禁忌；仅作风险提示，须结合现代肝功能和用药史人工复核。",
      severity: "review",
      sourceRefs: ["formula-patterns.md:17", "nihaixia-StableV2026.5.23/SKILL.md:6151"],
    },
    {
      id: "T14-ZHIZI-LOOSE-STOOL",
      formulaNames: ["栀子豉汤", "栀子厚朴枳实汤"],
      contraindicationTerms: ["旧微溏", "便溏", "下利清稀"],
      message: "既往或当前便溏与栀子豉汤课程禁忌线索冲突，需重新核对寒热虚实。",
      severity: "review",
      sourceRefs: ["nihaixia-StableV2026.5.23/SKILL.md:3463"],
    },
  ],
};

const textualModificationTargetFormulaNames = [
  "桂枝汤",
  "真武汤",
  "四逆散",
  "理中丸",
  "通脉四逆汤",
  "小青龙汤",
  "小柴胡汤",
  "归脾汤",
  "二陈汤",
  "六君子汤",
  "补中益气汤",
  "逍遥散",
  "四物汤",
  "八珍汤",
];
const seededModificationFormulaNames = new Set(textualModificationSeeds.map((item) => item.baseFormula));
if (
  formulaCompositionRules.entries.length < 35 ||
  textualModificationSeeds.length < 51 ||
  textualModificationTargetFormulaNames.some((name) => !seededModificationFormulaNames.has(name)) ||
  contraindicationRules.rules.length < 10
) {
  throw new Error("T14 governed composition/modification/contraindication coverage gate failed");
}

const formulaNames = [...new Set([
  ...governedFormulaCatalog.entries.map((entry) => entry.name),
  ...formulaAliases.entries.flatMap((entry) => [entry.canonical, ...entry.aliases]),
])].sort((left, right) => right.length - left.length);

const positionalChineseNumber = (value) => {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { "〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  if (!/[十百]/.test(value)) {
    const parsed = [...value].map((character) => digits[character]);
    return parsed.every(Number.isInteger) ? Number(parsed.join("")) : NaN;
  }
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (character === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (character === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (Number.isInteger(digits[character])) {
      current = digits[character];
    }
  }
  return total + current;
};

const shanghanClauseSourceIds = new Set(["58423f817a06", "125053a536e3"]);
// Only treat numbers from the two actual clause-text sources as clause anchors.
// The opener guard rejects page numbers, lecture headings and numbered commentary.
const clausePattern = /(?:^|\n)\s*(?:第\s*)?([〇零一二三四五六七八九十百]{1,6}|\d{1,3})\s*(?:条\s*)?[、：:，,.．]\s*[“「]?(?=(?:太阳|伤寒|问曰|答曰|师曰|凡|若|病人|病者|妇人|男子|阳明|少阳|太阴|少阴|厥阴|霍乱|发汗|脉|其|服|医|本|风|血|水|诸|趺阳|跌阳|寸口|中风|桂枝汤|二阳|大下|下之|病常|汗家|本先|形(?:作|做)伤寒|微数|烧针|火逆|藏结|病发|结胸))/g;
const quarantinePattern = /(疫苗.{0,20}(?:不要|不能|有害|致病|后遗症|毒|导致|造成)|西医.{0,20}(?:无用|害人|杀人)|拒绝.{0,12}(?:急诊|手术|化疗|放疗)|童子尿|人尿|生硫磺|服硫磺|刺血|放血|三棱针|生附子.{0,30}(?:使用|用到|剂量|钱|克|煎|服)|(?:使用|用|加|服).{0,16}生附子|自行.{0,8}(?:服|用|煎|灸|针))/i;
const restrictedPattern = /(生附子|附子|乌头|硫磺|砒霜|雄黄|巴豆|甘遂|大戟|芫花|水蛭|虻虫|承气汤|抵当汤|大陷胸汤|剂量|用量|(?:\d+(?:\.\d+)?|[〇零一二三四五六七八九十百半]+)\s*(?:克|g|钱|两|升|合|铢)|煎服|先煎|后下|针灸|穴位|癌症|肿瘤)/i;
const doseAndInstructionPattern = /(?:(?:\d+(?:\.\d+)?|[〇零一二三四五六七八九十百半]+)\s*(?:克|g|钱|两|升|合|铢)|每日.{0,8}(?:服|次)|(?:先煎|后下|久煎|水煎服)|(?:针|刺|灸).{0,16}(?:穴|分钟|寸))/gi;
const dangerousRuntimePattern = /(童子尿|人尿|生硫磺|服硫磺|生附子.{0,30}(?:使用|用到|剂量|钱|克|煎|服)|自行.{0,8}(?:服|用|煎|灸|针)|拒绝.{0,12}(?:急诊|手术|化疗|放疗))/i;
const caseEvaluationQuarantinePattern = /(疫苗|生附子|硫磺|刺血|放血|童子尿|人尿|西医.{0,30}(?:无用|害人|杀人|必死|骗人)|拒绝.{0,16}(?:急诊|手术|化疗|放疗))/i;
const caseNarrativeExclusionPattern = /(治愈|痊愈|根治|好转|好了|好掉|恢复|改善|转好|肿瘤.{0,12}(?:缩小|消失)|西医|西药|中药|剂量|处方|加减|服用|用药|开立|给予|使用|疗程|煎|每日|停药|自行|建议|必须用|疗效|有效率|死亡|必死|骗人|害人)/i;
const caseNarrativeFactPattern = /(患者|病人|主诉|症状|初见|可见|出现|发作|伴|舌|苔|脉|睡眠|失眠|胃口|食欲|纳差|大便|小便|便秘|排气|下利|口渴|汗|恶寒|发热|手足|四肢|疼痛|胸闷|心悸|咳|喘|乏力|精神)/;
const caseDoseOrInstructionPattern = new RegExp(doseAndInstructionPattern.source, "i");
const replayClinicalFindingTerms = [
  "发热", "低热", "高热", "恶寒", "恶风", "怕冷", "怕热", "往来寒热",
  "无汗", "汗出", "自汗", "盗汗", "大汗", "身痛", "项背强", "头痛", "眩晕",
  "头晕", "昏倒", "耳鸣", "耳聋", "鼻塞", "胸痛", "胸闷", "胸满", "胸胁苦满",
  "心悸", "气短", "呼吸困难", "无法平躺", "喘", "咳嗽", "咳血", "白痰", "黄痰",
  "痰多", "口苦", "口臭", "咽干", "咽痛", "吞咽困难", "口渴", "不渴", "喜冷饮", "喜热饮",
  "恶心", "呕吐", "胃痛", "腹胀", "腹满", "腹痛", "少腹痛", "腰痛", "背痛", "胁痛",
  "喜按", "拒按", "胃口差",
  "无胃口", "食欲差", "纳差", "饥不欲食", "便秘", "不放屁", "大便溏", "便溏",
  "下利", "腹泻", "黑便", "便血", "小便黄", "小便清", "小便不利", "尿频", "血尿",
  "失眠", "入睡困难", "睡眠不深", "夜醒", "早醒", "但欲寐", "嗜睡", "烦躁", "焦虑",
  "忧郁", "乏力", "无力", "疲倦", "倦怠", "体力差", "手足冷", "四肢冰冷", "手足厥冷",
  "麻木", "关节痛", "肌肉痛", "抽搐", "癫痫发作", "皮肤痒", "瘙痒", "水肿", "腹水",
  "面红", "面色黄", "皮肤黄", "无味觉", "无嗅觉", "停经", "月经不调", "痛经",
  "舌淡", "舌红", "舌绛", "舌紫", "苔白", "苔黄", "苔腻", "苔燥", "脉浮", "脉沉",
  "脉迟", "脉数", "脉弦", "脉细", "脉紧", "脉缓", "脉微", "脉弱", "脉结代",
];

const cleanExcerpt = (text, length = 260) => text
  .replace(doseAndInstructionPattern, "[具体剂量或操作已隔离]")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, length);

const formulaHits = compileFormulaMentionMatcher(formulaNames, 12);
const patternHits = (text) => [
  "太阳", "少阳", "阳明", "太阴", "少阴", "厥阴", "表证", "里证", "寒证", "热证",
  "虚证", "实证", "气虚", "血虚", "阴虚", "阳虚", "痰饮", "水饮", "瘀血", "湿热",
].filter((term) => text.includes(term));

function safetyClassForText(text) {
  if (quarantinePattern.test(text)) return "quarantine";
  if (restrictedPattern.test(text)) return "restricted";
  return "standard";
}

function mergeAdjacentSafetySegments(text) {
  const normalized = text.replace(/\n(?=\S)/g, "").trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^。！？；]+[。！？；]?/g) || [normalized];
  const output = [];
  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    const safetyClass = safetyClassForText(sentence);
    const previous = output.at(-1);
    if (previous && previous.safetyClass === safetyClass && previous.text.length + sentence.length <= 800) {
      previous.text += sentence;
    } else {
      output.push({ text: sentence, safetyClass });
    }
  }
  return output;
}

function evidenceSegments(text, module, docId) {
  const anchored = [];
  if (module === "shanghan" && shanghanClauseSourceIds.has(docId)) {
    clausePattern.lastIndex = 0;
    const matches = [...text.matchAll(clausePattern)]
      .map((match) => ({
        index: match.index ?? 0,
        clauseNumber: positionalChineseNumber(match[1]),
      }))
      .filter((match) =>
        Number.isInteger(match.clauseNumber) && match.clauseNumber >= 1 && match.clauseNumber <= 398);
    if (matches.length > 0) {
      if (matches[0].index > 0) anchored.push({ text: text.slice(0, matches[0].index), clauseNumber: undefined });
      for (const [index, match] of matches.entries()) {
        anchored.push({
          text: text.slice(match.index, matches[index + 1]?.index ?? text.length),
          clauseNumber: match.clauseNumber,
        });
      }
    }
  }
  if (anchored.length === 0) anchored.push({ text, clauseNumber: undefined });

  return anchored.flatMap((item) => {
    const blocks = item.text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    return (blocks.length > 0 ? blocks : [item.text]).flatMap((block) =>
      mergeAdjacentSafetySegments(block).map((segment) => ({
        ...segment,
        clauseNumber: item.clauseNumber,
      })));
  });
}

const evidenceRows = [];
const quarantineRows = [];
const runtimeByFormula = new Map();
const shanghanClauses = new Set();
const safeSourceCardIds = new Set();
const quarantineSourceCardIds = new Set();
let sourceCardCount = 0;

const input = createInterface({ input: createReadStream(sourceCardsPath, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  sourceCardCount += 1;
  const card = JSON.parse(line);
  const source = sourceById.get(card.doc_id) || {};
  const text = String(card.text || "");
  const sourceRole = source.source_role || "course-derived";
  const tier = sourceRole === "ni-recommended-supplement" ? "canon" : "experience";
  const segments = evidenceSegments(text, card.module, card.doc_id);
  // Preserve even a genuinely blank/excluded page as a mapped audit record.
  if (segments.length === 0) segments.push({ text: "", safetyClass: "standard", clauseNumber: undefined });
  const chapter = card.module === "jingui"
    ? text.match(/([^。\n]{2,40}(?:病脉证并治|篇))/)?.[1]?.trim() || null
    : undefined;
  for (const [segmentIndex, segment] of segments.entries()) {
    const formulas = formulaHits(segment.text);
    if (segment.clauseNumber) shanghanClauses.add(segment.clauseNumber);
    const anchorLevel = card.module === "shanghan" && segment.clauseNumber
      ? "tiaowen"
      : card.module === "jingui"
        ? "chapter_paragraph"
        : "page_paragraph";
    const recordSuffix = `r${String(segmentIndex + 1).padStart(3, "0")}`;
    const row = {
      evidenceId: `T15-${card.card_id}-${recordSuffix}`,
      sourceCardId: card.card_id,
      sourceName: card.source_name,
      docId: card.doc_id,
      module: card.module,
      anchorLevel,
      ...(segment.clauseNumber ? { clauseNumber: segment.clauseNumber } : {}),
      ...(card.module === "jingui"
        ? { chapter, paragraph: `${card.page}.${segmentIndex + 1}` }
        : { page: card.page, paragraph: segmentIndex + 1 }),
      text: segment.text.replace(/\s+/g, " ").trim(),
      formulas,
      patterns: patternHits(segment.text),
      citation: `${card.citation}:${recordSuffix}`,
      version: "2026-07-23",
      tier,
      safetyClass: segment.safetyClass,
    };
    if (segment.safetyClass === "quarantine") {
      quarantineRows.push(row);
      quarantineSourceCardIds.add(card.card_id);
    } else {
      evidenceRows.push(row);
      safeSourceCardIds.add(card.card_id);
    }

    if (segment.safetyClass !== "standard" || formulas.length === 0 || dangerousRuntimePattern.test(row.text)) continue;
    for (const formula of formulas) {
      const items = runtimeByFormula.get(formula) || [];
      if (items.length < 3) {
        items.push({
          evidenceId: row.evidenceId,
          citation: row.citation,
          anchorLevel: row.anchorLevel,
          ...(row.clauseNumber ? { clauseNumber: row.clauseNumber } : {}),
          excerpt: cleanExcerpt(segment.text),
          tier: row.tier,
        });
        runtimeByFormula.set(formula, items);
      }
    }
  }
}

const sourceCardsRaw = readFileSync(sourceCardsPath);
const textualModificationRules = {
  schemaVersion: "tcm-textual-modification-rules-v2",
  advisoryOnly: true,
  automaticPrescriptionMutationAllowed: false,
  governance: {
    coveragePolicy: "高频首方必须至少有一条可回溯到安全证据行的受控加减规则；规则仅在患者触发词明确肯定时展示，禁止自动增删药味。",
    targetBaseFormulas: textualModificationTargetFormulaNames,
  },
  entries: textualModificationSeeds.flatMap((seed) => {
    const evidenceCandidates = evidenceRows.filter((row) =>
      row.safetyClass !== "quarantine" &&
      (seed.sourceEvidenceId
        ? row.evidenceId === seed.sourceEvidenceId
        : row.formulas.includes(seed.baseFormula)) &&
      seed.evidencePattern.test(row.text));
    const evidence = evidenceCandidates
      .sort((left, right) => {
        const tierRank = { canon: 0, common: 1, experience: 2 };
        const anchorRank = { tiaowen: 0, chapter_paragraph: 1, page_paragraph: 2 };
        return tierRank[left.tier] - tierRank[right.tier] ||
          anchorRank[left.anchorLevel] - anchorRank[right.anchorLevel] ||
          left.evidenceId.localeCompare(right.evidenceId);
      })[0];
    const moduleMatch = evidence ? null : stableShanghanMarkdown.match(seed.evidencePattern);
    if (!evidence && !moduleMatch) return [];
    const moduleLine = moduleMatch
      ? stableShanghanMarkdown.slice(0, moduleMatch.index).split(/\r?\n/).length
      : undefined;
    const {
      evidencePattern: _evidencePattern,
      sourceEvidenceId: _requestedSourceEvidenceId,
      ...entry
    } = seed;
    void _evidencePattern;
    void _requestedSourceEvidenceId;
    return [{
      ...entry,
      sourceEvidenceId: evidence?.evidenceId || `T15-STABLE-SHANGHAN-L${moduleLine}`,
      sourceCitation: evidence?.citation || `参考/nihaixia-StableV2026.5.23/modules/01_shanghan_sun.md:${moduleLine}`,
      evidenceAnchorLevel: evidence?.anchorLevel || "chapter_paragraph",
      tier: evidence?.tier || "common",
      requiresAffirmedPatientTrigger: true,
      requiresClinicianReview: true,
    }];
  }),
};
const coveredModificationFormulaNames = new Set(textualModificationRules.entries.map((item) => item.baseFormula));
textualModificationRules.summary = {
  ruleCount: textualModificationRules.entries.length,
  targetBaseFormulaCount: textualModificationTargetFormulaNames.length,
  coveredBaseFormulaCount: textualModificationTargetFormulaNames.filter((name) =>
    coveredModificationFormulaNames.has(name)).length,
  sourceAnchoredRuleCount: textualModificationRules.entries.filter((item) =>
    /^T15-/.test(item.sourceEvidenceId)).length,
};
if (
  textualModificationRules.entries.length < 51 ||
  textualModificationRules.summary.coveredBaseFormulaCount !== textualModificationTargetFormulaNames.length ||
  textualModificationRules.summary.sourceAnchoredRuleCount !== textualModificationRules.entries.length ||
  textualModificationRules.entries.filter((item) => item.baseFormula === "归脾汤").length < 4
) {
  const emittedRuleIds = new Set(textualModificationRules.entries.map((item) => item.id));
  const missingRuleIds = textualModificationSeeds
    .filter((item) => !emittedRuleIds.has(item.id))
    .map((item) => item.id);
  throw new Error(
    `T14 textual modification source gate failed: rules=${textualModificationRules.entries.length}, ` +
    `coverage=${textualModificationRules.summary.coveredBaseFormulaCount}/${textualModificationTargetFormulaNames.length}, ` +
    `missing=${missingRuleIds.join(",")}`,
  );
}

const caseFiles = readdirSync(stableCasesDir)
  .filter((name) => /^\d{2}_.+\.md$/.test(name))
  .sort();
const caseSourceBuffers = caseFiles.map((name) => ({
  name,
  content: readFileSync(resolve(stableCasesDir, name)),
}));
const canonicalFormulaAlias = (value) => {
  const compact = value.replace(/\s+/g, "").trim();
  return formulaAliases.entries.find((entry) =>
    entry.canonical === compact || entry.aliases.includes(compact))?.canonical || compact;
};
const markdownCaseField = (block, label) =>
  block.match(new RegExp(`^- \\*\\*${label}\\*\\*[：:][ \\t]*(.*)$`, "m"))?.[1]?.trim() || "";
const safeReplayInput = (block) => {
  const clauses = block
    .replace(/^- \*\*(?:日期|疾病|六经|方剂|患者)\*\*.*$/gm, "")
    .replace(/\*\*[^*]+\*\*[：:]?/g, "")
    .split(/[。！？\n；;，,]+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) =>
      item.length >= 6 &&
      item.length <= 500 &&
      caseNarrativeFactPattern.test(item) &&
      !caseNarrativeExclusionPattern.test(item) &&
      formulaHits(item).length === 0 &&
      !caseDoseOrInstructionPattern.test(item));
  const findings = [...new Set(clauses.flatMap((clause) =>
    replayClinicalFindingTerms.filter((term) => clause.includes(term))))];
  return findings.length >= 1 ? `已记录患者事实：${findings.slice(0, 16).join("、")}` : "";
};
const stableCaseBlockByTitle = new Map(stableYianMarkdown
  .split(/(?=^###\s+)/m)
  .flatMap((block) => {
    const title = block.match(/^###\s+(.+)$/m)?.[1]?.trim();
    return title ? [[title, block]] : [];
  }));
const fileCases = caseSourceBuffers.flatMap(({ name, content }) => {
  const text = content.toString("utf8");
  return text.split(/(?=^###\s+)/m).flatMap((block) => {
    const heading = block.match(/^###\s+(\d+)\.\s*(.+)$/m);
    if (!heading) return [];
    const title = heading[2].trim();
    const fullSourceBlock = stableCaseBlockByTitle.get(title) || block;
    const formulaNamesForCase = markdownCaseField(block, "方剂")
      .split(/[、，,；;]/)
      .map(canonicalFormulaAlias)
      .filter(Boolean);
    const containsQuarantinedContent =
      caseEvaluationQuarantinePattern.test(block) ||
      caseEvaluationQuarantinePattern.test(fullSourceBlock);
    const replayInput = safeReplayInput(fullSourceBlock);
    const replayFactCount = replayInput.split("、").filter(Boolean).length;
    return [{
      caseId: `T16-${name.replace(/\.md$/, "")}-${heading[1]}`,
      title,
      date: markdownCaseField(block, "日期") || null,
      diseases: markdownCaseField(block, "疾病").split(/[、，,；;]/).map((item) => item.trim()).filter(Boolean),
      sixChannels: markdownCaseField(block, "六经").split(/[、，,；;]/).map((item) => item.trim()).filter(Boolean),
      expectedFormulaNames: [...new Set(formulaNamesForCase)],
      containsQuarantinedContent,
      replaySanitizedFromQuarantinedSource: containsQuarantinedContent && Boolean(replayInput),
      replayInput,
      replayEligible:
        formulaNamesForCase.length > 0 &&
        replayInput.length >= 10 &&
        replayFactCount >= 2 &&
        !caseEvaluationQuarantinePattern.test(replayInput) &&
        !caseDoseOrInstructionPattern.test(replayInput),
      sourceRef: `参考/nihaixia-StableV2026.5.23/cases/${name}#${heading[1]}`,
      sourceType: "structured_case_file",
      tier: "experience",
    }];
  });
});
const moduleCases = stableYianMarkdown.split(/(?=^###\s+医案\d+)/m).flatMap((block) => {
  const heading = block.match(/^###\s+医案(\d+)(?:[：:]\s*(.+))?$/m);
  if (!heading) return [];
  const formulaNamesForCase = [...new Set(formulaHits(block).map(canonicalFormulaAlias))];
  const containsQuarantinedContent = caseEvaluationQuarantinePattern.test(block);
  const replayInput = safeReplayInput(block);
  const replayFactCount = replayInput.split("、").filter(Boolean).length;
  return [{
    caseId: `T16-COURSE-${heading[1]}`,
    title: (heading[2] || `闭门课医案${heading[1]}`).trim(),
    date: null,
    diseases: (heading[2] || "").split(/[、，,；;]/).map((item) => item.trim()).filter(Boolean),
    sixChannels: ["太阳", "少阳", "阳明", "太阴", "少阴", "厥阴"].filter((item) => block.includes(item)),
    expectedFormulaNames: formulaNamesForCase,
    containsQuarantinedContent,
    replaySanitizedFromQuarantinedSource: containsQuarantinedContent && Boolean(replayInput),
    replayInput,
    replayEligible:
      formulaNamesForCase.length > 0 &&
      replayInput.length >= 10 &&
      replayFactCount >= 2 &&
      !caseEvaluationQuarantinePattern.test(replayInput) &&
      !caseDoseOrInstructionPattern.test(replayInput),
    sourceRef: `参考/nihaixia-StableV2026.5.23/modules/03_yian.md#医案${heading[1]}`,
    sourceType: "course_case_block",
    tier: "experience",
  }];
});
// Generated corpus governance belongs in the generator, never as a hand edit to the JSON output.
// This source case's distilled replay input drops the decisive diabetes/postoperative-bleeding
// context and points at 附子汤 although the source is a 芍药甘草附子汤 case.
const caseReplayGovernance = new Map([
  ["T16-06_other-54", {
    replayEligible: false,
    dataQualityNote:
      "回放输入(失眠、苔黄)与期望方(附子汤)临床方向矛盾：源案为芍药甘草附子汤症(糖尿病/术后出血)，distill 元数据映射为附子汤，且芍药甘草附子汤不在受控目录；回放输入抽取丢失关键事实，暂不可用于治理回放。待构建器修复 safeReplayInput 后恢复。",
  }],
]);
const t16Cases = [...fileCases, ...moduleCases].map((item) => ({
  ...item,
  ...(caseReplayGovernance.get(item.caseId) || {}),
}));
const t16CaseCorpus = {
  schemaVersion: "tcm-classic-case-eval-corpus-v2",
  evaluationOnly: true,
  runtimeRetrievalAllowed: false,
  commentaryRemoved: true,
  safetyBoundary: "仅保留结构化标签和经逐句过滤的患者事实用于离线/授权回放；删除剂量、方名句、疗效承诺、反现代医学言论和可执行处置。",
  sourceClaimAudit: {
    claimedCaseCount: 849,
    importedDistinctStructuredBlocks: t16Cases.length,
    status: t16Cases.length >= 450 ? "target_met" : "source_material_below_claimed_target",
    note: "参考包可定位的结构化病例块少于文档宣称数量；不得复制或合成病例凑数。",
  },
  cases: t16Cases,
};

const mainEvidence = evidenceRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const quarantinedEvidence = quarantineRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const classicRuntime = {
  schemaVersion: "tcm-classic-formula-evidence-v1",
  advisoryOnly: true,
  safetyBoundary: "仅含去剂量后的标准级课程证据摘录；不得替代原典核验、面诊或确定性安全审方。",
  aliases: formulaAliases.entries,
  formulas: Object.fromEntries([...runtimeByFormula.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN"))),
};

const manifest = {
  schemaVersion: "nihaisha-fusion-manifest-v1",
  generatedAt: new Date().toISOString().slice(0, 10),
  sources: [
    {
      path: "参考/nihaisha-nishi-tcm-main/references/pdf-evidence/evidence-cards.jsonl",
      sha256: sha256(sourceCardsRaw),
      records: sourceCardCount,
    },
    {
      path: "参考/nihaisha-nishi-tcm-main/references/pdf-evidence/source-manifest.json",
      sha256: sha256(sourceManifestRaw),
      records: sourceManifest.length,
    },
    {
      path: "参考/nihaixia-StableV2026.5.23/SKILL.md",
      sha256: sha256(readFileSync(resolve(stableRoot, "SKILL.md"))),
    },
    {
      path: "参考/nihaixia-StableV2026.5.23/modules/01_shanghan_sun.md",
      sha256: sha256(Buffer.from(stableShanghanMarkdown)),
    },
    {
      path: "参考/nihaixia-StableV2026.5.23/modules/03_yian.md",
      sha256: sha256(Buffer.from(stableYianMarkdown)),
      records: moduleCases.length,
    },
    {
      path: "参考/nihaixia-StableV2026.5.23/cases/*.md",
      sha256: sha256(Buffer.concat(caseSourceBuffers.map(({ content }) => content))),
      records: t16Cases.length,
    },
    {
      path: "src/data/tcm-formula-governed-catalog.json",
      sha256: sha256(governedFormulaRaw),
      records: governedFormulaCatalog.entries.length,
    },
  ],
  evidence: {
    inputCards: sourceCardCount,
    mappedCards: new Set([...safeSourceCardIds, ...quarantineSourceCardIds]).size,
    mappedRecords: evidenceRows.length + quarantineRows.length,
    safeOrRestrictedRecords: evidenceRows.length,
    quarantinedRecords: quarantineRows.length,
    mixedSafetySourceCards: [...safeSourceCardIds].filter((cardId) => quarantineSourceCardIds.has(cardId)).length,
    shanghanUniqueClauseAnchors: shanghanClauses.size,
    shanghanCoverageOf398: Number((shanghanClauses.size / 398).toFixed(4)),
    jinguiAnchorPolicy: "chapter_paragraph_only",
    runtimeFormulaCount: runtimeByFormula.size,
    runtimeRetrievalPolicy: "full_record_scan_no_prebuilt_index",
    runtimeScannableRecords: evidenceRows.length,
  },
  caseCorpus: {
    records: t16Cases.length,
    quarantinedRecords: t16Cases.filter((item) => item.containsQuarantinedContent).length,
    replayEligibleRecords: t16Cases.filter((item) => item.replayEligible).length,
    runtimeRetrievalAllowed: false,
  },
  clinicalRuleCoverage: {
    ...fusionCoverage.requirements,
    formulaCompositionRules: {
      actual: formulaCompositionRules.entries.length,
      minimum: 35,
      passed: formulaCompositionRules.entries.length >= 35,
    },
    textualModificationRules: {
      actual: textualModificationRules.entries.length,
      minimum: 12,
      passed: textualModificationRules.entries.length >= 12,
    },
    contraindicationRules: {
      actual: contraindicationRules.rules.length,
      minimum: 10,
      passed: contraindicationRules.rules.length >= 10,
    },
  },
  reviewQueue: [
    ...fusionCoverage.reviewQueue,
    ...(t16Cases.length < 450 ? [{
      type: "source_case_count_gap",
      claimedMinimum: 450,
      importedDistinctStructuredBlocks: t16Cases.length,
      action: "需要补充原始病例索引或缺失病例文件；禁止复制、拆分或合成病例凑数。",
    }] : []),
  ],
  outputs: {},
};

const outputs = new Map([
  ["tcm-formula-aliases.json", JSON.stringify(formulaAliases, null, 2) + "\n"],
  ["tcm-differentiation-rules.json", JSON.stringify(differentiationRules, null, 2) + "\n"],
  ["tcm-formula-discrimination-graph.json", JSON.stringify(formulaDiscriminationGraph, null, 2) + "\n"],
  ["tcm-formula-composition-rules.json", JSON.stringify(formulaCompositionRules, null, 2) + "\n"],
  ["tcm-textual-modification-rules.json", JSON.stringify(textualModificationRules, null, 2) + "\n"],
  ["tcm-contraindication-rules.json", JSON.stringify(contraindicationRules, null, 2) + "\n"],
  ["tcm-classic-case-eval-corpus.json", JSON.stringify(t16CaseCorpus, null, 2) + "\n"],
  ["tcm-classic-text-evidence.jsonl", mainEvidence],
  ["tcm-classic-text-evidence-quarantine.jsonl", quarantinedEvidence],
  ["tcm-classic-formula-evidence.json", JSON.stringify(classicRuntime, null, 2) + "\n"],
]);
for (const [name, content] of outputs) {
  writeFileSync(resolve(outputDir, name), content);
  manifest.outputs[name] = { sha256: sha256(content), bytes: Buffer.byteLength(content) };
}
writeFileSync(resolve(outputDir, "nihaisha-fusion-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(JSON.stringify({
  inputCards: sourceCardCount,
  mappedCards: manifest.evidence.mappedCards,
  mappedRecords: manifest.evidence.mappedRecords,
  mixedSafetySourceCards: manifest.evidence.mixedSafetySourceCards,
  quarantinedRecords: quarantineRows.length,
  shanghanUniqueClauseAnchors: shanghanClauses.size,
  runtimeFormulaCount: runtimeByFormula.size,
  t16Cases: t16Cases.length,
  t16ReplayEligible: manifest.caseCorpus.replayEligibleRecords,
}, null, 2));
