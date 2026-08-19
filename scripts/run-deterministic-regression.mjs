import { spawnSync } from "node:child_process";

const scripts = [
  "test:rxaudit-contract",
  "test:rxaudit-payload",
  "test:rxaudit-cache",
  "test:rxaudit-routes",
  // 审方风险的性别适用性裁剪（甲方生产实测 2026-08-04 缺陷2）。风险的适用人群几乎都是析取枚举
  // （出血倾向/月经期/抗凝状态、儿童/孕妇/经期妇女/年老体弱者），而下游只有一道按整格判定的
  // 性别净化——与性别无关的那一半被连坐，医生动作整格变成「本例男性不适用」。
  "test:rxaudit-sex-applicability",
  "test:safety-pediatric",
  "test:safety-mutations",
  // 上消化道警示征象：吞咽/进食梗阻、恶性肿瘤病史伴消化道症状、不明原因消瘦。
  // 钉 2026-08-13 鲁棒性压测实测的漏检——胃癌术后进食困难10月余加重7天，redFlags 为空、
  // 按普通「胃气壅滞」出方。根因是 M02 逐条追问这些征象、确定性门一条都接不住。
  // 套件里那条「M02 问句点名的征象必须接得住」的断言是防漂移的根，别删。
  "test:gi-alarm-features",
  // 红旗剂量授权开关：钉 2026-08-15 审查抓到的两件事——①旧 advise 档下
  // 6 岁儿童 + 红旗实测给出 full_dose（儿科硬边界被红旗分支的提前返回整条跳过）；
  // ②后一版改成无条件 non_dose 后开关彻底失效（三档输出一字不差）、无法回滚。
  // 本套件同时验「开关起作用」与「独立硬边界不受开关影响」，缺一不可。
  "test:redflag-dose-authorization",
  // 方证鉴别图的词位分离。钉 2026-08-15 实测的自证加分：病历里写「太阳伤寒」，
  // 麻黄汤从第6名 score=1 跳到第1名 score=2——医生已下的判断被当成患者症状再给对应方加分。
  // 同时钉反向边界：「发汗后腹胀满」是坏病病程的可观察事实（该方原始指征），不得按
  // 「像不像治法」误剔；复合词「少阳病往来寒热」必须拆而不删，可观察余部要回填评分位。
  "test:formula-term-roles",
  // 复核不可用原因码。钉 TCMEval-SDT 194 例实测：18 例 unavailable（均分 13.48% vs
  // accepted 组 20.34%），attestation 里只有 status 与 reviewedPayloadHash，无原因码，
  // 无法区分超时/上游报错/契约不合法/未配置。根因是 execution.reason 算出来即丢弃——
  // 与同文件 independentFromGenerator 曾经的毛病同形，同一个函数第二次。
  "test:clinical-review-reason",
  // 主证串分段归位。钉 194 例实测：157/194 把多段塞进 primarySyndrome、184/194 兼证为空。
  // 关键是别按逗号一拆了之——用国标词表逐段判定后，83 例是真并列证候（该外移到兼证），
  // 69 例是证候+病机结果（该进病机链），直觉修法会把后者做错。
  // 另钉一条已知局限：措辞变体（痰湿上蒙 vs 痰蒙清窍证）会被误归病机——宁可少认不可多认。
  "test:primary-syndrome-segmentation",
  // 编排时钟起点。钉 194 例实测：病例4 209.5s、病例148 202.0s 越过 M03 的 180s 时限。
  // 根因不是时限失效，是时钟起晚了——M04 路由在顶部记 orchestrationStartedAt 并传下去，
  // M03 根本没传，于是 180s 从临床事实回补（三次模型调用）跑完之后才计，
  // 总耗时变成「事实准备 + 180s」≈210s，冲出浏览器 210s 余量、被切成 HTTP 0。
  // 同一处修复只做了一半。断言的是**顺序关系**，不是「代码里有这一行」。
  "test:orchestration-clock",
  // 十八反(HIGH,硬门档) / 十九畏(MEDIUM,提示档) 分档。钉 2026-08-13 实测：
  // highRiskPairRules() 里一行 severity!=="HIGH" 把十九畏 28 条对所有出口隐藏了
  // （数据本身齐全、别名已展开、药名 100% 可解析）。放开时必须保持硬门口径逐字不变——
  // findTcmHerbPairIncompatibilities 同时喂着整方作废的驳回码，一把放开就成了硬拦。
  "test:herb-pair-tiering",
  // 口语化表述的确定性红旗覆盖。2026-08-13 鲁棒性专项实测：19 条口语急症表述里 13 条零红旗。
  // 本轮修掉并钉住时间窗最紧的两类——急性卒中口语（线上确定性与语义层双 0）与消化道出血口语。
  // 里面那条「服用铁剂后大便发黑，无头晕乏力」的反例钉的是另一个真误报：
  // 严重度伴随症被整句否认，判据却当阳性证据用。
  "test:colloquial-redflag",
  // 上面那条的收口：剩下六类口语零检出（心血管/神经/呼吸/晕厥/儿科/中毒）一次性做完，
  // 口语档位一律对齐其「同义且已命中」的书面兄弟，不自己发明档位。
  // 顺带查出两处结构性缺陷，比补词重要：
  //  ① 儿童判据四处各写各的，唯独安全提示那处漏了结构化年龄分支——patient.age=4 的患儿
  //     只要文本没在分句开头写「患儿」就一条儿童危重提示都没有。已收敛为 isPediatricPatient。
  //  ② 急性线索后置的语序整类漏检，书面语一起漏：「复视、行走不稳，今天突然出现」红旗 0。
  // 对照集里那 10 条常规主诉是本套件的另一半：躺不平/垫高枕头/冒虚汗/没精神/摔倒在地/
  // 不吃不喝都是常规门诊写法，直觉加词会把整类抬成红旗，删这些反例等于放开误报。
  "test:colloquial-redflag-parity",
  // 质量分档表必须在**两道校验点**都被读到。此前 shouldAcceptWithQualityAnnotation
  // 全文件只调用一次（编排校验、客户输出变换之前），变换之后的 finalize 校验直接走兜底、
  // 不查分档表——于是 T2 只要拖到 finalize 才暴露，分档表注释里声称的「带批注放行」就不存在。
  // 线上实证：一份复核已通过（reviewStatus=accepted, 2 轮）、病机治法俱在的 M03，
  // 只因证候名写法不合国标（primary_syndrome_name_nonstandard，T2）被整页清空。
  "test:m03-finalize-quality-tier",
  // 客户输出净化器的子句边界只认句号分号、不认逗号：一处未接地否定会把同句内的真实病机
  // 一并替换掉（「热邪炽盛，未见黑便，未见呕血，热盛迫津」→ 只剩两句对冲）。
  // 本套件把当前缺陷行为钉成已知缺陷，变红说明有人改了净化器——请确认改的方向是
  // 「保留同句内的非否定部分」，而不是放宽否定式检测（后者是安全要求，不得取消）。
  // 另钉：不含未接地否定的稳定病机必须逐字保持、豁免不得外溢到接地断言字段、净化必须幂等。
  "test:sanitizer-contract-preservation",
  // 中医师终审裁定（CLINICIAN-REVIEW-20260816）的落地校验。这批含三条**推翻工程侧原判断**的裁定：
  //  ①虫白蜡/颠茄草药典词条根本没有【功能与主治】、只有【用途】——工程侧原报「切不开」是错误诊断；
  //  ②败酱草既非小蓟也非菥蓂、也不是败酱，是独立规范实体，原歧义是本地别名汇总造成的假歧义；
  //  ③冬葵子与冬葵果是同植物不同药用部位，功效不同，不得自动替换。
  // 另钉麦芽三规格互异（生/炒/焦药典分列）——补充表必须在归一前按原名生效，
  // 否则「生」被前缀剥离表剥掉、退回麦芽总述（「焦」不在该表内所以侥幸没错，是巧合不是规则）。
  // 反向断言：未经裁定的歧义名（芍药/贝母）不得被顺手放开。
  "test:clinician-herb-adjudications",
  // 跨厂商 M03/M04 复核 与 临床事实复核相位必须独立。线上实证（2026-08-16）：
  // 把 PRIMARY_CLINICAL_REVIEW_PROVIDER 设成 bailian-qwen 后跨厂商复核确实生效
  // （independentFromGenerator=true），但 independentFactsReviewModel 把同一变量
  // 一并当成本相位开关、直接判 unconfigured，三相位 AND 出 ok=false，
  // health?strict=1 塌成 strictReady=false——而 Docker healthcheck 打的正是那个口，
  // 容器进入 health: starting 并重启。两个本该独立的能力被一行做成了互斥。
  // 保留 fail-closed 默认（不静默回落主模型），显式设 CLINICAL_FACTS_REVIEW_MODEL 才放行。
  "test:cross-provider-facts-decoupling",
  // T8′②b①：m03_chain_incomplete 六轮不收敛。两条独立缺陷叠在一起：
  //  ①【真根因】UNSTABLE_REASONING_MARKER 的「(不|未|无)…定」分支把气滞主症
  //     「痛无定处」「走窜不定」读成「无法确定」。模型写进 patientFact 的是病历原文，
  //     判据把原文判为不稳定 ⇒ chain_incomplete ⇒ 重写 ⇒ 还是原文 ⇒ 再判，怎么改都过不了。
  //     整个气滞证类别的病机链都可能因此建不起来。只豁免这四类固定搭配，真对冲词判定不变。
  //  ②【使它无法自愈】驳回码只回笼统的 chain_incomplete，而 m03ChainNodeDiagnostics
  //     早就逐节点算着四项标志位、只进日志不进修复提示词——模型不知道卡在哪，只能整条重写。
  //     与 contextualCandidates 同一条 doctrine：不指出目标的修复指令是不可执行的。
  //     明细只带字段名与节点序号，绝不回显 patientFact 原文。
  "test:chain-incomplete-repair-targeting",
  // 缺陷形状系统扫描（2026-08-16）确认并收敛的两处「同一判据两处各写各的」：
  //  ① L4 确定性阻断：药味级与病例级两条正则只差「严禁|禁止使用」。实测同一句
  //     「本品严禁与含乌头类药材同用」药味级 L4（阻断）、病例级 L0（常规信息，仅展示）——
  //     差 4 个档位，一条明确禁用语在病例级被当成常规信息。已收敛为单一常量。
  //  ② 心血管慢性稳定降级只巡查 6 个受治理症状里的 3 个。契约是「所有心血管提及都慢性稳定」
  //     才降级，漏检向：慢性稳定 + 未枚举的急性症状并存时，那个急性症状从未被检查过；
  //     误报向：纯口语「胸口疼」不在枚举内，稳定性心绞痛每次复诊都弹红旗。已收敛为读受治理表。
  // 否定式对照（未发现十八反/已排除绝对禁忌/未见配伍冲突）钉住收敛不得放宽既有排除。
  "test:duplicated-safety-predicates",
  // 上一条钉的是「判据只有一份来源」（源码形状）；这一条钉的是**行为**——
  // 分支老老实实读了表，仍可能因上游合取条件永不成立而一个字都不出，源码级断言看不见。
  // 实测（2026-08-17）：13 个受治理症状词写进病历后红旗/提示/待评估三个出口全静默，
  // 其中「休克」「脓毒症」「高渗状态」是诊断级结论词，另有「喉头水肿 vs 喉头肿胀」
  // 「阴道出血 vs 阴道流血」这类一字之差的分叉。全部源于 narrativeFallbackAdvisories
  // 的行内字面量与 redflag-triage-lexicon 各写各的。已让 6 个分支改读表。
  // 两层断言：组合层按词表自身 scopeNote 的组合规则（不做无差别笛卡尔积），
  // 裸词层带 13 条逐条写明理由的豁免（胃脘痛/腹痛是门诊第一高频主诉，表的 qualifiers
  // 明确要求限定词——裸词即报等于每个病人都弹红旗）。豁免过期会自动报错逼人删除。
  "test:governed-redflag-reachability",
  // 同一形状的第三例，且**被判错过一次**：2026-08-16 扫描把「剂型后缀表两处各一份」
  // 记为「属药名归一、非安全门控，影响低」而推迟——那是读源码得出的判断。
  // 补测推翻：身份归一喂 verifyMedicationSemanticCoverage 的同药状态冲突判据，
  // rxaudit 那份缺「混悬滴剂」「胶囊剂」，于是
  //   「现服阿莫西林胶囊，阿莫西林已停用」 → medication_status_conflict ✓
  //   「现服布洛芬混悬滴剂，布洛芬已停用」 → 静默通过 ✗（混悬滴剂是儿科布洛芬标准剂型）
  // 教训：「两份表只差几个词」不能靠读代码判影响，要问这几个词喂给了谁。
  "test:medication-identity-convergence",
  // 77 案预检实测：阴道出血21天、量多、血色素66g/L，因词序不是「阴道大量出血」而零红旗。
  // 钉住阴道出血 × 量多/持续/重度贫血/循环灌注组合，并守住否定、旧史、少量点滴的反例。
  "test:major-vaginal-bleeding",
  "test:clinical-facts",
  "test:evidence-sentinel",
  "test:evimed-normalization",
  "test:local-patent-medicines",
  "test:patent-medicine-ranking",
  "test:upstream-guards",
  // 主文本模型支持 DeepSeek/Qwen 双家族，但端点、凭据和厂商私有参数必须由单一策略层塑形。
  "test:text-model-tuning",
  "test:authoritative-his",
  // HIS 分节标题咬合（甲方 2026-08-05 核对件多条「无此模块」的共同根因）。可见正文标题由受治理
  // 输出契约登记表驱动，HIS 投影却按另一份手工词表整行精确匹配抓取；「模块改名」一次就让
  // 6 个分组全部失配，诊断三卡与中成药卡在 HIS 里内容恒为空串。反直觉之处在于降级路径用的是
  // 旧标题、匹配依然成立——**只有报废输出能进 HIS，正常输出反而进不去**，因此长期无人察觉。
  "test:his-section-coupling",
  // 流派做实（2026-08-13，甲方基线 §10.2「流派不能只是一个提示词标签」）。四条机制钉：
  // ①未终审零影响——全 pending 数据下展示重排必须是恒等变换；②展示层加分不得跨
  // 「正向充分性×可编译」层上移、幅度必须低于单个证候标签权重；③锁定路径隔离——
  // retrieveTcmFormulaCandidatesForReasoning 与 systemLockable 所在函数体按源码断言不得出现
  // lineage 词根（自动锁方读的就是那份原始返回序）；④三出口（Markdown/页面/HIS）必须共用
  // displayableLineageAdaptation 同一可展示判据，未选流派或空壳内容三处一致不渲染。
  "test:lineage-affinity",
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
  // 医生端只消费项目的具体内容、穴位与频次；模板状态、来源等级、资质和安全闸门仍留在后台治理对象。
  "test:tcm-treatment-clinician-view",
  // 治疗项目「适应证—方案」绑定（甲方生产实测 2026-08-04 缺陷1）。上一套断言的是项目**选谁**，
  // 本套断言的是选中之后**卡片说的适应证与卡片给的方案是不是同一个**——生产实测两者可以分叉：
  // 头痛病例写着"围绕头痛症状"却给失眠方的安眠/心俞，产后头痛的灸法写出本例没有的"经带与下腹症状"。
  "test:treatment-indication",
  "test:acupoint-evidence",
  // 普通咳嗽·风寒袭肺证的精确证型模板闸门（中医师 2026-08-11 已签字启用）。
  // 甲方线上实测「风寒咳嗽给出承灵、孔最、肩中俞，缺列缺、风池」的两层根因：
  // 「流清涕」先命中 upper_airway 抢在 respiratory 前；目录里根本没有普通风寒咳嗽模板。
  // 裁定不许调全局标签优先级，改为前置闸门（当前咳嗽事实 + 已签名风寒袭肺，显式排除流感/恢复期/风热）。
  // 套件钉住裁定点名的 7 条回归 + 「闸门仅限针刺项目」「频次不得照搬流感方案」
  // 「未登记进台账的闸门模板不启用但不静默」「带闸门的模板不得从常规按病名通路被选出」。
  "test:common-cough-template",
  // 同一条特性的**端到端**验证。纯函数套件打的是判据，这一套打的是**接线**：
  // currentFacts 有没有一路传到闸门（传成 caseFacts 会让「既往咳嗽」把病例带进来）、
  // 条件加穴有没有真的进 suggestedSitesOrPoints、签字后三个状态字段是不是同一个判据。
  // 它上线当天就抓到一个纯函数套件看不见的真缺陷：带闸门的模板同时也是普通 respiratory 模板，
  // 常规按病名通路可以绕过闸门把它选出来（风热咳嗽拿到了风寒证取穴）。
  "test:cough-template-e2e",
  // 结构化随访时间轴的模型驱动契约（甲方 2026-08-12：「别做成套话和固定话术和硬编码」）。
  // 改造前整张表只有 indicators 是模型写的、两条目还共用同一份；action 两条写死、
  // time 第二条恒为「治疗期间随时」、triggers 主体恒为一句固定话术——
  // 风寒表证与湿热淋证拿到的时间轴逐字相同。套件钉住：四栏都真的用模型的、
  // 审方安全触发条件只增不减、第一条时间点与正文同源、三条降级路径完全不走模型。
  "test:followup-timeline",
  // 西医诊断依据分组（甲方 2026-08-12 线上实测原样贴出的那一屏）：
  // 「神清，表情痛苦」同时出现在症状依据与体征依据；「其他四诊/问诊补充：畏光」把病历
  // 传输格式的段落标题当成了依据内容。前者根因是医生页面拿**全量**支持依据覆盖了 symptom 分组——
  // 分类在服务端算得完全正确，是出口又一次各写各的。判据含源码级守卫，防同形复发。
  "test:western-evidence-grouping",
  // 交付副本与源文档同步（甲方对接人 2026-08-12 连续两轮复核暴露）：
  // 接口文档已按新字段改好，但甲方读的是**飞书导入版**——那是生成器产物，
  // 我改完源文档没重跑生成器，于是对方看到的一直是旧字段，而我这边「文件明明改了」。
  // 判据不是"字段对不对"，是"产物是不是源文档的当前产物"：重跑生成器逐字节比对。
  "test:delivery-doc-freshness",
  "test:prompt-evidence-budget",
  "test:modern-case-corpus",
  "test:disease-lexicon",
  "test:runtime-data-presence",
  // 甲方线上实测（0811）第 12 条：health 接口把各阶段模型名、厂商、修复轮模型、reasoning_effort、
  // 超时毫秒数、上游探针原文与阶段遥测整个摊开。对外视图收窄为"只删不改"，
  // 同时钉住 build.commit / sourceDigest / strictReady 必须存活——它们是部署核验的证据来源。
  // 甲方线上实测（0811）：「指南引用要能点开看原文」。url 一直在载荷里、服务端 Markdown 也一直在印，
  // 医生页面拼展示串时丢了第三段——同一份数据两个出口各写各的。判据钉在共享投影上，
  // 并禁止出口自拼 `${entry.citation}（…）`：那正是分叉的起点。
  "test:guideline-reference-outlets",
  "test:diagnostic-citation-contract",
  "test:tcm-diagnostic-citations",
  "test:western-differential-citations",
  "test:diagnosis-citation-presentation",
  "test:health-public-view",
  // 甲方线上实测（0811）第 11 条：资料还没录全的病例，「需优先补充」把头颅 CT/经颅多普勒
  // 与"问病程"并列。分级函数早就写好，调用点在 851e4d76 被连带删掉成了死代码。
  // 该套件同时钉住「展示策略导出不得无人调用」——这才是它静默失效却全绿的那一层。
  "test:suggested-check-tiering",
  "test:pregnancy-recall",
  "test:patient-relevant-medication-risk",
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
  // 药味功效串的跨药串味（甲方 2026-08-11 线上实测：石决明被解释成「祛风止痒」）。
  // 身份目录把石决明与千里光登记成互为别名，上游按别名图把菊科草药的功效整段贴到了鲍鱼壳上。
  // 这类污染此前完全隐形——功效串是自由文本，没有任何断言看它属不属于这味药。
  "test:herb-function-contamination",
  // 国家药典委员会 2020 版一部功效正文治理批次：84 味逐条带词条 id、原文和来源 URL。
  // 离线闸门钉住“只取功能段、不跨身份分叉、受控治法可重算”，并直测僵蚕/地龙不再落方义占位。
  "test:chp-herb-functions",
  // 77 条回归病案从忽略目录迁入受治理源：20 条保留公开网页出处，57 条来自已签 replay 池。
  // 套件钉住数量、来源锚、PHI/金标准泄漏边界、病种多样性、三条真实红旗与确定性层一致。
  "test:robustness-cases",
  // 线上回归判据本身也是发布资产：请求级语义筛查超时不能冒充患者缺口；患者事实缺口仍须逐项
  // 回显。M04 只对传输/截断/无契约类失败做有上限、有留痕的恢复，不重试安全降级路径。
  "test:robustness-live-assertions",
  // TCMEval-SDT 四任务评测适配器：固定官方数据提交和哈希，金标准只在生成后评分，
  // 生产 M03 请求不得携带十选项或答案；同时逐式复现论文 Task 1/2/3/4 与总权重。
  "test:tcmeval-sdt",
  "test:herb-breadth-surface",
  "test:m04-dose-index",
  "test:m04-safety-contract",
  "test:guard-symmetry",
  "test:rejection-tiers",
  "test:stream-safety",
  "test:stream-modules",
  "test:stream-module-frames",
  "test:recorded-fact-visibility",
  "test:clinical-grounding",
  "test:inspection-lexicon",
  "test:clinical-entry",
  "test:clinical-terminology",
  "test:controlled-semantic-normalization",
  // 单个 M03/M04 阶段内部会扇出主生成、双腿术语共识与临床复核。线上两案并发时，两个阶段
  // 同时扇出使 provider 长时间无响应，public-091/public-092 的 M04 均越过医生端 210s 预算。
  // HTTP 请求仍可并行并持续收到心跳，但昂贵阶段按 FIFO 容量闸排队；取消/截止必须移出队列，
  // 正常完成与 fail-closed 完成都必须幂等释放，避免一个断开的请求永久堵住后续病例。
  "test:abortable-capacity-gate",
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
  // 可复用检索层（BM25F + 中文分析器）与首个迁移场（药材知识库检索）。
  // 要害不是「排得更好」而是三条不变量：每味药自名可检出（695/695 零缺失）、
  // 无意义查询仍 0 结果（打分化最典型的 fail-open 是「总能给出分数最高的一条」）、
  // 精确名命中仍置顶 score=100。迁移边界见 docs/检索层迁移清单-20260809.md：
  // 只改已过准入闸的候选池内部排序，绝不改准入线（改成 top-N 会让「查不到」永不可达）。
  "test:retrieval-bm25",
  // 书籍语料入库治理（甲方 2026-08-09 决定集成，版权由甲方负责）。钉的不是「过滤跑过了」，
  // 而是过滤之后仍必须成立的四条：危险内容零漏出、脱敏后剂量零残留、
  // tier=book 排在受治理来源之后、以及**未命中方名仍返回空**——
  // 新增语料最典型的 fail-open 就是把「查不到」变成「查到一条不相干的」。
  "test:book-corpus-evidence",
  // 身份核验专用的药味替代（党参/太子参 → 人参）。目录记古方原文用药（497 首含人参），
  // 而现代临床普遍以党参代之——实测处方用党参 15.1% vs 人参 7.3%，导致香砂六君子汤、
  // 四君子汤这类常用方因「缺人参」拿不到方名。本套件钉的不是「多认出几个方名」，
  // 而是四条线：只在身份核验生效（绝不进同药异名表，党参与人参剂量/安全各归各）、
  // 方名含「参」字者不适用（独参汤/参附汤回阳固脱）、无替代药时保持拒绝、
  // 方义承重药缺失（二陈汤缺半夏）不得放行。
  // 红旗表达覆盖（2026-08-09 审计实测复现后修复）。三类漏检共用一个形状：判据按「完整词」
  // 穷举，而中文不这么构词。① 程度词插在部位与症状之间——「突发右下腹剧痛」「脘腹剧烈疼痛」
  // 「少腹急痛，停经40天」全部零红旗（阑尾炎/异位妊娠典型主诉）；② 同一概念的中医写法是另一套
  // 词——认得「口角歪斜」不认得「口眼歪斜」，认得「肢体无力」不认得「半身不遂」，这是个中医
  // CDSS，后者才是医生实际会写的；③ 妊娠判据在安全层自写了一份 /孕\d+(?:周|月)/，
  // 于是 BP170/112+剧烈头痛写「孕32周」有重度子痫前期红旗、写「孕妇」零红旗——
  // 而 clinical-state 里早有覆盖口语写法且带否定排除的受治理谓词，现已收敛过去。
  // ④ 否定作用域跨逗号：「否认糖尿病，胸痛今日新发」零红旗，删掉那句无关否认就正常。
  // 反向断言同等重要：否认列举仍须是否认、轻症慢病不得升级、非妊娠语境不得触发产科红旗。
  "test:redflag-expression-coverage",
  // 把判断交回模型 + 确定性层只做校验（2026-08-10）。本仓库是 LLM 驱动的临床副驾驶，
  // 不是规则推理引擎；这两处此前被规则架空：
  // ① 极性层单向——中医里「无汗/不渴/不恶寒」是证候的定义性指征而非「没有该症状」，
  //    风寒表实教科书主诉「恶寒发热，无汗，头痛，身痛，脉浮紧」召回侧只剩 3 条事实，
  //    无汗被剥掉、头痛身痛被它的作用域顺着逗号带走。规则层分不了「四诊指征」与
  //    「系统回顾式否认」，改为模型裁决但关进受治理 68 词闭集，两次校验、只返回序号。
  // ② 方义被无条件覆盖——兜底句永远非空，模型写的 function 100% 被丢弃；当前代码在 7461 条
  //    归档药味行上重放，35.4% 印的是零内容套话，而这 2638 条里 KB 无条目的是 0 条。
  //    改为校验（复用合同侧 herbFunctionMatchesKnowledge 同一谓词）而非覆盖。
  // 反向断言与正向同重：审方 scope 必须完全忽略阳性增补、编造的高影响方向必须被驳回、
  // 空裁决必须与今天逐字相同、剥名时必须说出 M03 原锁定的方名且不得凭空捏造。
  "test:llm-adjudication-boundaries",
  "test:herb-identity-substitution",
  // 药味品种歧义层 + 目录条目级校勘通道（2026-08-09）。三件事各钉一半：
  // ① 甲方口径「后世同名方既有赤芍本也有白芍本，都算数」——但**只对证据到不了原文的方**放开
  //    （裸属名 / 方义推断 / 版本分叉），原书明载品种的方写反了必须判否。实测 B 表：
  //    模型 4 次把四物汤写成赤芍、1 次把痛泻要方写成赤芍，静默接受等于帮着藏处方错误。
  // ② 「医师定量」豁免表混进了 117 处身份分叉链接，放行 93 首方——与单字残片那次同一个
  //    自我授权闭环（豁免表按「哪些名字卡住了方剂」自动汇总，于是卡住它的东西自己拿到了豁免）。
  //    分叉链接 canonicalName 为空，十八反/特殊人群/毒性全按规范名索引，对每道检查都隐形。
  //    判据是「歧义且无规范名」而非「status=ambiguous」：白蜜已解析到蜂蜜，拦它没有安全收益。
  // ③ 章节题被抽取程序压成单方（37 味、51 味，含单字残片）。中医师核过的 2 条删除并拆成
  //    36 首具名子方；结构同类但未逐条回源的 23 条只取消资格不删除。拟名与外治法不得命名处方。
  "test:formula-variety-and-collation",
  "test:clinical-polarity",
  "test:negation-scope",
  "test:syndrome-name-standard",
  "test:formula-name-tiers",
  // HIS 契约版本协商：V1 只回旧两态（第三态向保守侧折叠）、tailoringStatus 恒为真实值、
  // V2 才开放真三态。钉的是「不要求甲方为我们新增的枚举值临时改代码」。
  "test:his-contract-version",
  "test:formula-identity-restore",
  // 经方可追溯率的三条根因：出处判官与身份判官各写各的、恢复身份不写出处、
  // 恢复发生在可见正文重建之后（页面说自拟方、载荷说经方名）。50 例实测页面可追溯 5/39。
  "test:formula-traceability",
  "test:governed-formula-lock",
  "test:phi-clinical-collision",
  "test:output-quality",
  "test:customer-review",
  // 甲方 2026-08-10 复核清单：急症排查确认的内容判据、symptoms 自由文本、方义占位句与修复轮、
  // 证型配穴、指南依据回写契约、依据排序三出口同源、加减风险提示、复核措辞拓扑一致、库存分片。
  "test:customer-review-20260810",
  "test:client-feedback-20260817",
  "test:governed-data-reachability",
  "test:m03-entry",
  "test:m02-contract",
  "test:m02-nonblocking",
  "test:m02-answer-interpreter",
  "test:prescription-permission",
  "test:primary-care-50-contracts",
  "test:diagnosis-display",
  // 甲方 2026-08-12：页面把内部口径词（知识库/受治理）印给了医生。
  // 判据落在源码字符串字面量上，扫医生页面/服务端 Markdown/HIS 三个出口，不是抽样看输出。
  "test:doctor-vocabulary",
  // 渲染层卫生（甲方评测 2026-08-04 呈现层四条）。其余套件断言的是 lib 层函数的返回值，
  // 这一套把归档的真实 M03/M04 产出重新投影、用 react-dom/server 渲染成静态 HTML，
  // 再对**医生实际看到的文本**断言：内部工程记号、方义解析长度、病机节内不重复、旧组件零残留。
  // 「函数绿 + 页面错」只有这一套拦得住。
  "test:visible-output-hygiene",
  "test:icd10-coding",
  "test:reasoning-signature",
  "test:model-rate-limit",
  "test:stage-telemetry",
  "test:knowledge-telemetry",
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
