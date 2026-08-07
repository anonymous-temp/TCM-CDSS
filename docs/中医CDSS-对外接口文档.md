# 中医 CDSS 对外接口文档

| 项 | 内容 |
|---|---|
| 文档版本 | V1.1 |
| 发布日期 | 2026-08-06 |
| 接口基址 | `https://82.156.128.153/tcm-cdss` |
| 协议 | HTTPS |
| 字符编码 | UTF-8 |

**V1.1 变更（针对贵方 2026-08-05《核对内容》「一、接口缺失内容」逐条）**

| 变更 | 说明 |
|---|---|
| 更正字段名 | 上一版 M04 出参表把中成药候选写作顶层 `patentMedicines`，**该字段在实现中并不存在**，实际路径是 `formula.patentAndWestern`。贵方按文档取值必然取空，特此更正并致歉 |
| 补齐 M03 出参 | 西医诊断的 `status` / `limitations` / `suggestedChecks` / `coding`（待查依据） |
| 补齐 M04 出参 | 方义分析、组成逻辑、方证鉴别、经典条文、剂数与煎服法全部子字段、随证加减（含可替换药味）、中成药完整子字段 |
| 新增接口章节 | HIS 诊疗方案导出（含健康调护、中医外治）、中药材/中成药目录查询——这些能力此前已实现但未在本文档登记 |
| 新增能力 | **院内药品库存导入**（§3.12）：贵方导入医院库存药，开方时优先落在有货药味上；缺货药不静默替换，而是标注缺货并给受治理替代候选 |

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
| 9 | HIS 诊疗方案导出 | POST | `/api/diagnosis/his-scheme` | 面向 HIS 写回的整合方案，含健康调护与中医外治 |
| 10 | 处方后风险审查 | POST | `/api/diagnosis/post-prescription-risk` | 统一审方结论 |
| 11 | 中药材知识检索 | GET / POST | `/api/tcm-knowledge/search` | 药材/方剂/配伍禁忌检索 |
| 12 | 药材功效查询 | GET / POST | `/api/tcm-knowledge/herb-function` | 单味药功效与分类 |
| 13 | 药品目录同步（出站） | GET | `/api/tcm-knowledge/drug-catalog` | 受治理药品目录分页下发，供院内目录对账 |
| 14 | 院内药品库存导入（入站） | POST / GET | `/api/drug-inventory` | 导入医院库存药，开方时优先落在有货药味上 |
| 15 | 服务健康检查 | GET | `/api/diagnosis/health` | `?strict=1` 返回发布就绪状态，未就绪时返回 503 |
| 16 | M02 追问回答解析 | POST | `/api/diagnosis/question/interpret` | 医生自由文本回答 → 结构化病历字段更新 |
| 17 | 病例快照加解密 | POST | `/api/diagnosis/snapshot` | AES-256-GCM 加密快照，鉴权绑定快照所有者 |
| 18 | 受控术语确认 | POST | `/api/diagnosis/terminology/confirm` | 医生确认一条国标术语映射 |
| 19 | 模型健康检查 | GET | `/api/model-health` | `?check=1` 触发一次真实模型调用 |

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

### 2.3.1 CaseState 入参字段表

调用方只需构造下表字段；其余为服务端产出、按 R2 原样回传即可。**未列出的键不会报错，但也不会生效。**

