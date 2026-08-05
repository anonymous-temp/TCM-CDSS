# 中医 CDSS 对外接口文档

| 项 | 内容 |
|---|---|
| 文档版本 | V1.0 |
| 发布日期 | 2026-08-05 |
| 接口基址 | `https://82.156.128.153/tcm-cdss` |
| 协议 | HTTPS |
| 字符编码 | UTF-8 |

---

## 1. 接口清单

| 序号 | 接口名称 | 方法 | 路径 | 说明 |
|---|---|---|---|---|
| 1 | 访问凭证获取 | POST | `/api/auth/access` | 令牌换取页面访问 Cookie |
| 2 | M01 病历采集 | POST | `/api/diagnosis/collect` | 自由文本病历结构化 |
| 3 | M02 追问生成 | POST | `/api/diagnosis/question` | 生成缺口追问 |
| 4 | M03 辨病辨证 | POST | `/api/diagnosis/diagnose` | 西医诊断 + 中医证候 + 病机 |
| 5 | M04 候选方药 | POST | `/api/diagnosis/prescribe` | 中药处方与中成药候选 |
| 6 | M05 风险随访 | POST | `/api/diagnosis/assess` | 用药风险与随访计划 |
| 7 | 红旗筛查 | POST | `/api/diagnosis/red-flags` | 急危重症征象筛查 |
| 8 | 急症排查确认 | POST | `/api/diagnosis/emergency-clearance` | 红旗病例的排查确认 |

---

## 2. 通用约定

### 2.1 鉴权

所有接口均需鉴权。请求头二选一：

| 方式 | 请求头 |
|---|---|
| 自定义头 | `x-cdss-api-token: <令牌>` |
| 标准头 | `Authorization: Bearer <令牌>` |

未携带或令牌错误返回 `401`。

### 2.2 请求头

| 请求头 | 必填 | 值 |
|---|---|---|
| `Content-Type` | 是 | `application/json` |
| `x-cdss-api-token` | 是 | 接口访问令牌 |

### 2.3 参数传递要求

**以下五条为强制要求，不满足将导致接口报错或链路中断。**

| 编号 | 要求 | 不满足的后果 |
|---|---|---|
| R1 | `caseState.id` 必填，且**同一次就诊全流程使用同一个值** | M04 返回 `409` 签名校验失败 |
| R2 | 上一阶段返回的结构化结论必须**原样**合并回 `caseState`，不得改写、精简或重新格式化 | 签名校验失败，返回 `409` |
| R3 | M03 结论中的签名字段名为 `contractSignature`（非 `signature`） | 取值为空，回传后 `409` |
| R4 | 查询参数中的中文必须 URL 编码 | 反向代理返回 `400` |
| R5 | 调用顺序须为 M01→M02→M03→M04→M05，不可跳段 | 跳段调用返回 `409` |

**R1 示例**

```json
{
  "caseState": {
    "id": "OPD-20260805-000123",
    "patient": { "sex": "女", "age": 28 },
    "chiefComplaint": "产后2月余，头痛反复发作1月"
  }
}
```

**R2 交接对照表**

| 交接节点 | 从上一阶段响应取出 | 合并进 caseState 的字段 |
|---|---|---|
| M03 → M04 | `diagnosis`、`reasoningDiagnose`（含 `contractSignature`） | `caseState.diagnosis`、`caseState.reasoningDiagnose` |
| M04 → M05 | `prescription`、`reasoningPrescribe`（含 `contractSignature`） | `caseState.prescription`、`caseState.reasoningPrescribe` |

### 2.4 响应格式

| 接口 | 响应类型 |
|---|---|
| M01–M05 | NDJSON 流（见 2.5） |
| 红旗筛查、急症排查确认、访问凭证 | `application/json` |

### 2.5 NDJSON 流式协议

每行一个 JSON 对象，以换行符分隔：

