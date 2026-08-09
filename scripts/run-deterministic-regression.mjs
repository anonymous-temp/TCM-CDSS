import { spawnSync } from "node:child_process";

const scripts = [
  "test:rxaudit-contract",
  "test:rxaudit-payload",
  "test:rxaudit-routes",
  // 审方风险的性别适用性裁剪（甲方生产实测 2026-08-04 缺陷2）。风险的适用人群几乎都是析取枚举
  // （出血倾向/月经期/抗凝状态、儿童/孕妇/经期妇女/年老体弱者），而下游只有一道按整格判定的
  // 性别净化——与性别无关的那一半被连坐，医生动作整格变成「本例男性不适用」。
  "test:rxaudit-sex-applicability",
  "test:safety-pediatric",
  "test:safety-mutations",
  "test:clinical-facts",
  "test:evidence-sentinel",
  "test:evimed-normalization",
  "test:local-patent-medicines",
  "test:patent-medicine-ranking",
  "test:upstream-guards",
  "test:authoritative-his",
  // HIS 分节标题咬合（甲方 2026-08-05 核对件多条「无此模块」的共同根因）。可见正文标题由受治理
  // 输出契约登记表驱动，HIS 投影却按另一份手工词表整行精确匹配抓取；「模块改名」一次就让
  // 6 个分组全部失配，诊断三卡与中成药卡在 HIS 里内容恒为空串。反直觉之处在于降级路径用的是
  // 旧标题、匹配依然成立——**只有报废输出能进 HIS，正常输出反而进不去**，因此长期无人察觉。
  "test:his-section-coupling",
  // HIS 对外投影的结构化字段（甲方 2026-08-05「一、接口缺失内容」9 条中的 6 条）。
  // 方义/组成逻辑/方证鉴别/经典条文、随证加减含可替换药味、中成药子字段、健康调护三段、
  // 西医待查依据、煎法细节——全部早已在内部契约生成、也进了 M04 sentinel，却一个都没进对外投影。
  // 断言口径刻意定为「甲方能不能从出参里拿到」，而不是「内部字段存不存在」：
  // 后者正是让这批缺陷连续躲过前几轮回归的判据。
  "test:his-structured-projection",
  // 可替换药味的确定性推导与安全边界（甲方 2026-08-05）。此前是假闭环：TS 字段与文档都加了，
  // 但 M04 提案 zod schema 未声明 substitutions，模型输出被 strip、编译器字面量也不带它，
  // 该字段从未产生过任何值。替代药一律不由模型提名——那等于让模型开药；候选由受治理数据推导，
  // 并逐条过硬边界：锚定最具体功效分类（否则半夏会被清化热痰的前胡替代，寒热方向相反）、
  // 风险不得升级（否则破血逐瘀的三棱会被当成活血止痛的川芎的同向替代）、
  // 药典剂量边界、十八反十九畏、管制毒性排除。
  "test:herb-substitutes",
  // 药品目录同步接口（甲方 2026-08-05「药品同步接口：缺少此接口」）。9 条接口缺失里唯一
  // **四环全缺**的一条。除接口存在性与分页/版本语义外，本套件的要害是「不得替医生做身份裁定」：
  // 499 条歧义别名（一包针 → 千年健/石韦）必须原样标为歧义，AUTO_PARSED_NEEDS_REVIEW 这类
  // 待复核状态必须原样保留——压平成单一正名或布尔，等于把待复核条目伪装成已确认条目。
  "test:drug-catalog-sync",
  // 院内药品库存导入与可得性标注（甲方 2026-08-05 药品同步的**入站**方向：把医院库存药导进来，
  // 开方时基于有货的药开）。本套件的要害不是「能不能导入」，而是**库存绝不能静默改方**——
  // 库存是可得性约束，不是临床正确性约束，与甲方对味数的口径同源（「如诊疗必须也不能裁剪」）。
  // 该用麻黄汤而院内没麻黄时，正确做法是标注缺货 + 给受治理替代候选，
  // 而不是悄悄换一味药：那会让医生看到的方与系统推理的方不是同一个，比缺货危险得多。
  // 另钉住「未导入库存时链路行为与接入前逐字节相同」——可得性不是安全控制，缺数据不得阻断出方。
  "test:drug-inventory",
  // 按组成反查经方（甲方 2026-08-05 R1「首选经方名，如确认无对应的经方，走自拟方」
  // + M5.2「该方为麻黄汤加味，展示为自拟方？」）。此前 restoreGovernedFormulaIdentity 只在
  // M03 已锁方名时进场，M03 判自拟就再没人回头看组成——系统认得麻黄汤，却从没按组成查过。
  // 本套件另钉住实现时真实踩过的两次误判：套用正向 80% 阈值会把麻黄汤识别成「桂枝汤加减」
  // （表实/表虚互斥对，比不识别严重）；纯按计数排序会选成「桂枝去芍药汤加味」
  // （基准味数与增味数完全相同，判别点是麻黄属安全定性药味、不能当普通增味）。
  "test:classic-formula-identification",
  // 自反不变量：受治理方的基准组成**原样当处方**喂回身份核验必须通过。不成立就意味着
  // M04 定向修复提示（「不重不漏输出基准全部药味」）在这些方上不可满足——模型照做也过不了，
  // 同码反复注入触发 fixpoint 早退，终点是「200 但没有候选方」的空白处方页。
  // 2026-08-05 给 ingredients 两侧过了受控解析表，requiredIngredients（锚点）漏了；
  // 锚点没过表不是更严而是恒假，实测 281/2062 方中招（柴胡疏肝散/三仁汤/八正散 皆在内），
  // 修掉后 281→1。遍历全目录而非抽样：这类缺陷的特征就是抽样看不出来。
  "test:formula-baseline-self-verification",
  // 核心药/可减药划分 + 按组成反查的减味兜底（甲方 5.2「该方为麻黄汤加味，展示为自拟方？」）。
  // 反查此前要求完整包含，缺一味即不认——全目录实测 2573 张方里只有 94 张（3.7%）在去掉
  // 一味非核心药后还认得出，其余医生看到的都是「本例辨证组方」。放宽阈值是上一轮踩过的坑
  // （麻黄汤被识别成「桂枝汤加减」），所以改成「哪一味不能减」有依据 + 分层兜底：
  // 核心药由 build:tcm-formula-core-herbs 从受控目录自动推导（塌陷判据自动算出「桂枝汤的白芍」
  // 「麻黄汤的桂枝」「七物浓朴汤的肉桂」），兜底层只在完整包含一无所获时启用。
  // 全目录对拍：原方识别 0 退步，加减方新识别 1141 张，0 丢失。
  "test:formula-core-herbs",
  // 归一层「单条非法不得连坐」结构性守卫。同族缺陷已复发 6 次，形态完全相同、只换字段：
  // 单条子治法 → 整个 therapy 变占位串；一条外治 → 整个 nonPharma 变 null（健康调护一起没）；
  // 8 条中成药坏 1 条 → 整栏 null；备选方少一个 dosesPerDay → 整份 M04 作废。
  // 门禁一直看不见的原因是 `.catch()` 让 safeParse **成功**，schema 码恒为 undefined——
  // 修复轮唯一的自动触发器对整个 .catch 家族是瞎的。本套件按行为判：注入「1 条非法 + N 条合法」，
  // 断言剩下恰好 N 条。新增数组字段必须加进它的 ISOLATED_ARRAYS。
  "test:reasoning-catch-isolation",
  // 饮片味数偏好 + 流派选择入参（甲方 2026-08-05 接口缺失 #1，标「高」，9 项里唯一没闭环的一条）。
  // 功能早已实现，但零回归覆盖，于是 between_10_15 的正则漏了 en dash 一直没人发现——
  // 而系统自己在 prompt 里印的就是「10–15 味」，甲方照抄回传，中间那一档静默失效。
  // 本套件另钉住两条**故意不同**的通道语义：味数只认 caseState 顶层，流派两条通道都生效；
  // 以及文档与实现同源（13 个流派 code 与 3 个味数取值必须在接口文档里列全）。
  "test:herb-count-preference",
  // 对外接口文档与真实出参的字段一致性。立闸的直接原因是同一类错犯了三次，且全都是「写完没实取」：
  // 中成药候选写成顶层 patentMedicines（实现中无此路径，甲方照文档取值必然取空）、
  // 随证加减写成 formula.candidates[].modifications[]（实际在 formula.modifications[]）、
  // M05 一节凭空写了 riskAssessment / followupTimeline 两个不存在的字段。
  // 本套件把文档里每条字段路径拿真实归档出参逐条取值，并强制「只在特定条件下出现的字段
  // 必须写明触发条件」——否则集成方取不到时会当成故障。
  // 另钉住甲方对可读性的三条反馈：字段表须带中文名列、不得逐行重复长路径、示例 JSON 必须可解析。
  "test:api-doc-field-parity",
  "test:formula-provenance",
  "test:classic-evidence-bundling",
  "test:syndrome-equivalence",
  "test:syndrome-hypothesis",
  "test:customer-dose-parity",
  "test:primary-care-50-safety",
  "test:snapshot-auth-binding",
  "test:lineage-governance",
  "test:tcm-treatments",
  // 治疗项目「适应证—方案」绑定（甲方生产实测 2026-08-04 缺陷1）。上一套断言的是项目**选谁**，
  // 本套断言的是选中之后**卡片说的适应证与卡片给的方案是不是同一个**——生产实测两者可以分叉：
  // 头痛病例写着"围绕头痛症状"却给失眠方的安眠/心俞，产后头痛的灸法写出本例没有的"经带与下腹症状"。
  "test:treatment-indication",
  "test:acupoint-evidence",
  "test:modern-case-corpus",
  "test:disease-lexicon",
  "test:runtime-data-presence",
  "test:pregnancy-recall",
  "test:warm-disease-rules",
  "test:clinical-decision-cards",
  "test:customer-evidence",
  "test:stage-contract",
  "test:m03-parallel-merge",
  "test:cdss-reason-codes",
  "test:clinical-vocabulary",
  "test:formula-syndrome-consistency",
  "test:formula-symptom-retrieval",
  "test:formula-discrimination-guard",
  "test:repair-guidance",
  // M04「重新生成候选方药」的跨请求恢复能力（甲方生产实测 2026-08-04 缺陷3）。
  // 生产上同一病例的第二次请求返回与第一次**逐字节相同**的失败页：编排层「同一修复提示重复注入
  // = 同一张失败彩票」的信条只在单次请求内生效，跨请求时修复计数/fixpoint/时限全部归零。
  "test:m04-retry-recovery",
  "test:therapy-vocabulary",
  "test:stage-outcome",
  "test:formula-selection-symmetry",
  "test:herb-name-resolution",
  "test:herb-breadth-surface",
  "test:m04-dose-index",
  "test:m04-safety-contract",
  "test:guard-symmetry",
  "test:rejection-tiers",
  "test:stream-safety",
  "test:stream-modules",
  "test:recorded-fact-visibility",
  "test:clinical-grounding",
  "test:inspection-lexicon",
  "test:clinical-entry",
  "test:clinical-terminology",
  "test:controlled-semantic-normalization",
  "test:clinical-governance-tables",
  // 单字残片（古籍抽取丢字/古文简写）不得拿到剂量豁免、不得被猜成真药、不得让整方可编译剂量。
  // 起因是豁免表按「哪些名字卡住了方剂」自动汇总，把 40 个残片收成了合法豁免成分，
  // 反过来放行含残片的方；构建脚本注释写了这条规则，代码从没实现。同时钉住两侧同集。
  "test:herb-name-identity",
  // 治法表述归一（L2 规则层）：同一病例重跑治法文字 100% 不同、概念集合 83% 不同。
  // 本层把同义写法折叠到同一受控条目，硬边界是**原本能命中的一律不得被改变**——
  // 第一版用自由子串包含，实测把「除湿通络止痛」引到「活血止痛」，那是语义漂移源。
  "test:therapy-phrasing",
  // M03 确定性后处理链的幂等性。finalizeM03CandidateForReview 的注释一直声称「第二遍是 no-op」，
  // 而「复核看到的字节 == 签名覆盖的字节」这条不变量、以及顺利路径上的 prepare 去重，都压在这句
  // 声称上。此前它没有任何断言：若某段变换不幂等，后果是复核通过之后仍发生临床内容静默改写。
  "test:m03-prepare-idempotence",
  // 透明降级：剥离器产出的形态必须恰好是合同放行口认得的形态。两处各写各的时，模型给出
  // 经典方名却把 formulaNames 留空这一整类形态会被判 formula_direction_drift，
  // 医生拿到 0 味。线上日志实测 44 次降级被拒里 26 次是这个码。
  "test:transparent-declassification",
  // 古籍摘录脱敏：单位与操作词的简繁两侧必须同集。原字符类全是简体，而语料本身是繁体，
  // 实测 2274 条运行期可达记录带着「三兩」这类具体剂量原样进 prompt。
  "test:classic-evidence-sanitizer",
  // 方名与自身记录组成的名实一致性裁定。目录里名实不符的小条目会在命名层以「完整包含」
  // 压过它所属的更大真方（归脾汤组成被命名为「理气化痰汤加减」）。反向护栏同样重要：
  // 取消资格只认 mismatched+high，unknown 一律不动——误取消一条正当条目等于少给医生一个方名。
  "test:formula-name-composition",
  "test:clinical-polarity",
  "test:negation-scope",
  "test:syndrome-name-standard",
  "test:formula-name-tiers",
  "test:formula-identity-restore",
  "test:governed-formula-lock",
  "test:phi-clinical-collision",
  "test:output-quality",
  "test:customer-review",
  "test:governed-data-reachability",
  "test:m03-entry",
  "test:m02-contract",
  "test:m02-nonblocking",
  "test:m02-answer-interpreter",
  "test:prescription-permission",
  "test:primary-care-50-contracts",
  "test:diagnosis-display",
  // 渲染层卫生（甲方评测 2026-08-04 呈现层四条）。其余套件断言的是 lib 层函数的返回值，
  // 这一套把归档的真实 M03/M04 产出重新投影、用 react-dom/server 渲染成静态 HTML，
  // 再对**医生实际看到的文本**断言：内部工程记号、方义解析长度、病机节内不重复、旧组件零残留。
  // 「函数绿 + 页面错」只有这一套拦得住。
  "test:visible-output-hygiene",
  "test:icd10-coding",
  "test:reasoning-signature",
  "test:model-rate-limit",
  "test:stage-telemetry",
  "test:m03-clinical-review",
  // 甲方 2026-08 复测「临床四条」：西医依据混入就诊经过 / 病名鉴别缺失 / 病位缺主症锚 /
  // 治法方向无病例绑定。四条都锁在受治理数据上（GB/T 15657 病名编码、症状—病位映射、
  // GB/T 16751.3 治法编号），因此必须与它们一起回归——词表升级若改了编码层级，本套件先红。
  "test:clinical-four-binding",
  // 主症/兼症未分主次（甲方 2026-08-04 复测）。与上一条同源但**不是同一个病**：那一条问
  // 「这个治法方向有没有节点撑着」，本条问「主症与兼症谁居首、谁主导选方」。产后头痛例里
  // 安神确有节点撑着，上一条放行是对的，主次仍然颠倒。判据同样锁在受治理数据上
  // （主症词族 + GB/T 16751.3 治法族编号 + 句序偏移），并钉住生产原始载荷。
  "test:chief-complaint-primacy",
  // 甲方 2026-08-04 复测「呈现层六条」。共同点是都发生在**渲染边界之后**：结构化载荷信息齐全，
  // 医生看到的那一页却把它拼错了（方义列表被表格单元格渲染口压成一行）、压扁了（逐味模板句）、
  // 或根本没分类（依据不分支持/排除/待查）。lib 层套件断言函数返回值，拦不住这一类。
  "test:presentation-contract",
  "test:nihaisha-fusion",
  "test:nihaisha-replay",
  "test:prompt-injection",
];

const startedAt = Date.now();
// Defense-in-depth: suites must pin their own audit config. Scrub inherited RXAI_AUDIT_* shell
// overrides (e.g. a small RXAI_AUDIT_TOTAL_TIMEOUT_MS) so they cannot leak into child processes.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("RXAI_AUDIT_")),
);
for (const [index, script] of scripts.entries()) {
  console.error(`[deterministic] ${index + 1}/${scripts.length} ${script}`);
  const result = spawnSync("npm", ["run", script], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(JSON.stringify({ script, status: result.status, signal: result.signal }));
    process.exit(result.status || 1);
  }
}

console.log(JSON.stringify({ suites: scripts.length, failures: 0, elapsedMs: Date.now() - startedAt }, null, 2));