| 字段路径 | 类型 | 必填 | 取值 | 作用阶段 | 说明 |
|---|---|---|---|---|---|
| `id` | string | 是 | — | 全阶段 | 同一次就诊全程不变（R1）。缺省时服务端自动生成，将导致 M04 返回 `409` |
| `phase` | enum | 建议 | `idle`/`collect`/`question`/`diagnose`/`prescribe`/`assess`/`done`/`error` | 全阶段 | **枚举外的值会让整个 caseState 被拒**（400），不是被忽略。M02 要求 `phase="question"` |
| `patient.sex` | string | 建议 | 男/女 | 全阶段 | `hisRecord.fields.sex` 优先 |
| `patient.age` | number | 建议 | — | 全阶段 | 影响特殊人群剂量规则与儿科门禁 |
| `patient.name` | string | 否 | — | — | **提交后恒被服务端清空**（脱敏），不要用它传身份信息 |
| `chiefComplaint` | string | 是 | — | M01 起 | 缺失时 M03 不进入完整诊断 |
| `symptoms` / `pastHistory` / `medicationHistory` / `allergyHistory` | string | 建议 | — | M01 起 | 一诉五史。**「未提及」不等于阴性**，不要用空串表达「否认」，应写明「否认…」 |
| `tongue` / `pulse` / `faceNote` | string | 建议 | — | M01 起 | 四诊文本 |
| `tongueImageDesc` | string | 否 | — | M01 | 舌象图片走 GLM 视觉后回填；无图时可手工录入 |
| `vitals` | object | 建议 | — | 全阶段 | BP/T/P/R/SpO2，危急阈值由确定性安全门解析 |
| `tcmLineagePreference` | string | 否 | 见 §2.3.2 | M02/M03/M04/M05 | 流派选择。顶层与 `hisRecord.fields` **两条通道都生效** |
| `herbCountPreference` | string | 否 | 见 §2.3.3 | **仅 M04** | 饮片味数偏好。**仅接受顶层字段** |
| `clinicTreatmentCapabilities` | object | 否 | — | M04/M05 | 院内可开展的中医外治项目，决定外治建议是 `clinic_available` 还是 `referral_only` |
| `hisRecord.fields` | object | 否 | — | 全阶段 | HIS 病历字段直传；与顶层同名字段冲突时以本通道优先 |
| `emergencyClearance` | object | 否 | — | 全阶段 | 只能由 `/api/diagnosis/emergency-clearance` 产出；每次读取都会重新校验并剥离，伪造无效 |
| `reasoningDiagnose` / `reasoningPrescribe` / `reasoningV2` | object | 交接必填 | — | M04/M05 | 上一阶段结论，**必须原样回传**（R2）。任何改写都会导致 `409` |

### 2.3.2 `tcmLineagePreference` 流派选择（甲方需求 #1，优先级「高」）

影响 M02 追问策略、M03 辨证重点、M04 组方风格、M05 随访口径四个阶段。不传等价于 `unrestricted`。

**流派偏好不改变任何安全判定**：剂量上限、十八反十九畏、特殊人群禁忌、红旗处置一律不因流派放宽。

| code | 可读名 | 分组 | 也可直接传的中文别名 |
|---|---|---|---|
| `unrestricted` | 不限定：循证安全优先 | 默认 | 不限定、循证安全优先 |
| `classical-formula` | 经方思路 | 经典辨治 | 经方、经典方证、经典方证对应 |
| `empirical-formula` | 时方/验方思路 | 经典辨治 | 时方、验方、临床经验方 |
| `warm-disease` | 温病思路 | 经典辨治 | 温病、卫气营血、三焦辨证 |
| `spleen-stomach` | 脾胃学派 | 学术流派 | 脾胃、补土、中焦、东垣 |
| `nourish-yin-danxi` | 滋阴/丹溪思路 | 学术流派 | 滋阴、丹溪、朱丹溪、相火、阴虚 |
| `warm-tonify-yang` | 温补/扶阳思路 | 学术流派 | 温补、扶阳、温阳、火神 |
| `gongxie` | 攻邪思路 | 学术流派 | 攻邪、攻下、祛邪、急则治标 |
| `hanliang` | 寒凉思路 | 学术流派 | 寒凉、清热、清热解毒、清热凉血 |
| `menghe` | 孟河医派 | 地域流派 | 孟河、轻灵平正 |
| `lingnan` | 岭南医派 | 地域流派 | 岭南、湿热、暑湿 |
| `haipai` | 海派中医 | 地域流派 | 海派、中西参证 |
| `institution-first` | 院内方案优先 | 机构 | 院内、院内方案、本院常用方案 |

出参侧回显在 `reasoningPrescribe.lineageAdaptation`（`lineageCode`/`label`/`applicable`/`applicabilityReason`/`influencedDecisions`/`unaffectedBySafety`/`safetyDeference`），以及 HIS 方案导出中。

