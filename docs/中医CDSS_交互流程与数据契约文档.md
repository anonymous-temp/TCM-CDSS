# 中医 CDSS 交互流程与数据契约文档

## 1. 产品定位

中医 CDSS 页面是独立的中医辅助诊疗 Copilot，不放在循证护理主页，也不复用护理平台的课程、示教或护理助手内容。系统面向门诊医生，嵌入或模拟甲方 HIS 的“AI 诊疗支持方案”区域，辅助医生完成中医辨证论治、候选处方生成和风险随访提示。

页面不展示工程化过程、不展示无意义的中间思考、不复述医生已在病历中录入的信息。医生首先看到的是：是否需要补问、为什么补问、补问选项是什么；信息充分后看到的是诊断、证候、病机、方药、风险和随访。

## 2. 页面布局

整体采用 HIS 工作台式布局：

1. 顶部：诊疗阶段进度条、新建诊疗按钮、报告下载按钮。
2. 左侧主体：门诊病历录入区，包括一诉五史、生命体征、四诊信息、舌象上传、检验检查和问诊补充。
3. 右侧主体：AI 诊疗支持方案，包括等待态、追问态、推理态和结果态。
4. 不保留无法点击的左侧“接诊/病历/处方/随访”导航。
5. 不展示“相关课程示教”“HIS 对接数据”等与中医 CDSS 无关的信息。

页面允许使用 Tab，但只用于有真实内容和状态的功能切换，例如中药饮片/西药中成药候选方案切换；禁止保留空壳导航或点击无反馈的栏目。

## 3. 医生输入流程

### 3.1 初始状态

医生进入页面后，只显示病历录入区和右侧等待态。右侧不显示红旗风险、信息充分度、用药风险和诊断结论。

等待态文案表达为：请录入主诉、病史、生命体征和四诊信息后点击 AI 辅助推理。系统将在提交后分析红旗风险、信息缺口、辨证结果和候选方案。

### 3.2 病历录入

输入结构：

| 区域 | 字段 | 交互 |
|---|---|---|
| 一诉五史 | 主诉、现病史、既往史、过敏史、用药史、个人史/家族史 | 主诉必填；其他可空或按医生输入 |
| 生命体征 | T、P、R、BP、SpO2、意识状态 | 手动输入；未测量可空；已输入则做格式和异常校验 |
| 望诊 | 面色、神态、形体等 | 特征词点击 + 手动输入；不上传面照 |
| 舌象 | 舌质、舌形、舌苔、润燥、舌下络脉 | 图片上传 + 特征词点击 + 手动输入 |
| 闻诊 | 声音、气味、咳喘、呕吐等 | 特征词点击 + 手动输入 |
| 问诊 | 寒热、汗出、口渴、饮食、睡眠、二便、疼痛、情志、月经等 | 特征词点击 + 手动输入 |
| 切诊 | 脉象 | 特征词点击 + 手动输入 |
| 辅助检查 | 检验检查、影像、既往诊断 | 手动输入；无结果可空 |

舌象、面象、脉象等特征词选择后应自动收起选择面板，已选内容进入对应输入框或标签区。

### 3.3 提交推理

医生点击“AI 辅助推理”后，系统开始完整流程。此时右侧进入推理态，显示阶段进度：

1. 病例标准化。
2. 红旗筛查和安全槽位判断。
3. 证据检索。
4. 辨病辨证和病机拆解。
5. 候选方药和风险提示。
6. 随访计划。

推理态只显示当前阶段，不显示模型隐藏思维链。

## 4. 追问交互

系统最多追问一轮。追问由后端 `slotPlanner + followupPlanner` 统一生成，问题必须与本次缺口直接相关。

追问卡片结构：

```ts
export type FollowupQuestion = {
  id: string;
  question: string;
  reason: string;
  relatedSlots: string[];
  impact: "红旗排查" | "西医诊断" | "中医证候" | "病机治法" | "处方安全" | "随访";
  answerMode: "single" | "multiple" | "text" | "number" | "vitals";
  options: Array<{
    label: string;
    value: string;
    valueStatus?: "positive" | "negative" | "unknown" | "not_applicable";
    patch: Array<{ path: string; value: unknown; source: "doctor_input" | "patient_report" }>;
  }>;
  allowFreeText: boolean;
};
```

