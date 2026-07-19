<!-- 由多智能体设计工作流(6维度设计→3重对抗式审查→整合)生成，已经人工校订入库并按 2026-07-03 会话决策定稿。生成日期 2026-07-03。-->
<!-- 定稿说明：本文件为「已定稿」，非增量补丁。凡与更早草稿冲突处，一律以本文为准；不使用「本节覆盖前文」式打补丁语气。核心架构决策：安全权威 100% 来自服务端确定性路径（本地处方前门 + 灵犀审方），V2 结构化 JSON 为纯展示层（Option B），安全判定绝不读取模型 JSON。 -->

# 中医CDSS V2 迭代方案（总架构师定稿）

> 本方案基于对真实代码的逐行勘探（`diagnosis-parse.ts`、`diagnosis-api.ts:94/181-231`、`diagnosis-safety.ts:355-390/513-793/815-868`、`tcm-knowledge.ts:643-717/1137-1154`、`rxaudit.ts:60-288`、`his-scheme.ts:105-135`、`post-prescription-risk/route.ts`、`diagnosis-prompts.ts`、`diagnosis-types.ts`）落地，已吸收三份对抗式审查全部 blocker/high 修复项，并按本会话锁定的 11 项决策改写受影响处。凡审查指出、代码验证为真的问题（`finish_reason` 从未被读、`buildPostPrescriptionRiskSection` 在非 dose-like 处方上 `return ""` 静默无风险、`buildAuditData` 强依赖 Markdown 药表、`sanitizeCaseStateForModel` 白名单式逐字段脱敏会漏放新字段、`isPlaceholderContent` 中文正则决定 adoptable、`detectModelRedFlags`/`sectionText` 强绑定标题正则），本方案均给出可执行的封堵。

---

## 0. 目标与设计原则

### 0.1 目标
在**不推翻现有 M01–M05 线性管线、不改 NDJSON 流式契约**的前提下：
1. 于 M03/M04 之上增加一层**纯展示用**的中医推理结构化结果层 `ClinicalReasoningResultV2`，把今天靠正则刮 Markdown 的结果页升级为读结构化字段驱动的六板块医生友好视图；
2. **重构审方架构**：本地弱审方引擎退役，灵犀（合理用药 V1.22）成为处方后审方的唯一权威，全链 fail-closed；
3. 引入 `node --test` 纯函数测试层（零新依赖），使安全关键纯函数机器可验证；
4. 清理死代码（EviMed 后端）与退役本地审方引擎（保留 KB 佐证）。

### 0.2 设计原则（贯穿全方案，任何 Phase 不得违反）

1. **增量而非重写**：V2 是 M03/M04 输出的结构化"补齐层"，复用现有 sentinel（`<!-- DIAGNOSIS_JSON_START/END -->`）与 `extractDiagnosisJSON`/`stripDiagnosisJSON`。Markdown 通道即兜底。

2. **安全铁律（Option B，不可动摇）**：**安全判定绝不读取 V2 模型 JSON。** 安全权威 100% 来自服务端确定性路径：
   - **处方前**：本地确定性门 `withSafetyGate`（红旗 / 生命体征 / 完整度）——保持现状不改判定逻辑；
   - **处方后**：灵犀审方（服务端、结构化 items[]、fail-closed）——本地审方引擎退役。
   V2 JSON 只驱动展示；它缺失 / 损坏 / 被截断 **不改变任何安全放行判定**。

3. **evidence-bound**：凡结论 / 药味 / 加减带 `evidenceLevel`+`source`；无来源 ⇒ `evidenceLevel:"insufficient"` 且 `source` 写"证据不足 / 待检索"。`evidenceLevel` **只是展示标注，安全判定绝不读取它**。

4. **fail-closed 不破**：模型 JSON 缺失 / 损坏 / 被截断 / 仅返回 reasoning_content ⇒ 展示层退回 Markdown 兜底，处方 `safetyLocked` 保持锁定；灵犀未启用 / 未配置 / 调用失败 / 返回 BLOCK ⇒ 一律强制"需药师人工复核"、绝不放开剂量级采纳；绝不退回本地弱引擎。绝不把"没拿到风险数据"当"无风险"。

5. **不新增数据库，浏览器短期保存可恢复工作区**：默认启用 `NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE=true`，仅在浏览器本机短期保存病历草稿与 AI 结果，避免关闭页面后病例与辅助诊疗结果丢失；可通过 `NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE=false` 显式关闭。`reasoningV2` / `tongueDx` 进入 CaseState；图像 / 音频不进入本地持久化，提交即清。

6. **单一真源治理**：所有跨维度共享的枚举、板块名、字段字典冻结为唯一来源（见 §1.6），杜绝审查发现的"多套不兼容词表"。

### 0.3 本会话锁定决策速览（定稿全文均已反映，冲突以此为准）

| # | 决策 | 落点章节 |
|---|---|---|
| 1 | 面部图像本轮不启用；Phase3 舌诊只做舌面+舌下，面部保持文字化 | §4, §9.1 |
| 2 | 引入 Node 内置 `node --test` 纯函数测试层（零新依赖） | §8 Phase5, §0.4 |
| 3 | M03 结构化只填到 `therapy`（`formula=null`）；M04 才补 `formula` | §1.1, §9.3 |
| 4 | 流派卡共 13 张 = 11 基础 + 攻邪(gongxie)/寒凉(hanliang)，本轮一起放开上线 | §3, §9.4 |
| 5 | 剂量可编辑但必须强制 post-prescription-risk（灵犀）重校后才能写回 | §6.6, §9.6 |
| 6 | 证据级别六档机读（deterministic_rule/kb_entry/guideline/classic_text/model_inference/insufficient），UI 侧再细化 | §1.2, §9.7 |
| 7 | 流式中安全板块占位用中性文案"确定性安全复核进行中" | §6.1, §9.8 |
| 8 | 审方架构=灵犀唯一权威 + fail-closed；删本地审方引擎在审方路径的使用；喂 V2 结构化 herbs → 灵犀 items[] | §7.2, §7.3 |
| 9 | 本地 695 味 KB 只砍审方引擎；tcm-knowledge.json + searchTcmKnowledge 保留作 M03/M04 用药佐证 | §7.6, §10 |
| 10 | V2 结构化 JSON = 纯展示层（Option B），永不作为任何安全判定输入 | §0.2, §7.1 |
| 11 | 清死代码：删 callEvimedStream + wrapEvimedBody + backend="evimed"；保留 EviMed 多源证据检索 | §10 |

### 0.4 本方案对两个原 Blocker 的处理（前置说明）

- **原 Blocker A（大 JSON 截断无处理）**：确认 `diagnosis-api.ts:94` 的 `finish_reason` 声明于 chunk 类型但从未被读、无 `max_tokens`。§6.2 给出截断检测 + 显式降级信号 + 强制安全受限处置（BLOCKER-3 修复），并新增回归用例。
- **原 Blocker B（安全关键纯函数无可验证测试路径）**：确认无单测框架（无 jest/vitest），回归套件是 HTTP 黑盒。§8 Phase5 引入 `node --test` 最小纯函数测试层（零新依赖，符合"无测试框架"约束），把"safetyLocked 派生""灵犀 items[] 构建""脱敏新字段"变为机器可验证断言，不依赖散文验收标准。

### 0.5 本会话安全复核（对抗式，已核对真实代码）必须闭合的问题清单

| ID | 问题（代码已验证） | 修复落点 |
|---|---|---|
| BLOCKER-1 | M03/M04 是纯流式透传，`withSafetyGate` 在"调模型之前"跑，服务端**没有**"流结束后解析模型 JSON→覆盖安全字段"的关口（那种覆盖只在 M01/M02 的 `consumeCollectStream`）。旧草稿把 V2 的"确定性覆盖模型"错误类比成 completeness 覆盖。 | §7.1：采用 Option B——安全判定根本不读 V2 JSON。删除"返回前覆盖模型 safety 字段"的伪代码。 |
| BLOCKER-2 | `buildPostPrescriptionRiskSection` 在处方非 dose-like 时旧路径可 `return ""` = 静默无风险 fail-open（`tcm-knowledge.ts:1137-1154` 已有部分兜底，但仍存在 `if (risks.length === 0) return ""` 尾）。 | §7.4：随本地审方引擎退役此路径消除；审方改灵犀 items[] 直发。过渡期任何本地风险展示：非空处方 + `allowDosePrescription` + 解析空 ⇒ 无条件输出"信息不足提示"，绝不空串。 |
| BLOCKER-3 | 截断形态是"人类可读 content 正常、末尾 sentinel JSON 被切一半"，此时 `contentChars>0`，`diagnosis-api.ts:231` 的 reasoning-only 判错不触发，流正常以 `[END]` 结束，截断处方原文被存进 `caseState.prescription`，无人关处方。 | §6.2：捕获 `finish_reason`、必设 `max_tokens`；截断或 sentinel 未闭合 ⇒ 用 `buildSafetyLimitedPrescription` 覆盖 `caseState.prescription` + 置 `safetyLocked` + 发截断信号帧。落到具体函数。 |
| HIGH-1 | `adoptable` 现由 `his-scheme.ts:111` `isPlaceholderContent` 的中文正则决定，医生润色占位文案即可翻转成可采纳。 | §6.5, §7.5：新增机读 `safetyLocked` 字段（由 gate + 灵犀派生），编辑层不可写；`item()` 里 `adoptable = safetyLocked ? false : ...`。 |
| HIGH-2 | 舌图 `needRetake` 重算只前端做则可被绕过。 | §4.3：`needRetake` 重算必须在服务端 `collect` 路由执行；坏图 ⇒ 服务端保证 `tongue`/`tongueImageDesc`/`tongueDx` 三者都不被该图结果写入。 |
| HIGH-3 | 标题正则不只 his-scheme 依赖，`diagnosis-safety.ts:365/376` 的 `detectModelRedFlags`/`sectionText` 也靠标题正则抓模型红旗。 | §1.6, §7.4：`SECTION_TITLES` 单一真源必须同时覆盖红旗抓取标题别名；回归断言"改标题后模型红旗行仍被 `detectModelRedFlags` 抓到"。 |
| MEDIUM-2 | `sanitizeCaseStateForModel` 是 `...state` 展开 + 白名单式逐字段脱敏（`diagnosis-safety.ts:815-868`），新增 `reasoningV2`/`tongueDx`/`wenzhen` 会被原样透传给模型 = PHI 漏。 | §5.3, §7.7：为 `tongueDx`（含 `summaryText` 与各 note）、`reasoningV2`（所有模型自由文本）、`wenzhen`（note）显式加 scrub 分支；回归断言含姓名的 `summaryText` 送模型前被脱敏。升为实现时必做项。 |
| MEDIUM-3 | 逐节展示降级不得影响安全路径。 | §7.1：Option B 下天然成立——V2 任何节解析成败都不改变安全放行判定。 |