| 行内容 | 含义 |
|---|---|
| `{"content":"<文本片段>"}` | 正文片段，按序拼接 |
| `{"content":"[END]"}` | 流结束标记 |
| `{"error":"<错误描述>"}` | 流内错误，出现后应终止解析 |

### 2.6 结构化结论提取

M01–M05 的正文中嵌有结构化 JSON，位于以下两个标记之间：

```
<!-- DIAGNOSIS_JSON_START -->
{ ... 结构化结论 ... }
<!-- DIAGNOSIS_JSON_END -->
```

提取步骤：拼接全部 `content` 片段 → 正则匹配两个标记之间的内容 → `JSON.parse`。

### 2.7 通用错误码

| 状态码 | 含义 | 处理建议 |
|---|---|---|
| `400` | 请求参数不合法 | 检查必填字段与参数格式 |
| `401` | 鉴权失败 | 检查令牌 |
| `409` | 流程状态或签名不满足前置条件 | 见 2.3 强制要求 |
| `413` | 请求体超出上限 | 压缩内容后重试 |
| `422` | 业务前置条件不满足 | 见各接口说明 |
| `429` | 触发调用频率限制 | 退避后重试 |
| `503` | 服务暂不可用 | 稍后重试 |

---

## 3. 接口详述

### 3.1 访问凭证获取

**接口地址**：`POST /api/auth/access`

**入参**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `token` | string | 是 | 接口访问令牌 |

**出参**

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | 是否成功 |

成功时通过 `Set-Cookie` 下发 httpOnly 访问 Cookie。

**错误码**

| 状态码 | 触发条件 |
|---|---|
| `401` | 令牌错误 |
| `429` | 10 分钟内失败 8 次，账户锁定 |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/auth/access" \
  -H "Content-Type: application/json" \
  -d '{"token":"3683a982d3d55f02890827f3fcc7e8cb67ad4640c5b19c8a5cdb6218cc97161e"}'
```

**响应示例**

```json
{"ok": true}
```

### 3.2 M01 病历采集

**接口地址**：`POST /api/diagnosis/collect`

**入参**（本接口为独立请求体，**不使用** `caseState` 包装）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `userInput` | string | 是 | 病历文本，≤12000 字符 |
| `patientSex` | string | 是 | 取值：`男` / `女` / `其他或未明确` |
| `tongueImage` | string | 否 | 舌象照片 data URL，格式 `data:image/(png\|jpeg\|jpg\|webp);base64,...`，二进制 ≤4 MB |
| `tongueImageConsent` | boolean | 有图时必填 | `true` 表示已取得患者授权 |

**出参**：NDJSON 流。

| 输入情况 | 正文内容 |
|---|---|
| 纯文本 | 采集确认文本 + 空结构化 JSON |
| 含舌象图片 | 舌象描述文本，用于回填 `caseState.tongueImageDesc` |

**错误码**

| 状态码 | 触发条件 | 响应体 |
|---|---|---|
| `400` | 缺 `userInput` | `{"error":"userInput required"}` |
| `413` | 文本超 12000 字符 | `{"error":"病历文本过长，请压缩至12000字以内"}` |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/collect" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: 3683a982d3d55f02890827f3fcc7e8cb67ad4640c5b19c8a5cdb6218cc97161e" \
  -d '{
    "userInput": "产后2月余，头痛反复发作1月，劳累后加重，伴神疲乏力、心悸失眠、面色少华。舌淡苔薄白，脉细弱。",
    "patientSex": "女"
  }'
```

**响应示例**（NDJSON 流）

```
{"content":"病历信息已采集，正在评估是否需要补充关键问诊。"}
{"content":"<!-- DIAGNOSIS_JSON_START -->{}<!-- DIAGNOSIS_JSON_END -->"}
{"content":"[END]"}
```

### 3.3 M02 追问生成

**接口地址**：`POST /api/diagnosis/question`

**入参**