交互要求：

1. 问题必须带选项，医生能直接点击完成答复。
2. 选项必须能回填到对应病历字段，例如年龄问题应出现年龄输入框，而不是只有“已填写年龄”按钮。
3. 追问卡片底部提供“提交补充信息并继续推理”按钮。
4. 医生提交追问后，系统自动恢复后续推理，不要求医生回到顶部再次点击。
5. 若医生选择“不清楚/暂未测量”，系统记录为明确未知，并按信息不足或安全提示处理。

示例：

```json
{
  "question": "入睡困难持续多久，每晚大约睡眠几小时？",
  "reason": "病程和睡眠时长会影响失眠程度、西医诊断分层和中医虚实判断。",
  "impact": "西医诊断",
  "answerMode": "single",
  "options": [
    {
      "label": "小于1周，每晚约4-6小时",
      "value": "acute_mild",
      "valueStatus": "positive",
      "patch": [
        { "path": "presentIllness.course", "value": "小于1周", "source": "doctor_input" },
        { "path": "symptoms.sleepDuration", "value": "每晚约4-6小时", "source": "doctor_input" }
      ]
    },
    {
      "label": "1-4周，每晚约2-4小时",
      "value": "subacute_moderate",
      "valueStatus": "positive",
      "patch": [
        { "path": "presentIllness.course", "value": "1-4周", "source": "doctor_input" },
        { "path": "symptoms.sleepDuration", "value": "每晚约2-4小时", "source": "doctor_input" }
      ]
    },
    {
      "label": "超过1个月，每晚少于3小时",
      "value": "chronic_severe",
      "valueStatus": "positive",
      "patch": [
        { "path": "presentIllness.course", "value": "超过1个月", "source": "doctor_input" },
        { "path": "symptoms.sleepDuration", "value": "每晚少于3小时", "source": "doctor_input" }
      ]
    }
  ],
  "allowFreeText": true
}
```

## 5. AI 输出结构

结果页不使用多个空 Tab，也不把完整报告作为普通 Tab 混在主流程中。主结果采用卡片分层：

1. 顶部摘要条：红旗状态、处方级输出状态、证据完整度、报告下载。
2. 诊断卡片：西医诊断、中医证候、证据支持。
3. 证候-病机-治法卡片：以链路或轴线展示从患者事实到证候、总体病机、子病机、治法。
4. 中药饮片处方卡片：处方笺式展示候选处方。
5. 西药/中成药卡片：与中药饮片处方使用 Tab 切换。
6. 用药风险提示条：有风险才展示；无风险不展示。
7. 风险随访时间轴：融合时间点、医生/患者动作、观察指标、触发处置；证据检索结果在独立证据区呈现，不与随访动作重复。
8. 证据链卡片：统一展示所有引用来源和使用位置。
9. 病历解析信息：放在可折叠区，不在主对话流复述。

## 6. 诊断卡片

诊断卡片分为左右两栏：

### 6.1 西医诊断

字段：

```ts
export type WesternDiagnosisResult = {
  primary: {
    name: string;
    status: "考虑" | "需排除" | "证据不足";
    confidence: "高" | "中" | "低";
    supportingFacts: string[];
    contraryFacts: string[];
    evidenceIds: string[];
  };
  differentials: Array<{
    name: string;
    reason: string;
    nextCheck?: string;
    evidenceIds: string[];
  }>;
};
```

展示要求：西医诊断必须有支持证据，不再写成问句，不再使用“参考西医诊断”标题。

### 6.2 中医证候

字段：

```ts
export type TcmSyndromeResult = {
  diseaseName?: {
    name: string;
    status: "待医师确认" | "证据不足" | "已由医生录入";
  };
  primarySyndrome: string;
  secondarySyndromes: string[];
  confidence: "高" | "中" | "低";
  syndromeEvidence: Array<{
    factor: string;
    patientFact: string;
    interpretation: string;
  }>;
  evidenceIds: string[];
};
```

展示要求：主界面以证候为诊疗核心，证候必须关联病机，不把症状当作证候。结构化数据可保留中医病名字段用于 HIS/审方对接；证据不足时显示为“待医师确认”，不抢占主结论。

## 7. 证候-病机-治法链