---

## 1. `ClinicalReasoningResultV2` 数据契约（纯展示层）

> **关键定位（Option B）**：`ClinicalReasoningResultV2` 是**纯展示层结构**，永不作为任何安全判定的输入。它的每个字段都由模型自由填写；服务端 / 前端**不做**"用确定性值覆盖模型 JSON 内安全字段"的操作（那种关口在 M03/M04 根本不存在，见 §7.1）。安全信息（红旗、输出层级、剂量放行、审方结论）**独立**由确定性来源产出并**独立**渲染（§6.1 双通道 B 面 / §6.3 风险复核页），不经过 V2 JSON。

### 1.1 顶层结构

```jsonc
{
  "schemaVersion": "tcm-cdss-reasoning-v2",   // 常量；展示层据此判定走 V2 还是旧 Markdown
  "stage": "diagnose" | "prescribe",          // M03 填到 therapy；M04 补 formula
  "completeness": { /* 复用 CompletenessSchema，diagnosis-types.ts */ },
  "overview": Overview,
  "pathogenesis": PathogenesisReasoning,
  "therapy": TherapyPlan,
  "formula": FormulaPlan | null,               // M03=null（决策3）；M04 才补
  "nonPharma": NonPharmaPlan | null,
  "lineageAdaptation": LineageAdaptation | null
}
```

- **必填**：`schemaVersion`、`stage`、`overview`、`pathogenesis`、`therapy`。
- **可空**：`formula`（M03 阶段恒 null）、`nonPharma`、`lineageAdaptation`。
- **不含** `truncated`/`degraded`/`doctorReview`/`safety` 等字段：截断状态由 NDJSON 元帧独立传递（§6.2），降级状态由展示层局部计算（§1.8），医生复核 / 风险清单由确定性来源独立渲染（§6.3 风险复核页），不塞进模型 JSON。这是 Option B 的直接推论——**模型 JSON 里没有任何字段是安全判定的输入或输出**。

### 1.2 证据级别（唯一枚举，冻结——决策6）

六档机读枚举，UI 侧渲染中文标签并可再细化：

```jsonc
type EvidenceLevel =
  | "deterministic_rule"  // 确定性安全规则 / KB 命中（剂量上下限 / 十八反 / 特殊人群 / 相互作用）
  | "kb_entry"            // tcm-knowledge.json 知识库条目
  | "guideline"           // 指南 / 共识 / 药典 / 教材（须可核查，禁编造 DOI）
  | "classic_text"        // 方剂典籍出处
  | "model_inference"     // 模型推断（无外部来源，UI 标"需核查"）
  | "insufficient";       // 证据不足 / 待检索

interface EvidenceRef {
  evidenceLevel: EvidenceLevel;
  source: string;              // 来源或"证据不足 / 待检索"
  confidence?: "高" | "中" | "低";
}
```

**UI 渲染规则**（非色彩编码，图标+文字，见 §6.5 a11y）：`deterministic_rule`/`kb_entry` → "KB/规则依据"（高信度视觉）；`guideline`/`classic_text` → "文献依据（需核查）"；`model_inference`/`insufficient` → "模型推断 / 证据不足（待医生确认）"。**再强调：安全判定绝不读取 `evidenceLevel`。**

### 1.3 输出层级（展示用；权威来自 gate + 灵犀，不来自模型 JSON）

```jsonc
type OutputTier = "advisory_only" | "needs_doctor_review" | "no_auto_prescription";
```

`OutputTier` **不写入模型 JSON**。它由展示层从**确定性来源**独立计算并渲染于总览 / 风险复核徽章：

| 确定性来源信号 | OutputTier |
|---|---|
| `safetyGate.status==="red_flag"` | `no_auto_prescription` |
| `safetyLocked===true`（gate 或灵犀派生，见 §7.5） | `needs_doctor_review`（至少） |
| 灵犀 `audit_result∈{MANUAL_REVIEW,BLOCK}` 或 `highest_risk_level∈{HIGH,CRITICAL}` 或不可用 | `needs_doctor_review`（至少） |
| `safetyGate.status==="ready"` && `allowDosePrescription` && 灵犀 `PASS/REMIND` && 无强提示 | `advisory_only` |

### 1.4 剂量表示（冻结）

采纳 `string | null`：中医剂量常含"先煎""3-9g""adlib""冲服"等非纯数字表达。**注意：确定性剂量校验不再依赖此展示字段**——审方走灵犀 items[]，剂量数据由前端从结构化 herbs 直接构造 items[] 的 `single_dose`（§7.3），不解析 JSON dose 字符串、也不解析 Markdown。

### 1.5 板块子类型
`Overview`、`PathogenesisReasoning`、`TherapyPlan`、`FormulaPlan`、`HerbRow`、`ModificationRule`、`NonPharmaPlan`、`FormulaCandidate`、`LineageAdaptation` 全部定义于 `src/lib/diagnosis-types.ts`（TS interface + zod `ReasoningV2Schema`，逐节宽松解析）。

### 1.6 单一真源清单（治理，冻结）

新增 `src/lib/cdss-vocab.ts`（或集中于 `diagnosis-types.ts`），作为唯一导出：
- `EvidenceLevel` / `OutputTier` 枚举；
- **板块 / 章节名注册表 `SECTION_TITLES`**：把 V2 Markdown 兜底标题、结果页 Tab、`his-scheme.ts` 的 `section()`/`extractField()` 别名数组、以及 **`diagnosis-safety.ts:376` `detectModelRedFlags` 的红旗标题别名数组**（`["红旗排查","红旗指征","红旗风险","红旗预警","转诊评估"]`）统一为一处引用（HIGH-3）。
  - **硬约束**：任何新增 / 改名章节必须同步三处消费者：`his-scheme` 别名、`detectModelRedFlags` 红旗别名、Tab IA。配回归断言：(a) HIS payload 字段非空；(b) **改标题后模型红旗行仍被 `detectModelRedFlags` 抓到**（node --test，见 §8 Phase5）。
- `SAFETY_DEFERENCE_TEXT` 等安全常量文案与"占位"判定文案分离为常量。**但注意（HIGH-1）**：`his-scheme.ts:111` `isPlaceholderContent` 的文本正则不再是 adoptable 的权威判据——adoptable 改由机读 `safetyLocked` 派生（§6.5, §7.5），文本正则仅作展示兜底。

### 1.7 CaseState size 治理

新增 `reasoningV2?`/`tongueDx?`/`wenzhen?` 为可选字段，各挂 zod 级 size / field-count 上限，沿用 `MAX_MODEL_OUTPUT_CHARS=30000` 纪律。`normalizeCaseStateInput` 对超限结构 fail-closed 截断或丢弃，绝不让 M01→M05 链累积撞 `readJsonBodyWithLimit`。**schemaVersion 治理**：未知 / 不匹配 schemaVersion ⇒ 视为缺失 ⇒ 展示降级（fail-open 到旧 UI），安全判定不受影响（Option B）。

### 1.8 sentinel 复用 + Markdown 兜底 + 展示降级链

- **解析新增**：`parseReasoningV2(data)` → `{ result: V2 | null, degraded: boolean }`。复用 `extractDiagnosisJSON`（取最后 sentinel 块，天然防前文 echo 污染）与 `parseCompleteness`，二者零改动。**该函数不接收也不产出任何安全字段**（Option B）。
- **展示降级链**（只影响 UI，不影响安全）：
  1. sentinel 缺失 / JSON 损坏 / `extractDiagnosisJSON` 返回 null ⇒ 纯 Markdown 渲染（今天路径），`stripDiagnosisJSON` 清标记。
  2. `schemaVersion` 不匹配或整体 zod 失败 ⇒ Markdown 渲染 + `degraded=true` + 顶部提示"结构化解析未完成，已回退文本视图"。
  3. 部分节损坏 ⇒ 好节走 V2 交互 UI，坏节回退对应 Markdown 段。
  4. **任何展示降级都不改变安全**：`safetyLocked`、红旗、剂量放行、灵犀审方结论全部来自确定性来源，与 V2 JSON 成败无关（MEDIUM-3 天然闭合）。

---

## 2. 六板块逐节设计（展示字段）

