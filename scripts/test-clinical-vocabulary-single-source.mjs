// 临床词表单一来源守卫(2026-08-04)。
//
// 这是「再也测不出来这类问题」的机制本体:临床语义判断所需的词表必须来自受治理词表
// (经 build:clinical-vocabulary 生成、由 clinical-vocabulary.ts 读取),代码里**新增**手写
// 中文词表一律在此失败。存量条目登记在 ALLOWLIST 并附审核理由与迁移计划;不在名单上的
// 新增手写词表 = 回归红灯。
//
// 为什么必须用测试强制而不是靠约定:手写表与受治理词表必然漂移,漂移的表现就是一个个临床
// 缺陷(方向判错、人群误伤、等价判 0 分)。逐个修永远修不完——下一个人还会手写下一张表。
// 只有让「新增手写词表」这个动作本身失败,这一类才真正终结。
//
// 判据(只认几乎必然是词表的形态,不误伤文案):
//  A. 模块级 const 的**正则字面量**里含 ≥3 个由 | 分隔的中文候选(典型词表正则);
//  B. 模块级 const 的**数组/Set 字面量**里含 ≥4 个纯中文字符串元素。
// 文案(模板串、返回消息、错误文本)不满足这两种形态,不受限制。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/lib", "src/app"];
const CJK = "\\u4e00-\\u9fa5";

/**
 * 存量豁免。每条必须写明「为什么现在不能迁」——豁免不是免死金牌,是待办清单。
 * 新增条目需要同时说明为什么该词表无法归入受治理来源。
 */