该卡片用于替代重复的“病机证据链”散文。建议使用横向或纵向链路：

```txt
患者事实 -> 证候 -> 总体病机 -> 子病机 -> 治法 -> 药组
```

每个节点可展开查看：

1. 患者事实：主诉、病程、睡眠、寒热、二便、舌象、脉象等。
2. 证候：主证、兼证、置信度。
3. 总体病机：一句话概括。
4. 子病机：主次权重、对应症状。
5. 治法：每个子病机对应一个子治疗方向。
6. 药组：主要治疗药物、增强配伍、对症处理药物。

医生可在采集区选择“诊疗思路偏好 / 流派偏好”（如不限定、经方思路、温病思路、脾胃学派、孟河医派、岭南医派、院内方案优先等）。该字段仅作为辨证视角、方源选择和加减说明的偏好约束，必须低于红旗排查、安全门控、药典剂量、说明书/指南、禁忌和相互作用规则；当病例证据不支持所选思路时，模型必须说明不适用并给出更匹配的替代方向。

## 8. 中药饮片处方卡片

中药饮片处方必须像处方，不再只展示大段文本。

卡片顶部：

1. 候选处方名称。
2. 基础方/经方/验方/院内方来源。
3. 剂数、煎服法、疗程。
4. 适用条件和不适用条件。
5. 方证对应摘要。
6. 对医生所选诊疗思路偏好的响应或不采用理由。

处方正文表格：

| 药名 | 炮制/规格 | 每剂剂量 | 每日/总剂量 | 煎服法 | 君臣佐使 | 处方角色 | 对应病机/症状 | 存在意义 | 证据 | 安全提示 |
|---|---|---|---|---|---|---|---|---|---|---|

每味药的“处方角色”和“存在意义”直接嵌入处方行，不再单独放一个重复卡片。

候选处方 2 可默认折叠，或使用候选处方 Tab 切换。候选处方 2 必须与候选处方 1 同等结构化，不能只写“同上”。

## 9. 西药/中成药方案卡片

西药/中成药与中药饮片处方使用同一卡片内 Tab：

1. 中药饮片。
2. 西药/中成药。

西药/中成药字段：

| 药品类型 | 药品/方案 | 规格 | 用法用量边界 | 疗程 | 用药定位 | 对应问题 | 证据 | 联用/替代关系 | 风险提示 |
|---|---|---|---|---|---|---|---|---|---|

用药定位包括“联合治疗”“替代方案”“短期对症”“暂不生成具体药品”。没有说明书或指南证据时，不输出具体药品和剂量。

## 10. 用药风险提示条

风险提示有则出，无则不出。展示形式为处方卡片上方的独立提示条：

```ts
export type RiskNoticeBar = {
  highestSeverity: "强提示" | "一般提示" | "信息不足提示";
  reviewDisposition: "可展示候选处方" | "需修正后展示" | "不生成剂量级处方" | "需药师复核";
  notices: RiskWarning[];
};
```

提示条内容：

1. 风险点。
2. 关联药味/药品。
3. 触发依据。
4. 医生动作。

不因“未提及过敏史/当前用药”泛化提示。只有候选药物明确涉及过敏、相互作用或禁忌时，才提示医生确认。

## 11. 风险随访时间轴

随访卡片采用时间轴，不再单独展示表格。每个时间节点融合表单字段：

```ts
export type FollowupTimelineItem = {
  timePoint: string;
  actorAction: string;
  observationItems: string[];
  triggerAction: string;
  evidenceIds: string[];
};
```

展示样式：

```txt
当日开方前
医生动作：核对候选处方、过敏/当前用药、特殊人群和风险提示
观察指标：主诉严重度、T/P/R/BP、舌脉、用药风险提示
触发处置：强提示未解除时调整药味/剂量或请药师复核
依据：[EVID-001] [RULE-023]
```

时间点建议包括：当日开方前、服药 1-3 日、疗程结束、症状加重或出现红旗时、复诊复评。

## 12. 证据链展示

证据链采用统一引用格式：

```txt
[EVID-GUIDE-001] 指南题名 | 发布机构 | 年份 | 用途：西医诊断
[RULE-TCM-DOSE-042] 药典剂量规则 | 中国药典2020/2025 | 用途：饮片剂量
[LABEL-NMPA-018] 药品说明书 | 企业/批准文号 | 用途：禁忌与相互作用
```