### 板块1 总览 Overview
```jsonc
interface Overview {
  primarySyndrome: string;                       // 主证候
  overallPathogenesis: string;                   // 总病机
  overallTherapy: string;                        // 总治法
  recommendedFormulaDirection: string;           // 推荐主方或方义方向
  evidence: EvidenceRef;
}
```
> **总览页的红旗行 / 输出层级徽章 / 安全门控提示不来自此对象**——由确定性来源（`safetyGate` + 灵犀）独立渲染（§6.1 B 面 / §6.3）。

### 板块2 病机推理 PathogenesisReasoning（吸收中医师审查）
```jsonc
interface PathogenesisChainStep {
  patientFact: string;       // 患者事实
  syndromeEvidence: string;  // 证候证据（舌 / 脉 / 症）
  pathogenesis: string;      // 病机判断
  therapyDirection: string;  // 对应治法
  pathogenesisType?: "始动" | "传变" | "兼夹" | "因果";  // 表达动态传变
  biaoBen?: "本" | "标" | "标本兼夹";                    // 标本关系
  evidence: EvidenceRef;
}
interface PathogenesisReasoning {
  summary: string;
  locationDifferentiation: { items: string[]; evidence: EvidenceRef };  // 脏腑(表里)/经络/气血津液/心神/卫气营血/三焦/上中下焦
  natureDifferentiation: { items: string[]; evidence: EvidenceRef };    // 六淫(风寒暑湿燥火)+内生+痰饮水瘀食积+气虚气滞气逆气陷+寒热虚实
  chain: PathogenesisChainStep[];                // 允许多步链 A→B→C
  uncertainties: { item: string; reason: string; affects: string }[];  // 与 gate.missingItems 呼应（仅展示追加，不覆盖）
}
```
> 病性 / 病位为"常用词表参照 + 允许合理补充"，不做封闭 enum。prompt 与 schema 两处措辞统一（消除"郁"与"风 / 火"不一致；显式纳入气滞、燥）。

### 板块3 治则治法 TherapyPlan
```jsonc
interface TherapyPlan {
  overallPrinciple: string;                      // 总治则（含急则治标 / 缓则治本优先级）
  subTherapies: { therapy: string; targetPathogenesis: string; priority: "主要" | "次要"; evidence: EvidenceRef }[];
}
```

### 板块4 方药方案 FormulaPlan（M04 独有，展示字段）
```jsonc
interface HerbRow {
  name: string;
  processing: string | null;
  dose: string | null;               // 展示用；灵犀 items[] 的剂量由前端从此结构化字段构造（§7.3）
  role: "君" | "臣" | "佐" | "使";
  prescriptionRole: string;          // 主要治疗 / 增强配伍 / 对症 / 调和引经
  targetPathogenesis: string;
  function: string;                  // 功用简析 / 配伍意义
  isToxic?: boolean;                 // 展示用；同步进灵犀 items[].is_toxic_herb
  decoctionRequirement?: string;     // 先煎 / 后下 / 包煎 / 烊化等；同步进灵犀 items[].decoction_requirement
  evidence: EvidenceRef;
}
interface ModificationRule {
  trigger: string; targetPathogenesis: string; action: string;
  doseOrHandling: string | null; reason: string; riskNote: string; evidence: EvidenceRef;
}
interface FormulaCandidate {
  name: string;
  positioning: "首选" | "备选" | "仅学术思路";
  formulaSource: EvidenceRef;        // classic_text / guideline / insufficient；须写清"由本例病-证-病机推导"或"借鉴代表方加减"
  therapyMatch: string;              // 本方对应板块3哪条治则 / 子治法（法→方可审计）
  applicable: string; notApplicable: string;
  herbs: HerbRow[];
  formulaAnalysis: string;           // 方义解析（君臣佐使分层）
  decoction: { doseCount: string | null; method: string; course: string; followUpNode: string };
}
interface FormulaPlan {
  candidates: FormulaCandidate[];    // 1-2 个
  patentAndWestern: PatentWesternItem[] | null;  // 证据不足 ⇒ null
  modifications: ModificationRule[];
}
```
> **`FormulaPlan` 不含 `doseGuardHits`**——处方后风险来自灵犀审方，独立渲染于风险复核页（§6.3），不塞进模型 JSON（Option B）。

### 板块5 非药物干预 NonPharmaPlan
```jsonc
interface NonPharmaPlan {
  diet: string; lifestyle: string; emotion: string; acupointCare: string | null;
  monitoring: { metric: string; timing: string; trigger: string }[];  // 模型建议；确定性随访另由 M05 独立渲染
}
```

### 板块6 医生复核清单（不入模型 JSON，风险复核页由确定性来源渲染）
医生复核清单 = 确定性内容，**不是模型 JSON 的板块**。渲染于风险复核页（§6.3），数据源：
- `mustConfirm`：`gate.missingItems` + 妊娠 / 特殊人群 + 灵犀 `issues[].action`（种子聚合，确定性）；
- `riskItems`：灵犀 `issues[]`（1:1 映射展示，见 §7.3）；
- `notForDirectPatientUse`：固定模板 + `safetyLocked` 命中项。

---

## 3. 流派卡整合（13 张，本轮全上线——决策4）

### 3.1 新数据源 `src/lib/tcm-lineages.ts`（UI 下拉 + prompt 注入唯一来源）
```ts
interface LineageCard {
  code: string; label: string; group: LineageGroup;
  aliases: string[];            // 旧自由文本 value 全部写入，支持迁移
  coreTheory: string; dxEmphasis: string[]; formulaStyle: string;
  representativeFormulas: string[];  // 【仅示意非推荐】，注入时与"方证眼目"绑定
  herbTendency: string; modificationStyle: string; applicability: string; cautions: string[];
}
export const LINEAGE_CARDS: readonly LineageCard[];
export const LINEAGE_OPTIONS: readonly { value: string; label: string; group: LineageGroup }[]; // value=code
export function getLineageCard(codeOrLegacy?: string): LineageCard;   // 永远返回一张卡，未知→unrestricted
export function resolveLineageCode(raw?: string): string;            // code / label / aliases / 关键词→code
export const DEFAULT_LINEAGE_CODE = "unrestricted";                  // 默认预选流派（常量，可改）；UI 下拉初始即选中此项，医生不选也有默认
```

**清单（13 张内置示例 / 预置流派 = 11 基础 + 2 增补；本轮全部放开进 `LINEAGE_OPTIONS`，不默认过滤；下拉初始预选 `DEFAULT_LINEAGE_CODE`——支持"内置示例流派 + 一个默认预选"）**：
`unrestricted`(default) / `classical-formula`(经方) / `empirical-formula`(时方) / `warm-disease`(温病) / `spleen-stomach`(脾胃) / `nourish-yin-danxi`(滋阴丹溪) / `warm-tonify-yang`(温补) / `menghe`(孟河) / `lingnan`(岭南) / `haipai`(海派) / `institution-first`(院内优先) / **`gongxie`(攻邪，增补)** / **`hanliang`(寒凉，增补)**。

> 攻邪 / 寒凉两卡的 `cautions` 字段必须写明过度攻下 / 寒凉伤正的边界，且注入 prompt 时强调"安全 > 流派"优先级；即便如此，**任何流派都不改变确定性安全门与灵犀审方**（§7.3）。

### 3.2 重写 `tcmLineageInstruction`（`diagnosis-prompts.ts`）
- 弃 `preference.startsWith("不限定")` 脆弱文案判断，改判 `card.code==="unrestricted"`。
- 非默认卡按卡字段拼结构化指令 + 优先级硬约束（安全 > 流派）+ 强制"流派适配说明"审计块。
- **代表方安全升级**：代表方在注入文本里与"方证眼目 / 适用证"绑定呈现（如"银翘散——适用于卫分风热、发热微恶风、口微渴、脉浮数；本例若不满足此证型不得选用"），逼模型先核对证型再联想方。回归断言：代表方名不得未经加减直接进入剂量级候选处方。

### 3.3 可审计"流派适配说明" LineageAdaptation（V2 顶层，展示字段）
```jsonc
interface LineageAdaptation {
  schemaVersion: "tcm-cdss-reasoning-v2";
  lineageCode: string; label: string;
  applicable: "applicable" | "partial" | "not-applicable";
  applicabilityReason: string;
  influencedDecisions: { aspect: "辨证视角" | "方源选择" | "组方思路" | "加减风格"; detail: string }[];
  unaffectedBySafety: string[];       // 模型自陈"由安全 / 证据决定、不因流派变"的项（红旗 / 剂量 / 配伍禁忌 / 特殊人群）
  alternativeDirection?: string;      // not-applicable 时必填
  safetyDeference: string;            // 文案由模型填；真正的安全约束不依赖此字段，见下
}
```
**硬约束**：`influencedDecisions` 的 `aspect` schema 层禁止含"剂量 / 配伍禁忌 / 特殊人群 / 红旗"——这些永远由确定性来源决定。**但再次强调（Option B）**：此对象是展示层，模型若违规填了安全相关项，也**不改变**实际放行——放行只看 `safetyLocked`（§7.5）。

### 3.4 向后兼容迁移
`resolveLineageCode`：精确 code → label → aliases → 关键词兜底（"温病"→`warm-disease`，"温补"含"温"须先按 aliases 精确、再按更特异关键词，避免误判；"攻邪 / 攻下"→`gongxie`，"寒凉 / 清热"→`hanliang`）→ 兜底 `unrestricted`。归一点最小化：`normalizeCaseStateInput`（存 code）+ 读取处（过 `resolveLineageCode`）。

---

## 4. 舌诊采集向导 + 结构化 schema + 质量门控 + 隐私（Phase3；面部本轮不启用——决策1）