| 字段路径 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `caseState` | object | 是 | 病例状态对象 |
| `caseState.id` | string | 是 | 就诊唯一标识，全流程一致 |
| `caseState.chiefComplaint` | string | 是 | 主诉，缺失返回 `422` |
| `caseState.phase` | string | 是 | 固定填 `"question"`，其他值返回 `409` |
| `caseState.questionRounds` | number | 否 | 已追问轮次，≥1 时返回 `409` |
| `caseState.patient.sex` | string | 否 | 性别 |
| `caseState.patient.age` | number | 否 | 年龄 |
| `caseState.symptoms` | object | 否 | 症状字段集合，键为分类名，值为文本 |
| `caseState.tongue` | string | 否 | 舌象 |
| `caseState.pulse` | string | 否 | 脉象 |
| `caseState.vitals` | object | 否 | 生命体征 |

**出参**：NDJSON 流。结构化结论中 `m02Plan` 字段为追问计划。

| 字段 | 类型 | 说明 |
|---|---|---|
| `m02Plan.schemaVersion` | string | 固定 `tcm-cdss-m02-plan-v1` |
| `m02Plan.decision` | string | `ask`（需追问）/ `proceed`（无需追问） |
| `m02Plan.rationale` | string | 决策理由 |
| `m02Plan.questions` | array | 追问列表，`decision=proceed` 时为空数组 |
| `m02Plan.questions[].id` | string | 问题标识 |
| `m02Plan.questions[].question` | string | 问题文本 |
| `completeness` | object | 病历完整度评估 |

**错误码**

| 状态码 | 触发条件 |
|---|---|
| `422` | 缺主诉 |
| `409` | `phase` 不为 `question`，或 `questionRounds` ≥1 |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/question" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: 3683a982d3d55f02890827f3fcc7e8cb67ad4640c5b19c8a5cdb6218cc97161e" \
  -d '{
    "caseState": {
      "id": "OPD-20260805-000123",
      "phase": "question",
      "questionRounds": 0,
      "patient": { "sex": "女", "age": 28 },
      "chiefComplaint": "产后2月余，头痛反复发作1月",
      "symptoms": { "现病史": "近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠" },
      "tongue": "舌淡苔薄白",
      "pulse": "脉细弱",
      "conversation": [],
      "vitals": {}
    }
  }'
