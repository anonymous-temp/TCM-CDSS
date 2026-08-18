# 中医非药物方案医生端输出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `tdd-workflow` to execute this plan task-by-task. Do not start production edits before the failing tests in each task exist.

**Goal:** 将“中医治疗项目”改造成只显示具体食疗、穴位/部位和频次的“中医非药物方案”，彻底阻止模板状态、来源等级、资质和安全闸门话术进入医生页面与可见 Markdown，同时保留后台治理对象和安全判断。

**Architecture:** 新增一个纯函数投影层，输入完整的 `nonPharma` 治理数据，输出最小医生端 DTO；React 页面和服务端 Markdown 只消费这份投影。投影层按项目类型验证内容完整性，无法形成实际方案的项目返回空，所有治理字段继续留在原始结构化载荷中供审计、HIS 和安全层使用。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript 5 strict、zod 4、Node `assert` + `jiti`、现有 Playwright 脚本。

---

## 范围与不可破坏项

- 设计依据：`docs/superpowers/specs/2026-08-18-treatment-project-clinician-output-design.md`。
- 本计划只整改医生可见“中医非药物方案”。不同时修改老年妊娠规则、M02 追问、流式阶段编排或知识库检索。
- 不删除或弱化 `protocolStatus`、`protocolSource`、`requiredChecks`、`techniqueBoundary`、`clinicianReviewRequired` 等后台字段。
- 不改变 M04 项目准入、排序、红旗门禁、适应证闸门、签名合同或 HIS 审计载荷。
- 不从治理话术中“抽几个词”拼成临床建议；只有现有结构化内容满足完整性合同才上屏。
- 历史快照与新生成结果必须经过同一投影，禁止旧 Markdown 作为失败回退。

## 目标 DTO 与共享 API

新文件：`src/lib/tcm-treatment-clinician-view.ts`

```ts
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";

type NonPharma = NonNullable<ClinicalReasoningResultV2["nonPharma"]>;
type TreatmentRecommendation = NonPharma["tcmTreatments"][number];

export type ClinicianTreatmentProject = {
  projectCode: TreatmentRecommendation["projectCode"];
  title: string;
  content: string;
  sitesOrPoints?: string[];
  schedule?: string;
};

export function buildClinicianTreatmentProjects(
  nonPharma: NonPharma | null | undefined,
): ClinicianTreatmentProject[];
```

投影规则必须集中在这一文件，不允许页面与 Markdown 再各写一套：

1. `diet_therapy`：`content` 读取已经过既有食疗净化的 `nonPharma.diet`；必须同时包含具体饮食行为和至少一个具体食物/食疗示例，否则隐藏。标题固定为“食疗与饮食”，不显示穴位。
2. `auricular`：标题固定为“耳穴压豆”；必须有非空穴位和完整的按压/换贴频次，`content` 使用简洁项目动作，不复用治理 `treatmentContent` 套话。
3. `moxibustion`：标题固定为“灸法”；必须有非空穴位/部位和每周频次、疗程或复评节点，`content` 使用简洁项目动作。
4. 其他项目：只有 `treatmentContent` 是具体操作内容、且该项目所需的部位/频次完整时才保留；标题使用已治理的 `projectName`。
5. `assessment_only_no_patient_specific_protocol` 一律不进入医生端投影。
6. 投影输出的任何字段包含内部治理词时整条拒绝，而不是把原始字符串净化后勉强上屏。内部词类至少包括：模板/未按证型加减/仅项目评估/政府发布方案/国家标准或规范/现场医师/资质/安全边界/烫伤风险/待终审/协议缺口及 `catalog_*` 状态码。
7. 输出去空白、去重复穴位；空数组不得序列化成空行。

### Task 1: 建立投影层的失败测试

**Files:**

- Create: `scripts/test-tcm-treatment-clinician-view.mjs`
- Modify: `package.json`
- Modify: `scripts/run-deterministic-regression.mjs`

**Step 1: 写测试夹具和行为断言**

在新测试中构造最小 `nonPharma`，覆盖下列类别：

```js
const internalTerms = /病种模板|未按证型加减|仅项目评估|政府发布方案|国家标准|规范|现场医师|资质|安全边界|烫伤风险|待终审|catalog_/;
```