### 2.3.3 `herbCountPreference` 饮片味数偏好（甲方需求 #1，优先级「高」）

| 取值 | 含义 | 也可直接传的中文写法 |
|---|---|---|
| `within_10` | 10 味以内 | `10味以内`、`≤10`、`<10` |
| `between_10_15` | 10–15 味 | `10-15`、`10–15`、`10~15`、`10至15`、`10－15` |
| `at_least_15` | 15 味及以上 | `15味及以上`、`15味以上`、`≥15`、`>15` |

五条实测语义，集成前请逐条确认：

1. **仅接受 `caseState` 顶层字段。** 放进 `hisRecord.fields` 不生效**且不报错**——这与 `tcmLineagePreference` 不同，后者两个通道都生效。
2. **仅在 M04 `/api/diagnosis/prescribe` 生效**，M01–M03、M05 不读取。
3. 大小写敏感（`WITHIN_10` 无效）；数字 `12`、模糊说法「少一点」一律丢弃为空，**不报错**。建议直接传三个受控代码，中文写法仅作兼容。
4. **是软偏好，不是硬约束。** 服务端不做任何按味数的确定性裁剪：经典方基准组成、绑定病机节点的必需药味、安全定性药味都不会为迁就味数被删——与甲方对味数的既有口径一致（「如诊疗必须也不能裁剪」）。
5. 因此出参味数可能超出所选档位。此时不是失效，而是临床必需优先。

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
| `westernDiagnosis.primary.name` | string | 西医主要诊断。症状级工作诊断统一写成「规范症状名，病因待查」形态 |
| `westernDiagnosis.primary.supportingFacts` | array | 支持依据。只收与该西医诊断直接相关的当前患者事实；舌脉、证候、病机不进此栏 |
| `westernDiagnosis.primary.status` | string | 诊断程度：`考虑` / `需排除` / `证据有限` |
| `westernDiagnosis.primary.confidence` | string | 置信度：`高` / `中` / `低` |
| `westernDiagnosis.primary.limitations` | array | **待查依据（一）资料限制**：当前证据不足在哪、缺哪一条判定条件 |
| `westernDiagnosis.primary.suggestedChecks` | array | **待查依据（二）建议检查**：补什么能推进诊断。分层给出——先补充问诊/生命体征/查体，仅在已有红旗或明确鉴别指征时才列影像与成套化验 |
| `westernDiagnosis.primary.clinicalRationale` | string | 事实到诊断倾向的推理，不复述病史 |
| `westernDiagnosis.primary.coding` | object | ICD-10 关联：`{system, code, display, source}`，由服务端确定性编码 |
| `westernDiagnosis.differentials` | array | 西医鉴别诊断：`{name, reason, distinguishingPoints, nextCheck}` |
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
| `formula.candidates[].herbs[].verificationTier` | string | `verified`（有药典剂量边界）/ `unverified_dose`（用量由医师确定）/ `identity_pending` / `toxic_regulated`（管制毒性或法律禁用，须按监管要求单独处理） |
| `formula.candidates[].constructionType` | string | `single_base` / `combined` / `self_devised` / `single_herb` |
| `formula.candidates[].modificationStatus` | string | `canonical`（原方）/ `modified`（加减） |
| `formula.candidates[].baseFormulas` | array | 基础方与出处，含组成匹配味数与核心药味匹配数 |
| `contractSignature` | string | 合同签名 |

**方义与出处**（贵方 8-05「方义分析/组成逻辑/方证鉴别/经典条文」🔴高）

四项均为**确定性产物**，锚定在受治理方名上。自拟方（`constructionType=self_devised`）时四项恒为空数组——无受治理方名即无出处可考，这是正确行为而非缺字段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `formula.candidates[].formulaAnalysis` | string | 方义分析。写**该药在本方发挥的作用**，不罗列全部功效 |
| `formula.candidates[].compositionLogic` | array | 组成逻辑：`{formulaName, summary, tier, sourceRefs}` |
| `formula.candidates[].discriminationPath` | array | 方证鉴别：`{againstFormula, question, status, sourceRef}`，`status` 为 `confirmed`/`absent`/`unknown` |
| `formula.candidates[].classicEvidence` | array | 经典条文：`{evidenceId, citation, anchorLevel, clauseNumber?, excerpt, tier}` |
| `formula.candidates[].textualModifications` | array | 有出处的成方加减规则，`requiresClinicianReview` 恒为 `true` |