const ALLOWLIST = new Map([
  ["src/lib/diagnosis-safety.ts", "确定性安全层(红旗/危急值)的保守下限词表。它是安全底线而非临床语义判断,且必须独立于任何可被上游数据变更影响的来源——受治理词表若漏收一个急症词,红旗就会静默失效。迁移前需先为安全词表建立带 sourceRef 的独立受治理来源与双向回归钉。"],
  ["src/lib/clinical-state.ts", "临床状态极性词汇(否认/未见/可能)。属于**语言学**层而非中医术语层,受治理词表不覆盖。待建 tcm-polarity-lexicon.source.json 后迁移。"],
  ["src/lib/clinical-polarity.ts", "同上:极性/否定的语言学词表。"],
  ["src/lib/cdss-vocab.ts", "报告章节标题词表(呈现层锚点),不参与临床判断。"],
  ["src/lib/medicine-clinical-concepts.ts", "中成药临床概念表,已是集中的单一来源文件,形态上等价于受治理词表;待与 build 流程对齐后并入生成物。"],
  ["src/lib/tcm-lineages.ts", "学术流派卡片文案与受控标签,已集中且带来源标注。"],
  ["src/lib/diagnosis-prompts.ts", "提示词正文(给模型的规范说明),是文案不是判断词表。"],
  ["src/lib/diagnosis-stage-contract.ts", "结构化合同的驳回码文案与少量结构判据;临床语义部分已改读 clinical-governance-tables 生成物,剩余为文案。迁移需逐条区分,列为下一轮。"],
  ["src/lib/diagnosis-visible-summary.ts", "医生可见正文的渲染文案。"],
  ["src/lib/tcm-knowledge.ts", "知识库读取层的字段名与单位词。"],
  ["src/lib/clinical-facts.ts", "语义事实回补的 schema 字段与文案。"],
  ["src/lib/m02-question-contract.ts", "追问模板文案。"],
  ["src/lib/m04-proposal-compiler.ts", "M04 编译期的结构校验文案。"],
  ["src/lib/rxaudit.ts", "灵犀审方接口的字段映射与文案。"],
  ["src/lib/diagnosis-types.ts", "类型定义中的受控枚举字面量(君/臣/佐/使 等),是 schema 不是词表。"],
  ["src/lib/tcm-formula-provenance.ts", "方剂出处解析的结构词(《》括号等)与文案。"],
  ["src/lib/tcm-treatment-projects.ts", "受控治疗项目目录标签,已是集中来源。"],
  ["src/lib/tcm-treatment-capabilities.server.ts", "治疗项目方案文案。"],
  ["src/lib/his-scheme.ts", "HIS 交付载荷的字段与文案。"],
  ["src/lib/prescription-output-safety.ts", "处方正文清洗的结构模式(空白模板残片),是形态判据不是临床词表。"],
  ["src/lib/clinical-warning-tier.ts", "警示分级文案。"],
  ["src/lib/tcm-syndrome-hypothesis.ts", "证候假设层的轴映射;其数据源已是受治理词表,剩余为结构判据。"],
  ["src/lib/tcm-formula-indications.ts", "召回层的结构判据与文案;临床轴已迁至 tcm-formula-axis-score + clinical-vocabulary。"],
  ["src/lib/diagnosis-parse.ts", "sentinel 与章节解析的结构锚点。"],
  ["src/lib/diagnosis-api.ts", "编排层的进度文案与驳回码。"],
  ["src/lib/diagnosis-engine.ts", "客户端流程胶水的文案。"],
  ["src/lib/his-prescription-validation.ts", "HIS 写回校验文案。"],
  ["src/lib/evidence-source-validation.ts", "证据来源白名单(机构名),是来源治理不是临床词表。"],
  ["src/lib/cdss-evidence-context.ts", "证据检索上下文的组装文案。"],
  ["src/lib/controlled-semantic-normalization.ts", "受控术语归一层,其词表本就来自受治理词表。"],
  ["src/lib/controlled-semantic-normalization.server.ts", "同上(服务端)。"],
  ["src/lib/tcm-formula-axis-score.ts", "轴方向侧集合(COLD_SIDE/HEAT_SIDE 等)是受控 nature id 的**英文**闭集,不含中文词表;人群中文词已于 2026-08-04 迁出。"],
  ["src/app/diagnosis/DiagnosisClient.tsx", "前端呈现文案与交互提示。"],

  // ── 语言学层(否定/极性/主语/占位):中医术语词表不覆盖,待建 tcm-linguistic-lexicon.source.json ──
  ["src/lib/clinical-entry.ts", "TODO-迁移:CLINICAL_NEGATION 等否定词。属语言学层,受治理中医术语表不含;待建语言学词表来源后迁移。"],
  ["src/lib/polarity-negation-assist.server.ts", "TODO-迁移:口语否定线索词。同上语言学层。"],
  ["src/lib/medication-event-extractor.ts", "TODO-迁移:家属主语词(区分患者自述与家属代述)。语言学层。"],
  ["src/lib/prescription-revision.ts", "TODO-迁移:编辑占位符词。语言学/呈现层。"],
  ["src/lib/diagnosis-client-guards.ts", "占位符与未生成态判据,呈现层结构判据不是临床词表。"],
  ["src/lib/clinical-output-authority.ts", "AMBIGUOUS_PLAIN_TERMS 是**工程术语**黑名单(前端/后端/权重/槽位),防止内部词汇泄漏到医生正文;与临床词表无关。"],
  ["src/lib/m04-modification-safety.ts", "加减动作句式(加入/加用/新增),语言学层。"],
  ["src/lib/tcm-therapy-phrasing.ts",
    "治法表述归一层。命中的是**语气虚词**（兼以/佐以/为主/为法）与繁简字对——汉语功能词，" +
    "GB/T 16751.3 里本来就没有也不该有，与 clinical-polarity.ts 同属语言学层。" +
    "该层的**临床**部分刻意没有写成词表：疗效目标词（止痛/止呕/退黄…）原为 27 词手写白名单，" +
    "已改为数据驱动——判据是「剥掉尾部两三字后能否命中受治理表」，能命中即说明剩余部分本身" +
    "是受控治法、被剥掉的是目的而非治法本体。这样既无需手写清单，也随受治理表一起演进。" +
    "待建 tcm-linguistic-lexicon.source.json 后与上列 TODO-迁移 项一并迁出。"],

  // ── 结构/呈现锚点:判据是文本形态而非临床语义 ──
  ["src/lib/customer-evidence.ts", "证据行标签锚点(证据依据/来源依据…),解析结构不是临床词表。"],
  ["src/lib/m03-diagnostic-review.ts", "服务端固定文案的回读判据(判断某段是否为服务端确定性生成),与文案同源维护。"],
  ["src/lib/result-display-policy.ts", "风险呈现分级的文案模式。"],
  ["src/lib/clinical-governance-tables.ts", "本身即受治理生成物(clinical-governance-static-tables)的读取层,其词表来自生成物;文件内剩余为结构判据。"],
  ["src/lib/followup-safety-net.ts", "随访动作词(复诊/急诊/转诊)。属临床动作而非证候术语;待受治理疗法词表补充动作维度后迁移。"],
  ["src/lib/clinical-evidence-display.ts",
    "呈现层的「可鉴别四诊事实」排序启发式。原样迁自 DiagnosisClient.tsx(该文件以「前端呈现文案」豁免在册)——" +
    "2026-08-10 上提到 lib 是为了让 Markdown 与 HIS 两个出口消费同一个谓词,词表内容一字未改。" +
    "它**不创造也不判断**任何临床事实:输入只能是已签名载荷里已经选定的事实,输出只是这些事实的排序与去重。" +
    "漂移的后果止于「哪条依据排在前面」,不改变任何结论。待建呈现层词表来源后与 DiagnosisClient 条目一并迁出。"],
  ["src/lib/emergency-clearance-contract.ts",
    "急症排查确认的**客观证据模态词**(心电图/复测/转诊交接…)。与 followup-safety-net 的动作词同类:" +
    "它判断的是「医生这句留痕有没有指向一件做过的事」,不对患者做任何临床判断,也不参与证候/方药语义。" +
    "刻意与受治理词表**解耦**的理由与 diagnosis-safety.ts 相同——这是安全边界:该表短于实际时结果偏严" +
    "(不解除急诊约束),而上游数据变更绝不能让它变松。待与安全词表一并建立带 sourceRef 的独立受治理来源。"],
  ["src/lib/herb-target-contract.ts", "君臣佐使等 schema 枚举字面量,不是可漂移词表。"],

  // ── 真正的中医术语层:已确认待迁移,列入下一轮 ──
  ["src/lib/herb-decoction-rules.ts", "TODO-迁移:煎服法词(先煎/后下/另煎/包煎)。应建 tcm-decoction-method.source.json 归口。"],
  ["src/lib/local-patent-medicine-candidates.ts", "TODO-迁移:中成药剂型后缀(片/胶囊/颗粒…)。应从受治理中成药目录的 dosageForm 字段派生。"],
  ["src/lib/tcm-formula-contraindications.ts", "TODO-迁移:TCM_AFFIRMED_STATE_TERMS(小便不利/饥而不欲食…)是古方主治状态词,应并入受治理证候/症状词表。"],
  ["src/lib/tcm-seasonal-care.ts", "二十四节气边界表(小寒/大寒/立春…)是历法常量,不随临床数据变化;其病性词已从 nature 词表读取(见 GOVERNED_NATURE_ENTRIES)。"],
  // tcm-constants.ts 已于 2026-08-13 删除（全仓零引用的死模块，TONGUE_TAGS 等从未被消费）。
  ["src/lib/tcm-classic-inference.ts", "TODO-迁移:与 tcm-formula-contraindications 同源的古方主治状态词表(两处重复正是漂移风险的证据),应一并并入受治理症状词表。"],
  ["src/lib/tcm-classic-evidence.server.ts", "经典方运行时同名药材消歧串(百合|合欢),是解析消歧不是临床判断词表。"],
  ["src/lib/tcm-followup-dimensions.ts", "六维随访问句模板(睡眠/食欲/大便…),是**问诊文案**不是判断词表:它只用于生成给医生看的随访问题,不参与任何语义匹配。"],

  // ── 2026-08-12 打开内联正则检测后新增的一批。逐条读过内容后按性质登记 ──────────────
  // 这批与上面几类同源，只是此前写成内联表达式、A/B 两条判据都看不见。
  ["src/lib/clinical-fact-source.ts",
    "病历**传输格式**的段落标题前缀（`现病史：`『舌象：』…）。它判的是「这一行有没有字段标题」，" +
    "不是临床语义；同一组标题由 diagnosis-safety 的 trustedInputText 逐行写出，两处同源维护。"],
  ["src/lib/clinical-terminology.ts", "诊断名的**修饰语**前缀（慢性/急性/原发性/一期…）与病名归一形态判据，属术语规范化层，不判临床事实。"],
  ["src/lib/diagnosis-stream-safety.ts", "流式净化的**剂量与煎服法字面形态**锚点（数值+单位、水煎服/冲服），是文本形态判据。"],
  ["src/lib/evimed-guide.ts", "外部证据接口的**返回体结构**锚点（批准文号形态、占位题名、章节标题）。方名串用于定位检索结果段落，不做临床判断。"],
  ["src/lib/formula-discrimination-guard.ts", "方名**后缀**剥离（加减/加味/化裁），是方名归一不是证候判断。"],
  ["src/lib/formula-syndrome-consistency.ts", "同上：方名后缀剥离，供受治理目录查名。"],
  ["src/lib/icd10-diagnosis-coding.server.ts", "诊断文本的**前后缀**清洗（『西医诊断：』前缀、『待排』后缀），编码前的字符串归一。"],
  ["src/lib/m02-question-review.server.ts", "追问复核的**语法**判据（存在/否认/是否…），语言学层，与 clinical-polarity 同类。"],
  ["src/lib/m04-deterministic-fallback.ts", "兜底文案里的妊娠人群与『依据不足』占位判据，人群词应随受治理人群表迁移（与 clinical-entry 同批 TODO）。"],
  ["src/lib/medicine-candidate-planner.server.ts", "中成药**剂型后缀**（片/胶囊/颗粒…），与 local-patent-medicine-candidates 同一条 TODO：应从受治理目录 dosageForm 派生。"],
  ["src/lib/phi-sanitizer.ts", "PHI 去标识的**职业类别**词。它服务于脱敏而非临床判断；表短于实际时结果偏严（多脱敏一点），方向安全。"],
  ["src/lib/prescription-regimen-contract.ts", "服法与复诊节点的**数量/时间字面形态**（每日N剂、第N天复诊），结构解析。"],
  ["src/lib/tcm-acupoints.ts", "特定穴类别名（五输穴/合穴/输穴…）——腧穴目录自带的分类字段取值，属目录结构不是判断词表。"],
]);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