在诊断、证候、处方行和风险提示中只展示证据 ID。点击证据 ID 后，在证据链卡片中定位对应来源。

## 13. 甲方 HIS 对接输出

本节为目标态 HIS 对接契约：AI 诊疗支持方案输出统一为 JSON，甲方前端可直接渲染，不依赖 Markdown 正则解析。

当前实现仍保留 `/api/diagnosis/*` 的 M01-M05 Markdown/NDJSON 兼容层；迁移期不得把兼容层输出误认为目标态契约。新建 `/api/tcm-cdss/*` 后，以本节 JSON payload 和 SSE run event 为准，Markdown 仅作为报告导出格式。

```ts
export type TcmCdssAiSupportPayload = {
  runId: string;
  status:
    | "waiting"
    | "analyzing"
    | "needs_followup"
    | "completed"
    | "insufficient_information"
    | "red_flag_referral"
    | "degraded"
    | "error";
  stage: CdssStage;
  summary: {
    chiefComplaint: string;
    redFlagStatus?: "低风险" | "需关注" | "高风险" | "无法评估";
    prescriptionOutputStatus?: "可生成候选处方" | "需修正后展示" | "需药师复核" | "仅输出建议" | "不生成剂量级处方";
    evidenceCompleteness?: "充分" | "部分充分" | "不足";
  };
  followupQuestions?: FollowupQuestion[];
  diagnosis?: {
    western: WesternDiagnosisResult;
    tcm: TcmSyndromeResult;
  };
  pathogenesis?: PathogenesisGraph;
  prescriptions?: {
    herbalCandidates: HerbalPrescriptionCandidate[];
    westernCpmPlan?: WesternCpmPlan;
  };
  riskNotice?: RiskNoticeBar;
  followupTimeline?: FollowupTimelineItem[];
  evidenceCitations: EvidenceCitation[];
  parsedCase?: {
    collapsedByDefault: true;
    normalizedCase: NormalizedTcmCase;
  };
  report?: {
    markdown?: string;
    pdfUrl?: string;
  };
  audit: {
    model: string;
    knowledgeVersion: string;
    evidenceRetrievedAt: string;
    sourceStatuses: Array<{
      source: "local_tcm" | "rx_audit_db" | "evimed_guide" | "evimed_instruction" | "evimed_search" | "official_web";
      status: "hit" | "no_hit" | "failed" | "skipped" | "degraded";
      reason?: string;
    }>;
    ruleExecution: Array<{
      ruleSet: string;
      version: string;
      status: "completed" | "failed" | "skipped";
      skippedReason?: string;
    }>;
    traceId: string;
    generatedAt: string;
  };
};
```

实际实现建议将 `TcmCdssAiSupportPayload` 定义为按 `status` 区分的 discriminated union：`needs_followup` 必须包含 `followupQuestions`；`completed` 必须包含 `diagnosis`、`pathogenesis`、`evidenceCitations`；`red_flag_referral` 必须包含红旗依据和转诊建议，且不得包含剂量级处方。

渲染规则：

1. `waiting`：只显示等待态。
2. `analyzing`：显示阶段进度。
3. `needs_followup`：显示追问卡片和提交按钮。
4. `completed`：显示完整诊疗支持方案。
5. `insufficient_information`：显示缺失项、影响范围和可补充路径，不显示具体剂量处方。
6. `red_flag_referral`：显示急危重风险、转诊建议和可携带信息摘要，不显示候选处方。
7. `degraded`：显示已完成的可核验结果、降级原因和人工复核路径；不得一键采纳未完成安全复核的处方。
8. 红旗状态为“无法评估”时，只在医生点击 AI 辅助推理后展示；若主诉属于胸痛、气促、晕厥、意识异常、高热寒战、出血等高风险场景且缺少关键生命体征，不得标为低风险。

## 14. 前后端状态一致性