> **经典条文使用边界**：条文按方名检索给出，说明该方的经典出处与主治语境，**不代表已判定适用于本例**；条文内古代剂量与现行法定剂量不可直接换算，用量以药味表与审方结论为准。

**剂数与煎服法**（贵方 8-05 🔴高）

| 字段 | 类型 | 说明 |
|---|---|---|
| `formula.candidates[].decoction.doseCount` | string | 剂数，如 `7剂` |
| `formula.candidates[].decoction.course` | string | 疗程，如 `7日` |
| `formula.candidates[].decoction.dosesPerDay` | number | 每日剂数，1–3 |
| `formula.candidates[].decoction.administrationTimesPerDay` | number | 每日服用次数 |
| `formula.candidates[].decoction.method` | string | 完整煎服法。**随方剂性质变化**：解表剂武火速煎、补益剂文火久煎，不是同一张模板 |
| `formula.candidates[].decoction.soakMinutes` | number | 浸泡分钟数 |
| `formula.candidates[].decoction.decoctionTimes` | number | 煎煮次数 |
| `formula.candidates[].decoction.firstDecoctionMinutes` | number | 一煎分钟数 |
| `formula.candidates[].decoction.secondDecoctionMinutes` | number | 二煎分钟数 |
| `formula.candidates[].decoction.targetVolumeMl` | number | 两煎合并药液量（儿童 200mL / 成人 500mL） |
| `formula.candidates[].decoction.administration` | string | 服法，如「饭后温服」 |
| `formula.candidates[].decoction.followUpNode` | string | 复诊节点 |

**随证加减建议**（贵方 8-05 🔴高，含「可替换药味的说明」）

加减针对的是**病历已记录、但主方覆盖不足的兼症**，不是预设的未来症状；加减行本身不携带克数——剂量由药味工作台与审方链路负责。

| 字段 | 类型 | 说明 |
|---|---|---|
| `formula.modifications[].trigger` | string | 触发的已记录患者事实（逐字引用） |
| `formula.modifications[].triggerSource` | object | 事实出处：`{kind, sourceRef, sourceQuote}` |
| `formula.modifications[].targetPathogenesis` | string | 对应病机 |
| `formula.modifications[].action` | string | 动作，如 `加党参` |
| `formula.modifications[].doseOrHandling` | string\|null | 恒为 `null`（加减不下发剂量） |
| `formula.modifications[].reason` | string | 理由 |
| `formula.modifications[].riskNote` | string | 风险提示，含「调整后须重新审方」 |
| `formula.modifications[].substitutions` | array | **可替换药味**：`{replaces, substitute, rationale, differenceNote}`。覆盖缺货/过敏/特殊人群禁用场景；每条必带与原药的差异说明。替代药同样受剂量上限、十八反十九畏、特殊人群规则全部约束 |
| `formula.modificationReview` | object | 加减复核统计：`{submittedCount, retainedCount, droppedCount, droppedReasons}` |

**中成药 / 西药候选**（贵方 8-05「中成药候选完整子字段」🟡中）

> ⚠️ **字段名更正**：上一版文档写作顶层 `patentMedicines`，实现中**无此字段**；正确路径是 `formula.patentAndWestern`。HIS 方案导出接口（§3.9）中该数据以 `prescriptions.patentMedicines` 提供，两处命名不同请注意区分。