```

**响应示例**（结构化结论节选）

```json
{
  "completeness": { "level": "B" },
  "m02Plan": {
    "schemaVersion": "tcm-cdss-m02-plan-v1",
    "decision": "ask",
    "rationale": "头痛性质、诱因与伴随症状尚不明确，需补充以支持辨证",
    "questions": [
      { "id": "q1", "question": "头痛为胀痛、刺痛还是空痛？有无固定部位？" },
      { "id": "q2", "question": "近期饮食、二便情况如何？" }
    ]
  }
}
```

### 3.4 M03 辨病辨证

**接口地址**：`POST /api/diagnosis/diagnose`

**入参**

| 字段路径 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `caseState` | object | 是 | 病例状态对象 |
| `caseState.id` | string | 是 | 就诊唯一标识，全流程一致 |
| `caseState.chiefComplaint` | string | 是 | 主诉 |
| `caseState.patient.sex` | string | 否 | 性别 |
| `caseState.patient.age` | number | 否 | 年龄 |
| `caseState.symptoms` | object | 否 | 症状字段集合 |
| `caseState.tongue` | string | 否 | 舌象 |
| `caseState.pulse` | string | 否 | 脉象 |
| `caseState.vitals` | object | 否 | 生命体征，键如 `BP`/`T`/`P`/`R`/`SpO2` |
| `caseState.conversation` | array | 否 | 追问对话记录 |

**出参**：NDJSON 流，正文为 Markdown，结构化结论字段如下。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | string | 结构版本 |
| `stage` | string | 固定 `diagnose` |
| `overview.primarySyndrome` | string | 主证候 |
| `overview.primarySyndromeBasis` | array | 主证候依据 |
| `overview.tcmDifferentials` | array | 证候鉴别 |
| `overview.tcmDiseaseDifferentials` | array | 中医病名鉴别 |
| `overview.tcmDiseaseDifferentials[].diseaseName` | string | 候选病名 |
| `overview.tcmDiseaseDifferentials[].reason` | string | 鉴别理由 |
| `overview.tcmDiseaseDifferentials[].distinguishingPoints` | string | 区分要点 |
| `overview.tcmDiseaseDifferentials[].nextCheck` | string | 建议核实项 |
| `westernDiagnosis.primary.name` | string | 西医主要诊断 |
| `westernDiagnosis.primary.supportingFacts` | array | 支持依据 |
| `pathogenesis.summary` | string | 病机概要 |
| `pathogenesis.chain` | array | 病机链 |
| `pathogenesis.chain[].nodeId` | string | 节点标识，如 `P1` |
| `pathogenesis.chain[].pathogenesis` | string | 病机描述 |
| `pathogenesis.chain[].therapyDirection` | string | 对应治法方向 |
| `pathogenesis.locationDifferentiation.items` | array | 病位 |
| `pathogenesis.natureDifferentiation.items` | array | 病性 |
| `therapy.overallPrinciple` | string | 治则 |
| `therapy.overallMethod` | string | 治法 |
| `therapy.subTherapies` | array | 分治法 |
| `management` | object | 管理建议 |
| `contractSignatureVersion` | string | 签名版本 |
| `contractSignature` | string | 合同签名，格式 `hmac-sha256:<64位十六进制>` |

**特殊说明**

| 情况 | 系统行为 |
|---|---|
| 命中急危重症征象 | 正文顶部输出安全警示横幅，管理建议将急诊/转诊列为第一优先级，辨证仍照常完整输出 |
| 缺主诉 | 返回 `200`，正文为补录提示，无签名载荷 |
| 模型服务不可用 | 返回带 `upstream_model_unavailable` 标识的提示，表示服务故障而非病历信息不足 |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/diagnose" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: 3683a982d3d55f02890827f3fcc7e8cb67ad4640c5b19c8a5cdb6218cc97161e" \
  -d '{
    "caseState": {
      "id": "OPD-20260805-000123",
      "patient": { "sex": "女", "age": 28 },
      "chiefComplaint": "产后2月余，头痛反复发作1月",
      "symptoms": {
        "现病史": "近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华",
        "既往史": "否认高血压病史"
      },
      "tongue": "舌淡苔薄白",
      "pulse": "脉细弱",
      "conversation": [],
      "vitals": {}
    }
  }'
```

**响应示例**（结构化结论节选）

```json
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "overview": {
    "primarySyndrome": "心脾两虚，气血不足",
    "primarySyndromeBasis": ["产后2月余，头痛反复发作1月", "神疲乏力、心悸失眠", "舌淡苔薄白，脉细弱"],
    "tcmDiseaseDifferentials": [
      {
        "diseaseName": "眩晕",
        "reason": "头痛与眩晕常并见，需鉴别主症",
        "distinguishingPoints": "本例以头痛为主症，无视物旋转",
        "nextCheck": "询问有无视物旋转、站立不稳"
      }
    ]
  },
  "pathogenesis": {
    "chain": [
      { "nodeId": "P1", "pathogenesis": "气血亏虚", "therapyDirection": "益气养血" }
    ],
    "locationDifferentiation": { "items": ["心", "脾", "清窍"] },
    "natureDifferentiation": { "items": ["气虚", "血虚"] }
  },
  "therapy": {
    "overallPrinciple": "虚则补之",
    "overallMethod": "益气养血，缓急止痛"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:d049aff0c240088f672f86800565535cb4bedddf5332bb7c08860011caaf8a22"
}
```

### 3.5 M04 候选方药

**接口地址**：`POST /api/diagnosis/prescribe`