1. 病历输入修改后，旧 AI 结果标记为“病历已修改，等待重新分析”，不继续展示旧红旗状态和旧诊断结论。
2. 追问答复提交后自动继续同一 `runId`，不得静默进入推理或按钮无反应。
3. 所有可点击 Tab、按钮、折叠区必须有真实状态变化。
4. 目标态处方和风险结果以结构化 JSON 为准，不再用前端正则从 Markdown 中猜测；当前 M01-M05 兼容层只允许作为过渡实现。
5. 右侧风险摘要只展示 AI 提交后的状态，不在医生录入过程中提前判定。

## 15. 报告下载

完整报告入口放在右上角“报告”按钮中。报告内容包括：

1. 病历摘要。
2. 红旗筛查和信息缺口。
3. 西医诊断。
4. 中医证候、病机和治法。
5. 中药饮片候选处方。
6. 西药/中成药方案。
7. 用药风险提示。
8. 随访计划。
9. 证据引用清单。
10. 模型和知识库版本。

报告可以由结构化 JSON 生成 Markdown/PDF，不作为主页面 Tab 展示。

## 16. 异常态、部分结果和降级渲染矩阵

为避免前端在异常态自行发挥，所有主卡片必须按状态矩阵渲染。任何卡片不得因为字段缺失而显示空白卡、重复散文或无反馈按钮。

注意区分两类信号：`TcmCdssAiSupportPayload.status` 是 payload 终态或阶段态；`RunEvent.event` 是 SSE 事件名。`payload.partial` 只能作为 SSE event 出现，不得加入 payload status 枚举。

| Payload status / Run event | 摘要条 | 追问卡 | 诊断卡 | 处方卡 | 风险提示 | 随访时间轴 | 医生可操作 |
|---|---|---|---|---|---|---|---|
| `waiting` | 不展示风险结论 | 不展示 | 不展示 | 不展示 | 不展示 | 不展示 | 录入病历并提交 |
| `analyzing` | 展示当前阶段和耗时 | 不展示 | 骨架态或上一版置灰 | 骨架态或不展示 | 不展示未完成风险 | 不展示 | 禁止重复提交，允许取消或等待 |
| `needs_followup` | 展示“需补充信息” | 展示结构化问题 | 不展示新诊断 | 不展示剂量处方 | 仅展示与追问相关的安全原因 | 不展示 | 提交追问答复或修改左侧病历后重评估 |
| SSE event `payload.partial` | 展示已完成阶段 | 不展示或保留待答追问 | 有结构化诊断才展示 | 仅结构化处方且已过最低安全复核才展示 | 有则展示，未知不假设低风险 | 有结构化条目才展示 | 可继续等待，不允许采纳未复核处方 |
| `completed` | 完整展示 | 不展示 | 展示 | 展示 | 有风险才展示 | 展示 | 下载报告、复制或后续采纳 |
| `insufficient_information` | 展示“信息不足” | 可展示缺口问题 | 可展示诊断倾向，但必须标注“证据不足/需确认” | 不展示剂量级处方 | 展示缺口影响 | 展示补充路径 | 补齐信息后重评估 |
| `red_flag_referral` | 展示高风险 | 不再追问非必要项 | 仅展示需排除方向 | 不展示候选处方 | 展示红旗依据 | 展示转诊/急诊路径 | 下载可携带摘要 |
| `degraded` | 展示降级原因 | 按缺口展示 | 展示可核验部分 | 按 `reviewDisposition` 降级 | 必须展示源失败状态 | 展示人工复核路径 | 继续查看但不能一键采纳 |
| `error` | 展示失败阶段 | 保留可恢复输入 | 保留已完成且与当前病历匹配的结果 | 保留已完成且已复核的结果 | 保留确定性风险 | 保留已完成随访 | 重试当前阶段或新建诊疗 |

若已有结果对应旧病历，前端必须显示“病历已修改，等待重新分析”，并隐藏或置灰旧红旗状态、旧诊断和旧处方采纳状态。

## 17. 标准化病历字段树和追问 Patch Path

`FollowupQuestion.options[].patch.path` 不得是自由字符串，必须来自标准字段树。后端生成非法 path 时应 schema 校验失败并转为文本追问或降级报告。

`NormalizedTcmCase` 是脱敏后的模型输入和节点状态，不得包含患者姓名、证件号、就诊号、手机号、地址等 PHI。HIS 授权展示层如需显示姓名，应使用独立的院内 display-only 上下文，且不得进入模型、外部检索、trace 或通用报告导出。