| 字段 | 类型 | 说明 |
|---|---|---|
| `formula.patentAndWestern[].type` | string | `中成药` / `西药` |
| `formula.patentAndWestern[].name` | string | 药品名 |
| `formula.patentAndWestern[].specification` | string\|null | 规格 |
| `formula.patentAndWestern[].singleDose` | string\|null | 单次剂量。**西药一律不下发**；中成药仅在说明书条目本身给全时填写，缺项即为 `null`，不作猜测 |
| `formula.patentAndWestern[].frequency` | string\|null | 用药频次 |
| `formula.patentAndWestern[].route` | string\|null | 给药途径 |
| `formula.patentAndWestern[].usageBoundary` | string | 适用边界与服药注意 |
| `formula.patentAndWestern[].course` | string | 疗程 |
| `formula.patentAndWestern[].positioning` | string | `联合治疗` / `替代方案` / `短期对症` / `需医生评估` |
| `formula.patentAndWestern[].correspondingProblem` | string | 对应的本例问题 |
| `formula.patentAndWestern[].relationship` | string | 与饮片方的关系（是否可叠加） |
| `formula.patentAndWestern[].riskNote` | string | 风险说明 |
| `formula.patentAndWestern[].evidenceId` | string | 说明书条目标识（`EVID-INST-*` / `LOCAL-INST-*`） |
| `formula.medicineCandidateStatus` | object | 无匹配候选时给出 `{status:"no_evidence_match", reason}` |

**健康调护与中医外治**

| 字段 | 类型 | 说明 |
|---|---|---|
| `nonPharma.diet` | string | 饮食调护 |
| `nonPharma.lifestyle` | string | 起居调护 |
| `nonPharma.emotion` | string | 情志调护 |
| `nonPharma.precautions` | array | 注意事项，0–6 条 |
| `nonPharma.tcmTreatments` | array | 中医外治项目，含 `suggestedSitesOrPoints`（穴位单列）、`treatmentContent`、`scheduleSuggestion`、`techniqueBoundary`、`operatorRequirement`、`protocolSource`、`clinicianReviewRequired` |

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

---

### 3.9 HIS 诊疗方案导出

**接口地址**：`POST /api/diagnosis/his-scheme`

面向 HIS「AI 诊疗支持方案」容器的整合出参。与 M03/M04 的分阶段流式出参不同，本接口返回**单个 JSON 对象**（非 NDJSON），把全流程结论按 HIS 写回所需的形态整合，并附写回权限策略。

**入参**：`{ "caseState": {...} }`，`caseState` 需携带 `reasoningDiagnose` 与 `reasoningPrescribe`。

**出参主结构**

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | string | 固定 `tcm-cdss-his-ai-scheme-v1` |
| `status` | string | `ready` / `pending` / `limited` |
| `candidateStatus` | string | `valid` / `limited` / `invalid` |
| `auditStatus` | string | `pass` / `alert` / `unavailable` / `not_submitted` |
| `warningProfile` | object | 风险分级与可执行性：`{level, label, action, executable, reasons, exportMode}` |
| `redFlag` | object | `{label, description, redFlags[]}` |
| `safetyGate` | object | 确定性安全门结论 |
| `aiMedicalRecord` | object | 病历字段回显，含 `tcmLineagePreference`（医生所选流派的可读名称） |
| `writeBackPolicy` | object | 写回权限。`finalPrescriptionReleaseAllowed`、`autoWriteDiagnosis`、`autoWritePrescription` **恒为 `false`** |

**诊断**

| 字段 | 类型 | 说明 |
|---|---|---|
| `diagnoses.western[]` | array | 西医诊断卡（`adoptable` 恒为 `false`，仅供参考） |
| `diagnoses.tcmPatterns[]` | array | 中医证候卡 |
| `diagnoses.mechanism[]` | array | 病机与治法卡 |
| `diagnoses.westernDetail` | object\|null | 西医诊断结构化待查依据：`{name, status, confidence, supportingFacts[], limitations[], suggestedChecks[], icd10?}` |

**处方**