- 具体反流食疗：“少量多餐，晚餐后3小时内不平卧；可用山药小米粥，每周3次。”应投影为“食疗与饮食”。
- 只有“食疗只作调护，由医生结合慢病限制指导”时不生成食疗卡。
- 耳穴含“脾、胃、神门、交感”和“每日按压3–5次，每次1–2分钟，每3–5天更换一次”时生成卡片。
- 耳穴缺穴位或缺频次时隐藏。
- 灸法有中脘、足三里且有“每周3次，2周后复评”时生成；缺穴位或缺频次时隐藏。
- 评估态气功/灸法即使有治理话术也隐藏。
- 任一输出字段不得命中 `internalTerms`。
- 原始治理对象深比较保持不变，证明投影无副作用。
- 三张卡全部不合格时返回 `[]`。

**Step 2: 注册测试命令**

在 `package.json` 增加：

```json
"test:tcm-treatment-clinician-view": "jiti scripts/test-tcm-treatment-clinician-view.mjs"
```

在 `scripts/run-deterministic-regression.mjs` 的中医治疗项目相关用例附近加入该命令。

**Step 3: 运行并确认测试按预期失败**

Run:

```bash
npm run test:tcm-treatment-clinician-view
```

Expected: 因 `src/lib/tcm-treatment-clinician-view.ts` 尚不存在而失败。

**Step 4: 提交测试红灯**

```bash
git add scripts/test-tcm-treatment-clinician-view.mjs package.json scripts/run-deterministic-regression.mjs
git commit -m "test: define clinician treatment projection contract"
```

### Task 2: 实现纯函数医生端投影

**Files:**

- Create: `src/lib/tcm-treatment-clinician-view.ts`
- Test: `scripts/test-tcm-treatment-clinician-view.mjs`

**Step 1: 实现最小类型与归一化函数**

实现以下内部帮助函数，保持纯函数与显式类型：

```ts
function cleanText(value: unknown): string;
function cleanList(values: readonly unknown[] | undefined): string[];
function containsInternalGovernanceText(value: string): boolean;
function hasConcreteDietAction(value: string): boolean;
function hasConcreteFoodExample(value: string): boolean;
function hasActionableSchedule(projectCode: string, value: string): boolean;
```

其中“具体饮食行为”和“食物示例”使用受控类别判据，不依赖某一个完整句子的单点字符串补丁；频次判据需识别每日/每周、次数/分钟、疗程/复评等同类表达。

**Step 2: 实现项目投影**

实现 `buildClinicianTreatmentProjects()`：

- 首先对 `nonPharma.diet` 调用既有 `safeDietAdviceForDisplay()`，再做食疗完整性检查。
- `diet_therapy` 不使用原始 `treatmentContent`。
- 耳穴/灸法只读取受治理穴位与频次；固定 `content` 为项目动作名称，不拼接“复核/实施/评估”等话术。
- 其他项目采用保守通用路径；不满足内容、部位或频次合同即舍弃。
- 对最终 DTO 做一次内部词扫描，命中则丢弃整卡。
- 不修改传入对象，不回写 `nonPharma`。

**Step 3: 运行专项测试**

Run:

```bash
npm run test:tcm-treatment-clinician-view
```

Expected: 全部通过。

**Step 4: 运行现有项目编译与类型测试**

Run:

```bash
npm run typecheck
npm run test:tcm-treatments
```

Expected: 全部通过；后台项目对象结构与既有准入行为不变。

**Step 5: 提交实现**

```bash
git add src/lib/tcm-treatment-clinician-view.ts
git commit -m "feat: project governed treatments for clinician display"
```

### Task 3: 页面只消费医生端投影

**Files:**

- Modify: `src/app/diagnosis/DiagnosisClient.tsx`
- Modify: `scripts/test-diagnosis-presentation-contract.mjs`
- Modify: `scripts/test-visible-output-hygiene.mjs`

**Step 1: 先读本仓库 Next.js 16 客户端组件文档**

Run:

```bash
find node_modules/next/dist/docs -path '*app*server-and-client-components*' -o -path '*app*css*'
```

完整阅读命中的客户端组件与样式指南，确认本次只做现有 Client Component 内的纯投影和 JSX 改造，不引入旧版 Next.js API。