### 4.1 两步向导（`src/app/diagnosis/TongueCaptureWizard.tsx`，抽离避免 4000 行膨胀）
- **①舌面（必需）**：静态采集提示卡（伸舌自然、距离 20-30cm、光线均匀避滤镜、拍前 30 分钟避进食刷苔）。复用 `fileToCompressedBase64`。
- **②舌下络脉（推荐，可跳过 / 手动勾选）**：颜色 / 粗细 / 曲张 / 瘀点；手动勾选为保底。
- **面部画像（独立弹窗，本轮做录入 UI、暂不外送识别）**：面部图像录入从舌诊向导中**拆出为独立模态弹窗** `FaceCaptureModal`（拍照 / 预览 / 显式知情同意）。**本轮只在浏览器内存采集 + 保留文字化 `faceNote`，不外送第三方 GLM 做图像识别**（零数据出境合规风险）；结构化面部识别（外送 GLM）列入后续增强（§9.1）。图像全程只在内存、提交即清、不落盘 / 不进 hisRecord / 不进日志。
- 底部"改为手动录入"逃生门，回退现有 `tcmTongue` 文本框。

### 4.2 结构化 schema（`src/lib/tongue-diagnosis.ts`，吸收中医师审查字段拆分）
```ts
interface TongueDiagnosisResult {
  schemaVersion: "tongue-dx-v1";
  quality: { score: number; issues: string[]; needRetake: boolean }; // issues 受控枚举；needRetake 由服务端代码重算覆盖（§4.3）
  tongueBody: {
    color: string | null;            // 淡白 / 淡红 / 红 / 绛红 / 紫暗
    shape: string[];                 // 胖大 / 齿痕 / 瘦薄 / 裂纹 / 点刺（各为枚举）
    posture: string[];               // 舌态：正常 / 强硬 / 痿软 / 歪斜 / 颤动 / 短缩
  } | null;
  coating: {
    color: string | null;           // 白 / 黄 / 灰 / 黑
    thickness: string | null;        // 薄 / 厚
    moisture: string | null;         // 润 / 燥 / 滑
    greasiness: string | null;       // 腐 / 腻
    peeling: string | null;          // 满布 / 剥苔 / 地图 / 无苔
  } | null;
  sublingualVeins: { color: string | null; distension: string | null; source: "image" | "manual" | null } | null;
  clinicalEvidenceLevel: "supportive" | "reference-only" | "insufficient"; // 代码按 quality 重算
  summaryText: string;               // CaseState.tongue 兜底展示；送模型前必经 scrub（§7.7）
}
```
> `舌态异常`（强硬 / 歪斜 / 颤动 / 短缩）作为望诊线索提示医生复核，但**仍不进确定性安全层**（保持隔离原意）。面部望诊结构本轮不落地。

### 4.3 质量门控 + 服务端重算（HIGH-2）
- **`needRetake` 重算必须在服务端 `collect` 路由执行**，不能只前端做。`tongue-diagnosis.ts` 用代码重算 `needRetake`（`score<0.6` 或 issues 含 `not_a_tongue`/`tongue_not_fully_extended`/`blurry`/`too_dark`），覆盖模型自评。
- **坏图 ⇒ 服务端保证 `tongue` / `tongueImageDesc` / `tongueDx` 三者都不被该图结果写入**（gate 的舌象槽位来源是 `state.tongue || tongueImageDesc || tcmTongue`，任一被污染都可能误判完整度）。
- **两条独立门，绝不合并**：舌诊质量门（前端 + 服务端解析层，非安全层）；completeness gate（现有 `determineCompletenessLevel`，不改判定逻辑）。坏图被拦 ⇒ `tongue` 为空 ⇒ 舌象缺失 ⇒ gate 自然停 A/B ⇒ 走追问（fail-closed，无新增绕过）。

### 4.4 进 CaseState 与 M03（标为辅助证据）
- `mergeStructuredData`（`diagnosis-engine.ts`）新增 `jsonData.tongueDx` 分支：仅服务端质量门通过才写 `tongueDx` 与 `tongue=summaryText`。
- `buildDiagnosePrompt` 舌象注入处有 `tongueDx` 时注入带 `clinicalEvidenceLevel` 标注的辅助证据段，写死"舌面为望诊客观所见可作证候佐证；舌下为参考项，不得单独支撑证候或凌驾主诉 / 脉象 / 确定性安全"。

### 4.5 隐私
- 图像全程只在浏览器内存 state，提交即清空；不写 localStorage / CaseState / hisRecord（hisRecord 只记 `tongueImageUploaded:boolean`）。
- 服务端 `collect/route.ts` 仅透传给 GLM、不落盘、禁止日志打印 base64；回归断言：collect 响应与日志绝不回显 base64、hisRecord/CaseState 绝不携带 image bytes。

---

## 5. 闻诊（本轮不做）

闻诊模块本轮移出范围（会话决策：闻诊先不做）。本轮**不引入** `wenzhen` 字段、`src/lib/wenzhen.ts`、`normalizeWenzhen`、`formatWenzhenForPrompt`，也不为 wenzhen 改 sanitize。结构化手动录入（声 / 息 / 咳 / 气味四组三态）+ Phase-2 音频列入后续增强（§9.x），届时须遵循"辅助证据、`unknown≠阴性`、不主导辨证 / 处方、不改 `allowDosePrescription`、note 脱敏"的既定原则。

---

## 6. 流式与渲染策略（体感张力 + 截断降级 + safetyLocked）

### 6.1 双通道（Option B 下的展示 / 安全分离）
- **通道A（流式人类可读）**：模型按中医表达顺序分节流式 Markdown（总览→病机→治法→方药→加减→流派适配说明→调护→复核）。`consumeMarkdownStream` 边流边渲染，`filterSentinelFromStreaming` 已在流中隐藏未闭合 sentinel。**首字延迟不变**。
- **通道B（末尾结构化补齐，纯展示）**：流末尾在 sentinel 块内输出 `ClinicalReasoningResultV2` JSON。流结束后 `extractDiagnosisJSON` 取最后块 → `parseReasoningV2` → **直接驱动交互 UI**（表格 / 君臣佐使折叠 / 加减表），**不经过任何安全覆盖**（Option B）。
- **安全板块独立渲染**：总览红旗行、输出层级徽章、风险复核页、`safetyLocked` 状态由**确定性来源**（`safetyGate` + 灵犀审方结果）二次渲染，与 V2 JSON 完全解耦。流中占位为中性文案 **"确定性安全复核进行中"**（决策7），与结果徽章视觉明确区分（spinner + 中性色，非红 / 绿结论色）。

### 6.2 截断检测与强制安全受限（BLOCKER-3，落到具体函数）
在 `callPrimaryTextModelStream` 流循环（`diagnosis-api.ts:181-231`）：
1. **捕获** `choice.finish_reason`；当其为 `'length'`（或 content 结束于 sentinel 中途、END_MARKER 缺失）标记 `truncated=true`。
2. **必设显式 `max_tokens`**：按最坏 V2 payload（六板块 + 药物表 + 证据 refs）估算并文档化预算；核对 `MAX_MODEL_OUTPUT_CHARS=30000` 与供应商上下文 / 输出上限。**初始建议区间 8000–12000 tokens**（对齐 30000 字符上限、留足最坏长度余量），作为回归用例参数，上线前用最长真实病例校准——设太小会人为制造截断→全量走安全受限，设太大则截断检测失效。
3. **NDJSON 增加截断信号帧**：在 `[END]` 前发一帧 `{"content":"[TRUNCATED]"}`（保持契约兼容，前端识别）。
4. **强制安全受限处置（关键落点，不能只"少渲染一个 Tab"）**：`truncated===true` 时，M04 处方流的服务端处置链：
   - 用 `buildSafetyLimitedPrescription(gate)` **覆盖** `caseState.prescription`（丢弃截断原文，绝不把半截处方存进 caseState）；
   - 置该次结果 `safetyLocked=true`（不可采纳，见 §7.5）；
   - 前端可见 banner："结构化 / 处方输出被截断，已按安全受限处理，请医生按文本复核"（区别于 zod 失败的"回退文本视图"）。
5. **DeepSeek reasoning-only 坑保留**：现有 `contentChars===0 && reasoningChars>0` 判错（`diagnosis-api.ts:231`）保留；V2 下拿不到 sentinel-JSON ⇒ 走同一安全受限处置，处方保持锁定。

### 6.3 结果页五标签页
| Tab | 内容 | 数据源 / 降级源 |
|---|---|---|
| 总览 | 红旗+输出层级徽章+三线卡+安全门控提示 | 徽章←`safetyGate`+灵犀（确定性）；三线卡←`reasoningV2.overview`；降级←`SummaryLine`+`SafetyGateNotice` |
| 病机推理 | 归纳段+病位 / 病性标签墙+病机链步进(含标本 / 传变)+不确定点 | `reasoningV2.pathogenesis` / 现 Markdown |
| 方药方案 | `HerbTableV2`+`RoleLayerAccordion`+`ModificationTableV2`+煎服法 | `reasoningV2.formula` / 现 `PrescriptionCandidateTabs` |
| 风险复核 | 灵犀审方结论 + 复核清单 + 不可直接执行项 | **始终直读** `caseState.riskAssessment`(M05 灵犀) + 确定性 `mustConfirm`；**不读 reasoningV2** |
| 调护随访 | 饮食 / 作息 / 情志 / 穴位 + 监测复诊 `FollowupTimeline` | `reasoningV2.nonPharma`（模型建议）+ M05 确定性随访 |