| 字段 | 类型 | 说明 |
|---|---|---|
| `prescriptions.structuredHerbs[]` | array | 药味表，含 `verificationTier` / `warningLevel` / `doseSource` |
| `prescriptions.regimen` | object\|null | 剂数疗程合同字段：`{doseCount, doseCountValue, course, courseDays, dosesPerDay, administrationTimesPerDay, administration, followUpNode}` |
| `prescriptions.decoctionDetail` | object\|null | 煎法细节：`{soakMinutes, decoctionTimes, firstDecoctionMinutes, secondDecoctionMinutes, targetVolumeMl, method, course}` |
| `prescriptions.formulaRationale` | object\|null | 方义四项：`{formulaAnalysis, compositionLogic[], discriminationPath[], classicEvidence[], evidenceBoundary}`。**内部枚举已转中文标签**（`tierLabel` / `anchorLabel` / `statusLabel`） |
| `prescriptions.modifications[]` | array | 随证加减，含 `substitutions[]` 可替换药味 |
| `prescriptions.patentMedicines[]` | array | 中成药/西药结构化候选，含 `dosageAvailable` 标记用法用量是否齐备 |

**健康调护与中医外治**

| 字段 | 类型 | 说明 |
|---|---|---|
| `healthGuidance` | object\|null | `{diet, lifestyle, emotion, precautions[]}`。食疗类治疗性表述已在服务端净化 |
| `treatments.tcmProjects[]` | array | 中医外治项目，`suggestedSitesOrPoints` 单列穴位，`adoptable` 恒为 `false` |

> **安全边界**：当安全门判定为非剂量输出（红旗未解、剂量级门控未通过）时，`prescriptions` 下所有剂量级字段——`structuredHerbs` / `regimen` / `decoctionDetail` / `formulaRationale` / `modifications` / `patentMedicines`——**一并置空或 `null`**，不存在只抑制一部分的情形。

---

### 3.10 中药材知识检索

**接口地址**：`GET /api/tcm-knowledge/search?q=<关键词>`

检索本地受治理中药材/方剂知识库，返回药材条目、剂量边界、十八反十九畏配伍禁忌、特殊人群规则等。

**接口地址**：`GET /api/tcm-knowledge/herb-function?name=<药名>`

返回单味药的功效文本与功效分类。

---

### 3.11 药品目录同步

**接口地址**：`GET /api/tcm-knowledge/drug-catalog`

把本系统据以做临床判断的受治理药品目录分页下发，供 HIS 与院内目录对账。

> **方向说明**：本接口是**出站**（CDSS → HIS），回答"系统认识哪些药"。
> **入站**（HIS 把院内库存推给本系统，开方时基于有货的药开）见 §3.12，回答"本院此刻有哪些药"。
> 两者不要混用。出参每页均带 `inboundSyncEndpoint` 指向入站入口。

**入参**（查询串）

| 参数 | 必填 | 说明 |
|---|---|---|
| `type` | 否 | `herb`（饮片正名/别名/剂量边界）、`patent`（中成药说明书条目）、`his_mapping`（HIS 商品名映射）、`spec_conversion`（规格换算）。**不填返回目录概览** |
| `cursor` | 否 | 分页游标，默认 `0` |
| `limit` | 否 | 每页条数，默认 100，上限 500 |
| `since` | 否 | 上次拿到的 `catalogVersion`；一致则返回 `304`，可跳过整轮拉取 |

**出参**

| 字段 | 类型 | 说明 |
|---|---|---|
| `catalogVersion` | string | 目录版本，形如 `kb:<schema>@<生成时间>\|identity:<schema>\|patent:<源文件哈希前16位>`。三份受治理资产任一重建即变化 |
| `type` | string | 本页目录类型 |
| `total` | number | 该类型总条目数 |
| `cursor` / `nextCursor` | number \| null | 当前游标 / 下一页游标（`null` 表示已到末页） |
| `items` | array | 条目列表 |
| `inboundSyncStatus` | string | 恒为 `not_supported_pending_persistence_decision` |

**`type=herb` 条目字段**

| 字段 | 说明 |
|---|---|
| `name` | 饮片正名 |
| `aliases` | 可自动归一的别名 |
| `ambiguousAliases` | **歧义别名**（如「一包针」可指千年健或石韦）。系统**绝不自动择一**，原样列出待人工裁定 |
| `doseLimit` | `{min, max, basis}`；仅在 `doseLimitStatus=governed` 时给出 |
| `doseLimitStatus` | `governed` / `not_governed`（无药典数值边界，用量由医师确定）/ `source_conflict_requires_pharmacist_review`（分用途剂量冲突，须药师复核） |