**Step 2: 先添加页面源码契约的失败断言**

测试必须确认：

- 页面导入并调用 `buildClinicianTreatmentProjects`。
- 章节标题为“中医非药物方案”。
- 章节副标题不含“安全边界/本机构可开展”等系统说明。
- 源码不再渲染 `tcmTreatmentTailoringPresentation`、`sourceAuthorityTier`、`deferred*`、`protocolGap`、`techniqueBoundary`、`operatorRequirement`、`requiredChecks`。
- 空投影时整个 `cdss-section-tcm-treatment` 不渲染。

Run:

```bash
npm run test:presentation-contract
npm run test:visible-output-hygiene
```

Expected: 新断言失败，证明旧页面仍在泄漏治理字段。

**Step 3: 修改 React 页面**

在 `DiagnosisResult` 内只计算一次：

```ts
const clinicianTreatmentProjects = buildClinicianTreatmentProjects(reasoning.nonPharma);
```

删除当前治疗项目去重账本和所有后台治理字段 JSX。新卡片仅渲染：

- 项目标题；
- `核心内容`；
- 有值时的 `穴位/部位`；
- 有值时的 `频次/复评`。

章节条件改为 `clinicianTreatmentProjects.length > 0`，网格保持移动端单列、`sm` 以上双列。不得添加来源徽标、状态徽标、折叠安全区或“暂无方案”空卡。

**Step 4: 运行专项与静态检查**

Run:

```bash
npm run test:tcm-treatment-clinician-view
npm run test:presentation-contract
npm run test:visible-output-hygiene
npm run typecheck
npm run lint
```

Expected: 全部通过。

**Step 5: 提交页面改造**

```bash
git add src/app/diagnosis/DiagnosisClient.tsx scripts/test-diagnosis-presentation-contract.mjs scripts/test-visible-output-hygiene.mjs
git commit -m "fix: show only actionable non-drug treatment content"
```

### Task 4: 服务端可见 Markdown 与页面共用投影

**Files:**

- Modify: `src/lib/diagnosis-visible-summary.ts`
- Modify: `scripts/test-visible-output-hygiene.mjs`
- Modify: `scripts/test-cough-template-end-to-end.mjs`

**Step 1: 先写跨出口一致性的失败测试**

给历史载荷构造一个含下列字段的项目：

```js
{
  protocolStatus: "governed_class_template_not_syndrome_tailored",
  protocolGap: "catalog_indication_mismatch",
  treatmentContent: "本例命中标准取穴模板，由现场医师复核后实施",
  techniqueBoundary: "由现场医师确认热证和烫伤风险后实施",
  operatorRequirement: "由受训人员操作"
}
```

断言 Markdown：

- 不含这些治理字段的任何文案。
- 合格耳穴/灸法仍显示具体穴位和频次。
- 合格食疗显示净化后的具体饮食内容。
- 全部投影为空时不出现“中医非药物方案”标题。

Run:

```bash
npm run test:visible-output-hygiene
npm run test:cough-template-e2e
```

Expected: 新断言失败。

**Step 2: 用共享投影替换旧 Markdown 展开**

在 `diagnosis-visible-summary.ts` 中：

- 导入 `buildClinicianTreatmentProjects`。
- 删除“方案状态、对应病机、方案边界说明、待终审、来源、操作禁忌与资质”等医生可见拼接。
- 按 DTO 输出 `### 中医非药物方案` 与四个允许字段。
- 保留 `nonPharma.diet/lifestyle/emotion/precautions` 原有调护区，但避免食疗项目与“饮食”重复：当已生成 `diet_therapy` 卡时，调护区仍可保留简短饮食调养，项目区不得再生成第二份相同内容。
- 旧 `tcmTreatmentTailoringPresentation` 若仍供非医生出口使用可保留导出；若所有调用消失，再由 TypeScript/引用扫描决定是否删除，不做顺手清理。

**Step 3: 运行跨出口测试**

Run:

```bash
npm run test:tcm-treatment-clinician-view
npm run test:visible-output-hygiene
npm run test:cough-template-e2e
npm run test:presentation-contract
```

Expected: 页面与 Markdown 输出合同一致，全部通过。

**Step 4: 提交 Markdown 收口**