**渲染落点**：新增 `src/app/diagnosis/ResultTabsV2.tsx`；`DiagnosisClient.tsx` 的 `CompactAiSchemeCardFlow` 只做接线。每 Tab 内"结构化优先 / 正则降级 / `MarkdownBlock` 原文"三级渲染，零退化。**风险复核页解析成败无关安全**（Option B）。

### 6.4 医生可编辑并入 HIS 写回
- 内存草稿 `reasoningDraft`（`useState`，不进 localStorage）。可编辑限展示字段（证候 / 病机 / 治法文字、加减理由、调护、复核勾选）。
- **剂量 / 君臣佐使角色只读或需二次确认**；改剂量必走 §6.6 重校环。
- 写回 payload 用 `reasoningDraft` 优先于 `reasoningV2`，编辑字段带 `editedByDoctor:true` 供审计。**`safetyLocked` 字段编辑层不可写**（§6.5）。

### 6.5 无障碍 / 响应式 + safetyLocked 机读字段（HIGH-1）
- **`safetyLocked` 是机读字段**（`boolean`），由确定性代码派生（§7.5），**编辑层不可写**。`his-scheme.ts` 的 `item()` 改为 `adoptable = safetyLocked ? false : (...)`——**不再靠 `isPlaceholderContent` 文本正则决定采纳**（文本正则仅作展示兜底 blockedReason 文案）。医生润色占位文案再也翻不转采纳性。
- **键盘模型**：Tab 容器 `role="tablist"`/`aria-selected`/箭头键切换；herb 表与 accordion 键盘可达；编辑字段焦点管理。
- **aria-live**：流式→结构化的异步替换用 live-region 播报"结构化视图已就绪"。
- **非色彩编码**：evidence / safety / tier 徽章用图标+文字。
- **窄侧栏（410-460px）**：标签条横向滚动（`overflow-x:auto`），五页固定，不折叠下拉（避免隐藏红旗页）。
- **i18n**：安全常量文案与 parse 逻辑分离，安全层 key 机读码不 key 显示串。

### 6.6 医生编辑→灵犀重校→重渲染环（决策5，端到端单一 owner）
剂量编辑 ⇒ 前端从编辑后的结构化 `herbs` **重建灵犀 items[]** ⇒ POST `post-prescription-risk`（服务端调 `auditPrescriptionWithLingxi`，§7.3）⇒ 刷新灵犀 `riskItems` 与 `safetyLocked` ⇒ 重渲染方药安全列与复核清单。**规则**：
- 编辑安全关键字段（剂量）**必须重跑灵犀审方后才能写回**；重校未完成前该处方 `safetyLocked=true`。
- `editedByDoctor` 永不抑制灵犀 BLOCK / 强提示阻断。
- 灵犀重校返回 BLOCK / 不可用 ⇒ `safetyLocked` 保持 true，不可采纳。

---

## 7. 安全对账（双层：处方前门 + 灵犀审方）

### 7.1 无 reconcile 覆盖层（BLOCKER-1 / Option B 澄清）
> **删除旧草稿的 `reconcileV2Safety` 设计。** 真实代码里 M03/M04 是纯流式透传，`withSafetyGate` 只在"调模型之前"跑（决定要不要调模型 / 用哪个 prompt），服务端**没有**"流结束后解析模型 JSON→覆盖安全字段→返回"的关口（那种覆盖只存在于 M01/M02 的 `consumeCollectStream`）。把 completeness 覆盖类比到 V2 安全覆盖是错误的。

**定稿采用 Option B**：安全字段由服务端确定性来源**独立产出**，前端只展示；**安全判定根本不读 V2 JSON**。因此不需要、也不实现任何"返回前覆盖模型 safety 字段"的关口。V2 JSON 缺失 / 损坏 / 截断 **不影响任何安全判定**（MEDIUM-3 天然闭合）。安全权威 = **两层确定性来源**：

### 7.2 双层安全架构总览
| 层 | 时机 | 来源 | 确定性 | fail-closed 语义 |
|---|---|---|---|---|
| **处方前门** | 调模型之前 | 本地 `withSafetyGate`（红旗 / 生命体征 / 完整度） | 是（保持现状） | 未 ready / 红旗 ⇒ 降级非 dose 输出 |
| **处方后审方** | 处方生成后 | **灵犀唯一权威**（服务端、结构化 items[]） | 是（外部规则引擎） | 未启用 / 失败 / BLOCK / 不可用 ⇒ 强制"需药师人工复核"、`safetyLocked=true` |

**本地审方引擎退役**（决策8）：删除 `evaluatePostPrescriptionRisks` / `buildPostPrescriptionRiskSection` / `extractPrescribedHerbs` 在**审方路径**的使用。**绝不退回本地弱引擎兜底**。生产前提：`.env` 必须置 `RXAI_AUDIT_ENABLED=true` 并配 `RXAI_AUDIT_BASE_URL`/`TOKEN`/`TENANT`（现为 `false`，未配即视为"不可用"→强制人工复核，绝不 fail-open）。

### 7.3 灵犀审方集成（结构化 items[] 直发，不解析 Markdown）

**接口**：统一入口 `POST /api/v1/rational-drug-use`，`operation="PRESCRIPTION_AUDIT"`，`prescription_category="CHINESE_MEDICINE_PRESCRIPTION"`。

**关键改造**：`rxaudit.ts` 的 `buildAuditData` 现状是 `extractPrescribedHerbs(state.prescription || "")` 从 **Markdown 药表**解析构造 items[]（`rxaudit.ts:112`）。**改为从 V2 结构化 `herbs[]` 直接构造 items[]**：
```
items[] ← reasoningV2.formula.candidates[selected].herbs.map(h => ({
  drug_name: h.name,
  single_dose: parseDose(h.dose),          // 从结构化 dose 字符串取数值
  single_dose_unit: "g",                   // 或从 dose 解析单位
  decoction_requirement: h.decoctionRequirement ?? null,
  is_toxic_herb: h.isToxic ?? false,
}))                                          // 最多 50 条
```
不再解析 Markdown 药表；`extractPrescribedHerbs` 退出审方路径（保留在 KB 供其他非审方用途或一并清理，见 §10）。

**灵犀调用时序**（`post-prescription-risk/route.ts` 重写）：
```
1. 从结构化 herbs 构建 items[]（buildAuditDataFromHerbs）；items 为空 ⇒ safetyLocked=true、"处方未生成有效药味，需人工复核"
2. audit = await auditPrescriptionWithLingxi(state)   // 已实现：超时9s/重试3次线性退避，任何失败 ok:false
3. 按下表确定性处置（都不放开采纳）
```

**四种情形的确定性处置（全部不得放开采纳）**：
| 情形 | 判据 | 处置 |
|---|---|---|
| **未启用 / 未配置** | `cfg.enabled===false` ⇒ `ok:false, reason:"rxaudit_not_configured"` | `safetyLocked=true`；section="灵犀审方未配置，需药师人工复核"；`allowOneClickAdoption=false` |
| **调用失败** | `ok:false`（超时 / 网络 / HTTP 非 200 / 非法 JSON / 业务错误码 / 重试耗尽） | `safetyLocked=true`；section="确定性审方未完成（{reason}），不等同无风险，需药师人工复核"；`allowOneClickAdoption=false` |
| **BLOCK / 高危** | `ok:true` 且 `audit_result==="BLOCK"` 或 `highest_risk_level∈{HIGH,CRITICAL}` 或 `need_manual_review===true` | `safetyLocked=true`；展示 `issues[]`；`allowOneClickAdoption=false`；outputTier≥needs_doctor_review |
| **部分降级** | `ok:true` 且 HTTP 200 / code 200 且 `degraded===true`（evimed/llm 组件降级但规则审核仍返回） | 正常展示 `issues[]` + 提示"部分组件降级（{degrade_reason}），规则审核已完成"；`safetyLocked` 按 `audit_result`/`highest_risk_level` 派生；**区别于"整个接口不可用"** |
| PASS / REMIND 且非降级且无高危 | `ok:true`, `audit_result∈{PASS,REMIND}`, `highest_risk_level∈{INFO,LOW,MEDIUM}` | `safetyLocked` 仅由处方前门决定；可采纳（受 gate 约束） |

**PHI 边界**：灵犀 `40005` = 患者数据含禁止字段。构建 items[] / patient 段绝不传身份证 / 手机号；沿用 `sanitizeCaseStateForModel` 纪律，患者段只传审方必需的年龄 / 性别 / 妊娠 / 特殊人群标记。

**映射到 V2 展示**：灵犀 `highest_risk_level`/`audit_result`/`need_manual_review` → `overview.outputTier` 与风险复核页展示；`issues[]`（`risk_level`/`issue_type`/`description`/`action`/`evidence[]`/`suggestions[]`）→ 风险复核页 `riskItems`（纯展示）；`summary.doctor_message` → 复核提示。**能否采纳（`safetyLocked`/`adoptable`）由确定性代码据 gate + 灵犀派生，绝不读模型 JSON。**

### 7.4 本地风险展示的过渡期约束（BLOCKER-2）
本地审方引擎退役后，`buildPostPrescriptionRiskSection` 的 `return ""` fail-open 路径随之消除（不再在审方路径调用）。**若过渡期仍保留任何本地风险展示**，必须：非空处方 + `allowDosePrescription` + 解析空 ⇒ **无条件输出**"信息不足提示 / 审方未完成，不等同无风险"，绝不空串。