> `his_mapping` 的 `status` 与 `spec_conversion` 的 `conversionStatus`（如 `AUTO_PARSED_NEEDS_REVIEW`、`P1-需补表/复核`）**原样保留**，表示该条尚未人工确认，不得当作已确认条目直接采用。

**调用示例**

```bash
# 概览：各类型条目数与目录版本
curl "https://82.156.128.153/tcm-cdss/api/tcm-knowledge/drug-catalog" \
  -H "x-cdss-api-token: <token>"

# 分页拉取饮片目录
curl "https://82.156.128.153/tcm-cdss/api/tcm-knowledge/drug-catalog?type=herb&limit=200&cursor=0" \
  -H "x-cdss-api-token: <token>"

# 增量判断：目录未变返回 304
curl -i "https://82.156.128.153/tcm-cdss/api/tcm-knowledge/drug-catalog?type=herb&since=<上次的catalogVersion>" \
  -H "x-cdss-api-token: <token>"
```

---

### 3.12 院内药品库存导入

**接口地址**：`POST /api/drug-inventory`（导入） / `GET /api/drug-inventory`（状态查询）

贵方把医院库存药导入本系统；开方时系统**优先**落在有货药味上。

> **核心口径：库存是可得性约束，不是临床正确性约束。**
> 这与贵方对味数的口径一致——"味数控制只是建议，如诊疗必须也不能裁剪"。
> 本例该用麻黄汤而院内恰好没有麻黄时，系统**不会**悄悄换一味药，而是照常给出麻黄汤、
> 标注"麻黄：院内暂无库存"，并附受治理替代候选供医师选择。
> 静默替换会让医生看到的方与系统推理的方不是同一个，临床上比缺货危险得多。

**入参**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source` | string | 否 | 来源标识，如院区名或 HIS 实例名 |
| `items` | array | 是 | 药品条目，单次上限 20000 条，超限返回 `413` 并要求分批 |
| `items[].name` | string | 是 | 院内药品名 |
| `items[].kind` | string | 否 | `herb`（饮片，默认）/ `patent`（中成药） |
| `items[].available` | boolean | 否 | 是否有货，**缺省为 `true`**（推过来的即视为在售目录） |
| `items[].specification` | string | 否 | 规格 |
| `items[].goodsId` | string | 否 | 院内商品号 |

**语义：整批替换。** 每次导入完全替换上一批，不做增量合并——增量要求贵方维护删除事件，
而"某药已下架却没推删除"会让系统长期以为它有货，比整批替换危险。

**出参**

| 字段 | 说明 |
|---|---|
| `inventoryVersion` | 库存版本（内容指纹） |
| `importedAt` / `source` / `itemCount` | 导入时间 / 来源 / 条目数 |
| `availableHerbCount` / `availablePatentCount` | 有货饮片数 / 有货中成药数 |
| `unresolvedNames` | **归一不到受治理正名的院内药名**，如实回报供贵方补映射；不静默丢弃 |
| `ambiguousNames` | 存在多个候选的院内药名（如"一包针"→千年健/石韦）。系统**绝不自动择一** |

**开方时的表现**

| 场景 | 系统行为 |
|---|---|
| 已导入库存 | 生成前把有货饮片清单作为**软偏好**注入；HIS 方案出参新增 `inventory`、`herbAvailability[]`、`outOfStock[]` |
| 药味缺货 | 保留在处方中并标注 `out_of_stock`，附 `substitutes[]`（先过安全边界再按库存过滤） |
| **未导入库存** | 全部标 `unknown`，开方链路行为与未接库存时**逐字节相同**。可得性不是安全控制，缺库存数据绝不阻断出方 |

> 库存**不进临床合同签名域**：库存每天都在变，若纳入签名，昨天签发的方案今天就会验签失败。

**部署要求**：容器需配置 `CDSS_DRUG_INVENTORY_PATH` 指向持久卷（compose 默认
`/app/runtime-data/drug-inventory.json`，已挂载 `tcm-cdss-runtime` 卷）。未指向持久卷时
每次发布后库存归零。

**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/drug-inventory" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: <token>" \
  -d '{
    "source": "好医生HIS-XX院区",
    "items": [
      { "name": "黄芪", "kind": "herb", "available": true },
      { "name": "当归", "kind": "herb", "available": true },
      { "name": "麻黄", "kind": "herb", "available": false },
      { "name": "八珍颗粒", "kind": "patent", "available": true, "specification": "每袋8g", "goodsId": "P-0001" }
    ]
  }'
```