最小字段树如下，后续扩展只能追加，不得改变既有 path 语义：

```ts
export type NormalizedTcmCase = {
  patient: {
    sex?: ClinicalFact<"男" | "女" | "其他" | "不详">;
    age?: ClinicalFact<number>;
    pregnancy?: ClinicalFact<"妊娠" | "备孕" | "哺乳" | "否认" | "不适用" | "不清楚">;
    weightKg?: ClinicalFact<number>;
  };
  chiefComplaint: ClinicalFact<string>;
  presentIllness: {
    course?: ClinicalFact<string>;
    onset?: ClinicalFact<string>;
    severity?: ClinicalFact<string>;
    aggravatingRelievingFactors?: ClinicalFact<string>;
  };
  symptoms: {
    sleepDuration?: ClinicalFact<string>;
    chestPain?: ClinicalFact<boolean>;
    dyspnea?: ClinicalFact<boolean>;
    syncope?: ClinicalFact<boolean>;
    feverRigors?: ClinicalFact<boolean>;
    bleeding?: ClinicalFact<boolean>;
    bowel?: ClinicalFact<string>;
    urination?: ClinicalFact<string>;
    thirstDiet?: ClinicalFact<string>;
    emotion?: ClinicalFact<string>;
    pain?: ClinicalFact<string>;
  };
  vitals: {
    temperatureC?: ClinicalFact<number>;
    pulsePerMin?: ClinicalFact<number>;
    respirationPerMin?: ClinicalFact<number>;
    bloodPressure?: ClinicalFact<{ systolic: number; diastolic: number }>;
    spo2?: ClinicalFact<number>;
    consciousness?: ClinicalFact<string>;
  };
  tcmFourDiagnosis: {
    inspection?: ClinicalFact<string>;
    tongue?: ClinicalFact<string>;
    pulse?: ClinicalFact<string>;
    inquiry?: ClinicalFact<string>;
  };
  history: {
    pastHistory?: ClinicalFact<string>;
    allergyAdr?: ClinicalFact<string>;
    currentMedication?: ClinicalFact<string>;
    familyPersonalHistory?: ClinicalFact<string>;
  };
  exams?: ClinicalFact<string>;
};

export type FollowupPatchPath =
  | "patient.sex"
  | "patient.age"
  | "patient.pregnancy"
  | "patient.weightKg"
  | "presentIllness.course"
  | "presentIllness.onset"
  | "presentIllness.severity"
  | "symptoms.sleepDuration"
  | "symptoms.chestPain"
  | "symptoms.dyspnea"
  | "symptoms.syncope"
  | "symptoms.feverRigors"
  | "symptoms.bleeding"
  | "vitals.temperatureC"
  | "vitals.pulsePerMin"
  | "vitals.respirationPerMin"
  | "vitals.bloodPressure"
  | "vitals.spo2"
  | "vitals.consciousness"
  | "tcmFourDiagnosis.tongue"
  | "tcmFourDiagnosis.pulse"
  | "history.allergyAdr"
  | "history.currentMedication"
  | "exams";
```

`answerMode` 必须使用 discriminated union：

1. `single`：只能提交一个 option 的 patch。
2. `multiple`：patch 按选项声明顺序合并；同一 path 默认禁止多次写入，确需覆盖时必须显式 `replace: true`。
3. `text`：自由文本写入指定 path，必须记录 `source` 和原文。
4. `number`：包含单位和最小/最大校验。
5. `vitals`：内置 T/P/R/BP/SpO2/意识状态输入和格式校验。

## 18. 医生决策动作和 HIS 写回事件

Copilot 输出不是最终医嘱。医生必须拥有明确的决策动作：

1. `adopt`：采纳候选项。
2. `modify_and_adopt`：修改后采纳。
3. `reject`：不采纳。
4. `copy_report`：复制或下载脱敏报告。
5. `request_pharmacist_review`：发起药师复核。

写回或采纳 payload：

```ts
export type DoctorDecisionEvent = {
  runId: string;
  caseVersion: number;
  action: "adopt" | "modify_and_adopt" | "reject" | "copy_report" | "request_pharmacist_review";
  target:
    | { type: "diagnosis"; id: string }
    | { type: "herbal_prescription"; candidateId: string }
    | { type: "western_cpm"; itemId: string }
    | { type: "followup"; itemId?: string };
  originalPayloadHash: string;
  doctorEditedText?: string;
  overrideReason?: string;
  reviewerId?: string;
  decidedAt: string;
};
```