> 旧草稿 §7.2"双写 Markdown 药表 + 饮片守恒"因审方改结构化 items[] 直发灵犀而**不再是安全关键路径**：处方后风险不再从 `caseState.prescription` 的 Markdown 表解析，而从 V2 结构化 herbs 直接构建 items[] 送灵犀。因此"Markdown 药表解析出空 ⇒ 静默无风险"这个 fail-open 随架构消除——灵犀直接吃结构化 herbs，无 Markdown 解析中间层。**HIGH-3 独立处理**：`detectModelRedFlags`/`sectionText`（`diagnosis-safety.ts:365/376`）的标题正则仍靠 `SECTION_TITLES` 单一真源（§1.6），回归断言改标题后模型红旗行仍被抓到。

### 7.5 safetyLocked 机读字段派生（HIGH-1，取代文本正则）
`safetyLocked: boolean` 由确定性代码派生，**编辑层不可写**：
```
safetyLocked =
     !gate.allowDiagnosis                              // 门控不放行诊断
  || !gate.allowDosePrescription                       // 门控不放行剂量
  || truncated                                          // 截断（§6.2）
  || prescriptionIsPlaceholderSource                    // 来源为安全受限占位（机读来源标记，非文本猜测）
  || lingxi.unavailable                                 // 灵犀未启用 / 失败
  || lingxi.result === "BLOCK"                          // 灵犀阻断
  || lingxi.highest_risk_level ∈ {HIGH, CRITICAL}       // 灵犀高危
  || lingxi.auditResult === "MANUAL_REVIEW"             // 灵犀要求人工复核（与 §7.3 四情形表对齐）
  || lingxi.needManualReview === true                   // 灵犀 need_manual_review
```
`his-scheme.ts` 的 `item()`：`adoptable = safetyLocked ? false : (opts?.adoptable ?? Boolean(clean(content)))`。`isPlaceholderContent` 文本正则降级为仅生成 `blockedReason` 展示文案，不再决定 adoptable。**医生编辑不得写 `safetyLocked`；编辑安全关键字段强制重跑灵犀（§6.6）后由代码重算。**

### 7.6 本地 695 味 KB 保留为佐证（决策9）
`tcm-knowledge.json` + `searchTcmKnowledge` **保留**，继续给 M03/M04 prompt 做用药佐证注入（`buildCdssEvidenceContext`）。只砍审方引擎（§10）。KB 是 prompt 佐证来源，不再是审方判定来源。

### 7.7 sanitizeCaseStateForModel 必加脱敏分支（MEDIUM-2，实现时必做，漏则 CRITICAL 泄漏）
`sanitizeCaseStateForModel`（`diagnosis-safety.ts:815`）是 `...state` 展开 + 白名单式逐字段 scrub。新增字段若不显式加分支会被原样透传给模型。**必做清单**：
```ts
return {
  ...state,
  // ...现有字段...
  tongueDx: state.tongueDx ? {
    ...state.tongueDx,
    summaryText: scrub(state.tongueDx.summaryText),      // 含姓名的 summaryText 必脱敏
    // sublingualVeins / coating 的任何自由文本 note 同 scrub
  } : undefined,
  reasoningV2: state.reasoningV2
    ? scrubUnknown(state.reasoningV2)                     // 所有模型自由文本递归脱敏
    : undefined,
  // 闻诊本轮不做，无 wenzhen 字段
};
```
回归断言（node --test）：含姓名的 `tongueDx.summaryText` / `reasoningV2` 自由文本送模型前被 `[已脱敏]`。

### 7.8 安全不变量清单（12 条，按 Option B + 灵犀唯一审方重述，逐条标注确定性来源）
1. **门控先行**：任何 V2 渲染前 `withSafetyGate` 已运行；`allowDiagnosis`/`allowDosePrescription` 是唯一处方前放行开关。**来源**：本地 `withSafetyGate`（确定性）。
2. **安全判定不读模型 JSON**：`parseReasoningV2` 不接收也不产出安全字段；V2 JSON 缺失 / 损坏 / 截断不改变放行。**来源**：Option B 架构（§7.1）。
3. **fail-closed 展示降级**：JSON 缺失 / 非法 / 仅 reasoning_content / 截断 ⇒ 展示退 Markdown，处方 `safetyLocked` 保持。**来源**：§1.8 + §6.2。
4. **截断即安全受限**：`finish_reason==='length'` 或 sentinel 未闭合 ⇒ `buildSafetyLimitedPrescription` 覆盖 + `safetyLocked=true` + 截断帧。**来源**：`diagnosis-api.ts` 流层（§6.2）。
5. **红旗不可降级**：`detectModelRedFlags` 只追加、不移除 `detectProgrammaticRedFlags` 与生命体征阈值命中红旗；标题正则靠 `SECTION_TITLES` 单一真源。**来源**：`diagnosis-safety.ts`（HIGH-3，§7.4）。
6. **处方后风险=灵犀唯一权威**：十八反十九畏 / 剂量 / 特殊人群 / 相互作用 / 味数 / 过敏由灵犀 `issues[]` 产出；从结构化 herbs 构建 items[]，不解析 Markdown。**来源**：`rxaudit.auditPrescriptionWithLingxi`（§7.3）。
7. **审方不可用即需人工复核**：灵犀未启用 / 失败 / 不可用 ⇒ `safetyLocked=true`、outputTier≥"需医生复核"；绝不退回本地弱引擎。**来源**：§7.3 四情形表。
8. **BLOCK / 高危阻断采纳**：灵犀 BLOCK 或 highest_risk∈{HIGH,CRITICAL} ⇒ `safetyLocked=true`、`allowOneClickAdoption=false`。**来源**：§7.5 派生。
9. **evidence-bound**：无 KB 规则 / 患者事实 / 灵犀 evidence 支撑不输出剂量 / DOI / 风险判定；肝肾 / 血糖以"固定提醒"呈现不伪装判定。**来源**：prompt 约束 + 灵犀 `evidence[]`。
10. **adoptable 机读派生**：`adoptable = safetyLocked ? false : ...`；不靠 `isPlaceholderContent` 文本正则；医生编辑不可写 `safetyLocked`。**来源**：`his-scheme.item()`（HIGH-1，§7.5）。
11. **NDJSON 契约保留**：所有阶段（含降级 / 截断 / 灵犀失败）仍走 `{"content":…}`/`[END]`/`{"error":…}`/截断元帧。**来源**：`markdownNdjsonResponse` + §6.2。
12. **PHI 边界不变**：送模型前 `sanitizeCaseStateForModel` 先跑，新字段（`tongueDx.summaryText`/`reasoningV2`/`wenzhen.note`）显式脱敏；送灵犀不传身份证 / 手机号（避 40005）；图像 / 音频不进日志 / hisRecord。**来源**：`sanitizeCaseStateForModel`（MEDIUM-2，§7.7）+ §7.3 PHI 边界。

### 7.9 HIS / his-scheme 影响
- `schemaVersion="tcm-cdss-his-ai-scheme-v1"` 不变，HIS 对接方无需改。
- `writeBackPolicy`（autoWrite*=false、doctorReviewRequired=true、`allowOneClickAdoption` 由 `safetyLocked` 派生）来自确定性函数，不从 reasoningV2 读。
- **章节名注册表同步**：`his-scheme.ts:207-231` 的 `section()`/`extractField()` 别名统一引用 §1.6 `SECTION_TITLES`；新增 / 改名章节（如"流派适配说明"）同 PR 追加别名 + 回归断言 payload 字段非空。

---

## 8. 分期路线（先做 Phase1 + Phase2）

> **落地顺序：Phase1 + Phase2 优先**。契约层（Phase1）+ 展示层（Phase2）是六板块价值核心闭环，且不引入摄像 / 音频 / 隐私新面。舌诊 / 闻诊（Phase3/4）依赖 Phase1 契约稳定后再接。Phase5 回归贯穿每期收尾。

### Phase1 — 新架构契约层（V2 展示层 + 灵犀审方 + 截断安全受限 + safetyLocked + sanitize + SECTION_TITLES）
- **范围**：M03/M04 升级"分节 Markdown + 末尾 sentinel-JSON（纯展示）"；截断检测→强制安全受限；灵犀审方改结构化 herbs→items[]、砍本地审方兜底；`safetyLocked` 机读派生；sanitize 新字段脱敏；`SECTION_TITLES` 单一真源（含红旗标题）。
- **交付物（真实路径）**：
  - `src/lib/cdss-vocab.ts`（新增：`EvidenceLevel`/`OutputTier`/`SECTION_TITLES`/`SAFETY_DEFERENCE_TEXT`）；
  - `src/lib/diagnosis-types.ts`（`ReasoningV2Schema` 逐节宽松 + 可选 CaseState 字段 + size 上限 + `safetyLocked` 类型）；
  - `src/lib/diagnosis-parse.ts`（`parseReasoningV2`——不含安全字段）；
  - `src/lib/diagnosis-api.ts`（`finish_reason` 捕获 + `max_tokens` + 截断元帧）；
  - `src/lib/diagnosis-safety.ts`（`deriveSafetyLocked`；`detectModelRedFlags`/`sectionText` 改引 `SECTION_TITLES`；**`sanitizeCaseStateForModel` 加 tongueDx/reasoningV2 脱敏分支**（闻诊本轮不做，无 wenzhen）；M04 截断→`buildSafetyLimitedPrescription` 覆盖落点）；
  - `src/lib/rxaudit.ts`（`buildAuditDataFromHerbs`：从结构化 herbs 构建 items[]，替代 `extractPrescribedHerbs` 路径）；
  - `src/app/api/diagnosis/post-prescription-risk/route.ts`（删本地 `evaluatePostPrescriptionRisks`/`buildPostPrescriptionRiskSection` 兜底，改灵犀唯一 + 四情形处置）；
  - `src/lib/his-scheme.ts`（`item()` 用 `safetyLocked` 派生 adoptable）；
  - `src/lib/diagnosis-prompts.ts`（V2 sentinel 变体，声明"安全字段不由模型填"）；
  - `src/lib/diagnosis-engine.ts`（流后 `extractDiagnosisJSON`→`parseReasoningV2` 填 `reasoningV2`）。