**入参**

| 字段路径 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `caseState` | object | 是 | 病例状态对象 |
| `caseState.id` | string | 是 | 与 M03 使用的同一标识 |
| `caseState.reasoningDiagnose` | object | 是 | M03 返回的结构化结论，**原样回传** |
| `caseState.diagnosis` | object | 否 | M03 返回的诊断结论 |
| 其余字段 | — | — | 同 M03 |

**出参**：NDJSON 流，正文含药味清单、煎服法、中成药方案、用药风险提示，结构化结论字段如下。

| 字段 | 类型 | 说明 |
|---|---|---|
| `stage` | string | 固定 `prescribe` |
| `formula.candidates` | array | 候选方列表 |
| `formula.candidates[].name` | string | 方名 |
| `formula.candidates[].herbs` | array | 药味列表 |
| `formula.candidates[].herbs[].name` | string | 药名 |
| `formula.candidates[].herbs[].dose` | string | 剂量，如 `10g` |
| `formula.candidates[].herbs[].role` | string | 君/臣/佐/使 |
| `formula.candidates[].herbs[].targetKind` | string | `pathogenesis_node` / `formula_structure` |
| `formula.candidates[].herbs[].targetRef` | string | 对应病机节点号，如 `P1` |
| `formula.candidates[].herbs[].isToxic` | boolean | 是否毒性药材 |
| `formula.candidates[].herbs[].decoctionRequirement` | string | 煎法要求，如先煎/后下 |
| `patentMedicines` | array | 中成药候选 |
| `contractSignature` | string | 合同签名 |

**特殊说明**

| 情况 | 系统行为 |
|---|---|
| 正文以 `<!-- CDSS_NON_DOSE_PRESCRIPTION -->` 开头 | 本次不提供剂量级候选，原因见正文"处方安全边界"段，可重试恢复 |

**错误码**

| 状态码 | 触发条件 | 响应体 |
|---|---|---|
| `409` | 缺有效 M03 签名 | `{"error":"辨病辨证结果缺少有效签名，请重新生成辨病辨证后再进入候选方药。"}` |

> `409` 最常见原因是请求中未携带 `caseState.id`，或未将 M03 结论原样回传。参见 2.3 强制要求 R1、R2。

---


**调用示例**

> `reasoningDiagnose` 为 M03 返回的结构化结论，须**原样**回传；`id` 与 M03 保持一致。

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/prescribe" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: 3683a982d3d55f02890827f3fcc7e8cb67ad4640c5b19c8a5cdb6218cc97161e" \
  -d '{
    "caseState": {
      "id": "OPD-20260805-000123",
      "patient": { "sex": "女", "age": 28 },
      "chiefComplaint": "产后2月余，头痛反复发作1月",
      "symptoms": { "现病史": "近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠" },
      "tongue": "舌淡苔薄白",
      "pulse": "脉细弱",
      "conversation": [],
      "vitals": {},
      "reasoningDiagnose": ...M03 返回的完整结构化结论...
    }
  }'