当 `overrideReasonRequired=true` 或 `reviewDisposition` 为“需药师复核/需修正后展示/不生成剂量级处方”时，前端不得提供直接采纳按钮；若业务允许覆盖，必须要求医生填写 `overrideReason` 并进入审计记录。

## 19. 运行取代、刷新和隐私持久化策略

本页面启用 24 小时本机短期恢复，以避免刷新或误关页面导致病例和推理结果丢失。为兼顾隐私和使用流畅性：

1. 仅保存经直接标识符清洗后的病历草稿、结构化结果、追问选择和当前阶段；患者姓名、证件号、手机号、住址以及舌照原图不得进入 localStorage。
2. 快照 24 小时自动过期；新建病例或医生主动清空时必须同步删除病例和工作区快照。
3. 任一新 run 启动时，旧的 `needs_followup` run 必须标记为 `superseded`，前端收到 `run.superseded` 后隐藏旧追问卡。
4. 追问答复必须携带 `runId`、`caseVersion` 和补丁；若病历已被修改，后端必须拒绝合并旧追问并要求重新评估。
5. 运行中断后，若有服务端 run-store，应通过 `Last-Event-ID` 恢复 SSE；若无 run-store，只恢复已确认的阶段结果，并把中断阶段置为可重试，不得假装该阶段已完成。

## 20. 过渡期实现对照和不可回退约束

当前实现仍是 M01-M05 线性链路和 Markdown/NDJSON 兼容层，不得把它误写成已完成 LangGraph/ReAct。过渡期必须遵守：

1. `scripts/regress-tcm-cdss.mjs` 是当前 golden-case 基线，覆盖红旗、否定病史、安全网污染、过敏/用药 false positive、知识库和鉴权。任何改动必须先跑通该基线。
2. 前端可继续解析 Markdown，但新的结构化字段必须优先于 Markdown 正则；同一信息不得在摘要、卡片、折叠区重复展示超过一次。
3. M05 当前是确定性风险随访和后置审方组合，不应在 UI 或文档中宣称为独立模型智能体。
4. 处方安全审查只作提示、不作硬拦截：若后置审方失败、返回 BLOCK/人工复核，或药味/剂量无法解析，应醒目展示“需医生/药师复核”，不得把未检出风险等同为无风险；是否阻断仅由红旗、关键资料缺失、输出截断和处方对象不一致等独立确定性安全门决定。
5. 新增 `/api/tcm-cdss/:path*` 时必须同步纳入 `src/proxy.ts` matcher 和 auth 回归，不能产生未鉴权旁路。

## 21. 方剂出处与证据呈现契约

方剂出处、现代证据和本例配伍理由是三类不同主张，禁止混写：

1. `single_base`：方名与实际药味组成通过服务端校验后，展示“经典方出处”；优先使用 200 首古代经典名方目录，其他本地方剂汇编仅以中置信度展示。
2. `combined`：逐一校验并展示每个基础方出处；任一基础方未通过组成校验时，不得把整张处方标记为已核验合方。
3. `self_devised`：只展示“组方依据”，说明本例证候、病机、治法和配伍逻辑，不显示古籍出处栏。
4. `single_herb`：分开呈现本例配伍意义与已命中的药典/本草/剂量安全依据；没有可靠来源时省略来源，不显示占位词。
5. 同名异方必须按药味组成 F1 和第二名分差消歧；零重合、低相似或结果歧义时一律不显示出处。
6. 客户页面、流式预览、下载报告和 HIS payload 均不得出现“证据不足/待检索”“检索失败”“未配置”“内部证据缺口”或供应商错误码；缺口只保留在内部结构化状态和服务端日志。
7. 证据展示缺口不构成整份方案的安全锁。红旗、关键资料缺失、输出截断、处方展示对象与审方对象不一致等独立确定性门控仍按原规则执行。
8. 本地剂量数据含 2020 版药典历史基线；自 2025 年 10 月 1 日起，正式采纳必须依据现行 2025 年版药典、现行说明书和院内药事规则复核。