- **验收标准**：
  - 正常 M04 zod 通过、`degraded=false`，herbs 每行含药名 / 角色 / 剂量 / 病机 / 功用全字段；
  - `red_flag` 时无论模型写什么，处方 `safetyLocked=true`、总览徽章 `no_auto_prescription`（徽章来自 gate 不来自模型 JSON）；
  - `allowDosePrescription===false` ⇒ `safetyLocked=true`；
  - sentinel 缺失 / 损坏 / **截断** ⇒ Markdown 兜底无空屏无报错 + `caseState.prescription` 被 `buildSafetyLimitedPrescription` 覆盖 + `safetyLocked=true`；
  - 灵犀构建 items[] 从结构化 herbs（人为植入十八反甘草+甘遂）命中灵犀 issue；灵犀未配置 ⇒ `safetyLocked=true`、section 含"需药师人工复核"、绝不空串、绝不 fail-open；
  - 含姓名的 `tongueDx.summaryText`/`wenzhen.note`/`reasoningV2` 送模型前被脱敏；
  - completeness 仍被 `determineCompletenessLevel` 覆盖（不改）。
- **回归断言**：
  - **node --test 纯函数**：`deriveSafetyLocked`（8 派生分支）；`buildAuditDataFromHerbs`（结构化 herbs→items[] 字段映射 + 十八反在 items 中可见）；`sanitizeCaseStateForModel`（新字段含姓名被脱敏）；`sectionText`/`detectModelRedFlags`（改标题后红旗行仍被抓到）；`parseReasoningV2`（截断 / schemaVersion 不匹配 → null，不 crash）。
  - **HTTP**：红旗 + 流派仍不出方；否定病史不误判；截断 sentinel ⇒ 处方 `safetyLocked`；灵犀不可用 ⇒ 需人工复核不放开；`npm run regress:tcm-cdss` 与 V2 前基线一致。
- **风险**：模型不稳定输出合法嵌套 JSON ⇒ 频繁展示降级（缓解：prompt 给最小示例 + 逐节宽松 + 双通道保证降级不影响可读性，且安全不受影响）；灵犀生产未配置 ⇒ 全量走人工复核（缓解：上线前置 `RXAI_AUDIT_ENABLED=true` 并配 BASE_URL/TOKEN，前提硬约束）。

### Phase2 — 结果页展示（五标签页 + 表格化 + 编辑重校环）
- **范围**：`ResultTabsV2.tsx`（总览 / 病机 / 方药 / 风险复核 / 调护）；处方表格化；君臣佐使折叠；加减四列表；病机链步进；三级优雅降级；医生编辑草稿 + 灵犀重校环（§6.6）；a11y / 响应式。
- **交付物**：`src/app/diagnosis/ResultTabsV2.tsx`（新增）；`src/app/diagnosis/DiagnosisClient.tsx`（`CompactAiSchemeCardFlow` 切标签页、`reasoningDraft` state、HIS 写回优先草稿、`safetyLocked` 只读渲染）。
- **验收标准**：流式散文逐字回显、裸 JSON 不外泄；方药页每味药含剂量(或"待医生确认")/角色 / 功用 / 病机 / 安全提示；加减四列表；`RoleLayerAccordion` 正确分组；置 null / 损坏 JSON ⇒ 五 Tab 全回退正则视图无空白 + 顶部提示（安全不受影响）；`safetyLocked===true` ⇒ 方药页锁定只读、风险复核页始终直读 M05 灵犀结论；编辑并入写回带 `editedByDoctor`、剂量改动强制走灵犀重校（§6.6）后才可写回、`safetyLocked` 不可编辑；键盘可达、非色彩编码、窄栏横滚；`npx tsc --noEmit` 通过。
- **回归断言**：降级不空屏、风险复核页解析成败无关安全、编辑不翻转 adoptable（`safetyLocked` 派生，编辑占位文案不改采纳性）、剂量编辑未重校前 `safetyLocked=true`。

### Phase3 — 舌诊采集向导（面部不启用）
- **范围**：`TongueCaptureWizard.tsx` 两步（舌面 + 舌下）；`tongue-diagnosis.ts` 结构化 schema（舌态 / 润燥 / 剥苔拆分）；**服务端 `needRetake` 重算**（HIGH-2）；GLM 结构化输出；隐私不落盘。**面部画像独立弹窗 `FaceCaptureModal`**（拍照 / 预览 / 知情同意，只内存录入 + 文字化 `faceNote`，**不外送 GLM 识别**，§4.1）。
- **交付物**：`src/lib/tongue-diagnosis.ts`；`diagnosis-types.ts`（`tongueDx?` + 校验）；`diagnosis-prompts.ts`（collect 输出 `tongueDx`、diagnose 注入辅助证据段）；`diagnosis-engine.ts`（`mergeStructuredData` tongueDx 分支 + 质量门）；`DiagnosisClient.tsx`（向导替换单上传按钮 + 面部弹窗入口）；`src/app/diagnosis/FaceCaptureModal.tsx`（新增：面部录入独立弹窗，只内存采集、提交即清、不外送）；`collect/route.ts`（**服务端 needRetake 重算** + 可选 sublingual 图透传 + 禁 base64 日志）；`diagnosis-api.ts`（多图透传）。
- **验收标准**：偏暗 / 非舌图 ⇒ 服务端 `needRetake=true`、`tongue`/`tongueImageDesc`/`tongueDx` 三者均未写入、不触发 safetyGate；坏图拦下 ⇒ completeness A/B 走追问；合格舌面 ⇒ `supportive`、写入、M03 带辅助证据标注；有无 tongueDx 时安全判定逐字一致；图像不落盘、日志无 base64；向后兼容（旧 tongue 字符串退化）。
- **回归断言**：坏图不进处方（node --test：`needRetake` 重算覆盖模型自评；HTTP：坏图 collect 后 tongue 三槽位为空）、有无 tongueDx 安全一致。

### Phase4 —（本轮不做）面部画像弹窗收尾 / 预留
闻诊本轮移出范围（§5）。面部画像**独立弹窗**在 Phase3 随舌诊向导一并交付（`FaceCaptureModal`，只录入不外送识别，§4.1）。本 Phase 号位保留给后续增强（闻诊、面部结构化识别，§9.x），本轮无交付物。

### Phase5 — 回归测试（贯穿，收尾强化）
- **范围**：扩展 `scripts/regress-tcm-cdss.mjs` + 新增 `node --test` 纯函数测试层（零新依赖，符合"无测试框架"约束——决策2）。
- **交付物**：
  - **node --test 纯函数**（`scripts/test/*.test.mjs` 或 `src/lib/__tests__/*.test.mjs`）：`deriveSafetyLocked`、`buildAuditDataFromHerbs`、`sanitizeCaseStateForModel`、`parseReasoningV2`、`sectionText`/`detectModelRedFlags`、`resolveLineageCode`、`normalizeWenzhen`、`parseTongueDx needRetake`。
  - **HTTP 用例**：截断 sentinel ⇒ 安全受限 + 处方锁定；红旗 + 流派仍不出方；否定症状不误判；灵犀不可用 ⇒ 需人工复核不放开；低质量舌图不强推理；旧自由文本解析为正确 code（含 gongxie/hanliang）；HIS payload 字段非空（改标题回归）。
- **验收标准**：`npm run regress:tcm-cdss` 全绿且与 V2 引入前基线一致；纯函数单测全过；"safetyLocked 派生""灵犀 items[] 构建""新字段脱敏""改标题红旗仍抓到"机器可验证。
- **关键文件**：`scripts/regress-tcm-cdss.mjs`，新增 `scripts/test/*.test.mjs`（`node --test`，不引入 jest/vitest）。

---

## 9. 已定决策清单（全部拍板）

1. **面部画像做成独立弹窗、本轮只录入不外送识别**（已定，修订自"本轮不启用"）：面部录入拆为独立模态弹窗 `FaceCaptureModal`（拍照 / 预览 / 知情同意），**本轮只在内存采集 + 保留文字化 `faceNote`，不外送第三方 GLM 识别**（零数据出境合规风险）；结构化面部识别（外送 GLM）待供应商数据处理条款明确后作后续增强（§9.x）。**闻诊本轮不做**（见 §5、§9.x）。
2. **`node --test` 纯函数测试层**（已定：接受）：在"无 jest/vitest"约束下引入 Node 内置 `node --test`（零新依赖）覆盖安全关键纯函数。HTTP 黑盒无法验 `deriveSafetyLocked`/`buildAuditDataFromHerbs`/脱敏。
3. **M03 结构化深度**（已定）：M03 只填到 `therapy`（`formula=null`），M04 才补 `formula`，降低单次 token 负担与漏填风险。
4. **攻邪 / 寒凉两张增补流派卡**（已定：本轮一起放开上线）：13 张全进 `LINEAGE_OPTIONS`，不默认过滤。`cautions` 写明过度攻下 / 寒凉边界；安全 > 流派，任何流派不改确定性门与灵犀审方。
5. **剂量可编辑粒度**（已定）：允许改但**强制 `post-prescription-risk`（灵犀）重校后才可写回**（§6.6 重校环）。尊重医生最终决策同时不放开审方旁路。
6. **证据级别档位**（已定）：六档机读（`deterministic_rule`/`kb_entry`/`guideline`/`classic_text`/`model_inference`/`insufficient`）足够，UI 侧再细化标注，保持 schema 简单。
7. **流式安全板块占位文案**（已定）：流中占位用中性 spinner + 文案 **"确定性安全复核进行中"**，与结果徽章视觉明确区分，避免医生误读为故障或误读为已放行。
8. **审方架构**（已定）：灵犀唯一权威 + fail-closed；删本地审方引擎在审方路径的使用；喂 V2 结构化 herbs → 灵犀 items[]（不解析 Markdown）。生产前提：`RXAI_AUDIT_ENABLED=true` 并配 BASE_URL/TOKEN。
9. **本地 KB**（已定）：只砍审方引擎；`tcm-knowledge.json` + `searchTcmKnowledge` 保留作 M03/M04 用药佐证（`buildCdssEvidenceContext`）。
10. **V2 JSON 定位**（已定：Option B）：纯展示层，永不作为任何安全判定输入；安全权威 = 本地处方前门 + 灵犀审方。
11. **死代码清理**（已定）：删 `callEvimedStream` + `wrapEvimedBody` + `backend="evimed"`；保留 EviMed 多源证据检索 `fetchGuideEvidence`/`buildGuideEvidenceContext`/`buildExternalEvidenceContext`（M03/M04 证据上下文活代码）。