```

**响应示例**（结构化结论节选）

```json
{
  "stage": "prescribe",
  "formula": {
    "candidates": [
      {
        "name": "归脾汤加减",
        "herbs": [
          { "name": "黄芪", "dose": "20g", "role": "君", "targetKind": "pathogenesis_node", "targetRef": "P1", "isToxic": false },
          { "name": "党参", "dose": "15g", "role": "臣", "targetKind": "pathogenesis_node", "targetRef": "P1", "isToxic": false },
          { "name": "当归", "dose": "10g", "role": "臣", "targetKind": "pathogenesis_node", "targetRef": "P1", "isToxic": false }
        ]
      }
    ]
  },
  "contractSignature": "hmac-sha256:7f3c1e..."
}
```

### 3.6 M05 风险随访

**接口地址**：`POST /api/diagnosis/assess`

**入参**

| 字段路径 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `caseState` | object | 是 | 病例状态对象 |
| `caseState.id` | string | 是 | 与 M03/M04 使用的同一标识 |
| `caseState.reasoningDiagnose` | object | 是 | M03 结论，原样回传 |
| `caseState.reasoningPrescribe` | object | 是 | M04 结论，原样回传 |
| 其余字段 | — | — | 同 M03 |

**出参**：NDJSON 流，内容依次为：

| 序号 | 内容 |
|---|---|
| 1 | 审方状态标记 `<!-- TCM_CDSS_RXAUDIT_STATUS:... -->` |
| 2 | 审方关联标记 `<!-- TCM_CDSS_RXAUDIT_CORRELATION:... -->` |
| 3 | 审方范围、录入质量提示、用药风险分级 |
| 4 | 随访计划 |

流中另有一帧结构化随访时间轴：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 固定 `followup_timeline` |
| `timelineItems` | array | 时间轴条目 |
| `timelineItems[].time` | string | 时间点 |
| `timelineItems[].action` | string | 随访动作 |
| `timelineItems[].indication` | string | 触发指征 |

**错误码**

| 状态码 | 触发条件 | 响应体 |
|---|---|---|
| `409` | M03 签名无效 | `{"error":"...","code":"invalid_m03_signature"}` |
| `409` | M04 签名无效 | `{"error":"...","code":"invalid_m04_signature"}` |

---


**调用示例**

> `reasoningDiagnose`、`reasoningPrescribe` 均须原样回传。

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/assess" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: 3683a982d3d55f02890827f3fcc7e8cb67ad4640c5b19c8a5cdb6218cc97161e" \
  -d '{
    "caseState": {
      "id": "OPD-20260805-000123",
      "patient": { "sex": "女", "age": 28 },
      "chiefComplaint": "产后2月余，头痛反复发作1月",
      "reasoningDiagnose": ...M03 返回的完整结构化结论...,
      "reasoningPrescribe": ...M04 返回的完整结构化结论...
    }
  }'
```

**响应示例**（流内随访时间轴帧）

```json
{
  "type": "followup_timeline",
  "timelineItems": [
    { "time": "服药后3天", "action": "评估头痛发作频次与程度", "indication": "无改善需复诊" },
    { "time": "服药后7天", "action": "复诊调方", "indication": "常规随访" }
  ]
}
```

### 3.7 红旗筛查

**接口地址**：`POST /api/diagnosis/red-flags`

**入参**

| 字段路径 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `caseState` | object | 是 | 病例状态对象 |
| `caseState.id` | string | 是 | 就诊唯一标识 |
| `caseState.chiefComplaint` | string | 是 | 主诉 |
| 其余字段 | — | — | 同 M03 |

**出参**（`application/json`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `available` | boolean | 筛查结果是否可用 |
| `semanticStatus` | string | `checked` / `unavailable` / `skipped_deterministic_critical_vital` |
| `redFlags` | array | 命中的红旗项 |
| `advisories` | array | 建议项 |
| `clinicalFacts` | object | 提取的临床事实 |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/red-flags" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: 3683a982d3d55f02890827f3fcc7e8cb67ad4640c5b19c8a5cdb6218cc97161e" \
  -d '{
    "caseState": {
      "id": "OPD-20260805-000123",
      "patient": { "sex": "男", "age": 58 },
      "chiefComplaint": "突发剧烈胸痛2小时",
      "symptoms": { "现病史": "2小时前突发胸骨后压榨样疼痛，向左肩放射，伴大汗" },
      "vitals": { "BP": "90/60", "P": "110" }
    }
  }'