### 3.13 M02 追问回答解析 —— `POST /api/diagnosis/question/interpret`

把医生对 M02 追问的**自由文本**回答确定性解析为结构化病历字段更新。

请求体 `{ caseState, m02Plan, answer }`，三者**均为必填**（任一为 `null` → 400）。请求体上限 1 000 000 字节。
`m02Plan` 必须是 M02 出参里 `decision="ask"` 且 `questions` 非空的**原样**计划；`answer` 为 1–6000 字符自由文本。

成功：`{ ok: true, schemaVersion: "tcm-cdss-m02-answer-interpretation-v1", answers: [...] }`。

失败：`{ ok: false, failure: { code, message, retryable, attempts } }`，状态码按 `code` 映射——
`invalid_request`/`invalid_case_state` → 400，`invalid_plan`/`invalid_answer` → 422，
`model_not_configured` → 503，`model_timeout` → 504，`request_aborted` → 408，其余 → 502。

### 3.14 病例快照加解密 —— `POST /api/diagnosis/snapshot`

AES-256-GCM 加密的病例快照，用于浏览器侧持久化。密钥为服务端 `CASE_SNAPSHOT_ENCRYPTION_KEY`，**不下发**。

请求体 `{ action: "encrypt" | "decrypt", binding, payload | envelope }`。`action` 取其它值 → 400。
`binding` 用于把快照绑定到当前鉴权身份，缺失或不匹配 → 400；**换一个身份无法解开别人的快照**。
请求体上限 3 MiB，明文上限 2 MiB，超限 → 413。未配置加密密钥 → 503。

### 3.15 受控术语确认 —— `POST /api/diagnosis/terminology/confirm`

医生确认一条控制词表映射（如把「心脾两虚」确认为 GB/T 16751 的「心脾两虚证」）。

请求体 `{ caseState, mapping: { namespace, fieldPath, candidateId } }`。

**`namespace` 只接受 `tcm_syndrome` 与 `icd10` 两个值**，其余命名空间会被**具名拒绝**（400，
`code: "terminology_confirmation_target_not_allowed"`）而不是静默忽略。
字段缺失或类型不对 → 400 `invalid_terminology_confirmation_request`。
若该映射不在当前已签名的合同里（例如 M03 结论已被替换）→ 409 `terminology_suggestion_not_current`。

### 3.16 服务健康检查 —— `GET /api/diagnosis/health`

不带参数时返回基础状态与构建身份（`commit` / `sourceDigest` / `timestamp`），用于核对**线上跑的是哪一版**。

`?strict=1` 额外返回 `strictReady`，并对以下依赖做**真实探针**：主模型、临床复核、证据检索、
舌象视觉（若启用）、审方、受控术语、快照加密、推理签名、临床事实、中医外治配置、
证候假设重排、限流身份。任一未就绪 → `strictReady: false` 且 **HTTP 503**。

> 该接口就是容器 healthcheck 打的那个。它会产生真实上游调用，**不要用于高频轮询**。

### 3.17 模型健康检查 —— `GET /api/model-health`

默认只返回配置态（provider / model / 是否配置密钥），不产生上游调用。
`?check=1` 会**真实调用一次**配置的模型并校验其返回了最终内容——只返回推理过程而无正文的提供方会在这里判失败。

### 3.18 院内药品库存查询 —— `GET /api/drug-inventory`

与 §3.12 的导入同一路径。返回当前生效的库存快照摘要（批次、条目数、解析状态、歧义与未识别名单）。
**未导入库存时链路行为与接入前逐字节相同**——库存是可得性约束，不是安全控制，缺数据不阻断出方。

---

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