```bash
git add src/lib/diagnosis-visible-summary.ts scripts/test-visible-output-hygiene.mjs scripts/test-cough-template-end-to-end.mjs
git commit -m "fix: share clinician treatment projection across outputs"
```

### Task 5: 防止治理字段被误删或安全层退化

**Files:**

- Modify: `scripts/test-tcm-treatment-clinician-view.mjs`
- Modify: `scripts/test-tcm-treatment-projects.mjs` only if an existing assertion needs a clearer invariant

**Step 1: 添加双层回归断言**

- 医生 DTO 键集合严格等于 `projectCode/title/content/sitesOrPoints/schedule`。
- 原始结构化项目仍保留 `protocolStatus/protocolSource/requiredChecks/techniqueBoundary/operatorRequirement/clinicianReviewRequired`。
- `assessment_only` 项目在医生端隐藏，但仍存在原始 M04 结构化对象中。
- 红旗或机构能力范围无效时，现有编译函数仍返回空项目。

**Step 2: 运行安全和合同回归**

Run:

```bash
npm run test:tcm-treatment-clinician-view
npm run test:tcm-treatments
npm run test:stage-contract
npm run test:m04-safety-contract
npm run test:guard-symmetry
```

Expected: 全部通过。

**Step 3: 提交回归保护**

```bash
git add scripts/test-tcm-treatment-clinician-view.mjs scripts/test-tcm-treatment-projects.mjs
git commit -m "test: preserve treatment governance behind clinician projection"
```

### Task 6: 全量本地验证与浏览器截图

**Files:**

- Modify: `scripts/e2e-release-journey.mjs`
- Output only: `artifacts/811-evidence/`（不提交）

**Step 1: 扩展现有 E2E 断言**

在完成结果后读取 `#cdss-section-tcm-treatment`（存在时）：

- 标题为“中医非药物方案”。
- 不命中内部治理词正则。
- 每张卡有项目名称和核心内容。
- 耳穴/灸法卡分别具有穴位与频次。
- 页面无空卡和横向溢出。

**Step 2: 运行发布总闸**

Run:

```bash
npm run verify:release
```

Expected: typecheck、lint、两轮 deterministic、production build 全部通过。

**Step 3: 启动生产构建并运行浏览器回归**

Run:

```bash
npm start
BASE_URL=http://localhost:3000 CDSS_API_TOKEN=<configured-token> E2E_OUTPUT_DIR=artifacts/811-evidence/treatment-project node scripts/e2e-release-journey.mjs
```

如端口已被占用，先用只读命令确认进程和对应工作树，不终止未知进程；改用明确空闲端口启动本次构建。

**Step 4: 针对甲方反流病例截图**

用同一套 8.11 反流病例运行到 M04，保存：

- 桌面端“中医非药物方案”完整模块；
- 移动端同一模块；
- 页面全文内部词扫描结果 JSON；
- 若某项目因不满足内容合同被隐藏，保存结构化原始项目与医生投影的对照 JSON（仅测试产物，不进客户文档）。

截图预期：只有具体食疗、明确穴位/部位、频次/复评；不出现任何模板、来源、资质、安全边界或“现场医师确认”话术。

**Step 5: 提交 E2E 合同**

```bash
git add scripts/e2e-release-journey.mjs
git commit -m "test: verify actionable treatment cards in browser"
```

## 最终自审与交付门禁

执行完成后逐项核对：

1. `git diff` 中没有 `.env*`、密钥、浏览器产物或 `.superpowers/`。
2. 页面和 Markdown 都只消费共享投影；没有第三个手写出口。
3. 原始治理字段仍在结构化对象、签名合同与安全测试中。
4. 所有设计验收项均有自动化断言或截图证据。
5. 本子项目完成后再分别为老年妊娠误报、模块级流式输出、M02/知识库有效性编写并确认规格；未完成前不得向用户宣称“甲方问题全部解决”。

## 计划完成判据

- `npm run verify:release` 通过。
- 专项 E2E 通过且桌面/移动截图均完成。
- 反流病例可见模块不含内部治理词。
- 后台治理和安全回归不退化。
- 代码、测试和计划均已提交到当前分支；推送与部署在用户批准执行阶段后统一进行。