```

**响应示例**

```json
{
  "available": true,
  "semanticStatus": "checked",
  "redFlags": [
    { "term": "急性胸痛", "level": "critical", "basis": "突发胸骨后压榨样疼痛伴放射、大汗" }
  ],
  "advisories": ["建议立即急诊评估，完善心电图与心肌标志物"]
}
```

### 3.8 急症排查确认

**接口地址**：`POST /api/diagnosis/emergency-clearance`

**入参**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `caseState` | object | 是 | 病例状态，须处于红旗状态 |
| `assessmentSummary` | string | 是 | 现场评估记录，脱敏后 12–1000 字 |

**出参**（`200`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `emergencyClearance.redFlagFingerprint` | string | 红旗事实指纹 |
| `emergencyClearance.confirmedAt` | string | 确认时间（ISO 8601） |
| `emergencyClearance.assessmentSummary` | string | 脱敏后的评估记录 |
| `emergencyClearance.contractSignature` | string | 服务端签名 |

返回对象需整体放入 `caseState.emergencyClearance` 供后续阶段使用。

**错误码**

| 状态码 | 触发条件 | 响应体 |
|---|---|---|
| `400` | 缺 `assessmentSummary` 或长度不足 | `{"error":"caseState and assessmentSummary are required"}` |
| `409` | 病例不处于红旗状态 | `{"error":"当前病历没有可绑定的急危重症红旗，未生成排查确认。"}` |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/emergency-clearance" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: 3683a982d3d55f02890827f3fcc7e8cb67ad4640c5b19c8a5cdb6218cc97161e" \
  -d '{
    "caseState": {
      "id": "OPD-20260805-000123",
      "patient": { "sex": "男", "age": 58 },
      "chiefComplaint": "突发剧烈胸痛2小时",
      "symptoms": { "现病史": "2小时前突发胸骨后压榨样疼痛，向左肩放射，伴大汗" },
      "vitals": { "BP": "90/60", "P": "110" }
    },
    "assessmentSummary": "已完成急诊排查：心电图无ST段抬高，心肌标志物阴性，生命体征平稳，排除急性冠脉综合征。"
  }'
```

**响应示例**

```json
{
  "emergencyClearance": {
    "redFlagFingerprint": "sha256:3a7f...",
    "confirmedAt": "2026-08-05T10:23:41.000Z",
    "assessmentSummary": "已完成急诊排查：心电图无ST段抬高，心肌标志物阴性，生命体征平稳，排除急性冠脉综合征。",
    "contractSignature": "hmac-sha256:9b2e..."
  }
}
```

## 4. 调用示例

### 4.1 完整链路

```bash
BASE="https://82.156.128.153/tcm-cdss"
TOKEN="<接口令牌>"
CASE_ID="OPD-20260805-000123"

# M03 辨病辨证
curl -X POST "$BASE/api/diagnosis/diagnose" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
  -d '{
    "caseState": {
      "id": "'"$CASE_ID"'",
      "patient": { "sex": "女", "age": 28 },
      "chiefComplaint": "产后2月余，头痛反复发作1月",
      "symptoms": { "现病史": "近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠" },
      "tongue": "舌淡苔薄白",
      "pulse": "脉细弱",
      "conversation": [],
      "vitals": {}
    }
  }'

# 从响应中提取 reasoningDiagnose 后，调用 M04
# caseState 须包含同一个 id，并原样携带 reasoningDiagnose
```

### 4.2 响应解析（Node.js）

```javascript
const response = await fetch(url, { method: "POST", headers, body });
const raw = await response.text();

let markdown = "";
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  const chunk = JSON.parse(line);
  if (chunk.error) throw new Error(chunk.error);
  if (chunk.content && chunk.content !== "[END]") markdown += chunk.content;
}

const match = markdown.match(
  /<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/
);
const structured = match ? JSON.parse(match[1].trim()) : null;
```

---

## 5. 限制说明

| 项 | 限制 |
|---|---|
| 调用频率 | 60 次 / 10 分钟 |
| M01 请求体 | ≤5.6 MB，文本 ≤12000 字符 |
| 舌象图片 | ≤4 MB |
| 单次请求超时 | 连接 90 秒 / 空闲 60 秒 / 总计 180 秒 |