### 9.x 后续增强（非本轮，记录方向）
- **灵犀 `STRUCTURED_KNOWLEDGE_QUERY`**（`TCM_FORMULA`/`CLASSIC_TCM_FORMULA`/`TCM_MATERIAL_MONOGRAPH`）+ `COMPATIBILITY_QUERY` 作流派"代表方"与 M03/M04 方剂 / 本草锚点——本地 695 味库无方剂表，这是补齐方向。
- his-scheme 增 `reasoningV2?` 可空承载结构化字段作"更干净抽取源"降低正则脆弱（安全三块仍来自确定性函数）。
- **闻诊模块**（本轮不做）：结构化手动录入（声 / 息 / 咳 / 气味）+ Phase-2 音频，后续再评估。
- **面部结构化识别**（外送 GLM，待合规评估）：本轮只做独立弹窗 `FaceCaptureModal` 录入 UI，不外送识别；待供应商数据处理条款明确后再接结构化识别。

---

## 10. 无关代码清理（独立一节，具体文件 / 函数清单与替代路径）

### 10.1 死代码删除：EviMed 流式后端（决策11）
前端硬编码 `backend="deepseek"`，`evimed` 后端触发不到，为死代码。删除：
| 文件 | 删除项 | 替代 |
|---|---|---|
| `src/lib/diagnosis-api.ts:98` | `DiagnosisBackend` 联合类型中的 `"evimed"` | 剩 `"deepseek"\|"glm"\|"openai"` |
| `src/lib/diagnosis-api.ts:255` | `wrapEvimedBody` | 无（无调用者） |
| `src/lib/diagnosis-api.ts:335` | `callEvimedStream` | 无 |
| `src/lib/diagnosis-api.ts:544` | `callDiagnosisStream` 中 `backend==="evimed"` → `callEvimedStream` 分支 | 删分支 |
| `src/lib/diagnosis-api.ts:533` | 相关注释行 | 更新注释 |

**保留（活代码，勿删）**：EviMed 多源证据检索 `fetchGuideEvidence`/`buildGuideEvidenceContext`/`buildExternalEvidenceContext`——M03/M04 证据上下文注入在用。`diagnosis-engine.ts:405` 的 `h5_evimed`/`evimed` url 解析属检索结果处理，与流式后端无关，保留。

### 10.2 本地审方引擎退役（决策8，保留 KB 佐证——决策9）
从**审方路径**移除本地弱引擎；灵犀唯一权威。
| 文件 / 函数 | 处置 | 替代路径 |
|---|---|---|
| `tcm-knowledge.ts` `evaluatePostPrescriptionRisks`(:968) | 退出审方路径；不再被 `post-prescription-risk/route.ts` 调用 | 灵犀 `issues[]` |
| `tcm-knowledge.ts` `buildPostPrescriptionRiskSection`(:1136) | 退出审方路径（消除 `return ""` fail-open，BLOCKER-2） | 灵犀 `buildLingxiRiskSection` |
| `tcm-knowledge.ts` `extractPrescribedHerbs`(:643) | 退出审方路径（`rxaudit.buildAuditData` 不再调它） | `buildAuditDataFromHerbs`（从结构化 herbs 构建 items[]，§7.3） |
| `rxaudit.ts` `buildAuditData`(:111) | 改为 `buildAuditDataFromHerbs`（入参 V2 herbs 而非 `state.prescription` Markdown） | — |
| `post-prescription-risk/route.ts` | 删 local section / local risks / `!audit.ok` 本地兜底；改灵犀唯一 + 四情形处置（§7.3） | 灵犀 |
| **`assess/route.ts:17`（M05，第二调用点）** | M05 现调 `buildPostPrescriptionRiskSection(gated)` 拼进 riskAssessment 且**不走灵犀**——退役表勿漏此处。处置：M05 处方后风险改走灵犀审方结论（与 M04 一致）；若过渡期保留该函数，**必须改其函数本体的 `return ""`（:1154）尾**为"非空处方 + `allowDosePrescription` + 解析空 ⇒ 无条件信息不足提示"——函数被两条路径共享，改本体即同时闭合两处 fail-open（BLOCKER-2） | 灵犀 / 改函数本体 |

**保留（决策9）**：`tcm-knowledge.json`、`searchTcmKnowledge`、`buildCdssEvidenceContext`——M03/M04 prompt 用药佐证注入。KB 从"审方判定源"降为"prompt 佐证源"。
**清理原则（遵循 CLAUDE.md §4 surgical）**：`evaluatePostPrescriptionRisks`/`buildPostPrescriptionRiskSection`/`extractPrescribedHerbs` 若确认全项目仅审方路径调用则删函数；若 KB 佐证或其他非审方处仍引用则保留函数、仅移除审方路径调用点。实现时先 grep 调用点再决定删 / 留，不做超范围删除。

---

**方案自洽性说明**：全部 blocker（BLOCKER-1 Option B 消除不存在的 reconcile 关口 / BLOCKER-2 fail-open 随本地审方退役消除 / BLOCKER-3 截断→强制安全受限落到 `diagnosis-api.ts` 流层 + `buildSafetyLimitedPrescription` 覆盖）与 high（HIGH-1 `safetyLocked` 机读取代文本正则 / HIGH-2 服务端 needRetake 重算 / HIGH-3 `SECTION_TITLES` 含红旗标题）已逐项闭合。medium（MEDIUM-2 sanitize 新字段脱敏升为必做 / MEDIUM-3 Option B 天然闭合）已固化。确定性安全层零削弱——处方前门（本地确定性）+ 处方后审方（灵犀唯一权威、fail-closed）双层，逐条不变量标注确定性来源（§7.8）。NDJSON/sentinel/Markdown 兜底全程保留，无推翻重写。

**相关真实文件路径**（供实现引用）：
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/diagnosis-parse.ts`（`extractDiagnosisJSON`、`determineCompletenessLevel`、`parseCompleteness`）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/diagnosis-api.ts`（`finish_reason` 已用于截断判断；reasoning-only 判错保留；`callEvimedStream`/`wrapEvimedBody`/`backend="evimed"` 已删）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/diagnosis-safety.ts`（`sectionText:365`、`detectModelRedFlags:376`、`evaluateSafetyGate:513`、`withSafetyGate:594`、`buildSafetyLimited*:619/648/667`、`sanitizeCaseStateForModel:815`）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/tcm-knowledge.ts`（`extractPrescribedHerbs:643`、`evaluatePostPrescriptionRisks:968`、`buildPostPrescriptionRiskSection:1136` fail-open 尾 `:1154`）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/rxaudit.ts`（`buildAuditData:111`、`auditPrescriptionWithLingxi:214`、四情形返回 `ok:false`）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/app/api/diagnosis/post-prescription-risk/route.ts`（灵犀主 + 本地兜底已移除；不可用/无结构化药味即 fail-closed）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/his-scheme.ts`（`isPlaceholderContent:111`、`item():117-131` adoptable 改 `safetyLocked` 派生、别名数组 `:207-231`）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/diagnosis-prompts.ts`（`SENTINEL_INSTRUCTION`、`tcmLineageInstruction`、舌象注入处）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/diagnosis-types.ts`（`SafetyGate`、`CaseState`、`MAX_MODEL_OUTPUT_CHARS`、`CaseStateInputSchema`）
- `/Users/wangzeyuan/Desktop/中医CDSS/src/lib/diagnosis-engine.ts`、`/Users/wangzeyuan/Desktop/中医CDSS/src/app/diagnosis/DiagnosisClient.tsx`、`/Users/wangzeyuan/Desktop/中医CDSS/scripts/regress-tcm-cdss.mjs`
- 新增：`/Users/wangzeyuan/Desktop/中医CDSS/src/lib/cdss-vocab.ts`、`/Users/wangzeyuan/Desktop/中医CDSS/src/lib/tcm-lineages.ts`、`/Users/wangzeyuan/Desktop/中医CDSS/src/lib/tongue-diagnosis.ts`、`/Users/wangzeyuan/Desktop/中医CDSS/src/lib/wenzhen.ts`、`/Users/wangzeyuan/Desktop/中医CDSS/src/app/diagnosis/ResultTabsV2.tsx`、`/Users/wangzeyuan/Desktop/中医CDSS/src/app/diagnosis/TongueCaptureWizard.tsx`、`/Users/wangzeyuan/Desktop/中医CDSS/scripts/test/*.test.mjs`