// A: const X = /…中文|中文|中文…/ —— 三个及以上中文候选的正则
const VOCAB_REGEX = new RegExp(
  `^\\s*(?:export\\s+)?const\\s+\\w+[^=\\n]*=\\s*/[^/\\n]*[${CJK}]+[^/\\n]*\\|[^/\\n]*[${CJK}]+[^/\\n]*\\|[^/\\n]*[${CJK}]+`,
  "m",
);
// B: const X = ["中文","中文","中文","中文"…] / new Set([...]) —— 四个及以上纯中文元素
const VOCAB_ARRAY = new RegExp(
  `^\\s*(?:export\\s+)?const\\s+\\w+[^=\\n]*=\\s*(?:new\\s+Set\\s*\\(\\s*)?\\[[^\\]]*(?:"[${CJK}]{1,10}"|'[${CJK}]{1,10}')[^\\]]*(?:,[^\\]]*(?:"[${CJK}]{1,10}"|'[${CJK}]{1,10}')){3,}`,
  "m",
);

// C: 内联正则 —— 不写成 const、直接嵌在表达式里的中文候选表（2026-08-12）。
//
// 甲方线上实测①：红旗证据 chips 只印「恶心、呕吐」，漏掉「爆裂样」「数秒达峰」「颈项僵硬」。
// 那条判据是写在 `value.match(/突发…(?:最剧烈|爆炸样|雷击样)…头痛|(?:恶心|呕吐)|…/g)` 里的
// **内联**正则——A 判据要求 `const X = /…/` 的模块级常量形态，看不见它。
// 手写词表的危害与它写成什么形态无关，判据不该被形态绕开。
const INLINE_VOCAB_REGEX = new RegExp(
  `(?:^|[=(,:!&|?[{;]|=>|\\breturn\\b|\\.(?:test|match|replace|replaceAll|split|search|exec)\\()\\s*` +
  `(/(?![*/])(?:[^/\\\\\\n]|\\\\.)*[${CJK}](?:[^/\\\\\\n]|\\\\.)*/[gimsuy]*)`,
  "g",
);
const INLINE_ALTERNATION = new RegExp(`[${CJK}][^|/\\n]*\\|[^|/\\n]*[${CJK}][^|/\\n]*\\|[^|/\\n]*[${CJK}]`);

function strippedComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

function inlineVocabularyHits(source) {
  const found = [];
  const text = strippedComments(source);
  INLINE_VOCAB_REGEX.lastIndex = 0;
  let match;
  while ((match = INLINE_VOCAB_REGEX.exec(text))) {
    if (INLINE_ALTERNATION.test(match[1])) found.push(match[1].slice(0, 120));
  }
  return found;
}

const offenders = [];
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const rel = file.replace(`${process.cwd()}/`, "");
    if (ALLOWLIST.has(rel)) continue;
    const source = fs.readFileSync(file, "utf8");
    const hitRegex = VOCAB_REGEX.test(source);
    const hitArray = VOCAB_ARRAY.test(source);
    const inline = inlineVocabularyHits(source);
    if (hitRegex || hitArray) {
      offenders.push({ rel, form: hitRegex ? "regex-vocabulary" : "array-vocabulary" });
    } else if (inline.length > 0) {
      offenders.push({ rel, form: `inline-regex-vocabulary ×${inline.length}：${inline[0]}` });
    }
  }
}

assert.deepEqual(
  offenders, [],
  `发现新增的代码内手写临床词表(必须改走受治理来源):\n${offenders.map((o) => `  ${o.rel} [${o.form}]`).join("\n")}\n` +
  `修法:把词表放进 src/data/*.source.json(带 basis 与 sourceRef),在 scripts/build-clinical-vocabulary.mjs 里生成,` +
  `运行时经 src/lib/clinical-vocabulary.ts 读取。若确实无法归入受治理来源,在本文件 ALLOWLIST 登记并写明原因与迁移计划。`,
);

// ── 安全呈现面：不受任何豁免（2026-08-12）──────────────────────────────────────
//
// 上面那张 ALLOWLIST 把 DiagnosisClient.tsx 整个文件以「前端呈现文案」为由豁免了。
// 但甲方①那条正则**不是文案**，它是一道决定「医生看不看得到某条红旗证据」的临床筛选器：
// 病历写「突然出现剧烈头痛，呈爆裂样…颈项僵硬」，它只印出「恶心、呕吐」，
// 而且一旦命中任意片段就整体丢弃完整原话。危害发生在**急诊转诊卡片**这一屏上。
//
// 所以在按文件的判据之外，另立一条按**函数**的判据：决定红旗/急症证据呈现内容的这几个
// 构建函数，函数体内一个中文候选正则都不许有。豁免表管不到这里——文件可以因为满是文案
// 而被豁免，但这几个函数不行。
const SAFETY_PRESENTATION_BUILDERS = [
  ["src/app/diagnosis/DiagnosisClient.tsx", "buildEmergencyPresentation"],
];

function functionBodyOf(source, name) {
  const start = source.search(new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

const safetyOffenders = [];
for (const [rel, name] of SAFETY_PRESENTATION_BUILDERS) {
  const source = strippedComments(fs.readFileSync(path.join(process.cwd(), rel), "utf8"));
  const body = functionBodyOf(source, name);
  assert.ok(body, `找不到安全呈现面构建函数 ${rel}#${name}——它被改名或删除了，本条判据会静默失效`);
  for (const hit of inlineVocabularyHits(body)) safetyOffenders.push(`${rel}#${name}：${hit}`);
  // 模块级常量形态同样不许（把词表挪到函数外再引进来，等于换个地方写）。
  if (VOCAB_REGEX.test(body) || VOCAB_ARRAY.test(body)) safetyOffenders.push(`${rel}#${name}：模块级形态的候选表`);
}
assert.deepEqual(
  safetyOffenders, [],
  `安全呈现面里出现了手写中文候选表——医生看到哪条红旗证据不得由关键词表决定：\n  ${safetyOffenders.join("\n  ")}\n` +
  `红旗证据应原样呈现规则/语义分诊**实际匹配到的原话**（按分句切分即可），不做关键词抽取。`,
);

// 生成物自检:任一维度塌成 0 说明生成器或上游词表坏了,不能静默通过。
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const vocab = await jiti.import("../src/lib/clinical-vocabulary.ts");
const counts = vocab.clinicalVocabularyCounts();
for (const key of ["locations", "natures", "syndromeAxes", "population_maternal", "population_obstetric", "population_pediatric", "population_geriatric", "population_broad"]) {
  assert.ok((counts[key] || 0) > 0, `派生词表维度 ${key} 为空——生成器或上游受治理词表异常`);
}
assert.ok(counts.syndromeAxes > 1000, `证候轴映射仅 ${counts.syndromeAxes} 条,远低于受治理词表规模,疑似生成异常`);

// 迁移正确性:人群口径必须保持「宽 maternal ⊋ 严格 obstetric」,否则冲突减分会误伤通用经典方。
const maternal = new Set(vocab.populationScopeForms("maternal"));
const obstetric = vocab.populationScopeForms("obstetric");
assert.ok(obstetric.length > 0 && obstetric.every((form) => maternal.has(form)),
  "胎产严格口径必须是妇产宽口径的子集(OBST-01 的前提)");
assert.ok(maternal.size > obstetric.length, "宽口径必须真包含严格口径,否则两者等价、减分会误伤性别中立经典方");

// 轴分解可用性:受治理词表自带的分解必须真的能用(这正是各模块手写映射时重复造的轮子)。
const axes = vocab.governedSyndromeLabelAxes("心脾两虚证");
assert.ok(axes.locations.length + axes.natures.length > 0, "常见复合证候必须能分解出轴");

console.log(JSON.stringify({ scannedRoots: ROOTS, allowlisted: ALLOWLIST.size, offenders: offenders.length, ...counts }));
