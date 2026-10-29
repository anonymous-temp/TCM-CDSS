# 中医临床决策支持系统（中医 CDSS）接口文档

| 项 | 内容 |
|---|---|
| 文档版本 | V2.53 |
| 发布日期 | 2026-10-29 |
| 服务版本 | `tcm-cdss-20260828-lineage-modification-contract-r1` |
| 接口基址 | `https://82.156.128.153/tcm-cdss` |
| 协议 | HTTPS |
| 字符编码 | UTF-8 |
| 数据格式 | 请求 JSON；诊疗流程接口响应为 NDJSON 流，其余为 JSON |

---

## 1. 概述

中医 CDSS 面向门诊场景，为医生提供辅助诊疗建议。一次完整诊疗按 M01–M05 五个阶段顺序调用，
每个阶段的结论作为下一阶段的输入原样传递。

**系统仅提供建议，不作诊疗决定。** 所有结论均可追溯到患者事实、确定性规则或知识库条目；
无法追溯的内容会被显式标注为证据不足，不会以确定结论的形式输出。

**调用顺序**

```
访问凭证获取
      │
      ▼
M01 病历采集 ──▶ M02 追问生成 ──▶ M03 辨病辨证 ──▶ M04 候选方药 ──▶ M05 风险随访
  舌象图片解析      补充信息缺口      诊断与病机        方药与调护        风险与随访
   （可跳过）      （可跳过）
      │
      └──▶ 红旗筛查（任意阶段可调）──▶ 命中时经急症排查确认后继续
```

**接口分组**

| 分组 | 用途 |
|---|---|
| 诊疗流程 | M01–M05 五阶段主链路，按顺序调用 |
| 安全控制 | 急危重症筛查与排查确认，可在任意阶段调用 |
| 药品同步 | 药品目录下发与院内库存导入，与诊疗流程解耦，可独立对接 |

---

## 2. 接口总表

| 序号 | 分组 | 接口名称 | 方法 | 路径 | 主要用途 |
|---|---|---|---|---|---|
| 1 | 诊疗流程 | 访问凭证获取 | POST | `/api/auth/access` | 令牌换取访问凭证，每个会话调用一次 |
| 2 | 诊疗流程 | M01 病历采集 | POST | `/api/diagnosis/collect` | 舌象图片解析；**纯文本输入不产出结构化病历**，见 §4.2 |
| 3 | 诊疗流程 | M02 追问生成 | POST | `/api/diagnosis/question` | 生成信息缺口追问，不阻断流程 |
| 4 | 诊疗流程 | M03 辨病辨证 | POST | `/api/diagnosis/diagnose` | 西医诊断、中医证候、病机拆解、治则治法 |
| 5 | 诊疗流程 | M04 候选方药 | POST | `/api/diagnosis/prescribe` | 候选方药、方义、煎服法、随证加减、中成药、健康调护、中医外治 |
| 6 | 诊疗流程 | M05 风险随访 | POST | `/api/diagnosis/assess` | 用药风险提示与随访计划 |
| 7 | 安全控制 | 红旗筛查 | POST | `/api/diagnosis/red-flags` | 急危重症征象筛查 |
| 8 | 安全控制 | 急症排查确认 | POST | `/api/diagnosis/emergency-clearance` | 医生确认已完成急症排查后继续流程 |
| 9 | 药品同步 | 药品目录下发 | GET | `/api/tcm-knowledge/drug-catalog` | 受控药品目录分页下发，供院内目录对账 |
| 10 | 药品同步 | 院内库存导入 | POST | `/api/drug-inventory` | 导入院内库存药，开方时优先使用有货药味 |
| 11 | 药品同步 | 院内库存查询 | GET | `/api/drug-inventory` | 查询当前生效的库存快照 |
| 11a | 药品同步 | 按药名查院内状态 | POST | `/api/drug-inventory/availability` | 按药名返回「院内有货 / 缺货 / 库存外用药」（V2.27 起，§4.10.1） |
| 12 | 客户管理 | 客户首次登记 | POST | `/api/customers/register` | 以幂等键登记固定 Token 下的新客户 |
| 13 | 运维审计 | 租户审计查询 | GET | `/api/tenant-audit` | 查询当前客户的登记、库存导入与读取留痕 |

接口详细定义见 §4。诊疗结果各项内容在响应中的字段位置见 §5。

另有两项能力（HIS 诊疗方案打包导出、服务健康检查）与主链路无关，见附录 A。

### 2.1 快速开始：先跑通第一次调用

在对接五阶段主链路之前，建议先用这三步确认网络、鉴权与版本三件事都对齐，
把环境问题与业务问题分开排查。

```bash
BASE="https://82.156.128.153/tcm-cdss"
TOKEN="<接口令牌>"
CUSTOMER_ID="<客户唯一标识>"

# ① 连通性与版本核对：确认所连服务与本文档表头的「服务版本」一致
curl -s "$BASE/api/diagnosis/health" -H "x-cdss-api-token: $TOKEN"

# ② 鉴权校验：令牌正确返回 {"ok":true}，错误返回 401
curl -s -X POST "$BASE/api/auth/access" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"customerId\":\"$CUSTOMER_ID\"}"

# ③ 业务路由连通性：库存查询不经模型、不计入调用频率限制，响应即时，
#    适合作为首个业务接口冒烟（未导入库存时返回 inventoryLoaded=false，属正常）
curl -s "$BASE/api/drug-inventory" \
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID"
```

三步都通过后，再按 §6.1 的完整链路示例接入 M01–M05。

> 首个**临床**接口建议直接用 M03（§4.4），它是主链路上信息量最大的一段。
> 注意红旗筛查（§4.7）虽然判定规则是确定性的，但会触发语义红旗预检，
> 属于计入调用频率限制的模型调用类接口（§3.8），不适合当作高频探活。
**首次接入务必先读 §3.3（五条强制要求）与 §3.5（流式帧解析），这两处是集成失败的主要来源。**

---

## 3. 通用约定

### 3.1 鉴权

所有接口均需鉴权。访问令牌请求头二选一：

| 方式 | 请求头 |
|---|---|
| 自定义头 | `x-cdss-api-token: <令牌>` |
| 标准头 | `Authorization: Bearer <令牌>` |

未携带或令牌错误返回 `401`。

除健康检查外，病例、诊断、处方、审方、HIS 打包、快照和药品库存接口还必须绑定客户上下文：

| 调用方式 | 客户标识传递方式 |
|---|---|
| 服务端/API 对接 | 请求头 `x-cdss-customer-id: <客户唯一标识>` |
| 浏览器登录 | `/api/auth/access` 请求体同时提交 `{token, customerId}`，成功后由服务端签发 httpOnly 客户上下文 Cookie |

`customerId` **区分大小写**，仅接受 6–64 位 ASCII 字母、数字、下划线或连字符。已经登记的客户必须属于该固定接口令牌的授权范围；未知客户调用 GET 或临床接口仍统一返回 `403 customer_forbidden`。启用 JIT 时，未知客户的第一次库存 `POST`（或显式调用 `/api/customers/register`）携带有效 `Idempotency-Key` 后会原子登记并继续处理；缺少幂等键、键冲突或超过配额均 fail-closed。**自 V2.6 起，库存载荷的结构校验先于 JIT 登记执行**：items 缺失/为空、条目缺 `name`、`kind` 非 `herb|patent|western` 枚举、`available` 非布尔、分片参数非法等载荷内在错误一律返回 `400`（或超限 `413`）且**不产生任何租户副作用**——失败的首提交不会留下已登记客户；条目级错误整批拒绝并在响应中回报 `rejectedEntries`（前 20 条，含 `index` 与 `reason`）与 `rejectedEntryCount`，不做静默丢弃。本次请求完成 JIT 登记时，库存响应额外返回 `customerRegistered: true`。客户标识与非秘密 `clientId` 共同进入 M03/M04、急症解除和语义事实证明的签名域，并参与快照 AAD、限流、库存路径和审方租户头；跨客户复用病例状态或凭证会在任何上游模型调用前返回 `409` 或失效降级，不会读取或回落到其他客户数据。

> **本文档中的所有 curl 示例统一使用 `$TOKEN` 占位**，请先在 shell 中导出真实令牌再执行：
> ```bash
> export TOKEN="<贵方接口令牌>"
> export CUSTOMER_ID="<客户唯一标识>"
> ```
> V1.4 之前的版本在示例里内联过生产令牌，现行文档已全部改为占位符。既定交付令牌在版本升级中保持不变，只能存放在受保护运行时配置中，不得复制到源码、文档、日志或工单；历史副本应限制访问并按双方既定安全流程处置。

### 3.2 请求头

| 请求头 | 必填 | 值 |
|---|---|---|
| `Content-Type` | 是 | `application/json` |
| `x-cdss-api-token` | 是 | 接口访问令牌 |
| `x-cdss-customer-id` | 临床与药品接口是 | 6–64 位客户唯一标识；同一次就诊全流程保持不变 |
| `Content-Encoding` | 否 | `gzip` 或 `deflate`：请求体压缩后发送。M04/M05 要原样回传上一阶段结论，请求体约 50–170 KB，压缩后约为原来的 1/5，建议使用，见 §3.10。不带此头即按未压缩处理 |
| `Idempotency-Key` | **库存 `POST` 与客户登记：是** | 8–200 位可打印 ASCII；同一键只能绑定同一个 client/customer。`POST /api/drug-inventory` **缺少或格式非法一律 `400 idempotency_key_required`**，且在读取请求体与建立客户上下文之前就返回（不产生任何租户副作用）。同键同载荷重放首次结果，同键不同载荷返回 `409`，见 §4.10 |

### 3.3 参数传递要求

**以下六条为强制要求，不满足将导致接口报错或链路中断。**

| 编号 | 要求 | 不满足的后果 |
|---|---|---|
| R1 | `caseState.id` 必填，且**同一次就诊全流程使用同一个值** | M04 返回 `409` 签名校验失败 |
| R2 | 上一阶段返回的结构化结论必须**原样**合并回 `caseState`，不得改写、精简或重新格式化 | 签名校验失败，返回 `409` |
| R3 | M03 结论中的签名字段名为 `contractSignature`（非 `signature`） | 取值为空，回传后 `409` |
| R4 | 查询参数中的中文必须 URL 编码 | 反向代理返回 `400` |
| R5 | 建议按 M01→M02→M03→M04→M05 顺序调用；**真实门禁只有三道**，不是"任意跳段即 409" | 见下方 R5 说明 |
| R6 | 所有临床、审方、HIS、快照和库存请求携带同一个 `x-cdss-customer-id`；**每一次**库存写入与显式登记都必须带 `Idempotency-Key`；`caseState.customerId` 若已存在必须与请求头一致 | 缺失返回 `400 customer_id_required`；未授权读取返回 `403 customer_forbidden`；库存写入缺键返回 `400 idempotency_key_required`；键冲突返回 `409 idempotency_conflict`；客户不一致返回 `409 customer_context_mismatch` |

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

### 3.3.1 CaseState 入参字段表

调用方只需构造下表字段；其余为服务端产出、按 R2 原样回传即可。**未列出的键不会报错，但也不会生效。**

| 字段路径 | 类型 | 必填 | 取值 | 作用阶段 | 说明 |
|---|---|---|---|---|---|
| `id` | string | 是 | — | 全阶段 | 同一次就诊全程不变（R1）。缺省时服务端自动生成，将导致 M04 返回 `409` |
| `customerId` | string | 建议回传 | 与请求头一致 | 全阶段 | 服务端按请求头写入病例状态并纳入签名；调用方不得跨客户改写或复用 |
| `phase` | enum | 建议 | `idle`/`collect`/`question`/`diagnose`/`prescribe`/`assess`/`done`/`error` | 全阶段 | **枚举外的值会让整个 caseState 被拒**（400），不是被忽略。M02 要求 `phase="question"` |
| `patient.sex` | string | 建议 | 男/女 | 全阶段 | `hisRecord.fields.sex` 优先 |
| `patient.age` | number | 建议 | 岁，可为小数（0.5＝6 个月） | 全阶段 | 影响特殊人群剂量规则、**儿童年龄分数法折算**与生命体征参考线（V2.30，见 §4.5「儿童患者」）。婴幼儿也可只在 `hisRecord.fields.age` 写「8个月」「18月龄」「12天」「3周龄」「6岁2个月」；两处都有时按**数值**比较（8个月＝0.6667 岁，相差不超过约 18 天算一致），不再逐字比较而误报「年龄记录冲突」 |
| `patient.name` | string | 否 | — | — | **提交后恒被服务端清空**（脱敏），不要用它传身份信息 |
| `chiefComplaint` | string | 是 | — | M01 起 | 缺失时 M03 不进入完整诊断 |
| `symptoms` | string \| string[] \| object | 建议 | — | M01 起 | 现病史等症状信息。**三种形态等价**：给字符串或字符串数组时归一到 `symptoms.presentHistory`；给对象时按键原样保留。<br>V1.3 及以前的实现只认 object，字符串会被静默丢成 `{}`（整段现病史消失且请求仍返回 200），**V1.4 已修复**。<br>与 `hisRecord.fields.xianbingshi` 同时存在时以后者为准，自由文本并入 `symptoms.extraText`，不丢字。<br>**病历各栏用中文键原样传入**：`现病史`、`既往史`、`过敏史`、`用药史`、`个人史`、`家族史`、**`婚育史`、`月经史`**、`辅助检查` 等。妊娠、哺乳、备孕、末次月经只写在婚育史或月经史里的病历，这两栏不传，系统就无从知道患者是孕妇（V2.48 说明：10.26 测评病历 1「孕期女性」只在婚育史里写了「怀孕」，而贵方的请求一直没有传婚育史）。 |
| `pastHistory` / `medicationHistory` / `allergyHistory` | string | 建议 | — | M01 起 | 五史。**「未提及」不等于阴性**，不要用空串表达「否认」，应写明「否认…」 |
| `tongue` / `pulse` / `faceNote` | string | 建议 | — | M01 起 | 四诊文本 |
| `tongueImageDesc` | string | 否 | — | M01 | 舌象图片走 GLM 视觉后回填；无图时可手工录入 |
| `vitals` | object | 建议 | — | 全阶段 | BP/T/P/R/SpO2，危急阈值由确定性安全门解析 |
| `tcmLineagePreference` | string | 否 | 见 §3.3.2 | M02/M03/M04/M05 | 流派选择。顶层与 `hisRecord.fields` **两条通道都生效** |
| `herbCountPreference` | string | 否 | 见 §3.3.3 | **仅 M04** | 饮片味数偏好。**仅接受顶层字段** |
| `clinicTreatmentCapabilities` | object | 否 | — | M04/M05 | 院内可开展的中医外治项目，决定外治建议是 `clinic_available` 还是 `referral_only` |
| `hisRecord.fields` | object | 否 | — | 全阶段 | HIS 病历字段直传；与顶层同名字段冲突时以本通道优先 |
| `emergencyClearance` | object | 否 | — | 全阶段 | 只能由 `/api/diagnosis/emergency-clearance` 产出；每次读取都会重新校验并剥离，伪造无效 |
| `reasoningDiagnose` / `reasoningPrescribe` / `reasoningV2` | object | 交接必填 | — | M04/M05 | 上一阶段结论，**必须原样回传**（R2）。任何改写都会导致 `409` |

### 3.3.2 流派选择 `tcmLineagePreference`

影响 M02 追问策略、M03 辨证重点、M04 组方风格、M05 随访口径四个阶段。不传等价于 `unrestricted`。

**流派偏好不改变任何安全判定**：剂量上限、十八反十九畏、特殊人群禁忌、红旗处置一律不因流派放宽。

| code | 可读名 | 分组 | 也可直接传的中文别名 |
|---|---|---|---|
| `unrestricted` | 不限定：循证安全优先 | 默认 | 不限定、循证安全优先 |
| `classical-formula` | 经方思路 | 经典辨治 | 经方、经典方证、经典方证对应 |
| `warm-disease` | 温病思路 | 经典辨治 | 温病、卫气营血、三焦辨证 |
| `nourish-yin-danxi` | 滋阴/丹溪思路 | 学术流派 | 滋阴、丹溪、朱丹溪、相火、阴虚 |
| `warm-tonify` | 温补学派思路 | 学术流派 | 温补、温补学派、温补派、肾命学派 |
| `support-yang` | 扶阳学派思路 | 学术流派 | 扶阳、扶阳学派、扶阳派、火神、火神派、郑钦安 |

以上六档即全部取值。**传入其他值不会报错，按 `unrestricted` 处理**——请不要依赖服务端对未知流派名报错来做前端校验。

> **V2.8 流派勘误**：温补学派与扶阳学派是有交集但不可合并的两套学术谱系。旧代码
> `warm-tonify-yang` 仅为请求兼容而保留，并确定性归一到 `warm-tonify`；新接入不得继续发送该旧码。
> 「温阳」本身是治法术语，不再单独作为流派别名；需要扶阳学派时请明确发送 `support-yang`
> 或「扶阳学派 / 火神派」。流派拆分不改变任何剂量、毒性药、配伍或特殊人群安全门。

默认档 `unrestricted` 不是"没有流派"，它是**以脏腑辨证 + 通用方为主**的工作路径（归脾汤、逍遥散、参苓白术散、六味地黄丸这类方在默认档下正常出现）。选择其余五档，是让系统在同等安全条件下优先按该体系的辨证眼目和常用方组织思路。

选了具体流派时（V2.41 起）：
- 模型按该派选的方（如经方思路下的桂枝汤），只要目录给这首方标的主治证候与本例证候相容，就保留为推荐方，治法随这首方的功效写；与本例证候不相容的派内方（风寒表证用四逆汤）、或模型判为不适用时，仍用教材代表方。
- 辨证依据末尾有一句按该派眼目看本例（经方看六经与方证眼目，温病看卫气营血或三焦，丹溪看气血痰郁与阴虚相火，温补看脾肾命门，扶阳看阴阳盛衰）；不适用时写这一派看什么、本例缺什么。
- `lineageAdaptation` 的 `influencedDecisions` 里说到的方与最终推荐的方一致；没有采用的方只以「未用 X」出现。
- 经方思路下，病历见到经方方证的条文特征症（且区分点不相反）时采用方证，不再先比教材行。

出参侧回显在 `reasoningPrescribe.lineageAdaptation`（`lineageCode`/`label`/`applicable`/`applicabilityReason`/`influencedDecisions`/`unaffectedBySafety`/`safetyDeference`），以及 HIS 方案导出中。

### 3.3.3 饮片味数偏好 `herbCountPreference`

| 取值 | 含义 | 也可直接传的中文写法 |
|---|---|---|
| `within_10` | 10 味以内 | `10味以内`、`≤10`、`<10` |
| `between_10_15` | 10–15 味 | `10-15`、`10–15`、`10~15`、`10至15`、`10－15` |
| `at_least_15` | 15 味及以上 | `15味及以上`、`15味以上`、`≥15`、`>15` |

该参数的行为规则如下，对接前请逐条确认：

1. **只认写在 `caseState` 最外层的这个字段。** 放到 `hisRecord.fields` 里**不生效，而且不报错**。
   注意这一点和流派**不一样**——流派两个位置都认，味数只认最外层。
2. **只有 M04 开方接口读它**，M01–M03、M05 都不读。
3. 大小写敏感（`WITHIN_10` 不认）。填数字 `12`、或"少一点"这种模糊说法，一律当没填处理，**不报错**。
   建议直接传上表左列那三个值，中文写法只是兼容。
4. **这是偏好，不是硬性限制。** 系统不会为了凑味数去删药：经典方的原方组成、绑定病机的必需药、
   有安全定性作用的药，都会保留。
5. 所以**开出来的药味数可能超出所选档位**。这不是参数没生效，是临床必需优先。

#### R5 的真实门禁（V1.4 更正）

V1.3 写的"不可跳段，跳段调用返回 409"与实现不符：M03 在 `phase=idle`、无任何前序产物时
**直接返回 200**（追问因此是可选的增强，不是前置条件）。实际存在且只存在三道门：

| 门 | 位置 | 触发条件 | 返回 |
|---|---|---|---|
| M02 阶段门 | `/api/diagnosis/question` | `caseState.phase ≠ "question"`，或 `questionRounds ≥ 1` | `409` |
| M04 前提 | `/api/diagnosis/prescribe` | 未携带 M03 结论（`reasoningDiagnose`） | `409` |
| M05 前提 | `/api/diagnosis/assess` | 未携带 M03 结论（`invalid_m03_signature`）；M04 缺席（如服务端非剂量页）时做 diagnose-only 评估（随访与安全总评照常） | `409` |

也就是说：**M01 与 M02 都可以跳过**；M03 之后的两段需要携带上一段的结论。**V2.31 起签名只标注、不拦截**：回传的 M03/M04 与本系统签发的版本不一致（被修改、未原样回传、换了病例编号）时，照常按回传内容生成结果，并在 `warnings[]`（HIS / 处方后审）或正文（M04 开头「来源说明」、M05 提示段）附 `contract_provenance_*` 来源提示；剂量边界、配伍禁忌、特殊人群等安全核对对实际回传的内容重跑，不依赖签名。

---

### 3.11 红旗命中后系统怎么表现

**V2.18 起只有一种处置方式**：原「处置档位」环境变量 `CDSS_GATE_DISPOSITION` 及其 `block`
（旧 fail-closed 拦截，仅作运维回滚）已删除，线上此前也从未使用 `block`。

红旗照常检测、照常输出，M03/M04 继续生成完整结论与候选；可见正文置顶一段确定性安全警示横幅
（`<!-- CDSS_SAFETY_ADVISORY -->`），用药风险段把急诊/转诊评估列为第一优先级。
**V2.46 起（剂量一致化）**：红旗未解除时 M04 照常给带剂量的候选，`safetyGate.candidateMode` 为 `limited_dose`、
`formalAdoption` 为 `blocked`——红旗解除前不可采纳，急症排查确认（§4.8）解除后按常规判定；复诊计划第一句为
「请在当天到医院急诊或专科就诊，先排除急危重情况…」。妊娠、哺乳、抗凝、肝肾功能不全等独立边界同样给剂量
（`limited_dose`，`formalAdoption` 为 `eligible_after_doctor_confirmation`，相冲的药味由开方核对剔除或逐味标注，原因仍列在
`reasons`）。只有剂量算不出来时才是非剂量候选（原因码 `dose_authorization_withheld`）：只写「患儿」而判不出年龄段、病历年龄与登记年龄冲突。
V2.45 及以前红旗与独立边界一律不给剂量。

> 若在测试中看到「只输出风险/处置/检查、不生成候选」，说明运行的是 V2.18 之前且设置了 `block` 的旧版本，
> 对账前请先核对 §2.1 的服务版本。
>
> 逐味硬规则始终生效：药典剂量上下限、十八反十九畏、特殊人群禁忌、管制毒性药材扣除、PHI 脱敏。
> "不阻断"只作用于**处置**，不作用于**检测**，也绝不把"未知"当成"无风险"。

---

### 3.4 响应格式

| 接口 | 响应类型 | `Content-Type` |
|---|---|---|
| M01–M05 | NDJSON 流（见 §3.5） | `application/x-ndjson` |
| 红旗筛查、急症排查确认、访问凭证、药品同步 | 一次性 JSON | `application/json` |

流式响应还会带以下响应头，反向代理与客户端不应缓存或缓冲：

| 响应头 | 值 | 说明 |
|---|---|---|
| `Cache-Control` | `no-store, private` | 全部 NDJSON 响应 |
| `X-Content-Type-Options` | `nosniff` | 全部 NDJSON 响应 |
| `Connection` | `keep-alive` | 仅真实流式响应；确定性结果为一次性写出，可能不带此头 |

> M01–M05 的响应**并非都是长流**。当本阶段结果可由确定性规则直接给出时（例如信息不足时的
> 追问、安全降级后的非剂量输出），服务端会一次性写出同样格式的 NDJSON 并立即结束。
> 两种情形的帧格式完全一致，解析逻辑无需区分。

### 3.5 NDJSON 流式协议

每行一个完整 JSON 对象，以 `\n` 分隔。常见帧及扩展事件如下：

| 帧 | 出现时机 | 处理方式 |
|---|---|---|
| `{"content":"<文本片段>"}` | 全程 | 按到达顺序拼接为正文 |
| `{"content":"[END]"}` | 流正常结束 | 结束解析；**未收到该帧即视为流被截断** |
| `{"error":"<错误描述>"}` | 流内错误 | 终止解析并向上报错；该帧之后不会再有内容 |
| `{"type":"heartbeat","status":"<进度描述>","processedChars":<已处理字符数>}` | 模型长时间推理期间，每 5 秒一帧 | **跳过，不计入正文**；可用于驱动前端进度提示 |
| `{"type":"module_draft","module":"m03.western","revision":1,"contentKind":"clinical_draft","content":"<预览文本>"}` | M03/M04 部分内容形成时 | **单独展示只读草稿，不拼入规范正文**；不需要预览的客户端忽略即可 |

V2.10 的临床草稿模块包括 `m03.western`、`m03.syndrome`、`m03.pathogenesis`、`m03.therapy`、`m04.candidate`。`contentKind` 是可选新增标记；新临床预览为 `clinical_draft`，历史状态帧可能没有该字段。预览明确标注“生成中·未定稿”，M04只提前展示候选名称、药味及配伍思路，剂量以完成报告为准。草稿不能当作已签名结果回传M04/M05/HIS；最终替换标记或END到达后，应清除草稿并忽略该请求后续迟到的草稿。切换病例或开始新请求时同样清除旧请求的草稿。

当本阶段结果含结构化随访节点时（最常见于 M05），流内还会多下发一帧：

| 帧 | 说明 |
|---|---|
| `{"type":"followup_timeline","timelineItems":[<随访节点数组>]}` | 随访节点数组，与正文并行下发；该帧**出现在正文之前**。不需要时跳过即可 |

V2.11 的 M05 完成响应还可在 `[END]` 前附带显示观测：

| 帧 | 说明 |
|---|---|
| `{"type":"warning_profile","observation":<服务端签发的显示收据>}` | 绑定本次病例及最终报告的警示显示信息，供页面、导出及经服务端验证的快照恢复保持一致。**不拼入正文**；不使用该能力的调用方忽略即可 |

该收据只服务于显示一致性，不是处方授权、审方通过或 HIS 采纳凭据，也不替代 M03/M04 的原有签名。HIS 仍依据当前病例及实际核对结果计算自己的结论，不信任调用方回传的显示分级。启用显示观测的客户端只在请求完整结束且病例和结果仍匹配时使用它；重复、损坏、过期或被编辑失效的观测应被忽略，不能因此清空可读报告。生活调护等建议仍完整展示，但不因其中包含“严禁”等措辞就自动成为当前用药禁忌；实际风险提示继续保留。新增帧不改变既有正文、结束帧、鉴权或客户 Token。

药味工作台的既有 `POST /api/diagnosis/post-prescription-risk` JSON 响应，在当前编辑版完成校验、审方及原有版本凭据签发后，也可在顶层返回可选 `warningObservation` 字段，内容为同一版本的显示收据。它绑定原始请求与页面采纳后的最终报告；不嵌入 `audit`、临床病例或正文。未返回、损坏或不匹配时忽略该字段，既有 `section`、`followup`、`followupTimeline`、`audit` 及处方版本凭据语义不变。加密快照恢复仅接受解密接口顶层的 `verifiedWarningObservation`；加密接口不会为调用方提供的显示结论签名。

**外部审方已下线（V2.18，2026-09-25）**：外部合理用药审方（灵犀）接口已从系统中移除，此后不再启用。线上自 2026-09-10 起一直处于关闭状态，各出口的表现与关闭期**逐字节相同**：M05 仍使用 `TCM_CDSS_RXAUDIT_STATUS:DISABLED` 呈现标记；HIS `auditStatus` 为 `not_submitted`；工作台响应的 `audit` 仍为 `source:"skipped"`、`reason:"rxaudit_disabled"`，未曾确认严重风险的版本仍为 `auditResult:"NOT_SUBMITTED"`（省略 `highestRiskLevel`）、`auditAvailable:false`、`degraded:false`、`auditReason:"rxaudit_disabled"`，`needManualReview` 只反映本地核对的实际发现。以上取值不能解释为已审或通过，也不得回填为 PASS 或 HIGH。处方安全由本地确定性核对负责：十八反十九畏、药典剂量上下限、缺剂量或剂量无法解析、服法与疗程不完整、现用药记录范围。已有有效签名的 BLOCK/CRITICAL 结果照旧保留原结果与原签名（`retainedPriorAudit:true`）；凭据仍绑定病例、租户和精确处方版本，集成方保留原始字段与版本凭据的要求不变。

若同一处方版本已有有效签名的 BLOCK/CRITICAL 结果，响应会保留原结果和原签名，并标记 `retainedPriorAudit:true`：`source:skipped` 只描述本次未新送审，保留的严重风险来自此前凭据。处方版本变动后原凭据失效。已有本地风险、真实用药史不明、缺失剂量和中成药/西药送审范围约束均保留，不新增医生操作步骤。

**解析器必须做到三点**，否则后续版本新增帧类型时会误判为故障：

1. 先分流带 `type` 的事件帧；只有**没有 `type` 且含 `content`**的帧拼入规范正文。`module_draft` 虽有 `content`，也不能拼入正文；
2. 遇到含 `error` 字段的帧立即终止；
3. 对无法识别的 `type` 值**静默忽略**，不要当作错误。

**错误出现在哪一层，取决于时机**：

| 时机 | 表现 |
|---|---|
| 首字节写出**之前**失败（鉴权、参数、限流、前置条件） | 普通 HTTP 错误响应，`application/json`，见 §3.7 |
| 首字节写出**之后**失败（模型超时、上游中断） | HTTP 状态仍为 `200`，错误以 `{"error":...}` 帧出现在流内 |

因此 **`200` 不代表本次调用成功**：必须读到 `{"content":"[END]"}` 才算完整，且中途不得出现 `error` 帧。

### 3.6 结构化结论提取

M01–M05 的正文中嵌有结构化 JSON，位于以下两个标记之间：

```
<!-- DIAGNOSIS_JSON_START -->
{ ... 结构化结论 ... }
<!-- DIAGNOSIS_JSON_END -->
```

提取步骤：拼接全部 `content` 片段 → 正则匹配两个标记之间的内容 → `JSON.parse`。

### 3.7 通用错误码

**错误响应体形态统一如下**，`code` 仅在可程序化区分的错误上出现：

```json
{ "error": "所选候选方不存在或没有结构化药味，未进入评估。", "code": "invalid_structured_herb" }
```

| 状态码 | 含义 | 是否可重试 | 处理建议 |
|---|---|---|---|
| `400` | 请求参数不合法（JSON 非法、枚举越界、必填缺失） | 否 | 检查必填字段与参数格式；原样重试仍会失败 |
| `401` | 鉴权失败 | 否 | 检查令牌 |
| `403` | 固定 Token 未获当前客户授权 | 否 | 检查客户是否已登记；首次写入按 §4.10/§4.12 携带幂等键 |
| `409` | 流程状态或签名不满足前置条件 | 否 | 见 §3.3 强制要求；须回到上一阶段重新取结论 |
| `413` | 请求体超出上限 | 否 | 见 §3.10；库存使用 §4.10 的分片整批替换，禁止拆成多次独立整批请求 |
| `415` | `Content-Encoding` 不是 `gzip`/`deflate` | 否 | 改用 `gzip`，或去掉该头按未压缩发送 |
| `422` | 业务前置条件不满足（内容合法但当前状态下不可执行） | 否 | 见各接口说明与 `code` |
| `429` | 触发调用频率限制 | **是** | 按 `Retry-After` 秒数退避后重试，见 §3.8 |
| `503` | 依赖未就绪或服务暂不可用 | **是** | 指数退避后重试 |
| `304` | 增量拉取时目录未变更（仅药品目录下发） | — | 沿用本地缓存 |

**结构化错误码速查**

| `code` | 状态码 | 触发条件 |
|---|---|---|
| `required_field_missing` | `400` | 必填字段缺失 |
| `customer_id_required` | `400` | 客户绑定接口未提供客户上下文 |
| `invalid_customer_id` | `400` | 客户标识格式非法 |
| `customer_forbidden` | `403` | 客户不存在或固定 Token 未获授权（两种情况统一响应） |
| `customer_context_mismatch` | `409` | 请求头、签名 Cookie 或病例中的客户标识不一致 |
| `customer_authorization_not_configured` | `503` | 服务端客户授权白名单缺失或非法 |
| `idempotency_key_required` | `400` | **任何**库存 `POST` 或显式登记缺少 `Idempotency-Key`，或提供了格式非法的键（不足 8 位、含空格等）。库存接口在解析请求体之前返回此码 |
| `idempotency_conflict` | `409` | 同一幂等键已经绑定另一 client/customer；或同一幂等键在库存写入上对应了另一份载荷（此时**未写入任何内容**） |
| `customer_quota_exceeded` | `429` | 固定调用方的静态客户与 JIT 客户总数达到上限 |
| `customer_jit_disabled` | `503` | 服务端未开启首次客户自动登记 |
| `customer_registry_unavailable` | `503` | 客户登记持久化不可用或内容非法 |
| `tenant_audit_unavailable` | `503` | 客户登记审计不可用；登记保持非激活状态，不会继续库存写入 |
| `invalid_m03_signature` | `409` | 需要 M03 的接口未携带 M03 结论（V2.31 起签名不一致不再返回本码，改为结果内来源提示） |
| `invalid_candidate_index` | `422` | 指定的候选方序号不存在 |
| `invalid_structured_herb` | `422` | 药味缺名称、剂量非单一正数，或缺对应病机/功用 |
| `contract_provenance_*`（`warnings[].code`，非错误码） | `200` | 来源提示：`m03_unverified` / `m04_unverified` / `workbench_revision_unattested` / `workbench_pre_edit_metadata_removed` / `workbench_edit_shape_unattested` / `unstructured_prescription_ignored`（未签名的处方文本不纳入核对，按诊断生成结果；V2.31 起取代原 `422 missing_structured_prescription`） |
| `invalid_emergency_clearance_request` | `400` | 急症排查确认入参不合法 |
| `invalid_terminology_confirmation_request` | `400` | 术语确认入参不合法 |
| `terminology_confirmation_target_not_allowed` | `400` | 术语命名空间不在允许范围内 |
| `unsupported_catalog_type` | `400` | 药品目录 `type` 取值不受支持 |
| `invalid_inventory_items` | `400` | 库存条目结构不合法 |
| `inventory_too_large` | `413` | 库存条目超过 20000 条上限 |

**失败响应示例**

```bash
# 未携带令牌
curl -i -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/diagnose" \
  -H "Content-Type: application/json" -d '{"caseState":{"id":"OPD-1"}}'
```

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error":"Unauthorized"}
```

```
HTTP/1.1 429 Too Many Requests
Retry-After: 143
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0

{"error":"Model invocation rate limit exceeded for this session or API tenant"}
```

```
HTTP/1.1 413 Payload Too Large
Content-Type: application/json

{"error":"Request body too large; limit is 1000000 bytes"}
```

### 3.8 调用频率限制

模型调用类接口按**会话或租户**分桶限流（同一令牌下的不同浏览器会话各自独立计数）：

| 项 | 值 |
|---|---|
| 配额 | 默认 **60 次 / 10 分钟**（部署可配，范围 10–2000） |
| 计数窗口 | 固定 10 分钟窗口，窗口结束后归零 |
| 覆盖接口 | M01–M05、追问解析、红旗筛查、处方后审方、HIS 方案导出（共 9 条 `POST` 路径） |
| 超限响应 | `429` + `Retry-After`（秒）+ `X-RateLimit-Limit` + `X-RateLimit-Remaining` |

鉴权失败另有两道独立限流，锁定期内一律 `429`：

| 场景 | 阈值 | 锁定时长 |
|---|---|---|
| 访问凭证获取（`POST /api/auth/access`）令牌错误 | 10 分钟内失败 8 次 | 10 分钟 |
| 其余接口携带错误令牌 | 10 分钟内失败 20 次 | 10 分钟 |

因此**令牌配错时不要自动重试**：重试只会触发锁定，把一个配置问题放大成一段不可用窗口。

> 限流计数在**单实例内存**中维护。若贵方在多实例后端做水平扩展，实际配额会按实例数成倍放大，
> 需在接入层自行做全局限流。

### 3.9 超时与重试

| 环节 | 时限 |
|---|---|
| 与上游模型建立连接 | 90 秒 |
| 流空闲（两帧之间无数据） | 60 秒 |
| 单次流总时长 | 180 秒 |
| M03 整体编排（含修复轮） | 180 秒 |
| M04 整体编排（含修复轮） | 120 秒 |
| 舌象图片识别 | 120 秒 |
| 心跳间隔 | 5 秒 |

**客户端超时建议不低于 200 秒**，否则会在服务端仍在正常推理时被客户端单方面切断。
心跳帧（§3.5）的作用正是让连接在长推理期间保持活跃，请勿把"一段时间没有正文"判为超时。

**重试语义**：M01、M05 为**非幂等**接口——同一 `caseState` 重复调用会重新生成内容，
结论文字可能不同，但不会产生重复的业务副作用（系统无处方落库，结论由贵方决定是否采纳）。
**M03、M04 自 V2.28 起、M02 自 V2.38 起对「同一病例」只计算一次**：服务端按「客户 + 阶段 + 会影响本阶段生成的病例内容」
（不含上一轮返回的诊断/处方等产物）识别同一病例，同一病例的重复请求会**并入仍在进行的同一次计算**，
或在 30 分钟内**直接回放已完成的结果**；计算与您的连接无关，您这边超时断开后计算照常完成，重试即可取到。
响应头 `x-cdss-stage-result: joined | reused` 标明这次是并入还是回放。降级页、中断页与上游故障页不会被复用。
确需重新生成时，请求头加 `x-cdss-regenerate: 1`（或查询参数 `?regenerate=1`）。
`429`/`503` 可安全重试；`4xx` 中的其余状态原样重试必然重复失败，须先修正请求。

### 3.10 请求体上限

| 接口 | 上限 |
|---|---|
| M01 病历采集 | 约 5.6 MB（舌象图片 ≤4 MB，自由文本 ≤12000 字符） |
| M02–M05 及其余诊疗流程接口 | 1 MB |
| 院内库存导入 | 8 MB，且条目数 ≤20000 |

超限返回 `413`，响应体写明实际字节上限。库存导入超限时请改用**分片整批替换**（§4.10 的 `part`），
不要截断，也不要拆成几次独立请求——本接口是整批替换，后一次会覆盖前一次，被截掉或被覆盖的药会被判为「库存外用药」。

**请求体压缩（V2.24 起，可选）。** 带 `Content-Encoding: gzip`（或 `deflate`）发送压缩后的 JSON，服务端解压后与未压缩请求完全等价。上表上限同时约束解压后的 JSON 字节数与实际传输的字节数；压缩数据损坏或不完整返回 `400 {"error":"Invalid compressed body"}`，其他编码返回 `415`。M04/M05 请求体要原样回传上一阶段的正文与签名结论，约 50–170 KB，在上行带宽有限的网络上光上传就要数秒，压缩后约为原来的 1/5，建议使用。示例：

```bash
gzip -c m05-request.json | curl -X POST "$BASE_URL/api/diagnosis/assess" \
  -H "Content-Type: application/json" -H "Content-Encoding: gzip" \
  -H "x-cdss-api-token: $CDSS_API_TOKEN" -H "x-cdss-customer-id: $CUSTOMER_ID" \
  --data-binary @-
```

### 3.12 测试与验收怎么做（V2.38 新增）

1. **先确认测的是哪个版本**：`GET /api/diagnosis/health` 的 `build.commit` 与 `releaseId` 是线上实际运行的版本，以它为准，不以文档日期为准。
2. **测「同一病例结果是否稳定」要分两种**：同一份病历重复请求，按 §3.9 并入同一次计算或回放已有结果（响应头 `x-cdss-stage-result: joined | reused`），
   这本来就会一致，不能说明重新生成的稳定性；要测重新生成的波动，请求头加 `x-cdss-regenerate: 1`，并逐字段统计（证名、治则、治法、方名、核心药味）的变化率。
   这个请求头只对会复用结果的 M02、M03、M04 起作用；M01、M05、红旗筛查、急症排查确认本来每次现算，带上也无妨。红旗筛查读的是按病历内容留存的事实层结果，
   同一服务版本内同一份病历给出同一结论，这个请求头不会让它重判；病历内容变了（例如补上婚育史）就按新内容重判。
3. **西医诊断依据看哪里**：见 §5.1。V2.47 起 `supportingFacts` 固定为一项——本条诊断的诊断依据（与 `clinicalRationale` 同一句）；`limitations` / `suggestedChecks` 自 V2.35 起仍为空数组，更细的依据在
   `candidates[].keyEvidence/againstEvidence` 与 `differentials[]`；病名因缺确诊检查而写到上一级（「贫血」「多囊卵巢综合征待查」）时，
   推理说明写「考虑X可能」，原病名在鉴别里注明「尚未取得确诊所需的检查或病程依据」。
4. **证据标签的含义**（`evidence: {evidenceLevel, source, confidence}`，V2.38 起按来源写）：
   - `kb_entry`（标准资料）：对上规划教材该证型（`source` 如「《中医内科学》心悸·心虚胆怯证」）、教材该证的加减原文（「…加减：兼心血不足，加阿胶、制何首乌、龙眼肉」）、
     《中医诊断学》辨证要点（「《中医诊断学》血虚证辨证要点」），或所用成方的组成（`source` 同方剂出处）。服务端逐字核对资料属实才写这一级。
   - `model_inference`（病例内推理）：由本例病历推出、没有对上上述资料的，如病机链第二个节点、加味的药；按本证常见兼症写的条件式加减 `confidence` 为「低」。
   - 主证名之外的虚性证素（如心虚胆怯证另写「心血不足」）要过《中医诊断学》辨证要点：病历里没有成组表现的不进病机、治法与方药，写在 `pathogenesis.uncertainties` 里
     （「是否兼心血虚：心血虚的辨证要点（心悸、失眠、多梦与血虚症状共见）在本例尚未成组出现」），供医生望诊、问诊核实；
     病历里这一类证素成组、只是脏腑归属没有专属表现时保留，证据标为该类辨证要点、`confidence` 为「低」。
5. **限流**：每个 Token + 客户每 10 分钟 60 次模型调用（§3.8），一条完整链路约 5 次；超限返回 `429` 与 `Retry-After`，按秒数退避后重试，不要计为用例失败。
   并发测试请分开使用不同客户编号。
6. **页面与接口**：舌象、脉象不是必填（§3.3.1），医生页面只需性别与主诉即可开始；追问可跳过，跳过后分析照常继续。

---

## 4. 接口详述

### 4.1 访问凭证获取

**接口地址**：`POST /api/auth/access`

**入参**

| 字段 | 中文名 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `token` | 接口令牌 | string | 是 | 接口访问令牌 |

**出参**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `ok` | 是否成功 | boolean | 是否成功 |

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
  -d "{\"token\":\"$TOKEN\"}"
```

**响应示例**

```json
{"ok": true}
```

### 4.2 M01 病历采集

**接口地址**：`POST /api/diagnosis/collect`

**入参**（本接口为独立请求体，**不使用** `caseState` 包装）

| 字段 | 中文名 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `userInput` | 病历文本 | string | 是 | 病历文本，≤12000 字符 |
| `patientSex` | 患者性别 | string | 是 | 取值：`男` / `女` / `其他或未明确` |
| `tongueImage` | 舌象照片 | string | 否 | 舌象照片 data URL，格式 `data:image/(png\|jpeg\|jpg\|webp);base64,...`，二进制 ≤4 MB |
| `tongueImageConsent` | 舌象采集授权 | boolean | 有图时必填 | `true` 表示已取得患者授权 |

**出参**：NDJSON 流。

| 输入情况 | 正文内容 | 是否调用模型 |
|---|---|---|
| 纯文本 | 采集确认文本 + **空**结构化 JSON（`{}`） | 否，直接返回确定性 NDJSON |
| 含舌象图片 | 舌象描述文本，用于回填 `caseState.tongueImageDesc` | 是（GLM 视觉） |

> **M01 不做病历结构化。** 纯文本路径既不调用模型、也不产出结构化字段——
> 调用方应把病历直接填进 `caseState` 的对应字段（§3.3.1）后进入 M02/M03。
> V1.3 的流程图把本阶段标成"结构化病历"，与本表自相矛盾，V1.4 已更正。

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
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
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

### 4.3 M02 追问生成

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

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `m02Plan.schemaVersion` | 结构版本 | string | 固定 `tcm-cdss-m02-plan-v1` |
| `m02Plan.decision` | 追问决策 | string | `ask`（需追问）/ `proceed`（无需追问）。**V2.36 起生产环境会返回 `proceed`**：病历已足够、没有值得问的题时，以及安全闸门已判急危重时（此时 `rationale` 说明应先按急症处置），`questions` 为空数组，调用方直接进入辨证即可 |
| `m02Plan.rationale` | 决策理由 | string | 决策理由 |
| `m02Plan.questions` | 追问列表 | array | 追问列表，`decision=proceed` 时为空数组。**一轮恒为 1 题**（V2.36 起；急症线索需要澄清时，这一题就是急症筛查题。V2.35 曾在急症筛查题之外另出 1 题）；选项是能直接写进病历的事实句 |
| `m02Plan.questions[].id` | 问题标识 | string | 问题标识 |
| `m02Plan.questions[].question` | 问题文本 | string | 问题文本 |
| `m02Plan.questions[].options` | 选项 | array | 每项 `{id, label, answer, kind, recordValue, requiresDetail}`：`label` 为按钮文字，`answer` / `recordValue` 为选中后写进病历的事实句；`kind` 为 `clinical_fact`（临床事实）/ `other`（其他，需医生补充，`requiresDetail` 为 `true`）/ `unknown`（本次未取得）。医生选择后把 `answer` 作为 user 消息放进 `conversation` 即可 |
| `completeness` | 病历完整度 | object | `{level, redFlag, infoGain, managementImpact, answerability}`，`level` 取 A/B/C。**V2.18 起由服务端按病历字段计算**，与各阶段门控使用同一口径；此前由模型自评，而系统门控另按病历重算，两者可能不一致 |

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
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
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
    "rationale": "头痛性质尚不明确，需补充以支持辨证",
    "questions": [
      {
        "id": "q1",
        "question": "头痛更接近哪一种？",
        "options": [
          { "id": "a", "label": "空痛、劳累后加重", "answer": "头部空痛，劳累后加重", "kind": "clinical_fact", "recordValue": "头部空痛，劳累后加重", "requiresDetail": false },
          { "id": "b", "label": "刺痛、痛处固定", "answer": "头部刺痛，痛处固定", "kind": "clinical_fact", "recordValue": "头部刺痛，痛处固定", "requiresDetail": false },
          { "id": "q1_other", "label": "其他（请补充）", "answer": "医生补充的具体情况", "kind": "other", "requiresDetail": true },
          { "id": "unknown", "label": "本次未取得", "answer": "本次未取得该信息", "kind": "unknown", "requiresDetail": false }
        ]
      }
    ]
  }
}
```

### 4.4 M03 辨病辨证

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

**出参**：NDJSON 流。正文为 Markdown 报告，结构化结论嵌在
`<!-- DIAGNOSIS_JSON_START -->` / `<!-- DIAGNOSIS_JSON_END -->` 之间（提取方式见 §3.6）。

下表按**所属对象分组**，「字段」列只写该对象内的字段名，完整路径 = 组标题路径 + 字段名。

**顶层**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `schemaVersion` | 结构版本 | string | 固定 `tcm-cdss-reasoning-v2` |
| `stage` | 阶段标识 | string | 固定 `diagnose` |
| `overview` | 诊断概览 | object | 中医病名、证候、鉴别、治法方向 |
| `westernDiagnosis` | 西医诊断 | object | — |
| `pathogenesis` | 病机 | object | 病位、病性、病机链 |
| `therapy` | 治则治法 | object | — |
| `management` | 管理建议 | object | 须补充采集项与随访安全网 |
| `terminologyMappings` | 国标术语对应 | array | 可选：仅当发生国标术语归一时输出，单次最多 20 条 |
| `contractSignatureVersion` | 签名版本 | string | — |
| `contractSignature` | 合同签名 | string | 格式 `hmac-sha256:<64位十六进制>`，原样回传给 M04 |

**诊断概览 `overview`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `tcmDiseaseName` | 中医病名 | string | — |
| `tcmDiseaseReferences` | 辨病循证依据 | array | 服务端受治理标准引用；当前绑定 GB/T 15657-2021《中医病证分类与代码》 |
| `primarySyndrome` | 主证候 | string | 采用 GB/T 16751 国标证候名，不含病机描述。病历只记录了主症、没有能分开证型的表现（寒热、虚实、诱因、伴随症状、舌脉）时，写只表达病位与气机失常的证名（如胃气不和证、肺气失宣证），`primarySyndromeResolution` 为 `bounded`（V2.37） |
| `tcmSyndromeReferences` | 辨证循证依据 | array | 服务端受治理标准引用；当前绑定 GB/T 16751.2-2021《中医临床诊疗术语 第2部分：证候》 |
| `primarySyndromeBasis` | 主证候依据 | array | 逐条来自病历的事实 |
| `primarySyndromeResolution` | 证候确定程度 | string | `resolved` 已确定 / `bounded` 有界 / `unresolved` 未确定 |
| `tcmDiseaseRationale` | 辨病依据 | string | 不得复述结论本身 |
| `tcmDiagnosticRationale` | 辨证依据 | string | — |
| `tcmDiseaseDifferentials` | 中医病名鉴别 | array | 见下 |
| `tcmDifferentials` | 中医证候鉴别 | array | 结构同下表，首字段为 `syndrome` |
| `secondarySyndromes` | 兼证 | array | 无兼证时为空数组 |
| `overallPathogenesis` | 总体病机 | string | — |
| `overallTherapy` | 总体治法 | string | — |
| `recommendedFormulaDirection` | 选方方向 | string | — |
| `recommendedFormulaNames` | 建议方名 | array | M04 据此锁定基准方 |
| `formulaSelectionMode` | 选方模式 | string | `single` / `combined` / `alternatives` / `self_devised` / `none` |

`overview.tcmDiseaseDifferentials[]` 中医病名鉴别

| 字段 | 中文名 | 类型 |
|---|---|---|
| `diseaseName` | 候选病名 | string |
| `reason` | 鉴别理由 | string |
| `distinguishingPoints` | 区分要点 | string |
| `nextCheck` | 建议核实项 | string / null |

**西医诊断 `westernDiagnosis.primary`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `name` | 西医诊断倾向 | string | 症状级工作诊断统一写成「规范症状名，病因待查」形态。**取值可能为空串**，表示本次未形成西医工作诊断，请按缺失处理 |
| `status` | 诊断程度 | string | `考虑` / `需排除` / `证据有限` |
| `confidence` | 置信度 | string | `高` / `中` / `低` |
| `supportingFacts` | 支持依据 | array | **V2.47 起固定为一项：本条西医诊断的诊断依据**（一到两句：支持诊断的关键已记录事实、为何符合该病、还需排除或核实什么；与 `clinicalRationale` 同一句）。V2.35–V2.46 为空数组。服务端的有限结论（红旗收口、证候未形成）除外：那时这里放红旗发现。回传给开方接口时这一项不当作病历事实使用 |
| `limitations` | 待查依据·资料限制 | array | **V2.35 起恒为空数组**（字段保留） |
| `suggestedChecks` | 待查依据·建议检查 | array | **V2.35 起恒为空数组**（字段保留） |
| `clinicalRationale` | 推理说明 | string | 事实到诊断倾向的推理，不复述病史 |
| `coding` | ICD-10 编码 | object | `{system, code, display, source}`，服务端确定性编码。可选：仅当匹配到受控医保码时输出 |

`westernDiagnosis.differentials[]` 西医鉴别诊断：`{name, reason, distinguishingPoints, nextCheck, guidelineReferences?}`。
其中 `reason`、`distinguishingPoints`、`nextCheck` 为临床鉴别内容；`guidelineReferences[]` 只承载标准参考文献条目，页面不会把模型思考过程混入参考文献栏。该字段仅在本轮受治理证据检索命中并完成绑定时输出。

**病机 `pathogenesis`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `summary` | 病机概要 | string | — |
| `locationDifferentiation.items` | 病位 | array | 如 `["心","脾"]` |
| `natureDifferentiation.items` | 病性 | array | 如 `["气血亏虚"]` |
| `symptomClusters` | 症状群 | array | `{symptoms, mechanism}` |
| `chain` | 病机链 | array | 见下 |
| `uncertainties` | 影响判断的待核实信息 | array | `{item, reason, affects}`；无待复核项时为空数组 |

`pathogenesis.chain[]` 病机链

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `nodeId` | 节点标识 | string | 如 `P1`。M04 的药味与外治项目用 `targetRef` 引用它 |
| `patientFact` | 患者事实 | string | — |
| `syndromeEvidence` | 辨证关键依据 | string | — |
| `pathogenesis` | 病机演变 | string | — |
| `therapyDirection` | 对应治法 | string | — |

**治则治法 `therapy`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `overallPrinciple` | 治则 | string | **V2.35 起只写国家标准治则术语**（GB/T 16751.3 治则类：虚则补之、实则泻之、寒者热之、热者寒之、扶正祛邪、攻补兼施、急则治标…），一条为主、至多两条，不带括号 |
| `overallMethod` | 总治法 | string | 一行治法。病名、证名对上教材的一行时用教材该证的治法原文（V2.35） |
| `subTherapies` | 分治法 | array | `{therapy, targetPathogenesis, priority, evidence}`，`priority` 为 `主要` / `次要` |

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
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
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
  "contractSignatureVersion": "tcm-cdss-m03-signature-v5",
  "contractSignature": "hmac-sha256:d049aff0c240088f672f86800565535cb4bedddf5332bb7c08860011caaf8a22"
}
```

### 4.5 M04 候选方药

**接口地址**：`POST /api/diagnosis/prescribe`

**入参**

| 字段路径 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `caseState` | object | 是 | 病例状态对象 |
| `caseState.id` | string | 是 | 与 M03 使用的同一标识 |
| `caseState.reasoningDiagnose` | object | 是 | M03 返回的结构化结论，**原样回传** |
| `caseState.diagnosis` | object | 否 | M03 返回的诊断结论 |
| 其余字段 | — | — | 同 M03 |

**出参**：NDJSON 流。正文为 Markdown 报告，结构化结论嵌在
`<!-- DIAGNOSIS_JSON_START -->` / `<!-- DIAGNOSIS_JSON_END -->` 之间（提取方式见 §3.6）。

**儿童患者（未满 18 岁，V2.30 起）**：不再一律收回剂量，改按教材**年龄分数法**折算——新生儿（<28 天）成人量的 1/6，乳婴儿（28 天～1 岁）1/3，幼儿（1～3 岁）1/2，学龄前（3～7 岁，教材未单列，按幼儿）1/2，学龄期（7～12 岁）2/3，12～17 岁接近成人量（上限＝药典成人上限）。分数乘在每味药的《中国药典》2020 年版成人**上限**上，向下取 0.5g，**没有下限**（低于成人下限是儿童用量的常态）；麻黄、附子、细辛、乌头、大黄、巴豆、芒硝等教材点名要控量的药，任何年龄档都不超过成人上限的 2/3。两部十三五教材（《中药学》《中医儿科学》）的分档口径不完全一致，本系统取较保守的一部；要改成更宽的口径只需改数据文件里的分数。

- 禁用（不得入方）：罂粟壳、密陀僧、雷公藤、马兜铃、广防己、关木通；慎用（逐味标注理由）：鸦胆子、昆明山海棠、苦杏仁（婴儿）、白果、礞石、饴糖、麻黄。M04 页面新增「**## 儿童用药说明**」（折算口径、控量药、药液量、服法、禁慎用药味）。
- 每味药的 `verificationReasons` 写明儿童口径（例：「剂量已按儿童折算上限 2.5g（成人 6-15g × 1/6）完成规则校验」）；模型给的剂量高于折算上限时，编译器按上限截取并在同一字段写明原值。药液量 `decoction.targetVolumeMl` 按年龄档（见下表）。
- **只写「患儿/男童」而判不出年龄段**（没有数值年龄，也没有婴儿/幼儿/学龄这类档位词）时仍收回剂量并追问年龄：新增缺项码 `pediatric_age_unknown`；旧码 `pediatric_dose_rules_unavailable` 不再产生（枚举保留，兼容旧快照）。体重 `pediatric_weight_unknown` 仍是核对项，不阻断。
- **生命体征按年龄判定**（V2.30）：成人固定线会把健康新生儿（呼吸 40～45 次/分）判成红旗。未满 12 岁的红旗线与「需尽快复测」线改按年龄段：呼吸红旗线新生儿及 2 月龄内 60、2～12 月龄 50、1～5 岁 40（5 岁以上仍为成人 35），心率红旗线婴儿 220、1～12 岁 180（12 岁以上仍为成人 150），低血压线按年龄（新生儿<60、婴儿<70、1～10 岁<70＋2×岁）。只放宽「正常儿童被误报」的方向；心率<40、呼吸≤8、体温、血氧、高血压线不变；年龄未知一律沿用成人线。出处与逐档数值见 `src/data/tcm-pediatric-vital-reference.source.json`。
- **婴幼儿病历里的「母乳喂养/混合喂养/哺乳」是患儿自己的喂养方式**，不再被当成母亲的哺乳期而触发妊娠/哺乳独立硬边界（数值年龄<10 岁，或没有数值年龄但档位词为新生儿/婴儿/幼儿/学龄前时生效；成年女性与 10 岁及以上不受影响，明确的妊娠表述照旧锁定剂量）。

下列表格按**所属对象分组**，「字段」列只写该对象内的字段名，完整路径 = 组标题路径 + 字段名。

**顶层**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `stage` | 阶段标识 | string | 固定 `prescribe` |
| `formula` | 方药 | object | 候选方、中成药、随证加减 |
| `nonPharma` | 非药物调护 | object | 健康调护与中医外治 |
| `lineageAdaptation` | 流派适配 | object | 可选：仅当请求指定流派偏好时输出 |
| `contractSignature` | 合同签名 | string | 原样回传给 M05，不得改写 |

**候选方 `formula.candidates[]`**（首选方固定在 `[0]`，其余为备选）

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `name` | 方名 | string | 如 `归脾汤加减`；无受治理方名时为 `本例辨证组方` |
| `formulaNames` | 基准方名 | array | 该方继承身份的受治理经典方名 |
| `positioning` | 定位 | string | `首选` / `备选` / `仅学术思路` |
| `constructionType` | 组方类型 | string | `single_base` 单方加减 / `combined` 合方 / `self_devised` 自拟 / `single_herb` 单味 |
| `modificationStatus` | 加减状态 | string | `canonical` 原方 / `modified` 加减 |
| `therapyMatch` | 方证契合说明 | string | 该方与本例治法的对应关系 |
| `applicable` | 适用情形 | string | V2.35 起为空串（此前是每例相同的模板句） |
| `notApplicable` | 不适用情形 | string | V2.35 起只有逐味的特殊人群提示，如「知母（哺乳期、孕期/妊娠慎用）；川芎（出血倾向/月经期/抗凝状态慎用）」；方中没有这类药味时为空串 |
| `formulaAnalysis` | 方义分析 | string | 写**该药在本方发挥的作用**，不罗列全部功效 |
| `baseFormulas` | 基础方与出处 | array | 含组成匹配味数、核心药味匹配数 |
| `herbs` | 药味清单 | array | 见下 |
| `decoction` | 剂数与煎服法 | object | 见下 |
| `compositionLogic` | 组成逻辑 | array | 见下 |
| `discriminationPath` | 方证鉴别 | array | 见下 |
| `classicEvidence` | 经典条文 | array | 见下 |
| `textualModifications` | 有出处的成方加减规则 | array | `requiresClinicianReview` 恒为 `true` |
| `formulaSource` | 方剂出处 | object | 出处级别与来源 |

**药味 `formula.candidates[].herbs[]`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `name` | 药名 | string | 受治理正名，如 `黄芪` |
| `processing` | 炮制 | string / null | 如 `炒`、`蜜炙`；无特殊炮制要求时为 `null` |
| `dose` | 用量 | string | 如 `20g` |
| `role` | 君臣佐使 | string | `君` / `臣` / `佐` / `使` |
| `prescriptionRole` | 配伍作用说明 | string | 如 `君药：益气养血，和络止痛。` |
| `targetKind` | 对应目标类型 | string | `pathogenesis_node` 对应病机节点 / `formula_structure` 承担方剂结构角色 |
| `targetRef` | 对应病机节点号 | string | 如 `P1`，对应 M03 的 `pathogenesis.chain[].nodeId` |
| `targetPathogenesis` | 对应病机 | string | 该药针对的病机表述 |
| `function` | 药物功效 | string | 取自受治理药材知识库 |
| `isToxic` | 是否毒性药材 | boolean | — |
| `decoctionRequirement` | 特殊煎法 | string / null | 仅特殊煎法药味有值，如 `先煎`、`后下`、`包煎`；其余为 `null` |
| `verificationTier` | 剂量核验等级 | string | `verified` 本次数值与可用参考范围对应，不等于临床适宜性批准 / `unverified_dose` 剂量待医师核对，含低于历史参考范围下限的普通药（儿童、老人、体弱者用量可低于成人下限）/ 普通药高于《中国药典》2020年版一部上限时，系统已按上限给出并判为 `verified`，原值写在 `verificationReasons` 首条 / `identity_pending` 药名待确认 / `toxic_regulated` 管制毒性或法律禁用，须按监管要求单独处理 |
| `doseSource` | 剂量依据来源 | string | `governed_boundary` 受治理边界 / `classical_source` 古籍来源 / `none` 无 |
| `verificationReasons` | 核验依据 | array | 如 `["受治理剂量边界 9-30g 已用于生成后校验"]`；按上限给出时首条为 `候选剂量原为 45g，高于《中国药典》2020年版一部规定的 9–30g，已按上限 30g 给出；…` |
| `evidence` | 证据引用 | object | 见 §3.6 |

**方义与出处**

以下四项均为**确定性产物**，锚定在受治理方名上。自拟方（`constructionType=self_devised`）时四项恒为空数组——无受治理方名即无出处可考，属正确行为而非字段缺失。

`formula.candidates[].compositionLogic[]` 组成逻辑

| 字段 | 中文名 | 类型 |
|---|---|---|
| `formulaName` | 方名 | string |
| `summary` | 组成逻辑说明 | string |
| `tier` | 证据层级 | string（`common` / `experience`） |
| `sourceRefs` | 来源引用 | array |

`summary` 自 V2.37 起写成「组成：…。出处：…。」，少数常用经方另有一句配伍说明；不再出现「受控目录」「处方编译」等系统用语。

`formula.candidates[].discriminationPath[]` 方证鉴别

| 字段 | 中文名 | 类型 |
|---|---|---|
| `againstFormula` | 对比方名 | string |
| `question` | 鉴别要点 | string |
| `status` | 本例判定 | string（`confirmed` 符合 / `absent` 不符合 / `unknown` 待确认） |
| `sourceRef` | 来源引用 | string |

`formula.candidates[].classicEvidence[]` 经典条文

| 字段 | 中文名 | 类型 |
|---|---|---|
| `evidenceId` | 条文标识 | string |
| `citation` | 出处 | string |
| `anchorLevel` | 锚定层级 | string（`tiaowen` 条文 / `chapter_paragraph` 章节段 / `page_paragraph` 页段） |
| `clauseNumber` | 条文编号 | number（可选） |
| `excerpt` | 条文原文 | string |
| `tier` | 证据层级 | string（`canon` 经典 / `common` 通行 / `experience` 经验） |

> **经典条文使用边界**：条文按方名检索给出，说明该方的经典出处与主治语境，**不代表已判定适用于本例**；
> 条文内古代剂量与现行法定剂量不可直接换算，用量以药味表与审方结论为准。

**剂数与煎服法 `formula.candidates[].decoction`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `doseCount` | 剂数 | string | 如 `7剂` |
| `course` | 疗程 | string | 如 `7日` |
| `dosesPerDay` | 每日剂数 | number | 1–3 |
| `administrationTimesPerDay` | 每日服用次数 | number | — |
| `method` | 完整煎服法 | string | **随方剂性质变化**：解表剂武火速煎、补益剂文火久煎，不是同一张模板 |
| `soakMinutes` | 浸泡分钟数 | number | — |
| `decoctionTimes` | 煎煮次数 | number | — |
| `firstDecoctionMinutes` | 一煎分钟数 | number | — |
| `secondDecoctionMinutes` | 二煎分钟数 | number | — |
| `targetVolumeMl` | 两煎合并药液量 | number | 成人及 12 岁以上 500mL；儿童按年龄档：新生儿 50 / 乳婴儿 100 / 幼儿 150 / 学龄前 200 / 学龄期 250mL（V2.30） |
| `administration` | 服法 | string | 如「饭后温服」 |
| `followUpNode` | 复诊节点 | string | — |

**随证加减 `formula.modifications[]`**

加减是给接诊医生的随证加减建议，通常 2–3 条，触发条件有三种（V2.35）：① 已定证型在规划教材里的加减条件（「若恶寒甚」），药味取自该条教材加减；② 病历已记录、主方未直接针对的伴随症状（逐字引用）；③ 教材该证没有列加减时，按本证常见兼症写的「若＋具体症状」。「加」的行带药典范围内的建议剂量；所加药味不与方中药味相反（十八反）。

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `trigger` | 触发条件 | string | 条件句（「若……」）或病历已记录的患者事实（逐字引用） |
| `triggerSource` | 事实出处 | object | `{kind, sourceRef, sourceQuote}`；只在 `trigger` 是病历已记录事实时出现，条件句没有本字段 |
| `targetPathogenesis` | 对应病机 | string | — |
| `action` | 加减动作 | enum string | `加` / `减` / `调整`，如 `加`；**不得再把药味拼入本字段** |
| `herbName` | 药味 | string | 如 `川芎` |
| `doseOrHandling` | 剂量或处理 | string / null | **V2.35 起「加」的行带建议剂量**（单一数值加 g，如 `"10g"`，在药典内服范围内，儿童按年龄分数折算）；「减 / 调整」的行与药典无剂量范围的药味为 `null` |
| `reason` | 加减理由 | string | — |
| `riskNote` | 风险提示 | string | V2.36 起：加入的药有特殊煎法时写煎法（如「附子先煎45–60分钟（至口尝无麻辣感）」「砂仁后下」）；备孕/未避孕病例加入药典孕妇慎用的饮片时写药典原文与「使用前请确认未妊娠」；其余为空串 |
| `substitutions` | 可替换药味 | array | 可选，见下。**仅出现在 `action="加"` 的加减上**，且需推得出合规替代药 |

`formula.modifications[].substitutions[]` 可替换药味

| 字段 | 中文名 | 类型 |
|---|---|---|
| `replaces` | 被替换药名 | string |
| `substitute` | 替代药名 | string |
| `rationale` | 替代理由 | string |
| `differenceNote` | 与原药的差异说明 | string |

> 覆盖缺货、过敏、特殊人群禁用等场景。替代药由系统按受控药品数据推导，不由模型生成，
> 并逐条校验：功效方向须同类、风险等级不得升高、不得超药典剂量上限、不得触发十八反十九畏、
> 不得使用管制毒性药材。无符合条件的替代药时不输出该字段。

`formula.modificationReview` 加减复核统计：`{submittedCount, retainedCount, droppedCount, droppedReasons}`

**中成药 / 西药候选 `formula.patentAndWestern[]`**

> **字段路径**：本接口响应中该数据位于 `formula.patentAndWestern`。HIS 方案打包导出（附录 A.1）中同一数据的字段名为 `prescriptions.patentMedicines`，两处命名不同，请勿混用。

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `type` | 药品类别 | string | `中成药` / `西药` |
| `name` | 药品名 | string | — |
| `specification` | 规格 | string / null | — |
| `singleDose` | 单次剂量 | string / null | **西药一律不下发**；中成药仅在说明书条目本身给全时填写，缺项即为 `null`，不作猜测 |
| `frequency` | 用药频次 | string / null | 同 `singleDose`：说明书未给全即为 `null` |
| `route` | 给药途径 | string / null | 同 `singleDose`：说明书未给全即为 `null` |
| `administrationTiming` | 服药时机 | string / null | 仅从说明书用法用量原文解析；原文未载时不展示 |
| `usageBoundary` | 适用边界 | string | V2.35 起为空串（此前是系统说明，不是用药信息） |
| `course` | 疗程 | string / null | 仅从说明书原文解析；原文未载时字段为空且页面省略，不再输出“本候选不形成疗程医嘱”等占位文案 |
| `positioning` | 定位 | string | `联合治疗` / `替代方案` / `短期对症` / `需医生评估` |
| `correspondingProblem` | 对应本例问题 | string | — |
| `relationship` | 与饮片方的关系 | string | 是否可叠加（V2.33 起由服务端写定：中成药与饮片方不默认联用、由医生择一或评估联用；西药由医生结合用药史决定） |
| `riskNote` | 风险说明 | string | V2.33 起取自同一说明书条目的禁忌/注意、特殊人群与相互作用原文 |
| `evidenceId` | 说明书条目标识 | string | `EVID-INST-*` / `LOCAL-INST-*` |

`formula.medicineCandidateStatus`：可选，仅当无匹配中成药候选时输出 `{status:"no_evidence_match", reason}`

**健康调护 `nonPharma`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `diet` | 饮食调养 | string | — |
| `lifestyle` | 生活方式 | string | — |
| `emotion` | 情志调护 | string | — |
| `exercise` | 运动保健 | string / null | 可选（V2.26 起）：本例适合的运动方式、强度、时长与频次及要避免的运动；未生成时为 `null`（此前运动内容写在 `lifestyle` 中） |
| `precautions` | 注意事项 | array | 0–6 条；无内容时为空数组 |
| `acupointCare` | 穴位保健 | string / null | 可选：患者居家可做的穴位按揉（及艾灸）。成人由模型按本例证候与主要不适，从教材核对过的 34 个常用穴里选 1～3 个并写明各自作用，服务端只保留表内穴位、去掉孕期禁用穴与医师项目已用的穴，手法、时长与注意事项取技术规范原文（V2.48）；儿童按技术规范原文段落；红旗或不出剂量的方案、妊娠阳性或可疑、3～17 岁及 6 月龄以下、证候对应不到体质（如外感、热毒）时为 `null`（见附录 B V2.26） |
| `tcmTreatments` | 中医外治项目 | array | 见下 |

**中医外治 `nonPharma.tcmTreatments[]`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `projectCode` | 项目代码 | string | 受控项目枚举 |
| `projectName` | 项目名称 | string | 如 `毫针刺法` |
| `availability` | 可开展性 | string | `clinic_available` 本院可做 / `referral_only` 需转诊 |
| `riskLevel` | 风险等级 | string | `low` / `moderate` / `specialist` |
| `recommendationMode` | 推荐性质 | string | `clinician_assessment` / `referral_assessment` / `specialist_assessment_only` |
| `targetRef` | 对应病机节点号 | string | 如 `P1` |
| `targetPathogenesis` | 对应病机 | string | — |
| `treatmentContent` | 治疗内容 | string | — |
| `suggestedSitesOrPoints` | 建议穴位或部位 | array | **穴位单列**，经受控穴位目录核定 |
| `scheduleSuggestion` | 疗程建议 | string | — |
| `techniqueBoundary` | 技术边界 | string | 不得超出的操作范围 |
| `protocolSource` | 方案来源 | string | — |
| `operatorRequirement` | 操作者资质要求 | string | — |
| `requiredChecks` | 操作前须完成的检查 | array | — |
| `containsMedication` | 是否含药物 | boolean | — |
| `requiresMedicationAudit` | 是否需药事审核 | boolean | — |
| `executable` | 是否可直接执行 | boolean | — |
| `clinicianReviewRequired` | 须医师复核 | boolean | 恒为 `true` |

**特殊说明**

| 情况 | 系统行为 |
|---|---|
| 正文以 `<!-- CDSS_NON_DOSE_PRESCRIPTION -->` 开头 | 本次不提供剂量级候选，原因见正文"处方安全边界"段，可重试恢复 |
| 同一页里另有一条注释 `<!-- CDSS_NON_DOSE_CANDIDATE_JSON:{…} -->`（V2.29 起） | **非剂量页的结构化副本**：候选方的药味、君臣佐使、功用、方义、适用/不适用，供 HIS 在「不给剂量」时仍能展示候选饮片，并说明为什么没有剂量。字段：`schemaVersion`（`tcm-cdss-non-dose-candidate-v1`）、`adoptable`（恒为 `false`：不签名、不能写回处方）、`reasonCode`（`dose_authorization_withheld`＝红旗未解除/儿童/妊娠哺乳阳性等独立硬边界收回了剂量；`m04_candidate_retained_non_dose`＝候选保留但本次不出剂量）、`doseWithheldReasons`（收回理由，字符串数组）、`candidates[]`（`name`、`herbs[]{name,role,function,targetPathogenesis}`、`formulaAnalysis`、`applicable`、`notApplicable`）。**不含剂量、煎服法、疗程**。JSON 内的 `-`、`<`、`>` 已转成 `\uXXXX` 转义，解析前先取出注释体再 `JSON.parse` 即可；不认识该注释的解析方不受影响。库存与本情形无关：库存只影响推荐排序与标注，从不决定是否出方 |

**错误码**

| 状态码 | 触发条件 | 响应体 |
|---|---|---|
| `409` | 缺有效 M03 签名 | `{"error":"辨病辨证结果缺少有效签名，请重新生成辨病辨证后再进入候选方药。"}` |

> `409` 最常见原因是请求中未携带 `caseState.id`，或未将 M03 结论原样回传。参见 §3.3 强制要求 R1、R2。

---


**调用示例**

> `reasoningDiagnose` 为 M03 返回的结构化结论，须**原样**回传；`id` 与 M03 保持一致。

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/prescribe" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
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

### 4.6 M05 风险随访

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
| 1 | 结构化随访时间轴帧（见下文 `followup_timeline`，解析不出条目时不出现） |
| 2 | 审方状态标记 `<!-- TCM_CDSS_RXAUDIT_STATUS:... -->`（外部审方已停用，恒为 `DISABLED`） |
| 3 | 审方关联标记 `<!-- TCM_CDSS_RXAUDIT_CORRELATION:... -->` |
| 4 | 「处方安全总评」：最高提示强度、综合风险判断、评级依据、医生需确认事项、待核实信息 |
| 5 | 「随访管理方案」：首次复诊时间、复诊评估重点、疗效评价标准、注意事项、无效或加重的处置预案，以及「整体状态评估」问题表 |
| 6 | 「生活管理」 |

#### 结构化随访时间轴（`followup_timeline`）

**什么时候返回**

本接口的 NDJSON 流中，**作为正文之前的第一帧**下发：

```
{"type":"followup_timeline","timelineItems":[ ... ]}   ← 本帧
{"content":"## 处方安全总评\n……"}                        ← 正文分块
{"content":"[END]"}
```

- 解析不出条目时**整帧不出现**，不会下发空数组，按「无此帧」处理即可
- 与正文并行，不影响正文解析；建议边收边解析，先落这一帧再拼正文
- 它是**响应**流内的结构化帧，不是请求入参

**字段**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `type` | 类型 | string | 固定 `followup_timeline` |
| `timelineItems` | 随访时间轴 | array | 时间轴条目 |
| `timelineItems[].time` | 时间点 | string | **相对**时间点，绝不返回具体日期。**第一条恒等于正文「首次复诊时间」**，两处同源 |
| `timelineItems[].action` | 随访动作 | string | 这个时间点具体做什么（线上问诊／门诊复诊并调方／停药观察…），按本例撰写 |
| `timelineItems[].indicators` | 观察项 | string[] | 这个时间点要记录/复评的项目。**不同时间点的观察项不同** |
| `timelineItems[].triggers` | 提前复诊触发条件 | string[] | 出现什么就不等到这个时间点、提前来诊。**第一条必含处方后审方得出的安全触发条件** |

**错误码**

| 状态码 | 触发条件 | 响应体 |
|---|---|---|
| `409` | 未携带 M03 结论 | `{"error":"...","code":"invalid_m03_signature"}` |

> V2.31 起 M03/M04 签名不一致、`prescription` 为未签名的处方文本时不再返回 409/422：照常评估，正文附来源提示。

> M04 **缺席**不是错误（2026-09-14 起）：M03 签名有效、`reasoningPrescribe` 为空且 `prescription` 为空或为服务端非剂量页时，assess 做 **diagnose-only 评估**——随访计划、疗效评价口径与安全总评照常返回，处方后审方按「无结构化药味」fail-closed 转人工复核。这与 his-scheme 的 diagnose-only 方案是同一条规则。

---


**调用示例**

> `reasoningDiagnose` 须原样回传；`reasoningPrescribe` 有则原样回传，缺席时为 diagnose-only 评估。

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/assess" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
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

**响应示例**（流内随访时间轴帧 · 线上真实返回）

**例 1 · 气血不和、瘀滞肌肤（白癜风）**

```json
{
  "type": "followup_timeline",
  "timelineItems": [
    {
      "time": "完成7剂（7日）后复诊；出现不适或症状加重时提前复诊",
      "action": "复诊查体，评估白斑变化及舌脉，询问服药后反应，决定是否调方。",
      "indicators": ["白斑面积与颜色", "新发白斑", "舌质紫暗", "睡眠与情志"],
      "triggers": ["白斑迅速扩大或新发增多", "出现严重皮肤瘙痒或疼痛", "服药后明显不适如恶心、腹泻"]
    },
    {
      "time": "服药14天后",
      "action": "线上问诊，了解白斑变化及全身症状，指导调护。",
      "indicators": ["白斑颜色深浅", "边界清晰度", "睡眠质量", "食欲与大便"],
      "triggers": ["白斑无改善或加重", "出现新发白斑", "情绪波动大影响睡眠"]
    },
    {
      "time": "疗程结束时",
      "action": "复诊查体，全面评估疗效，决定是否继续治疗或停药观察。",
      "indicators": ["白斑面积缩小比例", "色素恢复情况", "舌脉改善", "整体状态"],
      "triggers": ["白斑完全消退或显著改善", "出现其他不适症状"]
    }
  ]
}
```

**例 2 · 脾虚气不摄血兼瘀滞（崩漏）** —— 同一版本、同一接口，节奏与触发条件完全不同：

```json
{
  "type": "followup_timeline",
  "timelineItems": [
    {
      "time": "完成7剂（7日）后复诊；出现不适或症状加重时提前复诊",
      "action": "复诊查体，评估月经量、色、块及脾虚症状改善情况，调整方药。",
      "indicators": ["月经量、色、质及血块变化", "乏力、头晕等脾虚症状", "舌淡胖、苔白、脉细弱"],
      "triggers": ["月经量暴增不止", "出现头晕心慌、气短等气血暴脱征象", "腹痛剧烈或发热", "抗凝者增加出血风险时提前复诊"]
    },
    {
      "time": "下次月经来潮时",
      "action": "线上或电话随访，记录本次月经的量、色、质、血块及经期天数，与治疗前对比。",
      "indicators": ["经期天数与周期变化", "经期伴随的乏力、腹痛"],
      "triggers": ["月经量过多导致头晕、心慌、气短", "经期超过7天未净"]
    },
    {
      "time": "连续调理3个月经周期后",
      "action": "复诊评估整体疗效，结合舌脉判断脾虚是否纠正，决定是否巩固治疗或停药观察。",
      "indicators": ["月经周期、经期、经量是否恢复正常", "全身症状改善情况"],
      "triggers": ["月经量再次增多", "出现新的不适症状"]
    }
  ]
}
```

### 4.7 红旗筛查

**接口地址**：`POST /api/diagnosis/red-flags`

**入参**

| 字段路径 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `caseState` | object | 是 | 病例状态对象 |
| `caseState.id` | string | 是 | 就诊唯一标识 |
| `caseState.chiefComplaint` | string | 是 | 主诉 |
| 其余字段 | — | — | 同 M03 |

**出参**（`application/json`）

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `available` | 结果是否可用 | boolean | 语义复核已完成并签名时为 `true` |
| `semanticStatus` | 语义筛查状态 | string | `checked` / `unavailable` / `skipped_deterministic_critical_vital` |
| `redFlags` | 命中红旗项 | string[] | 本次命中的红旗，与 `safetyGate.redFlags` 内容相同；**空数组表示没有红旗**。V2.52 起响应带上此字段（此前文档列了、响应里没有，见下方说明） |
| `advisories` | 提示项 | string[] | 需要留意、但不构成红旗的提示，与 `safetyGate.advisories` 内容相同；可为空数组 |
| `safetyGate` | 安全闸门结论 | object | 见下表 |
| `prescriptionPermission` | 剂量呈现模式 | object | `candidateMode`（`full_dose` / `limited_dose` / `non_dose_only` / `blocked`）、`formalAdoption`（`blocked` 表示红旗解除前不可采纳） |
| `operationalCompleteness` | 病历完整度 | object | `{level, redFlag, infoGain, managementImpact, answerability}`，`level` 取 A/B/C |
| `clinicalFacts` | 临床事实（内部记录） | object | 语义复核的工作记录，**请原样保留，不要据此显示红旗**。其中的 `redFlags` 列的是复核查过的风险类目，也包括病历里明确否认的（`status` 为 `negative`，如「否认疫区旅居史」）、只需补问的（`clarify`）和常规的（`routine`）；哪些构成红旗由安全闸门判定，结论在上面的 `redFlags` 与 `safetyGate` |
| `latencyMs` | 耗时 | number | 毫秒 |

**`safetyGate`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `status` | 闸门状态 | string | `red_flag`（有红旗）/ `needs_information`（剂量级处方前需补充信息）/ `ready` |
| `redFlags` | 红旗 | string[] | 每条为一句完整说明（含需排除的情况与原文依据） |
| `advisories` | 提示项 | string[] | 不构成红旗的提示 |
| `missingItems` | 待补充项 | string[] | 剂量级处方前需补充或复核的信息 |
| `missingItemCodes` | 待补充项代码 | string[] | 与 `missingItems` 一一对应的代码 |
| `candidateMode` | 剂量呈现模式 | string | 同 `prescriptionPermission.candidateMode` |
| `allowDosePrescription` | 剂量直接可用 | boolean | 不等于「能否出现剂量」，请以 `candidateMode` 判断（见 §4.8 中 `safetyGate.candidateMode` 的说明） |

**怎么判断红旗（V2.52 更正）。** 以 `safetyGate.status` 为 `red_flag`（等价于 `redFlags` 不为空）为准，显示的文字取 `redFlags`；`advisories` 作一般提示显示。`clinicalFacts.redFlags` 不是红旗清单：同一份病历多写一句「否认疫区旅居史」，复核就会在那里记一条 `negative`，`safetyGate` 不变。V2.51 及以前本表把 `redFlags`、`advisories` 列为顶层字段，响应里实际只在 `safetyGate` 下有，按本表取顶层会取不到。

**查询参数 `prefetch=diagnose`（V2.25 起，可选）。** 医生答完追问、准备进入辨病辨证（M03）时，若先用**即将提交给 M03 的同一份病例**调用 `POST /api/diagnosis/red-flags?prefetch=diagnose`，服务端在完成本次筛查的同时，预先准备 M03 开始生成前需要的检索与语义输入；随后的 M03 请求病例内容不变时直接取用，病例有改动则照常重新计算，结果不受影响。本参数不改变本接口的返回内容。适用场景：接入方页面在医生选完追问答案、点击提交之前（例如停止操作 1 秒左右）就发起这一调用；系统自带的诊疗页面已默认这样做。线上：追问回答后的 M03 首次调用本身要先完成一次语义安全筛查（约 3–5 秒），提前调用后这部分不再计入 M03 的等待时间。

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/red-flags" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
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

### 4.8 急症排查确认

**接口地址**：`POST /api/diagnosis/emergency-clearance`

**入参**

| 字段 | 中文名 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `caseState` | 病例状态 | object | 是 | 病例状态，须处于红旗状态 |
| `assessmentSummary` | 现场评估小结 | string | 是 | 现场评估小结，脱敏后 12–1000 字 |
| `findings` | 逐条处置留痕 | array | **是**（V1.4 新增） | 当前**每一条**红旗的处置记录，与 `caseState.safetyGate.redFlagFindings` 一一对应 |
| `findings[].ruleId` | 红旗规则号 | string | 是 | 逐字复制自 `redFlagFindings[].ruleId` |
| `findings[].message` | 红旗原文 | string | 是 | 逐字复制自 `redFlagFindings[].message` |
| `findings[].disposition` | 处置方式 | enum | 是 | 见下表 |
| `findings[].basis` | 客观依据 | string | 是 | ≥10 字，且**必须写明做过什么**（检查/复测/转诊交接），见下方判据 |

> ### V1.4 变更：本接口不再是字数校验
>
> 这是全系统**唯一**能把确定性阳性红旗整条抹掉的入口（命中后 `redFlags` 清空、
> `allowDosePrescription` 由 `false` 变 `true`）。V1.3 及以前它的唯一内容判据是

> **`safetyGate.candidateMode`（V2.7 起，剂量呈现模式的唯一口径）**：`allowDosePrescription=false` **不等于**"不得出现任何数值"。服务端按确定性权限判据下发 `candidateMode`：`full_dose`（剂量级候选，可作为处方依据）/ `limited_dose`（仍显示药味与参考剂量，但缺过敏史、现用药、舌脉或专科筛查等必要信息，**须医师补齐并复核后方可执行**）/ `non_dose_only`（仅非剂量建议：V2.46 起只在剂量算不出时出现——儿童年龄段判不出、年龄记录冲突；红旗与妊娠等独立边界改为 `limited_dose`，红旗未解除时 `formalAdoption=blocked`）/ `blocked`（缺主诉等前提，不生成候选）。集成方请以 `candidateMode` 而非 `allowDosePrescription` 字面判断是否允许出现剂量数值；HIS 写回同样按 `non_dose_only|blocked` 才抑制剂量级输出。
> `assessmentSummary` 的字数 ≥12——一句无关的话即可签发。
>
> V1.4 起三条判据**必须同时成立**，缺一即不签发（凭证 = 解除约束，因此"证明不了"只能是"不解除"）：
> 1. 当前每一条活动红旗都有且只有一条对应的 `findings` 记录（多一条、少一条都不受理）；
> 2. `disposition` 取自受控集合，不接受自由文本；
> 3. `basis` 含**客观证据词**——心电图/CT/MRI/超声/内镜/血常规/粪隐血/复测/复查/查体/
>    转诊/急诊/会诊/收住院/交接 等指向"做过的事"的词。

**`disposition` 受控取值**

| 取值 | 含义 | `basis` 应写什么 |
|---|---|---|
| `excluded_by_objective_workup` | 已完成客观检查并排除 | 做了哪项检查与结果，如「心电图无 ST 段抬高、肌钙蛋白阴性」 |
| `referred_and_handed_over` | 已转急诊/上级并完成交接 | 转往何处、何时完成交接 |
| `vital_sign_repeated_and_corrected` | 复测后不成立（测量误差） | 复测方式与复测值 |
| `record_corrected_not_present` | 病历记录有误，该表现本次不存在 | 哪一句记错了、正确表述是什么 |

**出参**（`200`）

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `emergencyClearance.redFlagFingerprint` | 红旗事实指纹 | string | 红旗事实指纹；病历红旗变化后凭证自动失效 |
| `emergencyClearance.confirmedAt` | 确认时间 | string | 确认时间（ISO 8601） |
| `emergencyClearance.assessmentSummary` | 脱敏评估小结 | string | 脱敏后的评估小结 |
| `emergencyClearance.findings` | 逐条处置留痕 | array | 脱敏后的逐条留痕，**进签名域**，改一个字即验签失败 |
| `emergencyClearance.contractSignature` | 服务端签名 | string | `tcm-cdss-emergency-clearance-v3` |

返回对象需整体放入 `caseState.emergencyClearance` 供后续阶段使用。

> **旧凭证不再生效**：当前 v3 在 v2 的逐条 `findings` 基础上再绑定 `clientId + customerId`。
> 升级前签发或跨客户重放的历史凭证一律验签不过，回到"不解除"——这是有意为之的
> fail-closed 方向，请在升级窗口内避免复用跨版本的病例快照。

**错误码**

| 状态码 | `code` | 触发条件 |
|---|---|---|
| `400` | `invalid_emergency_clearance_request` | 缺 `caseState` 或 `assessmentSummary` |
| `400` | `emergency_clearance_assessment_summary_too_short` | 评估小结不足 12 字 |
| `400` | `emergency_clearance_attestations_missing` | 未提交 `findings`，或其中有条目缺字段 / 处置方式不在受控取值内（`error` 逐条指明第几条哪个字段） |
| `400` | `emergency_clearance_attestation_count_mismatch` | 处置记录与活动红旗未逐条对应 |
| `400` | `emergency_clearance_attestation_finding_unmatched` | 处置记录指向的红旗不在当前安全门内 |
| `400` | `emergency_clearance_attestation_basis_too_short` | 某条 `basis` 不足 10 字 |
| `400` | `emergency_clearance_attestation_basis_not_objective` | 某条 `basis` 未写明做过什么 |
| — | — | 病例不处于红旗状态：V2.31 起返回 `200 {"emergencyClearance": null, "notRequired": true, "message": "…"}`，无需排查确认，流程照常继续（原 `409 no_active_emergency_finding`） |

> 所有 `400` 响应（V2.31 起）另带：`activeFindings`（当前须逐条处置的红旗，`ruleId` + `message` 原文）、`allowedDispositions`（受控处置取值、中文名与 `basis` 写法提示）、`problems`（逐条问题：`index` 从 0 起，`field`，`reason`）。`disposition` 可填受控英文取值或其中文名；只填 `ruleId` 或只填 `message` 且能唯一对应当前一条红旗时，服务端用安全门原文补齐。客观依据（`basis` 须写明做过的检查、复测或转诊交接）与逐条一一对应的要求不变。
| `503` | `emergency_clearance_signing_unavailable` | 服务端签名密钥未配置 |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/emergency-clearance" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
  -d '{
    "caseState": {
      "id": "OPD-20260805-000123",
      "patient": { "sex": "男", "age": 58 },
      "chiefComplaint": "突发剧烈胸痛2小时",
      "symptoms": { "现病史": "2小时前突发胸骨后压榨样疼痛，向左肩放射，伴大汗" },
      "vitals": { "BP": "90/60", "P": "110" }
    },
    "assessmentSummary": "已完成急诊排查：心电图无ST段抬高，心肌标志物阴性，生命体征平稳，排除急性冠脉综合征。",
    "findings": [
      {
        "ruleId": "acute-cardiac-event",
        "message": "胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件",
        "disposition": "excluded_by_objective_workup",
        "basis": "心电图无ST段抬高，肌钙蛋白与心肌酶两次复查均阴性"
      }
    ]
  }'
```

> `ruleId` 与 `message` 请从上一次任意阶段响应里的 `caseState.safetyGate.redFlagFindings[]`
> 逐字复制；自行改写会命中 `attestation_finding_unmatched`。

**响应示例**

```json
{
  "emergencyClearance": {
    "redFlagFingerprint": "sha256:3a7f...",
    "confirmedAt": "2026-08-05T10:23:41.000Z",
    "assessmentSummary": "已完成急诊排查：心电图无ST段抬高，心肌标志物阴性，生命体征平稳，排除急性冠脉综合征。",
    "findings": [
      {
        "ruleId": "acute-cardiac-event",
        "message": "胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件",
        "disposition": "excluded_by_objective_workup",
        "basis": "心电图无ST段抬高，肌钙蛋白与心肌酶两次复查均阴性"
      }
    ],
    "contractSignature": "hmac-sha256:9b2e..."
  }
}
```

---

### 4.9 药品目录下发

**接口地址**：`GET /api/tcm-knowledge/drug-catalog`

把本系统据以做临床判断的受治理药品目录分页下发，供 HIS 与院内目录对账。

> **方向说明**：本接口是**出站**（CDSS → HIS），回答"系统认识哪些药"。
> **入站**（HIS 把院内库存推给本系统，开方时基于有货的药开）见 §4.10，回答"本院此刻有哪些药"。
> 两者不要混用。出参每页均带 `inboundSyncEndpoint` 指向入站入口。

**入参**（查询串）

| 参数 | 必填 | 说明 |
|---|---|---|
| `type` | 否 | `herb`（饮片正名/别名/剂量边界）、`patent`（中成药说明书条目）、`his_mapping`（HIS 商品名映射）、`spec_conversion`（规格换算）。**不填返回目录概览** |
| `cursor` | 否 | 分页游标，默认 `0` |
| `limit` | 否 | 每页条数，默认 100，上限 500 |
| `since` | 否 | 上次拿到的 `catalogVersion`；一致则返回 `304`，可跳过整轮拉取 |

**出参**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `catalogVersion` | 目录版本 | string | 目录版本，形如 `kb:<schema>@<生成时间>\|identity:<schema>\|patent:<源文件哈希前16位>`。三份受治理资产任一重建即变化 |
| `type` | 类型 | string | 本页目录类型 |
| `total` | 总条目数 | number | 该类型总条目数 |
| `cursor` / `nextCursor` | number \| null | 当前游标 / 下一页游标（`null` 表示已到末页） |
| `items` | 条目列表 | array | 条目列表 |
| `inboundSyncEndpoint` | 入站同步接口 | string | 恒为 `POST /api/drug-inventory`（院内库存导入，见 §4.10）。V2.27 前本文档写的是 `inboundSyncStatus: not_supported_pending_persistence_decision`，与实际出参不符，已更正 |

**`type=herb` 条目字段**

| 字段 | 中文名 | 说明 |
|---|---|---|
| `name` | — | 饮片正名 |
| `aliases` | — | 可自动对应到该正名的别名 |
| `ambiguousAliases` | — | **歧义别名**（如「一包针」可指千年健或石韦）。系统**绝不自动择一**，原样列出待人工裁定 |
| `doseLimit` | — | `{min, max, basis}`；仅在 `doseLimitStatus=governed` 时给出 |
| `doseLimitStatus` | — | `governed` / `not_governed`（无药典数值边界，用量由医师确定）/ `source_conflict_requires_pharmacist_review`（分用途剂量冲突，须药师复核） |

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

### 4.10 院内药品库存导入

**接口地址**：`POST /api/drug-inventory`（导入） / `GET /api/drug-inventory`（状态查询）

`POST` **必须**携带 `Idempotency-Key`（缺失即 `400 idempotency_key_required`，早于请求体解析）。当 `x-cdss-customer-id` 尚未登记时，该请求会先按固定 Token 的 `clientId`、配额和幂等键完成 JIT 登记，再执行同一个库存导入；登记或审计持久化失败时不会把未知客户当作已授权放行。`GET` 绝不触发登记。

> ### V2.12 更正：`Idempotency-Key` 现在真的作用于库存写入
>
> V2.11 之前这个请求头只参与**未登记客户的 JIT 登记**。客户一旦登记完成，它既不参与写入、
> 也不再校验格式——调用方带着同一个键重发，第二次会照常走整批替换。
> 实测（甲方 2026-09-15）：同键连发两次、第二次载荷不同，两次都返回 `200`，
> **第二次把第一次导入的库存整批覆盖了**。
>
> 危害不止"少了一次去重"：被覆盖掉的药味不会退回"未知"，而是变成**缺货**——
> 院内明明有麻黄，系统会告诉医生缺货并给替代候选。
>
> 自 V2.12 起，库存 `POST` 带 `Idempotency-Key` 即进入写入幂等事务：
>
> | 情况 | 状态码 | 行为 |
> |---|---|---|
> | 同键 + 同载荷 | 首次的状态码 | 重放首次响应（响应体逐字节相同），另带 `idempotent-replay: true` 响应头；**不再写入** |
> | 同键 + 不同载荷 | `409` | `idempotency_conflict`；**一个字节都不写**。确实要替换库存请换一个新键 |
> | 键格式非法 | `400` | `idempotency_key_required`；不会被当作"未提供"而放行 |
> | 未带键 | `400` | `idempotency_key_required`；在读请求体、建立客户上下文之前返回，不产生任何租户副作用 |
>
> 只有**真正落盘的结果**（`200`）会被登记为幂等记录：`202`（分片已暂存未提交）与任何
> `4xx/5xx` 都不占用这个键——写入失败后可以用同一个键改正载荷重试。
> 因此一次分片整批替换可以全程共用一个键；而把用过的键复用到**另一次**导入，
> 会在第一片就返回 `409`。幂等记录按客户隔离、保留 7 天，只存键的摘要，不落原始键。


将院内库存药导入本系统；开方时系统**优先**落在有货药味上。

> **核心口径：库存是可得性约束，不是临床正确性约束。**
> 与味数偏好同理：库存是可得性约束，不是临床正确性约束，不会为迁就库存牺牲方证对应。
> 本例该用麻黄汤而院内恰好没有麻黄时，系统**不会**悄悄换一味药，而是照常给出麻黄汤、
> 标注"麻黄：院内暂无库存"，并附受治理替代候选供医师选择。
> 静默替换会让医生看到的方与系统推理的方不是同一个，临床上比缺货危险得多。

**入参**

| 字段 | 中文名 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `source` | 来源标识 | string | 否 | 来源标识，如院区名或 HIS 实例名 |
| `items` | 条目列表 | array | 是 | 药品条目，单次上限 20000 条；超限返回 `413` 并给出**分片整批替换**通路（见下） |
| `part` | 分片信息 | object | 否 | 分片整批替换。**不传即单次整批替换，行为与 V1.3 逐字节相同** |
| `part.importId` | 本次导入批号 | string | 传 `part` 时必填 | `[A-Za-z0-9_-]{6,64}`，同一整批的所有分片必须一致 |
| `part.index` | 分片序号 | number | 传 `part` 时必填 | 从 `0` 到 `total-1` |
| `part.total` | 分片总数 | number | 传 `part` 时必填 | 1–50 |
| `items[].name` | 院内药品名 | string | 是 | 院内药品名 |
| `items[].kind` | 药品类别 | string | 否 | `herb`（饮片，默认）/ `patent`（中成药）/ `western`（西药）。V2.27 起也接受中文写法：饮片、中药饮片、中药、草药 → `herb`；配方颗粒 → `herb`（记为配方颗粒剂型）；中成药 → `patent`；西药、化学药 → `western`。其他写法整批拒收并逐条回报 |
| `items[].available` | 是否有货 | boolean | 否 | 是否有货，**缺省为 `true`**（推过来的即视为在售目录）。V2.27 起也接受 `1`/`0`、`"Y"`/`"N"`、`"是"`/`"否"`、`"有货"`/`"缺货"`；其他写法整批拒收 |
| `kinds` | 本批负责的类别 | array | 否 | **V2.27 新增。**如 `["herb"]`、`["patent","western"]`（同样接受中文写法）。给出时**只替换这几类**，其余类别原样保留——饮片与中成药来自 HIS 不同模块、分开推送时不会互相清掉；某类在本批没有条目 = **声明本院没有这一类药**（如 `{"kinds":["herb"],"items":[]}` 表示本院没有中药饮片）。不给时整批替换（与此前相同）。条目类别超出 `kinds` 时整批 `400` |
| `items[].specification` | 规格 | string | 否 | 规格 |
| `items[].goodsId` | 院内商品号 | string | 否 | 院内商品号 |

**语义：整批替换。** 每次导入完全替换上一批，不做增量合并——增量要求调用方维护删除事件，
而"某药已下架却没推删除"会让系统长期以为它有货，比整批替换危险。

**空清单（V2.27 起不再报错）。** `items` 为空时：
- 带 `kinds`：声明本院没有这几类药，返回 `200`；
- 不带 `kinds`：返回 `200` 且**不改动现有库存**，响应带 `unchanged: true` 与说明。整批替换语义下，不写类别的空清单字面意思是「清空全部库存」，HIS 故障时误推一次就会让整院所有药变成库存外，所以这类请求不做改动。未登记的客户照常完成首次登记。

此前（V2.26 及以前）空清单一律 `400 invalid_inventory_items`，且首次同步报错时不登记客户，之后调用诊疗接口会 `403`。

> ### V1.4 更正：超限时**不要**自行分成多次独立请求
>
> V1.3 的 `413` 文案写的是 `split the import into batches`，而落盘语义是整批替换——
> 照着做的结果是**后一批把前一批整体覆盖**（实测：第 1 批 4 味、第 2 批 3 味 → 落盘只剩 3 味）。
> 系统等于在错误提示里教调用方把第一批药删光。
>
> V1.4 提供真正安全的分片通路：带 `part` 的请求**只写暂存**，集齐全部分片后才做一次原子替换。
>
> | 情况 | 状态码 | 含义 |
> |---|---|---|
> | 分片已收下、仍缺其他分片 | `202` | 返回 `{importId, receivedParts, missingParts, total, bufferedItemCount, committed:false}`；**线上库存此刻未被改动** |
> | 最后一片到齐 | `200` | 一次性原子替换，返回与单次导入相同的快照 |
> | `part.total` 中途变更 | `409` | `import_part_total_conflict` |
> | 累计条目仍超 20000 | `413` | `inventory_too_large`，**不落盘** |
>
> 暂存分片 24 小时未集齐即过期作废，不会与新一轮分片拼接。

```bash
# 分片整批替换：两片合起来才是一整批
curl -X POST ".../api/drug-inventory" -H "Content-Type: application/json" \
  -H "x-cdss-api-token: <token>" \
  -H "x-cdss-customer-id: <customerId>" \
  -d '{"source":"HIS-A","items":[...4000条...],"part":{"importId":"imp-20260810","index":0,"total":2}}'
# → 202 {"missingParts":[1],"committed":false}   线上库存仍是上一版本

curl -X POST ".../api/drug-inventory" -H "Content-Type: application/json" \
  -H "x-cdss-api-token: <token>" \
  -H "x-cdss-customer-id: <customerId>" \
  -d '{"source":"HIS-A","items":[...3000条...],"part":{"importId":"imp-20260810","index":1,"total":2}}'
# → 200 {"itemCount":7000, ...}                  此刻才发生一次原子替换
```

**出参**

| 字段 | 中文名 | 说明 |
|---|---|---|
| `schemaVersion` / `customerId` | 库存结构版本 / 客户标识 | 新写入固定为 `tcm-cdss-drug-inventory-v2`；客户标识同时通过响应头 `x-cdss-customer-id` 返回 |
| `inventoryVersion` | — | 库存版本（内容指纹） |
| `importedAt` / `source` / `itemCount` | 导入时间 / 来源 / 条目数 |
| `availableHerbCount` / `availablePatentCount` / `availableWesternCount` | 有货饮片数 / 有货中成药数 / 有货西药数 |
| `coverage` | 各类同步状态 | **V2.27 新增。**`{herb, patent, western}` 各为 `synced`（已同步）或 `declared_none`（已声明本院没有）；某类不出现 = 未同步。未同步的类别**不算缺货**，开方照常推荐，标「库存外用药」 |
| `suspectNames` | 疑似测试数据 | **V2.27 新增，可选。**像测试或编号的条目（如「测试中药75601669」「砒霜0631」），请核对是否应在院内目录中 |
| `likelyNonHerbNames` | 疑似非饮片 | **V2.27 新增，可选。**名字像中成药或西药（颗粒、胶囊、注射液、规格数字）却按饮片推送的条目，多半是 `kind` 漏填 |
| `unchanged` | 未改动 | **V2.27 新增，可选。**不带 `kinds` 的空清单返回 `true`，库存未改动 |
| `unresolvedNames` | — | **在受控药品目录中找不到对应正名的院内药名**。原样回报供调用方补充映射，不会被静默丢弃。V2.27 起系统先按常见院内写法清洗再匹配（去掉「（免）」「Y/Z」等计费前缀、「/片」等规格后缀、括注、尾随编号、「片/段/丝/块/粉」，以及同一味药的炒/焦/蜜/酒/醋/盐等加工写法；「制/煅/炭」与药典单列的炮制品不归并），55 家诊所实测对上比例由 63% 升到 82%；已导入的库存读入时按新规则重算，无需重推 |
| `ambiguousNames` | — | 存在多个候选的院内药名（如"一包针"→千年健/石韦）。系统**绝不自动择一** |

**开方时的表现**

| 场景 | 系统行为 |
|---|---|
| 已导入库存 | 生成前把有货饮片清单作为**软偏好**注入；HIS 方案出参新增 `inventory`、`herbAvailability[]`、`outOfStock[]`、`medicineAvailability[]`（V2.27） |
| 中成药/西药推荐（V2.27 起） | **院内有货的排前面，院内没有的照常推荐并标「库存外用药」**。候选范围：病例检索的本地非处方中成药说明书、院内有货的处方中成药（本地处方中成药说明书目录，不含注射剂）、EviMed 说明书检索到的西药，以及本地说明书检索对本例没有任何候选时由模型提名的中成药——提名先按药名在本地全部说明书（非处方与处方共 8,807 种）核对，并过同一套安全排除、适应证须覆盖本例问题；本地没有这个药名时再查 EviMed（限时 1.5 秒）；核对不到的不出现。V2.26 及以前院内没有的直接删除，只同步了饮片的诊所因此拿不到任何中成药和西药推荐 |
| 药味缺货 | 保留在处方中并标注 `out_of_stock`，附 `substitutes[]`（先过安全边界再按库存过滤） |
| **未导入库存** | 全部标 `unknown`、不给标签，开方链路行为与未接库存时**逐字节相同**。可得性不是安全控制，缺库存数据绝不阻断出方 |
| 某类药未同步或已声明没有（V2.27） | 该类药标「库存外用药」：未同步时可得性为 `unknown`，已声明没有时为 `out_of_stock`；不列替代候选（院内不存在可替代的有货药）。饮片未同步时不注入软偏好，由模型按证推荐 |
| 库存超过 30 天未更新（V2.27） | 照常使用，HIS 的 `inventory.note` 与 `GET` 状态注明「库存数据已 N 天未更新」（`stale`、`ageDays`） |

> 库存**不进临床合同签名域**：库存每天都在变，若纳入签名，昨天签发的方案今天就会验签失败。

**部署要求**：容器需配置 `CDSS_DRUG_INVENTORY_PATH` 指向持久卷（compose 默认
`/app/runtime-data/drug-inventory`，已挂载 `tcm-cdss-runtime` 卷）。未指向持久卷时
每次发布后库存归零。

**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/drug-inventory" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: <token>" \
  -H "x-cdss-customer-id: <customerId>" \
  -H "Idempotency-Key: inventory-<customerId>-20260824-001" \
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

### 4.10.1 按药名查院内状态（V2.27 新增）

**接口地址**：`POST /api/drug-inventory/availability`

医生页面用它在药名旁显示院内状态；HIS 集成方也可直接调用。只读，不调用模型，不进签名合同。与 HIS 方案出参的 `herbAvailability[]` / `medicineAvailability[]` 同一判据。

**入参**：`{"items":[{"name":"甘草","kind":"herb"},{"name":"逍遥丸","kind":"patent"}]}`，至多 100 条，`kind` 为 `herb` / `patent` / `western`。

**出参**

| 字段 | 中文名 | 说明 |
|---|---|---|
| `inventoryLoaded` | 是否已接库存 | 该客户从未导入库存时为 `false`，此时 `items[]` 不带标签 |
| `coverage` / `stale` / `ageDays` / `inventoryVersion` | 同步状态 / 是否过期 / 距上次导入天数 / 库存版本 | 同 §4.10 |
| `items[].availability` | 可得性 | `in_stock` / `out_of_stock` / `unknown`（取值与此前相同，未新增枚举值） |
| `items[].label` | 库存标签 | `院内有货`（在院内目录且有货）/ `缺货`（在院内目录但无货）/ `库存外用药`（不在院内目录，或本院未同步、已声明没有这一类药） |
| `items[].inventoryName` / `goodsId` / `specification` | 院内药名 / 院内商品号 / 规格 | 匹配到的院内条目，可直接用于 HIS 下单 |
| `items[].note` | 说明 | 如「院内为粉剂」「院内剂型/规格为「逍遥颗粒」，用法以院内药品说明书为准」「本院未同步中成药库存」 |

### 4.11 院内药品库存查询

与 §4.10 的导入同一路径。返回当前生效的库存快照摘要（批次、条目数、解析状态、歧义与未识别名单）。
**未导入库存时链路行为与接入前逐字节相同**——库存是可得性约束，不是安全控制，缺数据不阻断出方。

### 4.12 客户首次登记

**接口地址**：`POST /api/customers/register`

请求必须同时携带固定 Token、`x-cdss-customer-id` 与 `Idempotency-Key`，不接收病例或患者信息。首次登记按 `provisioning → active` 状态机原子推进：先持久化 `pending/provisioning_started` 审计意图，意图成功后才允许写入 `active`，随后追加 `accepted/created` 完成事件；active 写失败则登记状态回落为 `failed` 并追加失败终态，绝不会出现审计先写“created”但客户实际未激活。进程中断或审计失败会保留为可用同一幂等键恢复的非激活状态。首次成功返回 `201 {customerId,status:"active",created:true,customerRegistered:true}`；同客户只能用原幂等键重放，返回 `200` 且 `created:false`、`customerRegistered:false`（`customerRegistered` 为 V2.6 起的规范字段名，`created` 保留兼容），换键或将任一历史键（含 failed/provisioning）改绑另一客户均返回 `409 idempotency_conflict`。登记记录持久化到受保护运行时卷，服务重启或发布不会丢失。

### 4.13 租户审计查询

**接口地址**：`GET /api/tenant-audit?limit=100`

只返回当前已鉴权 `clientId + customerId` 的结构化事件，最多 500 条、按时间倒序。事件覆盖客户登记、库存导入和库存读取，字段包括 `timestamp/event/outcome/code?/requestIdHash?/operationId?/itemCount?/inventoryVersion?`；调用方提交的 `x-request-id` 在生产鉴权配置下以固定接口 Token 为密钥、连同租户域做 HMAC-SHA-256 后截断保存（无 Token 的本地开发才使用域分离 SHA-256），不回写原文。审计文件不保存 Token、库存 `source` 自由文本、原始病例、患者标识或临床正文；另一个调用方或客户的事件不会出现在结果中。审计默认每文件 8 MB 自动轮转并保留 4 个归档文件（可通过 `CDSS_TENANT_AUDIT_MAX_BYTES` / `CDSS_TENANT_AUDIT_ARCHIVE_FILES` 调整），避免运行时卷无界增长。

库存写入先持久化带 `operationId` 的 `pending/inventory_import_started` 审计意图，再执行暂存或原子替换，最后追加完成事件；意图写入失败时返回 `503 tenant_audit_unavailable` 且库存不变。若变更提交后完成事件短暂写失败，接口按实际已提交状态返回成功并附 `auditStatus:"pending_reconciliation"`，保留的意图可供运维对账，避免出现“接口报失败但库存已经生效”的歧义。

---

## 5. 输出字段索引

诊疗结果各项内容在响应中的位置。字段完整定义见对应接口章节。

### 5.1 诊断与辨证（M03 响应）

| 内容 | 字段路径 |
|---|---|
| 西医诊断倾向 | `westernDiagnosis.primary.name` |
| 西医诊断依据 | `westernDiagnosis.primary.clinicalRationale`（推理说明：记录中的表现与检查 → 诊断 → 还需排除或核实什么）<br>`westernDiagnosis.candidates[].keyEvidence` / `againstEvidence`（可选：西医部分列出候选诊断时输出，各候选的支持与反对依据）<br>`westernDiagnosis.primary.supportingFacts` 自 V2.35 起恒为空数组（贵方 10.12 测评要求症状罗列不再展示） |
| 西医诊断待查依据 | 尚需排除的情况与关键检查写在 `clinicalRationale` 与 `westernDiagnosis.differentials[].nextCheck`<br>`westernDiagnosis.primary.suggestedChecks` / `limitations` 自 V2.35 起恒为空数组（同上） |
| 西医鉴别诊断 | `westernDiagnosis.differentials[]` |
| 西医鉴别诊断参考文献 | `westernDiagnosis.differentials[].guidelineReferences[]`（可选：仅当本轮受治理证据检索命中并绑定到该鉴别项时输出） |
| ICD-10 编码 | `westernDiagnosis.primary.coding`（可选：仅当匹配到受控医保码时输出） |
| **指南/文献依据** | `westernDiagnosis.primary.guidelineReferences[]`（V1.4 新增，可选）<br>`{evidenceId, citation, url?, appliesTo?}`。题名/机构/年份/URL 由服务端按 `evidenceId` 反查**本轮真检索到**的证据条目渲染，模型只提交条目号与一句适用说明；**本轮未检索到就不输出该字段**，不会回落到模型自撰题名 |
| 中医病名 | `overview.tcmDiseaseName` |
| 中医辨病循证依据 | `overview.tcmDiseaseReferences[]`（受治理标准引用） |
| 中医证候 | `overview.primarySyndrome` |
| 中医辨证循证依据 | `overview.tcmSyndromeReferences[]`（受治理标准引用） |
| 中医辨病依据 | `overview.tcmDiseaseRationale`（为什么归入该病名） |
| 中医辨证依据 | `overview.tcmDiagnosticRationale`（为什么是该证型） |
| 主证候依据 | `overview.primarySyndromeBasis[]` |
| 中医病名鉴别 | `overview.tcmDiseaseDifferentials[]` |
| 中医证候鉴别 | `overview.tcmDifferentials[]` |
| 总体病机 | `overview.overallPathogenesis` |
| 病机拆解 | `pathogenesis.chain[]` |
| 病位辨证 | `pathogenesis.locationDifferentiation` |
| 病性辨证 | `pathogenesis.natureDifferentiation` |
| 治则 | `therapy.overallPrinciple` |
| 总治法 | `therapy.overallMethod` |
| 分治法 | `therapy.subTherapies[]` |
| 病机节点、分治法、药味、加减的证据标签 | `pathogenesis.chain[].evidence`、`therapy.subTherapies[].evidence`、`formula.candidates[].herbs[].evidence`、`formula.modifications[].evidence`：`{evidenceLevel, source, confidence}`，含义见 §3.12（V2.38 起按来源写） |
| 国标术语对应关系 | `terminologyMappings[]`（可选：单次最多 20 条） |

### 5.2 方药与调护（M04 响应）

| 内容 | 字段路径 |
|---|---|
| 候选方 | `formula.candidates[]`（首选在 `[0]`，其余为备选） |
| 方名 | `formula.candidates[].name` |
| 药味组成 | `formula.candidates[].herbs[]`（含药名、用量、君臣佐使、对应病机） |
| 方义分析 | `formula.candidates[].formulaAnalysis` |
| 组成逻辑 | `formula.candidates[].compositionLogic[]` |
| 方证鉴别 | `formula.candidates[].discriminationPath[]` |
| 经典条文出处 | `formula.candidates[].classicEvidence[]` |
| 方剂出处 | `formula.candidates[].formulaSource` |
| 剂数与煎服法 | `formula.candidates[].decoction` |
| 随证加减 | `formula.modifications[]`（动作与药味分别读取 `action` / `herbName`） |
| 可替换药味 | `formula.modifications[].substitutions[]`（可选，见下方说明） |
| 中成药与西药候选 | `formula.patentAndWestern[]` |
| 中成药说明书用法 | `formula.patentAndWestern[].route`、`singleDose`、`frequency`、`administrationTiming`、`course`（均以说明书原文为准，缺项省略） |
| 健康调护 · 饮食调养 | `nonPharma.diet` |
| 健康调护 · 生活方式 | `nonPharma.lifestyle` |
| 健康调护 · 情志调护 | `nonPharma.emotion` |
| 健康调护 · 运动保健 | `nonPharma.exercise`（V2.26 起，可为 `null`） |
| 健康调护 · 穴位保健 | `nonPharma.acupointCare`（可为 `null`） |
| 健康调护 · 注意事项 | `nonPharma.precautions[]` |
| 中医外治项目 | `nonPharma.tcmTreatments[]` |
| 中医外治 · 穴位建议 | `nonPharma.tcmTreatments[].suggestedSitesOrPoints[]`（每个穴位内联标注国标代码·归经·**本例入选依据**） |
| 中医外治 · 方案状态 | `nonPharma.tcmTreatments[].protocolStatus`（V1.4 由两态扩为**三态**，见下） |
| 中医外治 · 方案边界说明 | `nonPharma.tcmTreatments[].protocolGap`（内部状态码）<br>`nonPharma.tcmTreatments[].protocolGapNote`（可选：**仅 HIS 方案出参**，且仅当 `protocolGap` 命中受控映射时输出；同一码的临床语言说明，集成方要直接展示时用它） |
| 随证加减 · 风险提示 | `formula.modifications[].riskNote`（V1.4 起同时出现在可见正文、结构化载荷与 HIS 三个出口） |

**`protocolStatus` 三态（V1.4）**

| 取值 | 含义 | 医生页面标签 |
|---|---|---|
| `governed_patient_specific_plan` | 命中该病种标准取穴模板**且**按本例已签名证候完成了证型加减 | 按证型加减 · 待复核 |
| `governed_class_template_not_syndrome_tailored` | **V1.4 新增。** 命中该病种标准取穴模板，但本例证候未匹配到受治理的证型加减方案 | 病种模板 · 未按证型加减 |
| `assessment_only_no_patient_specific_protocol` | 目录中无对应标准方案，仅作现场适应证/禁忌/资质评估 | 仅项目评估 |

> **为什么新增第三态**：V1.3 只有两态，命中病种模板即标为"个体化方案"。实测同一病种的两个
> 相反证型（风寒/风热、心脾两虚/肝火扰心、湿热中阻/脾胃虚寒、寒湿/湿热）拿到的穴位**逐字相同**，
> 而状态字段八次都写着"个体化方案"——那个标签说的不是这一次实际发生的事。
> V1.4 同时补入证型配穴表（来源：T/CAAM 011-2014《循证针灸临床实践指南：失眠》、
> 中国针灸学会痛经条目、《针灸学》规划教材证型配穴表），命中证型时才给第一态。
>
> **集成方需要做的**：把新枚举值纳入解析；按旧逻辑"非 `governed_patient_specific_plan` 即评估态"
> 处理会把已带治理穴位与频次的第三态误降级。三态的 `suggestedSitesOrPoints` 与
> `scheduleSuggestion` 完整度约束：前两态都有，第三态**不是**评估态。

> ### ⚠️ V1.5 勘误与兼容修正（2026-08-11）
>
> **V1.4 的处理是错的，本版已改正。** 第三态是在 `schemaVersion` 保持
> `tcm-cdss-his-ai-scheme-v1` 的前提下加进出参的。对使用 Java enum、Kotlin sealed class、
> TypeScript union 或 Jackson `FAIL_ON_UNKNOWN_PROPERTIES` 反序列化的集成方，
> 这不是"多一个可忽略的取值"，而是**解析直接抛异常**。在变更记录里登记"这是破坏性变更"
> 不等于没有破坏它，也不应要求贵方为此临时改代码。
>
> **V1.5 起的口径（HIS 方案接口 `/api/diagnosis/his-scheme`）**
>
> | 契约版本 | 怎么请求 | `protocolStatus` 取值 | `tailoringStatus` |
> |---|---|---|---|
> | **V1（默认，不请求即为此档）** | 无需任何改动 | **只回旧两态**。第三态向下映射为 `assessment_only_no_patient_specific_protocol` | 三态真实值，可忽略 |
> | **V2（显式请求）** | `?schemaVersion=v2`，或请求头 `x-cdss-his-scheme-version: v2`，或请求体 `hisSchemeVersion: "v2"` | 真三态 | 三态真实值 |
>
> · 映射方向是**单向且保守**的：第三态（病种模板未按证型加减）折叠成"尚未形成患者级方案"，
>   旧集成方按它处理只会更保守，绝不会把未加减的模板当成个体化方案采纳；
>   反向（评估态 → 患者级方案）在任何版本下都不存在。
> · `tailoringStatus`（`syndrome_tailored` / `class_template_only` / `assessment_only`）是
>   **非破坏性新增字段**，两个版本都下发，三态的真实值恒在这里。旧集成方忽略它即可；
>   要区分"病种模板未加减"与"纯现场评估"的，读它，不必升到 V2。
> · 版本号拼错或无法识别时**一律回落 V1**，不返回 `400`。
> · **M04 原始响应（`/api/diagnosis/prescribe` 的结构化载荷）不做折叠**：它的
>   `protocolStatus` 恒为规范三态。原因是该字段在 M03/M04 的 HMAC 签名域内，
>   按调用方折叠会导致 M04→M05 的签名校验失败。直接解析 M04 载荷的集成方请按
>   "可扩展枚举"处理（白名单匹配已知值 + 未知值降级展示），或改读 `tailoringStatus`。
| 流派适配说明 | `lineageAdaptation`（可选：仅当请求指定了流派偏好时输出） |

### 5.3 风险与随访（M05 响应）

M05 响应为 Markdown 文本流，不采用结构化字段，内容依次为：处方安全总评、随访管理方案（含整体状态评估问题表）、
生活管理（各节内容见 §4.6）。流中另含一帧结构化随访时间轴（**响应**帧，非入参）：

| 内容 | 字段路径 |
|---|---|
| 随访时间轴 | `timelineItems[]`（**响应**流内结构化帧，帧标识 `type: "followup_timeline"`；不是请求入参） |
| 随访时间点 | `timelineItems[].time` |
| 随访动作 | `timelineItems[].action` |
| 观察项 | `timelineItems[].indicators`（string[]） |
| 提前复诊触发条件 | `timelineItems[].triggers`（string[]） |

详见 §4.6。

**关于「可替换药味」的两点说明**

1. 该字段**仅出现在"增加某味药"类的加减建议上**。"减去某味药""调整用量"类建议不含此字段，属正常。
2. 替代药由系统按受控药品数据推导，不由模型生成。推导时逐条校验：功效方向须同类、
   风险等级不得升高、不得超出药典剂量上限、不得触发十八反十九畏、不得使用管制毒性药材。
   无符合条件的替代药时不输出该字段。

**关于空值**

字符串字段为空串表示"本阶段未产出该项内容"，请按缺失处理，不要直接展示。系统不使用占位文案填充。

---

## 6. 调用示例

### 6.1 完整链路

以下示例贯穿同一个病例（产后气血亏虚头痛），请求与响应均取自真实运行结果。
**全流程只需保持 `caseState.id` 不变，并把上一阶段返回的结构化结论原样并回 `caseState`。**

**第 1 步：准备**

```bash
BASE="https://82.156.128.153/tcm-cdss"
TOKEN="<接口令牌>"
CUSTOMER_ID="<客户唯一标识>"
CASE_ID="OPD-20260807-000123"
```

**第 2 步：M03 辨病辨证**

```bash
curl -N -X POST "$BASE/api/diagnosis/diagnose" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
  -d '{
    "caseState": {
      "id": "'"$CASE_ID"'",
      "patient": { "sex": "女", "age": 28 },
      "chiefComplaint": "产后2月余，头痛反复发作1月",
      "symptoms": { "现病史": "近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华" },
      "tongue": "舌淡苔薄白",
      "pulse": "脉细弱",
      "vitals": { "BP": "108/70mmHg", "T": "36.5", "P": "78" },
      "tcmLineagePreference": "classical-formula",
      "conversation": []
    }
  }'
```

响应为 NDJSON 流。按 §3.5 拼出完整正文后，取 `<!-- DIAGNOSIS_JSON_START -->` 与
`<!-- DIAGNOSIS_JSON_END -->` 之间的 JSON，即为 `reasoningDiagnose`（下为节选，字段含义见 §4.4）：

```json
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "overview": {
    "tcmDiseaseName": "头风病",
    "primarySyndrome": "心脾两虚，气血不足",
    "primarySyndromeBasis": [
      "产后2月余，头痛反复发作1月",
      "舌象：舌淡苔薄白",
      "脉象：脉细弱"
    ],
    "primarySyndromeResolution": "bounded",
    "tcmDiseaseDifferentials": [
      {
        "diseaseName": "眩晕",
        "reason": "头痛与眩晕可并见；病历已记录头痛阳性。",
        "distinguishingPoints": "病历已记录头痛阳性。",
        "nextCheck": "需追问有无视物旋转、站立不稳。"
      },
      {
        "diseaseName": "真头痛",
        "reason": "真头痛为头痛之急重症，需排除。",
        "distinguishingPoints": "病历已记录头痛阳性；病历已记录头痛阳性；病历尚未确认剧烈头痛是否存在；病历尚未确认抽搐是否存在；病历尚未确认呕吐是否存在。",
        "nextCheck": "若出现剧烈头痛、喷射性呕吐、意识改变，需急诊排查。"
      }
    ],
    "overallPathogenesis": "产后气血亏虚，心脾两虚，清窍失养，不荣则痛；心神失养则心悸失眠，脾虚不运则神疲乏力，面色少华。",
    "overallTherapy": "补益心脾，益气养血，和络止痛。",
    "recommendedFormulaDirection": "归脾汤加减",
    "recommendedFormulaNames": [
      "归脾汤"
    ],
    "formulaSelectionMode": "single"
  },
  "westernDiagnosis": {
    "primary": {
      "name": "头痛症状",
      "status": "考虑",
      "confidence": "中",
      "supportingFacts": [
        "产后2月余，头痛反复发作1月",
        "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华"
      ],
      "limitations": [
        "未提供神经系统查体及影像学检查，无法排除颅内器质性病变"
      ],
      "suggestedChecks": [
        "测量血压，评估有无高血压",
        "神经系统查体，包括眼底检查",
        "若出现红旗征（如突发剧烈头痛、意识改变、局灶神经体征），及时行头颅CT/MRI"
      ]
    }
  },
  "pathogenesis": {
    "summary": "产后气血亏虚，清窍失养，不荣则痛；心脾两虚，气血不足，心神失养，脾虚不运",
    "locationDifferentiation": {
      "items": [
        "心",
        "脾",
        "头窍"
      ]
    },
    "chain": [
      {
        "nodeId": "P1",
        "patientFact": "产后2月余，头痛反复发作1月",
        "syndromeEvidence": "产后2月余",
        "pathogenesis": "产后气血亏虚，清窍失养，不荣则痛。",
        "therapyDirection": "益气养血，和络止痛。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "虚则补之",
    "overallMethod": "补益心脾，益气养血，和络止痛。",
    "subTherapies": [
      {
        "therapy": "益气养血，和络止痛",
        "targetPathogenesis": "产后气血亏虚，清窍失养，不荣则痛",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "补益心脾，养血安神",
        "targetPathogenesis": "心脾两虚，气血不足，心神失养",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      }
    ]
  },
  "contractSignature": "hmac-sha256:3d134c59…（64位十六进制，原样回传）"
}
```

**第 3 步：M04 候选方药**

把上一步取到的 JSON **整体**放进 `caseState.reasoningDiagnose`，不要改写任何字段：

```bash
curl -N -X POST "$BASE/api/diagnosis/prescribe" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
  -d '{
    "caseState": {
      "id": "'"$CASE_ID"'",
      "patient": { "sex": "女", "age": 28 },
      "chiefComplaint": "产后2月余，头痛反复发作1月",
      "herbCountPreference": "between_10_15",
      "reasoningDiagnose": { ...上一步取到的完整 JSON... }
    }
  }'
```

响应中的结构化结论即为 `reasoningPrescribe`（下为节选，字段含义见 §4.5）：

```json
{
  "stage": "prescribe",
  "formula": {
    "candidates": [
      {
        "name": "归脾汤加减",
        "formulaNames": [
          "归脾汤"
        ],
        "positioning": "首选",
        "constructionType": "single_base",
        "modificationStatus": "modified",
        "herbs": [
          {
            "name": "黄芪",
            "processing": null,
            "dose": "20g",
            "role": "君",
            "prescriptionRole": "君药：益气养血，和络止痛。",
            "targetKind": "pathogenesis_node",
            "targetRef": "P1",
            "structureRole": null,
            "targetPathogenesis": "产后气血亏虚，清窍失养，不荣则痛。",
            "function": "补气升阳，固表止汗，利水消肿，生津养血，托毒排脓，敛疮生肌；补气药；补虚药",
            "isToxic": false,
            "verificationTier": "verified",
            "doseSource": "governed_boundary",
            "verificationReasons": [
              "受治理剂量边界 9-30g 已用于生成后校验"
            ],
            "evidence": {
              "evidenceLevel": "model_inference",
              "source": "基于本例证候、病机、治法与候选药味的配伍分析",
              "confidence": "中"
            }
          },
          {
            "name": "当归",
            "processing": null,
            "dose": "10g",
            "role": "君",
            "prescriptionRole": "君药：益气养血，和络止痛。",
            "targetKind": "pathogenesis_node",
            "targetRef": "P1",
            "structureRole": null,
            "targetPathogenesis": "产后气血亏虚，清窍失养，不荣则痛。",
            "function": "补血活血，调经止痛，润肠通便；补虚药；补血药",
            "isToxic": false,
            "verificationTier": "verified",
            "doseSource": "governed_boundary",
            "verificationReasons": [
              "受治理剂量边界 6-12g 已用于生成后校验"
            ],
            "evidence": {
              "evidenceLevel": "model_inference",
              "source": "基于本例证候、病机、治法与候选药味的配伍分析",
              "confidence": "中"
            }
          }
        ],
        "formulaAnalysis": "本方共9味，围绕「补益心脾、益气养血、和络止痛」分层组方：\n\n- **黄芪**（君）：以「补气升阳，固表止汗」直接承接核心病机「产后气血亏虚，清窍失养，不荣」，为本方治疗支点。\n- **当归**（君）：以「补血活血，调经止痛」同承接上述核心…",
        "decoction": {
          "doseCount": "7剂",
          "method": "每日1剂；加冷水浸泡30分钟，武火煮沸后转文火；一煎30分钟、二煎20分钟；两煎合并药液约500mL；每日分2次服；服药与进餐间隔按患者胃肠耐受、方剂性质及院内规范执行；特殊药味按药味表执行",
          "course": "7日",
          "followUpNode": "完成7剂（7日）后复诊；出现不适或症状加重时提前复诊",
          "dosesPerDay": 1,
          "administrationTimesPerDay": 2,
          "soakMinutes": 30,
          "decoctionTimes": 2,
          "firstDecoctionMinutes": 30,
          "secondDecoctionMinutes": 20,
          "targetVolumeMl": 500,
          "administration": "每日1剂，每日分2次服；服药与进餐间隔按患者胃肠耐受、方剂性质及院内规范执行",
          "followUpAfterDoses": 7,
          "followUpAfterDays": 7
        },
        "classicEvidence": [
          {
            "evidenceId": "TCMOC-18015743D19DF07E",
            "citation": "《时方歌括》·归脾汤",
            "anchorLevel": "chapter_paragraph",
            "excerpt": "属性：治思虑伤脾。不能摄血。致血妄行。或健忘怔忡。惊怪盗汗。嗜卧少食。或大便不调。 心脾疼痛。疟痢郁结。或因病用药失宜。克伐伤脾。以致变症者。最宜之。 归脾汤内术 神。（白术黄 炙茯神各[具体剂量或操作已隔离]。）参志香甘与枣仁。（人参酸枣仁炒研各[具体剂量或操作已隔离]。远志木香各五分。甘草炙[具体剂量或操作已隔离]。）龙眼当归十味外。（龙眼肉五枚。当归[具体剂量或操作已隔离]。）若加熟 地失其真。（本方只十味。薛氏加山栀丹皮各[具体剂量或操作已隔离]。名为加味归脾汤。治脾虚发热颇效。近 医加熟地黄。名黑归脾汤。则支离甚矣。） 陈修园曰。此方汇集补药。虽无深义。然亦纯而不杂。浙江江苏市医。加入熟地黄一味。 名为黑归脾汤。则不通极矣",
            "tier": "canon"
          }
        ],
        "compositionLogic": [
          {
            "formulaName": "归脾汤",
            "summary": "受控目录组成：白术、当归、茯苓、黄耆、远志、龙眼肉、酸枣仁、人参、木香、甘草。目录来源为《校注妇人良方》（通行十味方；初出《济生方》卷四为八味，薛己补当归、远志）。；方证定位为“心脾气血两虚，神失所养：心悸健忘，失眠，食少，或脾不统血出血，舌淡脉细弱。”，仍须逐项核对患者事实、鉴别边与禁忌后才能进入处方编译。",
            "tier": "common",
            "sourceRefs": [
              "urn:tcm-cdss:formula-catalog:归脾汤:济生卷四",
              "urn:tcm-cdss:formula-catalog:归脾汤:校注妇人良方",
              "ADJ-20260727-T14-GRAPH-EXPANSION"
            ]
          }
        ],
        "discriminationPath": [
          {
            "againstFormula": "炙甘草汤",
            "question": "当前心慌失眠，其脉是细弱，还是结代？",
            "status": "unknown",
            "sourceRef": "T14-080:ADJ-20260727-T14-GRAPH-EXPANSION"
          }
        ]
      }
    ],
    "modifications": [
      {
        "trigger": "产后2月余，头痛反复发作1月",
        "triggerSource": {
          "kind": "primary_syndrome_basis",
          "sourceRef": "overview.primarySyndromeBasis[0]",
          "sourceQuote": "产后2月余，头痛反复发作1月"
        },
        "targetPathogenesis": "产后气血亏虚，清窍失养，不荣则痛。",
        "action": "加",
        "herbName": "川芎",
        "doseOrHandling": null,
        "reason": "头痛反复发作，为气血亏虚、清窍失养所致，加川芎活血行气、祛风止痛，引药上行头目，以助和络止痛。",
        "riskNote": "实际采用时请在药味工作台确定剂量，并按调整后的完整处方重新审方。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "患者事实（overview.primarySyndromeBasis[0]）：产后2月余，头痛反复发作1月；对应病机节点：P1",
          "confidence": "中"
        }
      }
    ],
    "patentAndWestern": [
      {
        "type": "中成药",
        "name": "归脾丸",
        "specification": "每瓶装 60g",
        "evidenceId": "EVID-INST-001",
        "evidenceFingerprint": "sha256:1b8f9a574bca8eb451cf5655664a01408b20e08cfcd3db9a82d5e1dfc75b3ce9",
        "recommendationMode": "candidate_review",
        "usageBoundary": "作为饮片煎剂的替代或序贯方案，需在医生指导下使用；哺乳期用药需权衡利弊。",
        "positioning": "替代方案",
        "correspondingProblem": "心脾两虚、气血不足所致的产后头痛、心悸失眠、神疲乏力",
        "evidence": {
          "evidenceLevel": "instruction",
          "source": "[EVID-INST-001]",
          "confidence": "中"
        },
        "relationship": "与饮片方案不默认联用，由医生择一或评估联用",
        "riskNote": "说明书未载明确禁忌；哺乳期妇女应在医师指导下服用；服药期间忌不易消化食物，感冒发热不宜服用；病历已记录心悸阳性；病历尚未确认头晕是否存在。"
      }
    ]
  },
  "nonPharma": {
    "diet": "饮食宜温热、易消化，适当增加富含蛋白质和铁的食物如瘦肉、蛋类、豆制品，避免生冷、油腻及辛辣刺激之品；可少量多餐，忌暴饮暴食。",
    "lifestyle": "保证充足睡眠，避免劳累和熬夜；产后注意保暖，避免风寒；可适当进行温和活动如室内散步，逐步恢复体力，避免剧烈运动。",
    "emotion": "保持情绪平稳，避免过度思虑和恼怒；家人应多予关心支持，可尝试听舒缓音乐、深呼吸等方式放松心情。",
    "precautions": [
      "服药期间若头痛突然加剧、伴呕吐、视力模糊或肢体无力，应立即就医排查子痫前期或颅内病变。",
      "建议1周内复诊评估疗效，若服药后症状无改善或出现胃脘不适、食欲减退等，应及时就诊调整方案。",
      "病历尚未确认皮疹是否存在；病历尚未确认腹泻是否存在。",
      "若同时服用其他药物，尤其是抗凝药、降压药或镇静安神药，需告知医生以评估相互作用。"
    ],
    "tcmTreatments": [
      {
        "projectCode": "moxibustion",
        "projectName": "灸法",
        "availability": "clinic_available",
        "riskLevel": "moderate",
        "recommendationMode": "clinician_assessment",
        "targetRef": "P1",
        "targetPathogenesis": "产后气血亏虚，清窍失养，不荣则痛。",
        "protocolStatus": "assessment_only_no_patient_specific_protocol",
        "protocolGap": "目录存在该项目的其他适应证模板，但与本例适应证不符；不得跨适应证套用穴位、部位、频次或疗程。",
        "treatmentContent": "本例与经带与下腹症状存在项目评估关联；仅进入现场适应证、禁忌与资质评估，不形成操作计划。",
        "suggestedSitesOrPoints": [
          "按针刺方案中与当前证型匹配的穴位",
          "膀胱经大杼至肾俞区域（现场定位）"
        ],
        "scheduleSuggestion": "",
        "techniqueBoundary": "仅在病例文字命中模板适应证且通过红旗、资质和禁忌复核时可显示治理过的穴位/部位与频次；不得跨适应证套用。",
        "protocolSource": "SRC-SAMR-ACUPUNCTURE-OPS、SRC-TCM-INFECTION-CONTROL",
        "operatorRequirement": "由受训医务人员评估火源、温度和皮肤耐受",
        "requiredChecks": [
          "感觉障碍、糖尿病足、发热热证、皮损和烫伤风险"
        ],
        "containsMedication": false,
        "requiresMedicationAudit": false,
        "executable": false,
        "clinicianReviewRequired": true
      }
    ]
  },
  "contractSignature": "hmac-sha256:9f2ab7c1…（64位十六进制，原样回传）"
}
```

**第 4 步：M05 风险随访**

把 M03 与 M04 两份结论都并进 `caseState`：

```bash
curl -N -X POST "$BASE/api/diagnosis/assess" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
  -H "x-cdss-customer-id: $CUSTOMER_ID" \
  -d '{
    "caseState": {
      "id": "'"$CASE_ID"'",
      "reasoningDiagnose": { ... },
      "reasoningPrescribe": { ... }
    }
  }'
```

> **最常见的两个集成错误**
> 1. 把上一阶段结论「精简」或「重新格式化」后再回传 —— 签名校验失败，返回 `409`。必须逐字节原样。
> 2. 各阶段用了不同的 `caseState.id` —— 同样返回 `409`。

### 6.2 响应解析（Node.js）

下例边收边解析，可直接用于渐进式展示；四种帧的处理与 §3.5 一致。

```javascript
async function callStage(url, headers, body) {
  const response = await fetch(url, { method: "POST", headers, body });
  // 首字节之前的失败走普通 HTTP 错误，不会进入流（§3.5）
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`${response.status} ${detail.code || ""} ${detail.error || ""}`);
  }

  let markdown = "";
  let buffer = "";
  let ended = false;                       // 是否收到 [END]
  const timeline = [];

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    // NDJSON 帧可能被 TCP 分片切开，必须按换行切分并保留未完成的尾部
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.error) throw new Error(frame.error);          // 流内错误
      if (frame.type === "followup_timeline") {               // M05 随访时间轴
        timeline.push(...(frame.timelineItems || []));
        continue;
      }
      if (typeof frame.content !== "string") continue;        // heartbeat 及未来新增帧一律跳过
      if (frame.content === "[END]") { ended = true; continue; }
      markdown += frame.content;
    }
  }
  // HTTP 200 不等于成功：没有 [END] 说明流被截断，结果不可采用
  if (!ended) throw new Error("stream truncated: [END] not received");

  const match = markdown.match(
    /<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/
  );
  return { markdown, structured: match ? JSON.parse(match[1].trim()) : null, timeline };
}
```

> 若贵方暂时只做非流式接入，可用 `await response.text()` 一次性读完再按同样规则逐行解析；
> 但**客户端超时必须放宽到 200 秒以上**（§3.9），否则会在服务端正常推理途中被切断。

---

## 7. 限制说明

| 项 | 限制 | 详见 |
|---|---|---|
| 调用频率 | 60 次 / 10 分钟（可配 10–2000），按会话或租户分桶 | §3.8 |
| 请求体上限 | M01 约 5.6 MB；其余诊疗接口 1 MB；库存导入 8 MB / 20000 条 | §3.10 |
| 舌象图片 | ≤4 MB | §3.10 |
| 超时 | 连接 90 秒 / 空闲 60 秒 / 单流总计 180 秒；M03 编排 180 秒、M04 编排 120 秒 | §3.9 |
| 幂等性 | M01–M05 非幂等；`429`/`503` 可重试，其余 `4xx` 须先修正请求 | §3.9 |

**能力边界**

| 项 | 说明 |
|---|---|
| 结论性质 | 仅为建议。系统不出具诊断结论、不代替医师决策，处方须经医师与药师复核后方可使用 |
| 剂量输出 | 存在未解安全风险或剂量不可核定时，输出会自动降级为非剂量建议，而非给出未经核定的剂量 |
| 证据边界 | 无法追溯到患者事实、确定性规则或受治理知识库条目的内容会被显式标注为证据不足 |
| 部署形态 | 限流与库存快照为单实例内存/本地卷；水平扩展需在接入层另行处理（§3.8） |



## 附录 A. 与主链路无关的能力

以下能力已实现，但不属于 M01–M05 主链路，按需选用。

### A.1 HIS 诊疗方案导出 —— `POST /api/diagnosis/his-scheme`

把 M03 与 M04 的结果打包成一份 JSON，便于一次性写回 HIS，无需从两个阶段的响应中逐字段拼接。
**直接对接 M01–M05 的调用方不需要此接口。**
该接口的字段名与 M03/M04 原始响应**不完全相同**（例如中成药在此为 `prescriptions.patentMedicines`，
在 M04 原始响应中为 `formula.patentAndWestern`）。请勿混用两套字段命名。

**V2.27 新增出参（库存标签）**

| 字段 | 中文名 | 说明 |
|---|---|---|
| `inventory.coverage` / `inventory.importedAt` / `inventory.stale` | 同步状态 / 导入时间 / 是否过期 | 同 §4.10；未接库存时不出现 |
| `herbAvailability[].label` | 库存标签 | `院内有货` / `缺货` / `库存外用药`，未接库存时不出现 |
| `herbAvailability[].inventoryName` / `goodsId` / `specification` / `note` | 院内药名 / 院内商品号 / 规格 / 说明 | 匹配到的院内条目（如处方写「甘草」，院内为「甘草片」） |
| `medicineAvailability[]` | 中成药/西药院内状态 | 与 `prescriptions.patentMedicines` 逐条对应：`{name, type, availability, label?, inventoryName?, goodsId?, specification?, note?}`；院内没有的照常保留，只标「库存外用药」 |

**V1.4 新增出参**

| 字段 | 中文名 | 说明 |
|---|---|---|
| `clinicalReviewMethod` | 临床复核方式 | **V2.14 起恒为 `null`**（模型复核环节已移除，见附录 B）。仅历史快照中 `clinicalReview.status==="accepted"` 的记录仍按原样写回：`independence` 取 `cross_model` 或 `same_model_second_pass`，`label`/`note` 为对应中文说明 |
| `diagnoses.westernDetail.guidelineReferences[]` | 指南/文献依据 | 与 §5.1 同源；可选，仅当本轮 EviMed 检索命中时输出 |
| `diagnoses.westernDetail.clinicalRationale` | 西医诊断推理 | 事实到诊断倾向的推理；此前只出现在可见正文，写回链路取不到 |
| `diagnoses.tcmDetail` | 中医辨病辨证详情 | 与 `westernDetail` 同构的结构化中医推理：病名、辨病推理、辨证推理、证候与依据、证候/病名鉴别（含 `typicalManifestation` 典型表现）、被剥离的方名 `deferredFormulaSelection`（可选：仅当模型选过方而服务端未予锁定时输出）。无中医证候结论时为 `null` |
| `nonPharma.tcmTreatments[].protocolGapNote` | 方案边界说明 | `protocolGap` 内部状态码的临床语言说明；集成方要直接展示时用它，不要自行翻译码值 |

**V1.5 新增出参**

| 字段 | 中文名 | 说明 |
|---|---|---|
| `prescriptions.modifications[].triggerSource` | 加减触发依据 | `{kind, sourceRef, sourceQuote}`，三项齐全才下发，否则为 `null`。`kind` 取 `primary_syndrome_basis` / `pathogenesis_patient_fact` / `western_supporting_fact`，说明这条加减是从证候依据、病机患者事实还是西医支持事实来的；`sourceQuote` 为病历原文逐字引用。此前 HIS 侧只有一句自由文本 `trigger`，无从判断触发来自哪里 |
| `diagnoses.terminologyMappings[]` | 国标术语归一痕迹 | `{namespace, fieldPath, originalText, canonical, candidateId, status, confidence}`。系统把医生原文归一到国标/受控词表（如「胃痞」→「痞满」）时的逐条记录。`status=suggested` 表示系统建议、医生**尚未确认**；`clinician_confirmed` 表示已确认。此前 HIS 只拿得到归一**之后**的名字，无法回答「这个证候名是医生写的还是系统改的」。内部执行痕迹（模型名、缓存命中）不下发 |
| `treatments.tcmProjects[].tailoringStatus` | 方案加减状态 | `syndrome_tailored` / `class_template_only` / `assessment_only`。三态的**真实值**，两个契约版本都下发，永不随 `protocolStatus` 折叠。详见上方「V1.5 勘误与兼容修正」 |
| `treatments.tcmProjects[].pointProvenance[]` | 逐穴来源与权威分级 | `{point, role, sourceRefs, authorityTier, adjudicationStatus, conflictNote}`。`role` 为 `base_point`（病种主穴）/ `syndrome_refinement`（证型加穴）/ `syndrome_removal`（证型剔除穴）/ `conditional_point`（**条件加穴**，V1.8 新增：既非主穴也非证型加减，而是本例出现某组当前症状时才加的穴，如风寒咳嗽兼鼻窍或头项症状时加风池）。**`conditional_point` 只在 `?schemaVersion=v2` 下出现**；V1 把它折叠为 `syndrome_refinement`，因此按 V1 严格枚举反序列化的集成方不受影响。**主穴与加减穴来自不同来源**，此前只有一个拼接的 `protocolSource` 字符串，集成方看不出哪个穴来自哪个来源、什么等级、有没有分歧 |
| `treatments.tcmProjects[].sourceAuthorityTier` | 本条方案最高权威等级 | 取值：`regulatory_primary`（国家标准/规范）、`government_primary`（政府发布方案）、`government_mirror`、`professional_society_standard`（学会标准）、`professional_society_reference`（学会参考条目）、`project_governed_source`（项目治理教材来源）、`unregistered`。逐穴等级见 `pointProvenance` |
| `treatments.tcmProjects[].adjudicationStatus` | 证型加减终审状态 | `approved` / `pending_clinician_review`。**未终审时服务端不应用该条加穴**，`suggestedSitesOrPoints` 只是病种标准取穴，`protocolStatus` 同时降为病种模板态 |
| `treatments.tcmProjects[].deferredGovernedTemplate` | 待签字的病种标准取穴 | `{templateId, indicationLabel, deferredPoints, conflictNote}`。本例已匹配到一条**受治理的病种标准取穴模板**，但该模板尚未完成中医师签字终审，因此本轮**整条不启用**，该项目仍按评估态（`assessment_only_no_patient_specific_protocol`）呈现。字段只作知悉用途，**不得当作可执行取穴**。与下一行的区别：下一行是「病种模板能用、这一条证型加减不敢用」，本行是「整条病种模板都还没签字」 |
| `treatments.tcmProjects[].deferredSyndromeRefinement` | 未予应用的证型加减 | `{syndromeLabel, deferredPoints, conflictNote}`。命中了本例证型的配穴方案、但因未完成中医师终审而没有应用。如实下发而不是静默隐藏——否则医生会以为系统根本没识别出本例证型 |

**V2.26 新增出参：健康调护 `healthGuidance`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `healthGuidance.diet` | 饮食调养 | string | 与 M04 `nonPharma.diet` 同源（经服务端食疗净化） |
| `healthGuidance.lifestyle` | 生活方式 | string | 与 `nonPharma.lifestyle` 同源 |
| `healthGuidance.emotion` | 情志调护 | string | 与 `nonPharma.emotion` 同源 |
| `healthGuidance.exercise` | 运动保健 | string / null | **V2.26 新增**，与 `nonPharma.exercise` 同源 |
| `healthGuidance.acupointCare` | 穴位保健 | string / null | **V2.26 新增**，与 `nonPharma.acupointCare` 同源；写回病历时按原文整段写入 |
| `healthGuidance.precautions[]` | 注意事项 | array | 与 `nonPharma.precautions[]` 同源 |

`healthGuidance` 整体在 M04 未生成健康调护时为 `null`。

**V2.8 加减字段勘误**

HIS 投影与 M04 原始响应保持同一语义：`prescriptions.modifications[].action` 只取
`加` / `减` / `调整`，药味单独读取 `prescriptions.modifications[].herbName`。例如：

```json
{
  "action": "加",
  "herbName": "茯苓"
}
```

不要再按旧形态把 `action` 解析成「动作前缀 + 药味正文」。

**V2.9 临床意见随结果交付**

对已签发的 M04 候选或服务端确认的医生编辑版本，药味方向、参考药量、煎服说明、重复药味、解释待补充等临床问题不再单独使 HIS 返回 `422`。接口保留诊断和处方，返回 `200`，将具体问题放入 `warnings[]`，并在 `riskTips` 中提供同源中文说明。`200` 表示方案已交付，不等于所有临床问题均已消除；集成方应将建议与处方一起展示，不应再因存在提示隐藏整份报告。

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `workflowPermission` | 流程权限 | string | `continue`：已有报告可继续查看、编辑和流转 |
| `reviewRequired` | 临床判断提示 | boolean | 医生仍需结合病例作临床判断；不是要求客户端拦截报告的指令 |
| `warnings` | 补充意见 | array | 无补充意见时为 `[]`，有意见时使用下表字段 |
| `warnings[].code` | 归因码 | string | 可扩展的内部归因码，用于对账；不直接作为医生提示文案 |
| `warnings[].relatedCodes` | 相关归因码 | string[]，可选 | 合并同一可见提示时保留相关归因码 |
| `warnings[].candidateIndex` | 候选方序号 | number | 候选方序号，从 0 开始 |
| `warnings[].herbIndex` / `herbName` | 药味序号/名称 | number / string，可选 | 能定位到具体药味时提供；整方意见不提供药味位置 |
| `warnings[].message` | 问题说明 | string | 问题与本例的关系；可获得时包含当前药量与资料参考范围 |
| `warnings[].suggestedAction` | 建议动作 | string | 医生可采取的核实、补充或调整动作 |

处方后审接口同样返回 `warnings[]` 和包含提示的 `section`；M05 将相关意见写入可见随访/风险正文。外部审方已下线（V2.18），处方后审只含本地确定性核对，状态如实标为未送外部审方，不伪装为审方通过，也不自动授权最终处方。鉴权失败、跨租户或被改写的签名、候选不存在等无法定位可信业务对象的请求仍返回相应 `4xx`，这些不是临床意见。

医生在药味工作台实际增删改药味时，变更直接体现在当前候选的 `herbs[]`，不再把“已经
落入处方的编辑动作”重复塞进条件性 `modifications[]`。工作台审方响应另返回
`audit.attestationVersion` 与 `audit.attestation`；浏览器须将二者连同原审方字段原样回传。
该凭据绑定租户、病例、就诊、候选序号和完整处方摘要，M05/HIS 不接受仅靠
`prescriptionRevision.source="herb_workbench"` 声明的未签发版本。本地核对结果是建议性，
但缺少 CDSS 服务端版本凭据时不能把被篡改的医生编辑版当成可信写回版本。

> **证型配穴的权威性必须按条看，不能按病种看。** 当前 8 组针刺模板下共 **44 条**证型加减，
> **全部已完成中医师终审**（`approved`）。原 45 条中「感染恢复期 · 风热犯肺 → 大椎、曲池」
> 一条经终审整条删除（该配穴对应发热/表热的急性阶段，与恢复期定位不匹配），
> 该证型现走第三态，不再返回看似精准、病程阶段却不匹配的配穴。
> 权威等级同样逐条不同：不寐的「心脾两虚/肝火扰心/心肾不交/心胆气虚」四条有
> T/CAAM 011-2014 学会标准背书，同病种的「痰热内扰/脾胃不和」只有项目治理教材来源；
> 痛经同理。**请勿按病种整组采信**，以 `pointProvenance[].authorityTier` 与
> `adjudicationStatus` 为准。
> 完整 JSON Schema 见 `docs/schema/his-ai-scheme-tcm-projects.schema.json`（V1.5 起随文档发布）。

> **同批修复（无出参变化，但影响你看到的值）**：`nonPharma.tcmTreatments` 此前在评估态项目上
> 会整条丢失（服务端生成的 `techniqueBoundary` 为空串，撞上载荷校验的非空约束被静默剔除），
> 表现为「医生页面有三个诊疗项目、HIS 一个都没有」。V1.5 起该字段在评估态写明
> 「本轮不下发患者级操作参数」，项目正常下发。若贵方此前按「HIS 侧常年为空」做过特殊处理，
> 请撤销。

> `diagnoses.western[0].name` 与 `diagnoses.westernDetail.name` V1.4 起统一走同一套诊断名规范化
> （ICD-10 编码名优先、症状级限定收敛成"X，病因待查"），此前这两处与医生页面可能出现三种写法。

### A.2 服务健康检查 —— `GET /api/diagnosis/health`

供运维使用。不带参数返回服务状态与当前服务版本标识，可用于核对线上运行版本。

V2.25 起响应包含 `classicEvidence`：经典条文语料逐项的 `name`（语料名）、`records`（记录数）、`indexed`（已建索引、可被引用的条数）。

`?strict=1` 会对模型、证据检索、舌象视觉、语义预检、术语库等依赖执行真实探测，任一项未就绪返回 `503`。
客户授权配置也属于严格发布闸门：响应只包含 `configured/valid/clientConfigured/customerCount/ready`，不返回客户标识列表。
该模式会产生真实的上游调用，**不适用于高频轮询**。

**V2.18 变化**：外部审方下线，响应不再包含 `rxAudit` / `rxAuditProbe`，`rxaudit_*` 系列未就绪原因随之消失；
事实层复核/裁决相位删除，`clinical_facts_reviewer_*` / `clinical_facts_adjudicator_*` 系列原因消失。
术语归一与证候重排不可用时会退回确定性结果、不影响结论，因此改为只出现在 `degradedReasons` 里，
不再拉低 `strictReady`（此前它们任一未配置都会让容器判为不健康、阻断发布）。
`GET /api/model-health` 与本接口采用同一套对外脱敏规则（不返回模型名、厂商、地址等内部配置）；
`?check=1` 改为对**每个已配置的模型厂商各做一次真实调用**（当前为两家），全部成功才算通过。

---

## 附录 B. 变更记录

| 版本 | 日期 | 变更 | 是否影响已完成的集成 |
|---|---|---|---|
| V2.53 | 2026-10-29 | **只改内容；字段名、枚举与调用顺序不变。** ① 未满 10 岁的患儿，病历却写着本人的婚育、月经记录（如 1 岁女童写「配偶体健，备孕」「月经周期13天，有痛经史」）时，`safetyGate.advisories` 多一条「病历记录的「…」与患者年龄（…）不符，可能录入有误，请核实」；这些记录不再用于辨证依据，注意事项不再写备孕、验孕一类提示；剂量照登记年龄按儿童年龄分数法折算。8–9 岁写着月经、或就诊原因就是性早熟、阴道出血的不在此列。② 未满 3 岁不再给拔罐项目（《刺法灸法学》拔罐法禁忌证「婴幼儿…不宜拔罐」）。③ 西医病名「慢性X」按病程门槛核对时，「2月余」「10余天」这类约数按「不到下一个整数」算：如「失眠2月余」不再写「慢性失眠障碍」（需满 3 个月），写「失眠障碍」。④ 中医治疗项目的 `techniqueBoundary` 不再出现「…由现场医师复核后确定」「适用于成人普通急性/亚急性咳嗽…不适用」这类模板说明；西医依据里的「工作诊断」「症状层面工作诊断」改为「初步诊断」。⑤ 选了流派的病例，辨证依据末尾的流派视角那一句不再在依据补写时丢失。 | 否 |
| V2.52 | 2026-10-29 | **更正文档与响应不一致的地方；字段名、枚举与调用顺序不变。** ① **红旗筛查（§4.7）**：出参表此前把 `redFlags`、`advisories` 列为顶层字段，响应里实际只在 `safetyGate` 下有；本版起响应顶层带上这两个字段（内容与 `safetyGate.redFlags` / `safetyGate.advisories` 相同），出参表补上 `safetyGate`、`prescriptionPermission`、`operationalCompleteness`、`latencyMs`。**红旗以 `safetyGate.status` 为 `red_flag`（即 `redFlags` 不为空）为准**；`clinicalFacts` 是语义复核的内部记录，其中 `redFlags` 也记病历里明确否认的风险（`status` 为 `negative`，如「否认疫区旅居史」），不能据此显示红旗。② **追问（§4.3）**：一轮恒为 1 题的说明与 V2.36 的实际行为对齐；补上 `questions[].options` 的结构，响应示例改为 1 题。③ **风险随访（§4.6、§5.3）**：正文各节按实际输出列出（处方安全总评、随访管理方案、生活管理）。④ **内容**：病历写了「藿香正气水」这类以「水」等剂型结尾的药名时，`safetyGate.missingItems` 写「已提及当前用药但缺少剂量/频次」，不再写「缺少药名」；注意事项与方义里病历所写、本页所推荐的药名不再按药味表改字（药味表有广藿香时，「藿香正气水」曾被写成「广藿香正气水」）；辨证结果 `management` 里的红旗处置一句不再出现「服务器红旗」，改写为「急危重征象」。 | 否：新增的顶层 `redFlags` / `advisories` 与 `safetyGate` 下的同名字段内容相同；此前按 `clinicalFacts.redFlags` 显示红旗的，请改按 `safetyGate.status` / `redFlags`。 |
| V2.51 | 2026-10-28 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的内容变化。** ① **男性的中医病名鉴别**：只属妇科的病（如异位妊娠）在补齐鉴别之前就不计入，`overview.tcmDiseaseDifferentials` 仍补足两项（此前删掉后只剩一项）。② **周围性面瘫的评估时限**：起病不超过 72 小时、或病历读不出起病时间时，`safetyGate` 优先评估项与复诊首句写「24 小时内到神经内科或面瘫门诊」，让口服激素能在起病 72 小时内开始；超过 72 小时仍为 48 小时内（依据 AAO-HNS 2013 Bell 面瘫指南、NICE CKS）。③ **中成药**：说明书「用于/适用于」写明的证与本例证候落在不同脏腑时不推（如「适用于心脾两虚证」的五味安神颗粒之于心虚胆怯证；说明书的证更宽、包含本例脏腑的不在此列）；证名、治法都不分寒热时，汤剂里有三味以上清热药且没有温里药，按偏寒核对，不再推风寒类中成药（如桂枝颗粒）；「清阳不升」「中气下陷」这类证名按虚证核对，说明书只写邪实（如「用于风热头晕目眩」的清眩丸）的不推；成药的组成整个都在本方汤剂里（人参口服液之于方中已有人参）时不推，避免同一味药重复服用。④ **兼证**：辨证阶段补出的兼证与模型自写的兼证过同一道结构核对，与主证寒热相反（风热犯肺证兼风寒表证）或已被主证包含的不补，治法也不再多出相反的一项。⑤ **妊娠状态**：「否认妊娠」写在 `symptoms` 的「既往史」里也按当前否认处理，`safetyGate.missingItemCodes` 不再列 `pregnancy_unknown` / `lactation_unknown` / `conception_unknown`，也不再追问。⑥ **红旗病例的辨证边界**：剂量照给（V2.46 起）时，`pathogenesis.uncertainties` 与红旗处置说明写「风险解除前本方不能正式采纳」，不再写「本次不显示具体用量」。⑦ **措辞**：随证加减的人群慎用提示与逐味提示同一写法（男性、儿童与 60 岁以上不写「月经期」）；模型写的「复评」交付为「再次评估」；依据里未记录的「无X」改「未诉X」时不再被「以…多为主症」这类写法挡住。 | 否 |
| V2.50 | 2026-10-27 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的内容变化。** ① **开方不再因一味药整页退成无剂量**：与本例治法方向相反的非君药（候选不再声称原方名时也算）、《中药学》写明「脾胃虚寒者忌用/不宜」而本例病历有便溏且有虚寒表现、无热象的苦寒药（如黄芩），在定稿时单味拿出，`notApplicable` 写明「按本例情况已去除：X（原因）」，其余药味照常给剂量；同属补气的参类（人参、党参、太子参、西洋参）只留一味。`formula.modificationReview` 的说明文字不再被删空（此前男性患者偶发整张处方退成无剂量页）。② **开方正文与结构化结果一致**：开方响应的 Markdown 正文从「# 候选方药」起按最终结构化结果重新生成，方名标题、方义与 `formula.candidates[]` 首选方逐字一致（此前约一半正文方义是改写前的版本，偶见「本方以本方案合本方案加减」）。③ **方名**：方名写成自拟方、组成却正是辨证阶段锁定的成方时（逐味相同或保留数达到该方的组成下限），`name` 写原方名或「X加减」，`formulaSource` 写原书。④ **措辞**：质量说明、M05「处方安全总评」「整体状态评估」、信息完整性边界、治疗卡 `operatorRequirement`、流派段的安全让位说明不再出现「确定性核查」「系统未能自动对应」「候选方案」「复评」「资质」「药事审方」等用语；男性、儿童与 60 岁以上患者的逐味提示不再写「月经期」；现用药提示不再写「最好间隔1小时左右」（没有统一的官方间隔），改为「与本方如何错开服用由医生决定」。⑤ **中医治疗**：《推拿学》写了取穴与操作步骤的病种（虚劳、腰痛、不寐…）出推拿卡，背俞穴按本例证名里的脏选取（肺脾两虚→肺俞、脾俞）。⑥ **治法与中成药**：证名、病名都不涉心神时，治法里单列的「宁心安神」一项不再出现；证名不分寒热时，中成药按已签名治法与汤剂组成的寒温核对方向，不推与之相反的药。 | 否 |
| V2.49 | 2026-10-27 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化。** ① **追问是否出题更稳定**：同一份病历多次生成时，`decision` 曾在「出一道题」与「无需追问」之间来回切换（甲方 10 例各生成 4 次，6 例出现切换）。现在每次出题同时独立生成两份出题计划，各自经过同一套核对（病历已写明、一题两问、选项同值），任一份留下了针对本例的题就出这道题，两份都没有才返回 `proceed`；同样 4 次生成只剩 1 例切换。② **复诊计划的评估时限按指南病名收紧**：需先完成评估再服药的病例，`followupSafetyNet` 与 M05 首次复诊里的时限此前由模型判断，短暂性脑缺血、深静脉血栓、急性肾损伤、马尾综合征等常比指南慢一档。现在模型写出的要排除的病对上指南时限表（55 行，逐行附 NICE、KDIGO 等指南原文与链接）时，取指南与模型较紧的一档，只收紧不放宽。③ **辨证依据**：病历记录了舌象、脉象而 `tcmDiagnosticRationale` 没讲到时也会补写进主证的推理。④ **用药频次**：「硝苯地平控释片60mg/d」「1片/d」「2次/d」「q8h」这类写法读作已写明频次，不再提示「缺少剂量/频次」。⑤ **否认的范围**：「无皮疹，是否抽搐尚未询问，面色苍白」里的「无」只管到「是否抽搐尚未询问」之前，面色苍白不再被读成否认。另在 §3.12 写明 `x-cdss-regenerate` 对哪些接口起作用。 | 否 |
| V2.48 | 2026-10-27 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化。** ① **婚育史、月经史**：`symptoms` 可以（也应当）用中文键 `婚育史`、`月经史` 传入这两栏；婚育史里单独写的「怀孕」「妊娠」按当前妊娠处理（此前读不出）。贵方 10/13 以来的请求从未传过这两栏，妊娠只写在婚育史里的病历（10.26 测评病历 1）系统无从得知。② **自行停药**：「利伐沙班，近一周自行停用」「阿司匹林，已停用半年」这类写了时长或「自行」的停药不再算当前在用，剂量复核理由里不再出现「当前抗凝或抗血小板治疗」。③ **病历记载的当前出血**：当前咯血、咳血、痰中带血，或正在抗凝/抗血小板治疗而有经量增多、牙龈或鼻出血、皮下瘀斑、血尿、便血、黑便时，与活动性出血红旗同样处理——辨证阶段治法止血为先、开方阶段活血化瘀药不入方；此前要看红旗引文是否引到了这句。④ 红旗里的出血只是「需排除」的情况、病历本身没有记载出血时，辨证与方义写「出血尚未排除」，不再写「因活动性出血」。⑤ **西医病名**：成人（18 岁及以上）不再用只为儿童制定标准的「反复（上）呼吸道感染」：本次有急性呼吸道感染表现写「急性上呼吸道感染」，没有时写症状层面名称（如「乏力待查」）。⑥ `safetyGate.advisories` 里「上消化道警示征象需优先复核」只用于消化道的警示表现；乳房等消化道以外的肿块改写「当前异常表现需优先复核」，提示档位不变。⑦ **辨证依据**：`overview.tcmDiagnosticRationale` 漏讲主诉主症，或漏讲两项以上病历已记录的表现（含舌象、脉象）时，按病历逐项「表现→病机」重写这一段（只写病历有的表现，不改证名）；某个证名以外的虚证要点在病历里不成组、从依据撤下时，相应表现保留，写成「…，是否兼X尚待核实」，与 `pathogenesis.uncertainties` 一致。方义不再出现原方本有药味的「以X易之」。⑧ **居家穴位保健**：`nonPharma.acupointCare`（成人）改为按本例证候与主要不适选 1～3 个居家按揉穴并写明各自的作用，格式为「按揉X、Y。取穴：X在…；Y在…。手法：…。X：…；Y：…。」后接注意事项；穴位只从教材核对过的 34 个常用穴里选，孕期禁用穴与部位、医师项目已用的穴不给，红旗、儿童、妊娠等不给的情形与此前相同。 | **否**：字段路径、类型、取值集合均未改变。`acupointCare` 的文字格式变化；成人「反复上呼吸道感染」的西医名会改变；带当前咯血或抗凝中出血的病例方中不再出现活血化瘀药。 |
| V2.47 | 2026-10-27 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化（按 10.26 医学测评整改）。** ① **西医诊断依据**：`westernDiagnosis.primary.supportingFacts` 不再是空数组，固定为一项：本条西医诊断的诊断依据（一到两句，写支持诊断的关键已记录事实、为何符合该病、还需排除或核实什么）；`limitations`、`suggestedChecks` 仍为空数组。回传给开方接口时这一项不当作病历事实使用。② **同一份病历结果一致**：红旗检查、追问、辨证、开方读到的语义事实按病历内容留存（与结果复用同一开关、同一保留期），同一份病历隔天再测不再重新抽样；舌苔、脉象拆成几个勾选项写（「苔薄，苔白」与「苔薄白」）按同一份病历复用。③ **严重过敏提示**：只有风团、荨麻疹而病历未见呼吸、循环或胃肠受累（或逐项否认了这些）时，`safetyGate.advisories` 不再出现「严重过敏或气道受累线索需立即复核气道、呼吸和循环」；喉头水肿、声音嘶哑等气道表现照旧提示。④ **治则**：虚证而治法以重镇、止血、止痛等治标法开头的（如心虚胆怯证「镇惊定志，养心安神」），`therapy.overallPrinciple` 写「标本兼治」。⑤ **兼证**：辨证依据自己写明某组表现「非独立病证」「不另立」的，`secondarySyndromes` 不再列该证，治法同步去掉只为它写的一项。⑥ **辨证依据**：依据里写到证名以外的虚性证素（如心虚胆怯证下写「心脾两虚、气血不足」）也按《中医诊断学》辨证要点核对，不够的那一句不交付、列入 `pathogenesis.uncertainties`。⑦ **方名与方义**：处方组成与方剂目录原方逐味相同时方名不带「加减」、方义开头写「本方用某方原方」；组成不同时方名一律带「加减」。⑧ **中成药**：`formula.patentAndWestern` 里的中成药，说明书「用于」部分要说到本例的主诉、中医病名、西医诊断或证候之一（只点名其他病的不列，如蛇串疮不列穿黄清热胶囊、月经先期不列乳癖康胶囊）；说明书写的是虚证（如固经丸「阴虚血热」）而本例为实热的不列；与本例证候相合的中成药排在前面。⑨ **复诊计划**：月经病（月经先期、后期、过多、过少、经期延长、崩漏、痛经等）的 `management.followupSafetyNet` 写按月经周期复诊（下次月经来潮时及经净后，连续观察3个周期），不再写「2周后复诊评估月经」；先就医评估那一句的待排除项不再套两层括号。⑩ **中医治疗**：教材有该病的推拿、针灸等方案时，主证这一节点按病名认适应证（此前要求节点标签对上）；教材某节只有治则与手法名、没有可执行操作的（如《推拿学》虚劳）仍不交付，这类病例的居家穴位保健见 `nonPharma.acupointCare`。⑪ 西医病名：中医脏腑概念不再写成西医器官病名（如腰痛、乏力、口干不写「慢性肾脏病待查」）；儿科专用病名（反复呼吸道感染）不用于成人。⑫ **活动性出血**（呕血、黑便、咯血、阴道流血、腹腔内出血、蛛网膜下腔出血、失血性休克等红旗）：辨证阶段治法先止血，不以活血化瘀为主法；开方阶段活血化瘀药（延胡索、川芎、五灵脂等）不入方，化瘀止血药（三七、蒲黄、花蕊石）可用；锁定的成方组成里有本例不宜的药时，去掉这些药、方名改写「本例辨证组方」并在方义说明（如胎盘早剥不再给少腹逐瘀汤）。⑬ 定稿去掉某味药后，`nonPharma.precautions` 里点名该药的条目一并去掉，煎服法按最终药味重写。生地黄超过药典上限时按上限给出（与其他常规药味相同），不再整页退为非剂量。耳穴项目在妊娠阳性或可疑时同样不出。兼证与主证寒热相反（风热犯肺证兼风寒表证）或已被主证包含（肾阴虚证兼虚热证）时不列。⑭ **过敏注意事项**：病历写明的过敏写「病历记录您对X过敏或不耐受」；病历未写过敏、只是本次进食后发病的，写「本次进食X后发病，可能对X过敏」，两种都同样要求避开（饮食、食疗、饮片、中成药）。⑮ 先就医评估那一句的待排除项自带括号时（「异常子宫出血（需排除子宫内膜病变…）」）按配对括号取，不再截成缺右括号的半句。⑯ **治法**：教材治法栏后面接着讲处置或分情况写的（异位妊娠·气血亏脱证「益气止血固脱。此证为腹腔内出血所致，首应及时手术止血治疗。术后再辅以……」），`therapy.overallMethod` 只取打头的治法（「益气止血固脱」）；教材写成二选一或分情况的，不套用教材原文、保留辨证所写。⑰ 定稿逐味剔除：与本例安全边界冲突的药（如活动性出血时的活血化瘀药）是并列君药之一时同样去掉、写入 `notApplicable`，另一味君药保留，处方照常给剂量；唯一的君药冲突时仍按原规则重选。⑱ 活动性出血时 `therapy.overallMethod` 里的止血一项排在最前（如「宁络止血，化瘀通络，宣肺平喘」），只调次序、不增删。 | **否**：字段路径、类型、取值集合均未改变。`supportingFacts` 由空数组变为一项文字；方名可能由「某方」变为「某方加减」；部分病例的中成药条目减少；荨麻疹病例的提示减少。 |
| V2.46 | 2026-10-26 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化。** ① **剂量一致化**：同类病历不再一会儿有剂量一会儿没有。红旗未解除时照常给带剂量的候选：`safetyGate.candidateMode=limited_dose`、`formalAdoption=blocked`（红旗解除前不可采纳），可见正文仍置顶安全警示，复诊计划第一句为「请在当天到医院急诊或专科就诊，先排除急危重情况…」，随访评估的安全总评写「红旗解除前不得采纳本方」。妊娠、哺乳、抗凝、肝肾功能不全等独立边界同样给剂量（`limited_dose`，`formalAdoption=eligible_after_doctor_confirmation`，原因仍在 `reasons`），复诊第一步按原因去产科、哺乳期用药评估、凝血复查或相应专科；药典孕妇禁用药、活动性出血时的活血化瘀药、与过敏原同源的药和方内十八反由开方核对按单味剔除（君药除外），须由医生单独定量的管制或濒危药材（羚羊角、麝香、生川乌等）在还有别的君药时同样单味拿出、请医生另行开具，剔除了什么写在该候选的 `notApplicable`；`formula.modifications` 里拟加的药按同一判据核对（冲突的不列），本例病历记有的人群对该药为慎用时在该条 `riskNote` 写明（如转氨酶升高加补骨脂）。只有剂量算不出时才给非剂量候选（原因码 `dose_authorization_withheld`）：只写「患儿」而判不出年龄段、病历年龄与登记年龄冲突；缺主诉仍是 `blocked`。红旗语义复核未完成时给剂量，`reasons` 写「本次红旗语义复核未完成，采纳前请医生当面核对有无急症表现」。② **红旗判定**：两周以内起病的写法（「2天前受凉后出现…」「半月前…出现」）不再整句按既往读；未满 18 岁胸痛、胸闷没有活动时胸痛、晕厥、先心病、家族猝死等心源性警示时不按急性冠脉事件报红旗（有发热走 24 小时心电图通道）；只有周围性面瘫（额纹消失或闭眼不全、无其他神经缺损）不报神经红旗，改为 48 小时内到神经内科或面瘫门诊；妊娠伴腹痛或阴道出血、同时血压≤90/≤50、心率≥120 或晕厥时报红旗（NICE NG126），循环稳定时 20 周前写 24 小时内到妇产科急诊或早孕门诊、20 周后写 24 小时内到产科急诊。③ 失眠以外的就诊原因不再要求睡眠呼吸暂停筛查（`missingItemCodes` 少一项 `osa_screening`）。 | 无字段增删、无枚举增删；`missingItemCodes`、`candidateMode`、`formalAdoption` 的取值集合不变。 |
| V2.45 | 2026-10-26 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化与兼容。** ① **发热伴胸闷、气促**：同时满足以下条件时，不再报「胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件」红旗，改为给剂量并在 `safetyGate.missingItems` 写「发热伴胸闷（或气促），暂无不稳定征象，宜24小时内到医院完成心电图、肌钙蛋白与血氧检查（需排除：病毒性心肌炎、肺炎）」（`missingItemCodes` 为既有的 `priority_evaluation_required`），复诊首句为 24 小时内：有发热；有胸闷并伴气促或呼吸困难、无胸痛；胸闷不是突发、加重或持续发作；没有大汗、冷汗、放射痛、晕厥、压榨感、濒死感；病历没有写明冠心病、心衰等已知心脏病；没有意识改变；心率、呼吸、血压、血氧至少记录两项且按 NEWS2 无单项 3 分、总分 <5。任一条不满足，红旗照旧。② **键名大小写**：`caseState` 顶层、`patient`、`hisRecord` 与 `hisRecord.fields`、`conversation` 各项的键写成首字母大写（如 .NET 默认输出的 `Role`/`Content`、`ChiefComplaint`）时照样读取；同时给了文档写法与大写写法时以文档写法为准。请仍按文档使用小写开头的键名。③ **生命体征**：`caseState.vitals` 各项应为字符串或数字。传来对象（如 .NET 的 `{"ValueKind":3}`，数值并未随请求传来）时，服务端用同一 `caseState.id` 在 30 分钟内最近一次请求里的数值补上；补不上时 `safetyGate.advisories` 写「本次请求的生命体征（…）未能读取，红旗检查未使用这些数值，请核对生命体征后再提交」。④ 服务端加密留存临床接口的响应（与请求留存同一做法），不影响接口行为。 | 无字段增删、无枚举增删。 |
| V2.44 | 2026-10-26 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化。** ① **复诊时限分档**：给了剂量但需先完成临床评估时，`management.followupSafetyNet`、随访首次复诊与 `formula.candidates[].decoction.followUpNode` 的时限不再一律「3天内」，而是按评估项目写「24小时内 / 48小时内 / 3天内 / 2周内」：乳房肿块仍为 2 周内乳腺专科（NICE NG12）；血糖 ≥11.1 mmol/L（或已知糖尿病）且尿酮 ≥2+ 或血酮 ≥3.0 mmol/L 为 24 小时内到医院急诊查血气与血酮（ADA 2024 高血糖危象共识）；其余由语义复核按病情给出，拿不准时取更早的一档。② **指南红旗判别项**：`safetyGate.redFlags` 新增依据 NICE NG143（5 岁以下发热红绿灯表）、NICE NG253/NG254/NG255（疑似脓毒症）与曼彻斯特分诊通用判别项的红旗，如「按压不褪色的皮疹（瘀点/瘀斑/紫癜）（NICE NG143 五岁以下发热红绿灯表红色征象），需立即急诊评估。原文依据：“…”」「不足 3 月龄体温 ≥38℃…」，语义复核超时时这类红旗照样给出；疑似脓毒症的高危生命体征（如成人发热伴呼吸 ≥25 次/分）不报红旗，写入 `missingItems`「疑似感染伴脓毒症高危指标…宜当天评估」（`missingItemCodes` 为既有的 `priority_evaluation_required`，复诊时限 24 小时内）；5 岁以下发热患儿的琥珀色征象写入 `advisories`；读病历的复核未能完成时，`advisories` 列出该年龄段的红色征象供当面核对。③ **本系统辨病为急危重病**：辨证结果的西医主诊断是确定的急危重病名（如脓毒症、感染性休克、急性心肌梗死、主动脉夹层、糖尿病酮症酸中毒、异位妊娠；带「待查」「可能」的不算）而安全闸门没有红旗时，开方、随访阶段补一条红旗，不给剂量。④ **两种读法不一致**：规则读出的红旗，语义复核对同一处原文读为否认、未问及或非本人时，红旗与剂量处置不变，红旗文字末尾注明「两种读法不一致，请先核实…核实确无可由医生解除此项」。⑤ **过敏**：病历记录食物等过敏或不耐受（按 GB 7718-2025 八类致敏物质及芝麻、蜂产品、软体动物、海鲜、芒果、漆、荞麦归类）时：`nonPharma.precautions` 必有一条请避开该类食物及其制品；`nonPharma.diet` 与食疗卡不推荐含过敏原的食物（鸡蛋过敏时不再出现蒸蛋）；名称或成份含该过敏原的中成药、西药不推荐；与过敏原同源的饮片（如鸡子黄、蜜炙饮片、淡豆豉）不进处方与随证加减。⑥ **病历引文**：辨证依据、病机链里的病历引文可能是带字段标签的原文（如「脉象：弦」）。此前模型写「脉弦」时会被判为找不到原文、整个病机节点被删，个别病例因此退为有限的辨证结果。 | 无字段增删、无枚举增删。`clinicalFacts`（文档只列为对象，集成方原样回传）内部增加判别项读取结果与评估时限。 |
| V2.43 | 2026-10-25 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化。** ① **未询问、待核实的记载**：病历写「是否黑便尚未询问」「有无发热不详」「未询问有无呕血」「黑便情况未问」时，这一项按病历没记录处理——不报相关红旗与优先评估，模型写的「无黑便」交付为「未诉黑便」（此前读成病历记录了黑便，交付成「有黑便」）；「腹痛性质不详」「发热，体温不详」只是属性不详，表现本身照算记录了；同一句别处的「（具体不详）」不再让同句其他表现都算没记录。问答体记录按问句与答句读（「问：有没有呕吐？答：没有」为否认，「问：咳嗽厉害吗？答：厉害」为有）。② **与病历相反的否认**：辨证依据、鉴别、不支持证据等文字里，病历写着有、模型写成「无X」的，改为直接删去这一项（连同只回指它的「与之不符」一类尾句），不再改写成「有X」（V2.42 ② 的「只写有X」作废）；单值字段删去后为空的仍按旧写法。辨病依据里以鉴别病名为主语的否认（「产后腹痛无发热」）说的是那个病，不改。「未明显发热」按否认读。③ **先评估再服药的复诊安排**：给了剂量又需先完成专科评估时，`management.followupSafetyNet` 第一句写「请在3天内到相关专科就诊，先完成评估（需排除…）；医生确认可以服药后，服完N剂药（约N天后）再复诊」，`candidate.decoction.followUpNode` 写「先在3天内到相关专科完成评估；医生确认可以服药后，完成N剂（N日）后复诊…」，M05 首次复诊同一句（此前复诊计划说「3天内评估」、煎服节点说「服完7剂后复诊」）。乳房肿块为 2 周内乳腺专科。④ **安全门**：晕厥或黑矇，同时心电图/动态心电图记录到清醒时窦性停搏（长间歇）≥3 秒、二度 II 型/三度/高度房室传导阻滞或室速，报红旗「晕厥伴心电记录的高危心律失常（…），需立即心内科急诊评估（心电监护，必要时临时起搏）」（依据 2018 ESC 晕厥指南）；睡眠中的长间歇、已植入起搏器的不在此列。「经常腹泻」「时有胸痛」「无法入睡，头痛」这类写法里的表现照算有（此前被前面的否认词或「无法」带走）。⑤ **病历引文**：主证依据与病机节点的病历引文，开头若是病历原处否认列举里的项（「无腹痛，发热，呕吐，于乡卫生院…」被切成「发热，呕吐，于乡卫生院…」），去掉这几项后交付，剩下的仍逐字是病历原话。 | 否。字段与取值集合不变。 |
| V2.42 | 2026-10-25 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化。** ① **中医病名须解释本次就诊原因**：病名要能解释主诉写在最前的主要不适或主诉点名的病；只对应伴随症状、自幼或多年的宿疾、已基本痊愈或偶然发现的问题的病，不作本次病名（其表现在辨证依据与加减里兼顾）。辨证阶段写成这类病名时，服务端核对后按就诊原因把中医部分重写一次（如「感冒后发热2周（伴自幼遗尿）」不再写成遗尿，「2型糖尿病3年，就诊取降糖药」不再写成一处已愈的皮肤破损）。② **病历原话与前后记载**：辨证依据、鉴别等文字里逐字照录病历原文的部分不再被改写；病历对同一表现先后有肯定、否定两种记载时只写「有X」，不再同句出现「有X；否认X」；「无A，B，C」这类读不出 B、C 是否在否认范围里的记载，写「X的有无病历记载不明确，需核实」（语义事实层判为阳性的写「有X」）。③ **安全门**：开头一句无关否认之后带肯定证据的表现不再被那句否认带走（「无咳嗽，胸痛，伴大汗」「无头痛，言语不清，右侧肢体无力」「无恶心，黑便3次」照常报红旗）；「否认胸痛，胸闷，气促」这类逐项否认照旧。④ **证据**：开方阶段本例命中的院内用药规则（如中成药与抗凝药、他汀与肝功能）在证据裁剪时不再先被裁掉；辨证阶段的指南/文献检索与开方阶段同一选取规则，首个检索词的结果全与本例无关时改用下一个检索词。 | 否。字段与取值集合不变。 |
| V2.41 | 2026-10-24 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化（联网收集的 144 份基层门诊病历与流派矩阵测试后）。** ① **诊疗思路（流派）**：选了具体流派时，模型按该派选的方在主治证候与本例证候相容时保留（治法随方），辨证依据末尾按该派眼目说一句，`lineageAdaptation` 的 `influencedDecisions` 说到的方与交付方一致；见 §3.3.2。不限定流派时输出不变。② **中成药/西药行**：`riskNote`、`usageBoundary`、`relationship` 等按说明书逐字填写的字段原样交付（此前「感冒发热病人不宜服用」会被改成「未诉发热」）；说明书写明用于实热/实证的中成药不再推荐给纯虚证；注意事项说「不宜再服滋补类中成药」时不再同页推荐补益类中成药。③ **方名**：三味及以下的小方须全部药味在方中才沿用方名（左金丸缺吴茱萸时按自拟方交付）。④ **安全门**：「抽搐的痛」这类疼痛性质写法、同一份病历实测血氧 ≥94% 的轻度口唇发绀、14 岁以下儿童反复数月的胸闷气促（无急性线索）不再报红旗；「哺乳期过后/已过/结束」「断奶后」「停止哺乳」按未在哺乳处理。⑤ **西医病名核对**：急性胰腺炎、急性胆囊炎、急性心肌梗死、急性肺栓塞、蛛网膜下腔出血进入诊断标准要点表，未做确诊所需检查时按「待查」核对。⑥ **教材补充行**：成人尿失禁按「小便不禁」辨证（肾气不固、脾肺气虚），不再落到「阴挺」。⑦ **其他**：同一句后面写了「停药」的药不再写成「正在服用」；病历写了指脉氧读数时不再说「未记录血氧」；「既往体检无…」「平素无…」按否认读；「脾气不升证」治则为「虚则补之」；病历写「难以入眠」时不写「未诉入睡困难」。 | 否。字段与取值集合不变。 |
| V2.40 | 2026-10-24 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化（V2.39 测试集复评后的第二批）。** ① **孕哺备孕缺项**：妊娠已明确（阳性、可疑或否认）时，`safetyGate.missingItemCodes` 不再列 `lactation_unknown` / `conception_unknown`；否认妊娠而病历写到近一年内分娩的，仍列 `lactation_unknown`。妊娠状态未记录时三项照旧。② **妊娠状态未记录的 15–49 岁女性**：照常给剂量；《中国药典》2020 年版标「孕妇禁用 / 忌用」的饮片（如三棱、莪术、水蛭、牵牛子、甘遂）不进处方（与备孕档同一做法），标「孕妇慎用」的照用，注意事项仍有「如已怀孕、可能怀孕或正在哺乳，请服药前告知医生」。病历写明绝经、子宫切除，或妊娠已否认的不在此列。③ **已停用的药**：用药史只写着已停用的药（「普萘洛尔曾短期服用，目前停用」）时，不再列 `medication_details`。④ **乳房肿块**：30 岁及以上女性（男性 50 岁及以上）有乳房肿块、病历里没有乳腺影像或病理结果时，`missingItemCodes` 含 `priority_evaluation_required`（需排除乳腺癌，依据 NICE NG12），剂量照给；复诊句为「请在 2 周内到乳腺专科就诊，先完成乳腺超声检查」；针刺卡不取乳房周围的穴，在局部施术的其他外治卡不出。乳痈、乳腺炎、哺乳期结块与已确诊、术后的不在此列。⑤ **饮片味数**：主方味数落在医生所选区间（`herbCountPreference`）；兼症不够时按已定治法加同一方向的常用臣佐药补足，不再以「本例无更多需兼顾的表现」为由少于下限（V2.39 ④ 的说明作废）；经方原方不删、不加与治法无关的药的口径不变。⑥ **教材病证表新增两病**：耳鸣耳聋（风热侵袭、肝火上扰、痰火郁结、气滞血瘀、肾精亏损、气血亏虚）、虚脱（休克：毒热内陷、气脱、亡阴、亡阳）。⑦ **脱证为先**：辨证出现脱证（亡阳、亡阴、气脱、阳气虚脱…）而它落在兼证栏时，提为主证、治法以固脱救逆为先；原病名在教材里没有这一证时，`overview.tcmDiseaseName` 改为「虚脱」，原病名写在辨病依据里作为起因。⑧ **治则**：只表达病位与气机失常的中性证名（胃气不和证、肺气失宣证、心神不宁证）的 `therapy.overallPrinciple` 为「调理阴阳」，不再推成「实则泻之」。⑨ **西医**：红旗病例中缺确诊检查的急危重病名同样写「X待查」（如未做任何血检的「婴儿败血症待查」）。⑩ **辨病依据**：病历记有两方说法不同（「家属与本人对症状持续时间描述不同」）时，`overview.tcmDiseaseRationale` 点明这一句并在 `pathogenesis.uncertainties` 加一项；肛裂、痔等肛肠局部病名在病历写明尚未做肛门检查时，依据末尾写明这是据病史的初步判断。⑪ **注意事项**：模型已按药名写到药物过敏时不再重复补一句。⑫ **结直肠随访提示**只在「便秘」与「近期出现 / 加重」写在同一句时给出。⑬ 兼证与证素核对所用《中医诊断学》辨证要点补全了「面、睑、唇、舌色淡白」「口、鼻、唇、舌、皮肤干燥」这类并列写法与「咳、喘」单字症状。⑭ **用药缺项措辞**：用药史写了药名、只缺剂量频次时，`missingItems` 写「已提及当前用药但缺少剂量/频次」（此前一律写「缺少药名/剂量/频次」）。⑮ **体重下降伴咯血、痰中带血**：红旗照报，`safetyGate.redFlags` 写「咯血伴体重下降，需优先完成胸部CT与痰检以排除肺癌或肺结核，再评估处方」，不再写「上消化道警示征象（不明原因体重下降）…内镜」。⑯ **出处**：方名是方剂目录里的成方（组成标志药都在）而 `formulaSource.source` 为「自拟方」时，改为该方的目录出处。 | 无字段增删、无枚举增删。 |
| V2.39 | 2026-10-24 | **接口路径、字段名、结构、枚举与调用顺序都不变，集成方不需要改代码；以下是写进现有字段的行为变化（甲方 10/23 的 100 例测试集与页面反馈）。** ① **妊娠状态未知不再按可疑处理**：病历写「妊娠可能性尚待核实 / 尚未排除 / 不详」「妊娠状态未知」时按未知处理——照常给剂量，`safetyGate.missingItemCodes` 含 `pregnancy_unknown`，不再出现「已记录妊娠、哺乳或备孕阳性/可疑状态」、产科急症提示与「3 天内到产科」的复诊句；「不能排除妊娠」及停经、验孕阳性等有依据的写法仍按可疑。「妊娠状态明确否认」「怀孕已排除」按否认，不再追问，注意事项与逐味人群提示不写孕期内容。当前妊娠的其他写法（妊娠 N 天、胎漏、胎动不安、先兆流产、妊娠腹痛 / 恶阻、单胎 / 宫内妊娠）按妊娠处理（不给剂量）；出生史「孕 32 周出生」、比喻「如孕 5 月」不算。② **产科急症提示**（`safetyGate.advisories`）只在妊娠阳性 / 可疑，或育龄女性停经伴阴道出血、腹痛时给出。③ **红旗**：只有数值、没有任何消化道症状的体重下降（如糖尿病多饮多尿伴体重下降）不再报「上消化道警示征象」；「无尿痛 / 无尿频」不再触发循环灌注提示。④ **饮片味数**：开方阶段按锁定方的基础味数与组成下限把主方味数落在所选区间（`herbCountPreference`）；做不到时 `formulaAnalysis` 末尾说明原因；经方原方不删、不为凑数加药的口径不变。⑤ **诊疗思路**：选了具体流派且本例相符时，辨证阶段可选该流派的方（如经方思路选《伤寒论》《金匮要略》方），治法随方，并在流派适配说明（`influencedDecisions`）里写明；不相符时照旧用教材该证代表方。⑥ **原方含十八反的方**（如洗心汤的附子与半夏）：处方去掉其中一味，按辨证组方命名，方义写明去了哪味。⑦ **西医**：「慢性X」病程未满诊断标准门槛时写「急性X」或「X」；「新生儿X」用于出生超过 28 天的患儿时写「婴儿X / 小儿X」；红旗病例中缺确诊检查的非急危重病名写「X待查」。⑧ **复诊计划**：给了剂量但安全闸门要求「正式采纳前需优先完成临床评估」的病例，`management.followupSafetyNet` 与随访方案的首次复诊先写「请在 3 天内到相关专科就诊，先完成评估（需排除X）」。⑨ **注意事项**：病历记录药物过敏（如「阿莫西林后曾出现全身荨麻疹」）时写一条请勿再用该药及同类药物；病历写明外用的药按外用写，不说「服用」；`nonPharma.precautions` 超过 6 条时保留前 6 条（此前会整列变为空数组）。⑩ **随证加减**：`formula.modifications[]` 不再加入与方中药味构成十九畏的药（十八反照旧不加）。⑪ **依据措辞**：病历测得体温 ≥37.3℃ 时，辨病、辨证依据不再写「未诉发热」。 | 无字段增删、无枚举增删。 |
| V2.38 | 2026-10-22 | **接口路径、字段名、结构与调用顺序都不变，集成方不需要改代码；以下是 10/14 以来写进现有字段的变化。** ① **证据标签按来源写（§3.12）**：`pathogenesis.chain[].evidence`、`therapy.subTherapies[].evidence`、`formula.candidates[].herbs[].evidence` 此前是同一个常量（病例内推理/中），现在对上教材证型、成方组成的写「标准资料」并给出处；教材加减此前多被标成「证据不足」且出处为空，现在为「标准资料」+ 教材加减原文。② **主证名之外的虚性证素要过《中医诊断学》辨证要点**：病历里没有成组表现的（如心虚胆怯证另写「心血不足→养血安神」）不再进入病机链、分治法、总治法与方药，改写在 `pathogenesis.uncertainties`。③ **西医**：缺确诊检查或病程时病名写到上一级或「X待查」，推理说明随之写「考虑X可能」；主诊断按病历特异记录在西医半自己列出的候选里重选时，推理说明写明理由。④ **中医鉴别**：病名鉴别、证候鉴别各至少两项。⑤ **兼证**：须有《中医诊断学》辨证要点成组支撑，不够数的不立。⑥ **治则**：按证名里的证素推：有虚的证素为「虚则补之」，有邪的为「实则泻之」，两者都有为「扶正祛邪」。⑦ **不给剂量的病例**：`management.followupSafetyNet` 写明复诊时间（红旗当天；妊娠、哺乳、需专科评估、抗凝治疗 3 天内，抗凝另写开始服药 1 周内复查凝血；年龄不明的患儿当天）。⑧ **孕哺提示**：注意事项、逐味人群提示与随访信号里的孕哺内容从 15 岁起写（月经类仍 12 岁起，安全闸门的孕哺筛查 10–59 岁不变）。⑨ **煎服法**：要捣碎的药在 `decoction.method` 里点名（「酸枣仁用前捣碎」）。⑩ **M02 同一病例只计算一次**（§3.9），与 M03/M04 相同。⑪ **措辞**：病位、病性、证候把握度说明不再出现「可逐字回溯」「按有界建议展示」这类校验用语；服务端两条「质量边界」不确定项不再下发。 | 无字段增删、无枚举增删；证据标签、西医推理说明、不确定项的内容变化见左栏。 |
| V2.37 | 2026-10-14 | **接口路径、字段名、结构与调用顺序都不变，集成方不需要改代码。** ① 病历只记录了主症（如只有「胃痛3天」）、没有能分开证型的表现时，`overview.primarySyndrome` 写只表达病位与气机失常的证名（如胃气不和证），治法、推荐方随之为调理气机的平和方向，不再默认套用教材该病的第一条证型；病历有能分证型的表现时行为不变。② `formula.candidates[].compositionLogic[].summary` 改为「组成：…。出处：…。」（HIS 方案 `formulaRationale.compositionLogic` 同源）。 |
| V2.36 | 2026-10-14 | **接口路径、字段名、结构与调用顺序都不变，集成方不需要改代码；有三处行为变化请知悉。** ① **追问会返回 `decision=proceed`**：病历已足够、没有值得问的题时，以及安全闸门已判急危重时，`m02Plan.decision` 为 `proceed`、`questions` 为空数组（取值一直在接口里，此前服务端缺省从不返回；收到时直接调用辨证接口）。② **备孕 / 未避孕不再收回剂量**：病历记录备孕或未避孕、且没有妊娠或哺乳（含停经、月经逾期）记录时照常给剂量；《中国药典》2020 年版孕妇禁用 / 忌用的饮片不进方，孕妇慎用的饮片在该味 `verificationReasons` 里写明药典原文与「使用前请确认未妊娠」；加减里拟加孕妇禁用饮片的行不列，`modificationReview.droppedReasons[].code` 记 `special_population_conflict`。妊娠、可能妊娠、哺乳期照旧不给剂量，`doseWithheldReasons` 文案不变。③ **低体温合并意识改变判红旗**：体温 35.0～35.5℃ 且病历记录嗜睡、反应迟钝、意识模糊等当前表现时，红旗、不给剂量（此前只有 <35℃）。另有内容层面的修正，字段不变：`formula.modifications[].riskNote` 见该字段说明；煎服用法里大黄等「几选一」煎法的药按药味表标注写（不再与药味表矛盾）；中医治疗项目的疗程与操作说明不再出现流程用语，补泻手法与证候相符；鉴别诊断的典型表现栏写鉴别对象自身的表现；参考西医诊断名与病历已记录的检查结果直接矛盾时改为够得上的较宽或较轻一层名称。 |
| V2.35 | 2026-10-13 | **按 10.12 医学测评整改：接口路径、字段名、结构与调用顺序都不变，集成方不需要改任何东西；变化只有「某些字段不再带内容」和「内容写得更准」。** ① **追问作答 / 跳过后不再读不到病历**：整份病历放在 `symptoms`（含「现病史 / 既往史 / 过敏史 / 用药史 / 辅助检查」等中文键）、追问问答放在 `conversation` 的传参方式下，此前只要有一条回答或一次跳过，安全闸门就只看对话、不看病历正文——现病史写明的呕血黑便不报红旗，孕周与抗凝药照常给剂量，性别 / 舌脉 / 过敏史被判成未提供。现在追问的回答是对病历的补充；跳过句（`本次未能确认，请继续现场评估`）不是病历内容，不进入任何判断；对急症筛查题选了阳性选项即按已确认的急症表现处理；`symptoms` 的中文键与规范键等价；生命体征只认字符串与数值（`{"ValueKind":3}` 这类序列化残留按未提供）。② **西医诊断**：`supportingFacts` / `limitations` / `suggestedChecks` 恒为空数组；`name` 写最可能的规范病名，不带括号说明，不带「，病因待查」（只能停在症状层面时写「症状名＋待查」）。③ **中医诊断与证候**：病名、证名用规划教材的写法（「头痛」不写「头风病」，「虚劳」不写「虚劳类病」）；`secondarySyndromes` 默认空数组，只有另成一组的表现才写一个；`tcmDiseaseDifferentials` 每例 1–2 条。④ **治则治法**：`overallPrinciple` 只写国家标准治则术语，不带括号；`overallMethod` 一行，证型对上教材时用教材治法。⑤ **方药**：辨证阶段定的方名（教材该证的代表方优先）开方阶段不再改名，不再出现「本例辨证组方」（确无成方写「自拟方」）；`decoction.method` 写成一行用法并点名先煎 / 后下 / 包煎 / 另煎的药味；`modifications[]` 优先取教材该证的加减（`trigger` 可以是「若…」的条件句，此时没有 `triggerSource`；教材该证没有列加减时可以是按本证常见兼症写的条件句），「加」的行带剂量，`evidence.source` 写教材出处或「患者原文：…」；`applicable`、`modifications[].riskNote`、`patentAndWestern[].usageBoundary` / `relationship` 为空串。⑥ **中医治疗与调护**：给不出具体内容的项目不再下发；食疗只在教材食疗分型与本例证型对得上时给一个方子；`precautions` 写给患者，不含天数、体温等数字阈值。⑦ **复诊计划**（`management.followupSafetyNet`）写给患者。⑧ **追问一轮一题**，优先问能把教材候选证型分开的那条事实；急症筛查题只为事实层判为 urgent 的线索而出。没有值得问的题时是否返回 `decision=proceed` 由服务端开关控制，缺省仍返回一题。⑨ **红旗**：语义层只为病历明确写出的现症提示与限制给药（「可能」「仅不能排除」的不再提示）；确定性红旗与危急生命体征不变。⑩ **同一份病历结果一致**：结果按病历内容留存（缺省 30 天，换病例编号、只差标点空格都算同一份），请求头 `x-cdss-regenerate: 1` 显式重新生成；出题的同时服务端已按「不回答」开始计算，跳过追问后的辨证、开方直接取现成结果。 |
| V2.34 | 2026-10-13 | **全面回归后的修正，接口路径与字段名不变。** ① **独立剂量边界不再受病历完整度与追问轮次影响**：已记录妊娠阳性/可疑、哺乳、抗凝或抗血小板治疗、只写「患儿」而无年龄时，无论病历是否完整、是否答过追问，M04 一律只给非剂量页（此前「病历不完整且未答追问」的请求会先按有限信息给出带剂量方）。② 红旗筛查：「反复上腹痛1年，无呕血黑便」这类「反复/多次/大量…＋被否认的出血词」不再判为活动性消化道出血。③ 西医候选诊断（西医诊断下的 `candidates`）恢复为 2–3 条（首项即主诊断，其后为最需区分的备选）；V2.33 后多数病例只剩 1 条。④ 流派适配的 `applicable` 改由模型按本例判断（`applicable`/`partial`/`not-applicable`），不再对任何已选流派恒为 `applicable`；HIS `tcmLineageAdaptation.applicability` 随之如实显示「适用/部分适用/不适用」。⑤ HIS `aiMedicalRecord.vitals`：调用方传对象时由 JSON 串改为可读文字（`T 37.5℃；P 80次/分；BP 110/78mmHg`），未填时不出该栏。⑥ `caseState.diagnosis` / `prescription` / `riskAssessment` 单字段上限由 30000 提到 120000 字符：原样回传的 M04 正文（含结构化段约 3.5–4.5 万字符）此前会被裁掉，并使 his-scheme 报「候选方案生成被截断，不允许写回采纳」。⑦ `candidates[].notApplicable` 末尾的逐味提示改为可读文字（见字段表）。⑧ 送模型前的姓名脱敏不再误抹「患者全身发热」「经色暗有血块」「劳力性胸痛」等临床用语；「病人＋姓名」的三个姓氏漏脱敏已补。⑨ 六味地黄丸、补中益气汤、丹栀逍遥散、龙胆泻肝汤的目录主治改为教材原文，可按患者表现进入候选。 | **否。** 字段名、类型与路径均不变。按①，此前在「不完整病历＋未答追问」下能拿到剂量方的妊娠/哺乳/抗凝/年龄不明患儿请求，现在得到非剂量页（`CDSS_NON_DOSE_CANDIDATE_JSON`，带 `doseWithheldReasons`）；按⑤，若集成方曾对 `aiMedicalRecord.vitals` 做 `JSON.parse`，需改为按文字显示 |
| V2.33 | 2026-10-12 | **生成提速：模型只写需要临床判断的内容，字段不变。** 实测耗时几乎全在模型逐字写出，因此把服务端本来就会覆盖、推出或不展示的内容从模型输出中拿掉，并给可见文字加了字数上限。**① M03：**分治法 `therapy.subTherapies` 由病机链逐节点生成（首节点为「主要」，其余「次要」）；`overview.overallTherapy` 与 `therapy.overallMethod` 一致；病机节点不再带 `pathogenesisType`，`pathogenesis.caseRelationship` 不再生成（本证与主要表现的关系见 `overallPathogenesis`）；病名鉴别与证候鉴别各 1–3 项、西医鉴别至多 8 项（先列必须排除的严重方向），各项文字更短；未选择流派时 `lineageAdaptation` 为 `null`。**② M04：**中成药/西药行的药名、规格、用法、`usageBoundary`、`relationship`、`riskNote` 由服务端按 `evidenceId` 从同一说明书条目填写；候选方 `applicable` / `notApplicable` 由服务端生成；逐味 `function` 为短语，方义解析约 120–150 字，注意事项至多 5 条（优先未核实的妊娠/哺乳状态、与现用药的重叠、需要立即就医的表现），饮食、起居、运动、情志各一两句。**③** M04 的随证加减现在能读到 M03 的西医支持事实。**④ 实测（本机 15 例，同一环境前后对照）：**模型写出量约减半，M03 中医部分模型耗时中位数 15.1 秒 → 6.9 秒，M04 13.9 秒 → 6.3 秒。 |
| V2.32 | 2026-10-12 | **流派与经方目录核对。** **① 五张学派卡逐字段按原典与教材核对重写：**扶阳卡代表方改为郑钦安自制的潜阳丹、补坎益离丹及其常用的四逆汤、白通汤、附子理中汤、封髓丹（原先四首全是仲景/宋代方）；丹溪卡去掉知柏地黄丸、滋阴降火汤等非丹溪方与「二陈汤合越鞠丸」合方写法；温补卡补入李中梓及薛己、赵献可、孙一奎的常用方；经方卡补阳明、少阴代表方；温病卡把注意事项拆成可逐条核对的四条。卡片的审核信息如实写明「无执业医师签字」。**② 流派对候选方的排序：**新增「标志性运用」归属，一首方可同时属于多个流派（如四逆汤既属经方、也属扶阳）；此前扶阳学派可参与排序的方剂为 0 首，选了不起作用。仍只在同一证据层内调整展示顺序，不参与准入、方名锁定、剂量与审方。**③ 方剂目录：**72 首方的出处由转引它的后世书回归原书（白通汤《医方考》→《伤寒论》、通脉四逆汤《古今名医方论》→《伤寒论》、理阴煎《成方切用》→《景岳全书》、封髓丹→《御药院方》等），其中 6 首组成残缺按原文补足（桂枝二麻黄一汤原只记两味等）；补收《伤寒论》《金匮要略》此前缺失的内服方 50 首（桂枝加龙骨牡蛎汤、薯蓣丸、四逆加人参汤等；外用方、历史方与含十八反药对的赤丸不收）与郑钦安、孙一奎自制方 5 首。 | 无字段增删；HIS 与正文中上述方剂的「出处」取值变化；`lineageAdaptation` 结构不变。 |
| V2.31 | 2026-10-12 | **签名只标注、不拦截；阶段复用换绑；急症排查确认报错可操作。** **① 签名不再拦截：**M03/M04 回传内容与本系统签发版本不一致时，`prescribe` / `assess` / `post-prescription-risk` / `his-scheme` / `terminology/confirm` 照常返回结果，附 `contract_provenance_*` 来源提示；安全核对对实际回传内容重跑。医生编辑版携带编辑前签名时剥除后照常审方（原 `422 stale_workbench_contract_metadata`）；形态不规范的编辑版照常审方但不签发写回凭据（原 `422 invalid_workbench_edit_shape`）；未签名的处方文本不纳入核对、按诊断生成结果（原 `422 missing_structured_prescription`）。只有完全未携带 M03 时仍返回 `409`。**② 阶段复用换绑：**同一病历换病例编号重推时，复用的 M03/M04 按本次编号重新签名（此前回放旧编号签名，导致后续 M05 `409 invalid_m04_signature`，9/30、10/9 线上 4 次）。**③ 急症排查确认：**无红旗时 `200 notRequired`（原 `409`）；`400` 附 `activeFindings` / `allowedDispositions` / `problems`，逐条指明问题；`disposition` 接受中文名；客观依据判据不变 | **否（只减少报错）**：原先会收到的 `409/422` 改为 `200` + 提示；按 §3.5 忽略未知字段的解析器无需修改。若贵方以 `409 invalid_m04_signature` 触发「重新生成」，可改为读取 `warnings[].code` 中的 `contract_provenance_*` |
| V2.30 | 2026-09-30 | **儿童剂量改按教材年龄分数法 + 方剂/药味知识库缺口补齐（联网原文核对）。** **① 儿童剂量（§4.5「儿童患者」）：**未满 18 岁不再一律收回剂量，按新生儿 1/6、乳婴儿 1/3、幼儿 1/2、学龄前 1/2、学龄期 2/3、12 岁以上接近成人量折算（每味药上限＝药典成人上限×分数，无下限；控量药≤2/3；禁用/慎用药味清单）；药液量按年龄档；页面新增「儿童用药说明」；年龄段判不出（只写「患儿」）仍收回剂量，新增缺项码 `pediatric_age_unknown`。**② 儿童生命体征、年龄与喂养：**未满 12 岁的呼吸/心率/血压判定线改按年龄段（此前 12 天新生儿呼吸 40 次/分被判红旗而收回剂量）；`patient.age` 的数值年龄与 HIS 年龄栏「8个月」「12天」按数值比较，不再误报「年龄记录冲突」；婴幼儿病历的「母乳喂养」不再触发哺乳独立硬边界；儿童折算说明不再混进「正式采纳前需确认」清单。**③ 药味身份错链整改：**旧身份目录把 A 药归成 B 药的同名异物按「唯一来源」自动落药，已整类清理——茵陈蒿汤的「茵陈蒿」不再变成青蒿（茵陈五苓散同），大附子不再归狼毒，汉防己不再归北豆根，葵子归冬葵子（不再归天葵子），寒水石/刘寄奴/透骨草/海桐皮/紫荆皮/凤仙花/大豆各自独立（不再借用石膏、金龙胆草、急性子、刺五加、南五味子、黑豆的剂量口径）；沙参（南/北）、大茴香、南木香、胡麻子不再自动落一种，须按方义选定；关木通、广防己（国家 2004 年取消药用标准）、雷公藤、雪上一枝蒿、鬼臼、莽草、虾蟆、蜘蛛不再被归成别的药，改为不可自动落药（此前等于让禁用/剧毒药以别的药名过审）。**④ 方剂知识库：**章节标题冒充方名的 16 首移除、41 条章节合抄条目取消方名与剂量资格（不再命名处方、不编译剂量、不作为证据进入 M03/M04）；出处书名规范化约 116 条、按原文订正出处/组成约 40 条（例：麦味地黄丸〔8 味，《医级》〕与《疡科心得集》补遗的同名 12 味异方分立）；药名夹带剂量/用法文字的解析残片清零（组成含残片的方 50→14）；药名待选定的同名异物 113→70；药味身份补充 38 条、药味功用词典 +80 味；居家穴位保健的取穴定位措辞与禁忌按 2021 年规范原文修订。原文确实查不到的方剂（如化风丹、八珍益母汤等）保留，并在目录备注里如实说明原文未能核到，不编造。 | 无字段增删；`decoction.targetVolumeMl` 儿童取值随年龄档变化（此前恒为 200）；`missingItemCodes` 新增取值 `pediatric_age_unknown`；儿童、婴幼儿病例现在会拿到折算后的剂量（此前非剂量页）。 |
| V2.29 | 2026-09-29 | **9.24/9.27 测评整改（续）。** **① 非剂量页的结构化副本（§4.5）：**红旗未解除、儿童、妊娠/哺乳阳性时，M04 只给非剂量页（原因码 `dose_authorization_withheld`），此前页面文字里有药味，但没有 HIS 认的结构化区块，HIS 只显示「暂未生成」；现在同一页多一条 `CDSS_NON_DOSE_CANDIDATE_JSON` 注释，带药味、君臣佐使、功用、方义和收回剂量的原因（不含剂量、不可写回、不影响原有解析）。「饮片暂未生成」与院内库存无关，库存从不决定是否出方。**② 药味功用不再出「需医生结合方义复核」：**功用来源新增联网/教材逐条核对的药味功用词典（药典 2020 与十三五《中药学》原句，逐条带引文，约 300 味），对不上本方治法时取该药入方的通常作用；词典同时剔除了已核对为无依据的条目（炙甘草名下的「清热解毒」「祛痰止咳」属生甘草等）；修复用尽后保留模型写的合理方义，不再整句作废。**③ 方剂出处与组成：**按联网原文核对订正 48 条（28 首改出处、27 首改组成，有重叠；另有清燥救肺汤胡麻仁按教材归一为黑芝麻，不再误归亚麻子）（六君子汤出《医学正传》，柴胡加龙骨牡蛎汤出《伤寒论》且补桂枝、牡蛎、黄芩，右归饮恢复为原方八味〔此前是左归饮六味〕，防风通圣散补大黄、芒硝、去党参、黄芪；三妙丸/四妙丸/独活寄生汤的牛膝与川牛膝按原文区分；射干麻黄汤「一法」、牵正散「并生用」不再当药味等），温经汤（《金匮要略》十二味）、温脾汤（卷十三）、润肠丸（《脾胃论》）、橘皮竹茹汤（《济生方》）、金沸草散（《博济方》）、钩藤饮（《医宗金鉴》）另立同名异方条目 6 条；国家《古代经典名方目录》来源条目的出处栏不改。**④ 不再有「待终审」：**教材非药物方案的配穴、居家穴位保健、流派取向映射，原先因无中医师签字而被搁置，改为联网权威来源逐条核对（不通过的记 `evidence_rejected`，不生效）。居家穴位保健因此默认启用，并按核对结果修正了期门（女性不以乳头定位）、命门（不只以脐定位）、阴陵泉的定位措辞与艾灸/按揉禁忌。**⑤ 响应时限：**M04 首轮生成用时已超过 20 秒时不再开新一轮修复（按「修复用尽」交付，质量类问题带批注、安全类问题走非剂量页），避免为一次不确定的修复搭上 HIS 30 秒等待；`M04_REPAIR_START_CUTOFF_MS` 可调。**⑥ 老年与男科病例「无饮片」的真因：**M03 病机里的「患者高龄，…」「宗筋失于充养」被脱敏层当成人名改写成「[姓名已脱敏]」，M04 抄回被改写的病机，与已签名 M03 对不上，整份候选被收回；已让脱敏层认得这类临床词形（隐私反证：真姓名照旧脱敏）。**⑦ M04 偶发 47–85 秒：**模型偶尔把数组的 `]` 写成 `}`，内容是好的但 JSON 不合法，同模型重抽也常犯同一个错，最后走 34 秒的 Qwen 兜底；现在按语法把错位的括号换成该有的那一个（仍过严格 schema 校验）。**⑧ 工具调用重试的终态：**被接受的 DeepSeek 工具调用重试以 `tool_calls` 结束，此前被终态门当成非权威终态，M03 落成「症状级工作判断」；现视同正常结束。 | 无字段增删；非剂量页多一条可选注释；M04 偶发的第二轮修复不再发生（此前在慢请求上会超过 30 秒）。 |
| V2.28 | 2026-09-29 | **9.24/9.27 医学测评整改。** **① 同一病例只算一次（M03/M04）：**贵方 30 秒断开后重试，此前每次都从零重算，慢一点的病例重试多少次都一样卡住（「饮片暂未生成」）；同一病例被连发两轮时，两轮结果也可能被拼在一起。现在同一病例的请求并入同一次计算或回放 30 分钟内的结果，计算不因您断开而中止；`x-cdss-regenerate: 1` 可强制重算，详见 §3.9。**② 方义方解：**此前只要方解里出现与本方药名相近的字串（如「杏仁」与「苦杏仁」、「地黄」与「熟地黄」、「屏风」与「玉屏风散」）就被整段丢弃改用模板句；现在只去掉确实提到本方没有的药的那一句，其余模型原文保留；模板兜底句式同步改写。**③ 治则：**先给具体治则（虚则补之、实则泻之、寒者热之、热者寒之、扶正祛邪、攻补兼施、急则治标，括号写明针对什么），「治病求本」这类总纲只作补充。**④ 随证加减：**「对应病机」写本症的病机，不再整段复述辨证节点；「加已在方中的药」「减不在方中的药」不再出现。**⑤ 与病历一致：**病历记录了过敏史/用药/既往史时，注意事项和随访不再写「未提及」。**⑥ 中医鉴别诊断：**统一为中医病名（流感→时行感冒、带状疱疹→蛇串疮、荨麻疹→瘾疹）。**⑦ 煎服法：**具名方按《方剂学》教材用法（银翘散勿过煮、不啜粥；麻黄汤覆取微汗、不须啜粥；桂枝汤啜粥）；其余按主要治法分档，兼治通腑不再一律空腹服；清热方饭后服。**⑧ 方名与出处：**反查命名只用常用方；自拟方标「自拟方，组方参考：X（《出处》）加减」；更正 5 处出处（龙胆泻肝汤《医方集解》、血府逐瘀汤《医林改错》、清营汤《温病条辨》、三子养亲汤《韩氏医通》、回阳救急汤《伤寒六书》）。**⑨ 中医治疗项目：**针灸、推拿、食疗按病名与证型给出教材方案（《针灸治疗学》《针灸学》《推拿学》《中医食疗学》《刺法灸法学》，来源栏注明书名与行号），含主穴、按证型与按症状加减、操作与疗程频次；食疗只用药食同源与常见食物；食疗、导引类项目不再写「取穴」。教材方案待中医师终审，仍须接诊医师现场评估后实施。 | 无字段增删；M03/M04 同一病例的重复请求返回同一结果（此前每次重新生成），需要重新生成时按 §3.9 加请求头。 |
| V2.27 | 2026-09-28 | **客户容量。** 固定 Token 下的客户总数上限由 1,000 提高到可配 50,000，生产配置为 **20,000**（此前生产为 100：2026-09-28 贵方一次接入 1,926 家诊所，1,821 家返回 `429 customer_quota_exceeded`）。登记表不再因条目数超过 1,000 而整表失效，鉴权按登记表缓存查找，客户数上万时不增加接口耗时。登录页（`POST /api/auth/access`）只在已授权客户不超过 200 家时返回 `customerOptions` 下拉列表，超过时提示直接填写客户标识。**被拒的诊所请用原 `Idempotency-Key` 重发库存导入或客户登记，失败的请求不占用幂等键。** **② 库存只是参考，推药优先院内库房（§4.10、§4.10.1、附录 A.1）：**中成药/西药院内没有的不再删除，院内有货的排前面、其余标「库存外用药」（此前只同步了饮片的诊所拿不到任何中成药和西药推荐）；院内有货的处方中成药可进入候选；本地说明书检索没有候选时由模型提名中成药，须在本地说明书目录或 EviMed 核对到说明书才采用。同步接口：空清单不再报错（不写类别时不改动库存）、新增 `kinds` 分类替换与「本院没有某类药」的声明、`kind`/`available` 接受中文与 1/0 写法；院内药名先清洗再匹配（对上比例 63%→82%）；新增 `coverage`、`suspectNames`、`likelyNonHerbNames`；未同步的类别不再算缺货；库存超 30 天未更新时注明。新增 `POST /api/drug-inventory/availability`；HIS 新增 `medicineAvailability[]` 与标签字段；页面在药名旁显示院内状态。**③ 剂量与药名：**「高置信中药饮片剂量校准层」（未复核推定值，部分粉剂量按汤剂量写）不再使用；药典未收载的 17 味常用药（五灵脂、六神曲、败酱草、龙骨、龙齿、浮小麦、白花蛇舌草、冬瓜子、玉米须、绞股蓝、红曲、橘络、海浮石、蚕沙等）按联网核查的参考用量标注出处，区间外只批注不压剂量；此前这类药开多少都显示「已按标准区间校验」，已改为如实标注。「延胡索（元胡）」「土鳖虫（䗪虫）」等带括注的药典正名、「败酱」（此前误作小蓟）、龙骨、五灵脂、六神曲等药名可正确识别，土鳖虫按药典 3–10g（有小毒）核对。**④ 文档更正：**§4.9 出参为 `inboundSyncEndpoint`；§3.10 超限改用分片整批替换。 | **否**：新增字段均为可选，可得性取值不变；接入方如按 `availability=out_of_stock` 判断「本院没有」，请改看 `label`（未同步的类别现为 `unknown`）。 |
| V2.26 | 2026-09-28 | **随访计划改为写给患者；运动保健单列；穴位保健接入。** **① 随访评估（M05）「随访管理方案」写给患者本人：**首次复诊时间按处方剂数写成「请在服完7剂药后（约7天后）复诊；如有不适或症状加重，请提前复诊。」；复诊评估重点、疗效评价标准、整体状态复评表改为白话；无效或加重的处置预案写明「请及时回门诊复诊……请不要自行加减或更换药物」，并按本例病情写出「出现以下情况请立即到急诊就医」（未写出时给出通用急症表现，不会空着）；随访时间轴的动作与触发条件改为患者要做的事。栏目名与字段不变。**② 三处随访一致：**同一段随访在医生页面、处方后审与 HIS 写回三处内容相同（此前医生页面会把「有无新出现发热」这类提醒改写成「病历已记录否认发热」，M04 注意事项里的就医提醒也曾被删去）。**③ 运动保健单列：**新增 `nonPharma.exercise`（HIS 为 `healthGuidance.exercise`），`nonPharma.lifestyle` 此后只写起居与睡眠。**④ 穴位保健 `nonPharma.acupointCare`：**由服务端按《老年人中医药健康管理服务技术规范》与《0～36个月儿童中医药健康管理服务技术规范》（2013，国家基本公共卫生服务规范配套）原文生成，模型不参与：由本例已确定的证候病性对应到体质，给出该体质的保健穴、定位、手法、时长与次数，气虚、阳虚体质另给艾条温和灸及防烫伤提示；0～36 月龄按月龄给摩腹、捏脊或穴位按揉。红旗、不出剂量的方案、妊娠阳性或可疑时不给；育龄女性未写明是否妊娠时去掉孕期禁用穴与腹部、腰骶部穴位，且不给艾灸；3～17 岁与 6 月龄以下不给。按贵方 2026-09-28 确认，清单在中医师审定签字前即已启用；审定中如有修改，以审定结果为准更新。HIS 新增 `healthGuidance.acupointCare` 同步写回（附录 A.1）。**⑤ 中医外治项目：**此前病历写「可能怀孕」时未被识别，针刺、艾灸等项目仍会推荐，现与妊娠阳性同样排除。**⑥ 候选方药剂量核对范围只按《中国药典》2020 年版：**此前有 23 味药叠加了一份未经复核的候选用量表，区间被改窄且依据仍标为药典（如板蓝根只能 15g、杜仲只能 10g、川贝母只能 3g，药典分别为 9–15g、6–10g、3–10g），药典范围内的剂量也会被判越界；现已按药典恢复。普通药超出或低于药典范围时仍给出「参考范围偏离」提示，超上限的剂量编译时压到上限。 | **否**：新增字段均可为 `null`，原有字段与栏目名不变。随访各栏只是措辞改为患者口吻；如曾按固定字符串匹配旧模板句（如「治疗期间随时」「完成首次复诊与疗效复评」），请改为按数组遍历。 |
| V2.25 | 2026-09-28 | **响应时延与内容质量。** **① 辨病辨证（M03）前的语义安全筛查：**新增可选的提前准备调用 `POST /api/diagnosis/red-flags?prefetch=diagnose`（§4.7），医生答完追问、提交之前用同一份病例调用，M03 开始前的筛查与检索即已就绪。另修正两类让筛查多跑一轮核对（每次约 5–6 秒）的情况：「4天前/1周前/半月前出现发热」这类近期起病被误当作既往；原文「否认A、B、C」而引用写成「否认C」。**② 候选方药（M04）：**沿用经典方时组成要求此前没有传到生成环节，导致首轮常被退回重写；已修正。线上同类病例 M04 修复轮由 69 例中 20 例降到上线后 31 例中 0 例，M04 客户端耗时中位约 15 秒。少数输出格式出错的情况改为同时发起两路重新生成、取先完成者。**③ 随访评估（M05）：**M04 生成过程中候选方药一确定即开始撰写随访方案；线上 M04 结束后紧接着调用 M05，客户端耗时 0.6–2.0 秒（中位 0.9 秒；此前 3.1–4.1 秒）。**④ 经典条文出处 `formula.candidates[].classicEvidence[]`：**此前线上一直为空（服务构建缺陷），现已恢复。**⑤ 文献证据：**检索改为按本例已确定的西医诊断、中医病名证候与治法分别查询，取第一组与本例相关的结果；本地 65 例回放中与本例无关的文献条目占比由 60% 降至 31%。**⑥ 方剂功效：**补全了常用方剂目录中缺失的功效（常用层 732 首中有功效的由 543 首增至 705 首），完带汤、茵陈蒿汤等在辨证与治法相符时可保留经典方名。**⑦ 服务健康检查（附录 A.2）：**响应新增 `classicEvidence`，列出各经典条文语料的记录数与已建索引数。 | **否**：字段只增不删；`prefetch` 为可选查询参数，不带时行为与此前相同；健康检查新增字段可忽略。 |
| V2.24 | 2026-09-27 | **响应时延：随访评估（M05）提前准备、请求体可压缩。** **① 随访评估（M05）：**候选方药（M04）完成时，服务端即按本例已签名的辨证与处方预先撰写随访方案，M05 调用时直接取用；若 M05 到达时仍在撰写，则等待同一次撰写完成，不重复生成。M05 请求里的病例、辨证或处方与 M04 返回时不一致（如医生改了方）时，照常重新撰写，结果不受影响。线上同一批病例：M04 完成后隔几秒再调用 M05 时，客户端耗时 0.7–1.3 秒；紧接着调用时 3.1–5.2 秒（此前 7.8–8.6 秒）。**② 请求体可压缩（§3.2、§3.10）：**请求可带 `Content-Encoding: gzip`（或 `deflate`）。线上实测 M04 请求体 49–65 KB、M05 请求体 137–180 KB，gzip 后约为原来的 1/5（M04 9–11 KB，M05 32–35 KB）；在上行带宽有限的网络上，这部分上传此前要数秒。系统自带的诊疗页面已默认压缩。 | **否**：字段与返回内容均未改变；不带 `Content-Encoding` 的请求行为与此前逐字相同。新增状态码 `415`（仅在带了不支持的 `Content-Encoding` 时出现）。 |
| V2.23 | 2026-09-27 | **响应时延与知识/规则层改进，无字段改动。** **① 追问生成（M02）：**语义风险筛查与出题并行进行；筛查结果不影响出题时直接采用并行结果，影响时按筛查结果重出，返回内容与此前串行时逐字一致。**② 辨病辨证与候选方药（M03/M04）：**M02 请求时预先完成 M03 所需的文献检索与检索词规范化，M03 完成时预先完成 M04 所需的用药规划与文献检索；M04 等待外部文献检索最多 2 秒，未返回的部分本次不纳入。**③ 候选方药偶发需要修正时**（约四分之一的病例，多为沿用经典方时组成保留不足或个别剂量越出保守区间），修正轮改由主模型只重写处方主体，约 5 秒（此前约 20 秒）；**结构化结果偶发格式不合格时，**辨病辨证改由同一模型以严格格式重新生成（约 10 秒，此前改由备用模型重新生成约 25 秒）；只多写了无关字段的结果直接剔除该字段后受理，不再整份重生成。**④ 方剂：**只有官方标准方、古代经典名方和现代医案常用方（共 732 首）可被锁定为主方，冷僻古方（如「防饥救生四果丹」）不再被锁定；模型自选的常用方在治法与已签名治法对齐、且目录证候标注不与主证/兼证冲突时保留（此前多被剔除为「按病机组方」）。**⑤ 证据：**与本例临床问题无关的外部文献条目不再进入推理；证据超出篇幅时优先保留方剂出处与本地中成药候选，先裁通用剂量索引。**⑥ 参考医案：**按病历检索 3 例相似的现代名医验案供辨证与组方参考（不含剂量，不作处方依据）。**⑦ 总体病机**写有「尚待明确」一类措辞时，不再把整份辨病辨证退回「症状级工作判断」，改为带质量提示受理。验证：65 例公开病案（40 例名老中医医案、25 例专科病案）本机对照，医学质量评分与改动前持平（对照名医答案的可采纳度改动前两次 3.00、3.02 分，定稿 3.08 分，差异在重复测量的波动范围内），评审员提出的用药安全疑虑 4–7 例→4 例，辨证整体退回 1 例→0 例；候选方药耗时 90 分位 39–43 秒→20 秒。线上按外部接口顺序直调（collect→question→diagnose→prescribe→assess）同一批 4 例：追问生成 7.2–14.0 秒→4.0–5.2 秒，辨病辨证 13.9–18.1 秒→10.0–14.2 秒（开始返回内容由 3.1–4.3 秒提前到 0.2–1.4 秒）。 | **否**：字段路径、类型、取值集合均未改变。变化在取值上：`overview.recommendedFormulaNames` 更常非空；M03 给出推荐方名而 M04 按本例病机另行组方时，`formula.candidates[].name` 为「本例辨证组方」并在 `formula.candidates[].applicable` 中写明未沿用该方的理由；冷僻古方不再出现在锁定方名中。 |
| V2.22 | 2026-09-26 | **西医诊断、中医辨证与方药剂量的质量改进，无字段改动。** **① 西医主诊断：病历已有确诊依据时直接给出病名。**影像、病理、内镜、特征性检验或已明确的既往诊断足以确立诊断时，`westernDiagnosis.primary.name` 直接写该疾病（可附分型、分期与主要并发症），`status` 为「考虑」，不再写「……，病因待查」；依据确实不足时仍按症状/症候群名加「病因待查」。同时修复三处缺陷：主诊断偶发显示为「年龄：52岁症状」这类文字（取主诉时误取了系统补写的年龄行）；「房间隔缺损，合并中度肺动脉高压、三尖瓣中度关闭不全」这类用顿号列举并发症的正确诊断被当成「多个诊断并列」降级为症状名；「A/B」「A或B」写法的主诊断或鉴别项改为拆开——主诊断保留括注外的主干，择一的方向逐条进入鉴别。**② 中医辨证：主证加兼证。**辨证须照顾病历中全部关键阳性信息（情志诱因、寒热、舌脉、二便、久病等），与主证寒热虚实相矛盾的表现要据此修正主证或列为兼证；兼证写入 `overview.secondarySyndromes`，并在 `therapy.subTherapies` 中有对应的分治方向。选方须与证候的寒热虚实一致（例如有湿热、阴虚时不选以温燥药为主体的方）。**③ 剂量：普通药高于《中国药典》2020年版一部上限时按上限给出。**此前原值照出、仅提示「偏离参考」；现在 `dose` 为上限值，`verificationTier` 为 `verified`，`verificationReasons` 首条写明原值与药典范围。毒性药、需医师定量的药和来源冲突的药不在此列；低于下限的剂量不改（儿童、老人、体弱者用量可低于成人下限），仍提示医生核对。**④ 两类「辨证结果整体退回」的缺陷修复。**系统给总体病机追加的提示语、以及病机里「神志不清」「视物不清」「月经先后不定期」这类症状写法，此前会被误判为「结论未定」，整份辨病辨证退回「症状级工作判断」；修复后照常给出。**⑤ 同时处理的诊断/开方由 3 路增至 8 路。**此前第 4 位医生同时点诊断，排队 25 秒后拿到「症状级工作判断」；8 路、12 路同时压测均未再出现。验证：65 例公开病案（40 例名老中医医案、25 例专科病案）本机前后对照：专科病案西医主诊断与专家诊断一致 44%→72%，专家诊断出现在主诊断或鉴别中 96%→100%，主诊断写「病因待查」69%→26%；中医主证与名医一致或部分一致 80%→88%，寒热虚实方向错误 5%→2%；评审员提出用药安全疑虑 20%→5%；辨证整体退回 3 例→0 例。 | **否**：字段路径、类型、取值集合均未改变。变化在取值上：`westernDiagnosis.primary.name` 更多为具体病名、`status` 更多为「考虑」；`westernDiagnosis.differentials` 行数可能增多；`overview.secondarySyndromes` 更常非空；个别药味的 `dose` 可能低于模型原值（见 `verificationReasons` 首条），`verificationTier` 相应为 `verified`。 |
| V2.21 | 2026-09-26 | **安全判定增强，无字段改动。** **① 新增「开方前处置去向」判断。**红旗预检在原有类目之外，增加一步开放判断：先列出与本次表现相符、一旦漏掉可能致死致残且有处置时间窗的情况（病名不限类目），再判断今天能否在中医门诊直接开剂量级中药。此前「车祸伤3小时、膝关节畸形」「无痛性进行性黄疸伴胰头占位」「甲状腺占位伴饮水呛咳」「血钠118伴神志糊涂」「打球扭伤后膝关节交锁不能负重」等不在任何红旗类目里的情况会照常给剂量；现在按「宜先由西医相关专科尽快评估」处理，需立即急诊的按红旗处理，只差一个关键信息的仅提示医生补问、不扣剂量。每条判断都附原文依据与需排除的病名。已在医院确诊、本次来中医调理且无急性加重证据的慢性病，不因病名升档。**② 10 岁以下女童不再要求填写妊娠/哺乳/备孕状态。**验证：58 例提示词未涉及的危重情形中 56 例扣剂量（另 2 例为模型输出解析失败，按语义筛查不可用同样不给剂量），此前 52 例；350 例全新真实门诊病历与在线问诊中，因风险扣剂量的比例净增 4.6 个百分点。 | **否**：字段路径、类型、取值集合均未改变。上述情形的病例 `safetyGate.status` 会由 `ready` 变为 `needs_information`（或 `red_flag`），`missingItems` 中出现以「开方前处置去向」开头的条目，`allowDosePrescription` 相应变为 `false`；`advisories` 可能出现以「建议补问」开头的提示。 |
| V2.20 | 2026-09-26 | **安全判定修复，无字段改动；本次两个方向都有变化。** **① 查体记录里的角度数值不再被当成体温。**「左下肢直腿抬高试验30度阳性」「针尖与皮肤成45度角斜刺」「折端向外成角约40度」「掌倾角约负30度」此前被读成体温 30℃/40℃/45℃，弹出低体温或极高热红旗并扣掉剂量——骨伤、推拿、针灸病历里这类写法很常见。修复后按角度处理；写明「体温40度」「高烧40度」「T 40℃」「腋温40度」的真体温照旧报警。**② 查体段的否定写法不再被读成阳性体征。**「全腹未触及压痛反跳痛」「未扪及肌紧张」「未引出病理反射」「四肢肌力正常，未触及抽搐」此前被判成阳性反跳痛/抽搐，弹出急腹症或神经系统急症红旗；同义的「全腹无压痛反跳痛」一直是对的，差别只在动词。修复后两种写法一致；真正的阳性体征照旧报警。**③ 病理报告的肿瘤写法不再漏检。**受治理词表收的是病种名（胃癌/食管癌/结肠癌），而病理报告写「结肠腺癌」「胃低分化腺癌」「食管鳞癌」「直肠印戒细胞癌」，此前整类不识别；同时补入与表内「纳差」同义的「食欲不振」等写法。修复后这类病例按「恶性肿瘤 + 当前消化道症状」正常提示。验证：公开真实病历语料 39,854 条 × 2 种病历形态回放，40 条判定改变、全部是误报消失，0 条被放宽；另取 25,917 条成人内科真实问诊回放，仅 1 条改变且方向更谨慎。 | **否**：字段路径、类型、取值集合均未改变。变化在取值上且**两个方向都有**：含角度数值或查体否定写法的病例，`safetyGate.status` 可能由 `red_flag` 变为 `ready`、`allowDosePrescription` 由 `false` 变为 `true`；病理报告写组织学名的肿瘤病例则相反。若贵方有按这些写法写死期望的自动化用例，需要更新。 |
| V2.19 | 2026-09-26 | **安全判定修复，无字段改动。** **① 「晕厥后跌倒」「昏倒过一次」「抽搐过一次」这类说法不再被当成既往史。**红旗语义预检此前会把只说明「发生过」、没有写明何时发生的事件判为既往已缓解，于是不提示、照常给剂量；同一批说法（含两组事后新写的说法）在修复前每句采样 5 次近四成漏判，修复后全部判为需先评估，写明「三年前」「已治愈」「此后未再发」的既往史仍按既往处理。**② 「既往体健，胸痛2小时伴大汗」这类写法不再被整句当成既往。**确定性红旗规则此前会让句首的「既往体健」「否认高血压病史」越过逗号，把后面的当前症状甚至当前血压读数一起算成既往；「这次」「此次」「近两天」「3天前开始」等时间说法也未被识别为当前。典型写法如「患者既往体健，2小时前无明显诱因出现胸痛，伴大汗」「否认高血压病史，血压190/125mmHg」「3天前开始发烧，体温39℃，伴一次抽搐」修复前判为无风险，修复后按红旗处理。27,329 句真实医案叙述回放：83 句判定改变，全部是变得更谨慎（81 句由无风险改为需评估或红旗，2 句多出一条提示），没有一句被放宽。 | **否**：字段路径、类型、取值集合均未改变。上述写法的病例 `safetyGate.status` 会由 `ready` 变为 `needs_information` 或 `red_flag`，`allowDosePrescription` 相应变为 `false`；若贵方有按这类病例写死 `ready` 的自动化用例，需要更新期望。 |
| V2.18 | 2026-09-25 | **精简冗余环节，无出参字段删改。** **① 追问环节的模型复核取消。**该环节与出题使用同一个模型，等于自己检查自己；同一批 34 例对照，模型复核与确定性规则删掉的问题数相当（13 比 14）、分歧双向，没有一方更好，却让每次追问多等约 1.2 秒。改为只保留确定性规则：删掉病历已回答的问题、选项不互斥的问题，中性化带倾向的提问理由。**② 追问自由文本回答改为原样记录。**此前由模型把医生打的字"理解"成病历字段值；65 条真实口吻回答实测，其中 30 条被截短（丢掉「降压药一直吃着」「烟抽二十年」「无紫绀咯血」等临床信息）、14 条被判为不确定而没有写入（含「说不清有无黑便」）、2 条失败。现在页面直接把医生原话写入对应字段。`POST /api/diagnosis/question/interpret` 接口保留、出入参形状不变，改为确定性按「问题ID：」前缀逐题归属；整段无法归属到具体问题时返回 `200` + `ok:false` + 新增原因码 `answer_not_attributable`，医生原话由调用方保留。**③ 病历完整度改由服务端计算。**M02 结构化结论里的 `completeness` 此前是模型自评，而系统门控另按病历字段重算，两者可能不一致；现在统一由服务端同一套规则给出（字段与取值范围不变）。**④ 外部审方下线**（详见 §3.5 说明）：线上自 9/10 起即为关闭状态，各出口取值与关闭期逐字节相同，处方安全由本地确定性核对（十八反十九畏、药典剂量上下限、缺剂量、服法疗程、现用药范围）负责。**⑤ 处置档位开关取消**（详见 §3.11）：仅保留线上一直在用的"不阻断"处置。**⑥ 语义红旗预检取消复核相位**：198 例实测复核对安全判定影响为零，现按单次抽取结果判定（此前已按此配置运行）。**⑦ 页面不再显示「临床复核状态」行**：模型复核环节已于 V2.14 移除，该行文案（「本版本不设模型复核环节…」）随之删除；受限结果页与非剂量候选页中提及"复核"的措辞一并改为如实描述（如「本次结构化辨证结果未通过服务端完整性校验」）。**⑧ 健康检查调整**见附录 A.2。 | **否**：出参字段路径、类型与取值集合均未删改。三处需要注意：`clinicalReview` 仍固定为 `unavailable/not_configured`（自 V2.14 起即如此），**页面上那一行复核状态文案消失**，按该行文案做过页面截图比对或正则匹配的自动化用例需更新；`question/interpret` 新增一个失败原因码，按已知码白名单解析即可；严格健康检查的未就绪原因集合缩小（只减不增）。 |
| V2.17 | 2026-09-24 | **提速，无字段改动。** **① 追问、辨病辨证、候选方药三个环节的首轮生成改用出字更快的模型。**同一批真实病例对比：追问约 15 秒降到约 4–5 秒，辨病辨证约 43 秒降到约 15 秒，候选方药约 40 秒降到约 15 秒，一次完整流程约从 100 秒降到 40 秒左右。**② 结构质量有兜底。**新模型的每一份输出都按原有的字段结构逐项校验（字段是否齐全、类型与取值范围是否正确）；不合格、连接失败或服务异常时，系统自动改用原来的模型对同一病例重新生成，这一例的耗时会回到改动前的水平，但结果质量不低于改动前。修复环节与红旗语义预检仍使用原来的模型，确定性安全规则完全不变。**③ 可见差异：『辨证边界』说明出现得更多。**对四诊资料仍有欠缺的病例，新模型更常把证候标为「有边界的工作判断」，此时页面与结构化结果会在证候下方附一行「辨证边界」，写明还缺哪些信息（本地 9 个典型病例中约 6 例出现，此前多数不出现）；证候名称、病机与处方结论不受影响，`overview.primarySyndromeResolution` 的取值集合（resolved / bounded / unresolved）不变。 | **否**：字段路径、类型、取值集合与中文名均未改变，调用方无需任何修改。若贵方界面按 `primarySyndromeResolution` 做了区分展示，bounded 的出现比例会上升。建议客户端超时仍按 §3.9 保持 200 秒以上。 |
| V2.16 | 2026-09-20 | **提速，无字段改动。** **① 内部辅助环节换用更快的模型。**术语归一、证候重排、方名召回、否定语义辅助、随访内容撰写与追问复核这几个内部小环节改用出字更快的模型，单环节耗时下降约六成；它们任何一个不可用时，系统都会退回确定性规则结果，不影响给出的结论。诊断与处方的主生成环节不变。**② 重复调用去掉。**追问复核与术语归一此前把同一请求原样发送两遍再取一致，现只发一次；术语对应仍只作为待医生确认的建议，不会自动替换结论。**③ 语义红旗预检只做一次抽取。**预检原先在抽取之后再做一轮复核，实测 198 个用例中复核对安全判定的影响为零，每位患者因此少等约 7 秒；红旗仍会照常提示并参与安全判定，确定性红旗规则完全不变。**④ 处方修复只补出问题的部分。**处方个别药味不合规（如某味剂量越界）时，系统此前会让模型把整张处方连同中成药、调护建议全部重写，现在只重写中药处方本身，其余部分原样保留，修复耗时约减半，也不会再顺带改动原本合格的内容。**⑤ 结构化输出改为紧凑排版、若干内部时限放宽。**内容与字段不变。综合结果：M03、M04 的典型耗时明显回落，随访评估约 4 秒，仍以 §3.9 的上限为准。 | **否**：字段路径、类型、取值集合与中文名均未改变，调用方无需任何修改。建议客户端超时仍按 §3.9 保持 200 秒以上。 |
| V2.15 | 2026-09-19 | **① 西医诊断恢复。** 9/11 西医部分切换到 DeepSeek 之后，该段模型输出实测 9/9 次都是括号层级错位的非法 JSON（顶层对象被提前闭合，`suggestedChecks` 等字段写到了外层），服务端解析失败后整段丢弃，结果里的 `westernDiagnosis` 落为默认占位（`primary.name`=「症状性诊断，病因待临床鉴别」，页面显示「当前未形成可复核的西医工作诊断」），`management.mustCollect` 同时为空。现已按结构修复并把错位字段归位；修复不了时重试一次，仍不行才落占位。**② 字段中文名与医生页面统一。** 页面曾把「中医辨病依据 / 中医辨证依据」两个标题挂在国标引用（`tcmDiseaseReferences` / `tcmSyndromeReferences`）上，而本文档中这两个名字指的是 `tcmDiseaseRationale` / `tcmDiagnosticRationale`（页面叫「辨病推理 / 辨证推理」）——标题正好交叉。现在页面与可见正文统一为：国标引用 = 辨病/辨证**循证**依据，病名与证型的判断理由 = 辨病/辨证依据。其余仅措辞不同的中文名按页面现行叫法修订：`primary.name` 西医诊断倾向、`chain[].syndromeEvidence` 辨证关键依据、`chain[].pathogenesis` 病机演变、`chain[].therapyDirection` 对应治法、`uncertainties` 影响判断的待核实信息、`therapy.overallMethod` 总治法、`nonPharma.diet / lifestyle / emotion` 饮食调养 / 生活方式 / 情志调护；§5.1 补入「中医辨病依据 / 中医辨证依据」两行，原「证候依据」更正为「主证候依据」（原名与病机链的同名字段重名）。生成过程中的预览草稿与进度提示同步改用上述名称。**③ 文本模型换回百炼通义千问。** 全部文本环节改回 Qwen（首轮生成与多数辅助任务 qwen3.8-flash，修复轮与临床事实分诊 qwen3.8-max），两档都由模型服务端按接口结构约束输出，不再出现①那类结构错位；中医部分的主证候依据、病名与证候鉴别、病位、病性、分治法、影响判断的待核实信息改为每例必有内容（此前可能为空数组）。代价是 M03、M04 单次耗时比 9/11–9/19 期间长约 20–30 秒，仍在 §3.9 的上限之内。 | **否**：字段路径、类型与取值集合均未改变，只改中文名；按字段路径解析的调用方无需修改。此前把 `westernDiagnosis.primary.name` 等于占位串当成「模型未给出西医诊断」处理的调用方，现在会拿到真实诊断。客户端超时若低于 §3.9 建议的 200 秒，请按建议放宽 |
| V2.14 | 2026-09-16 | **移除 M03/M04 模型复核环节。** 线上实测该环节全部是与生成方同一模型、低推理力度、中位 1.4 秒的请求，84% 打回；M03 侧意见全部被服务端降为有界建议，M04 侧把通过全部确定性核验、零安全问题的候选扣成非剂量 15/35 次，且同一病例重试结果逐次相同；没有可证明的正收益。安全底线（药典剂量上限、配伍禁忌、特殊人群、剂量授权轴、审方）全部保留且仍由确定性层执行；临床合理性由医生把关。出参变化：`clinicalReview` 字段保留但固定为 `{status:"unavailable", unavailableReason:"not_configured", reviewedPayloadHash}`；`clinicalReviewMethod` 固定为 `null`；可见正文的「临床复核状态」行改为「本版本不设模型复核环节」；严格健康检查不再含 `independent_clinical_reviewer_*` 项；`model-health?check=1` 响应不再含 `clinicalReview`。部署变量 `PRIMARY_CLINICAL_REVIEW_*`、`PRIMARY_*_REVIEW_MODEL`、`*_REVIEW_FALLBACK_MODEL` 删除。 | **否**：两个字段本就可选且取值仍在既有枚举内。按 `clinicalReview.status==="accepted"` 判断"已复核"的集成方从此恒为否——请勿据此拦截剂量或标红 |
| V2.13 | 2026-09-15 | **`Idempotency-Key` 成为库存 `POST` 的必填请求头。** 缺失或格式非法一律 `400 idempotency_key_required`，且在解析请求体、建立客户上下文之前返回——不读 8MB 载荷、不产生任何租户副作用。此前缺键请求按整批替换照常执行（V2.12 仍如此），且校验只在未登记客户的 JIT 分支生效、已登记客户完全不校验。 | **是（破坏性）**：不携带该请求头的库存同步作业会立即收到 `400`，必须为每一次导入生成一个 8–200 位可打印 ASCII 的键；同一次分片整批替换可共用一个键，把用过的键复用到另一次导入会在第一片返回 `409` |
| V2.12 | 2026-09-15 | **库存写入幂等落地。** `Idempotency-Key` 此前只参与未登记客户的 JIT 登记，客户登记后既不参与写入也不校验格式——同键连发两次、第二次载荷不同会两次都返回 `200`，后一次整批覆盖前一次（被覆盖的药味会被讲成"缺货"而非"未知"）。现在库存 `POST` 带该头即进入写入幂等事务：同键同载荷重放首次响应并带 `idempotent-replay: true`；同键不同载荷返回 `409 idempotency_conflict` 且不写入；键格式非法返回 `400`。仅 `200` 结果占用幂等键，`202`/失败可用同一键改正后重试。 | **否**：未携带该请求头的调用方语义不变（仍是整批替换）；携带该头并复用同一键提交不同载荷的调用方，此前是静默覆盖，现在会收到 `409`，需为每一次新的导入换一个键 |
| V2.11 | 2026-09-10 | 区分当前风险与生活调护、未实施的加减建议及已核实的说明书参考文本；M05 可新增 `warning_profile` 显示观测帧，使页面、导出和经验证的恢复结果保持同一显示分级。实际风险、原有临床签名与 HIS 采纳判据继续独立生效 | 新增可选事件；按 §3.5 忽略未知 `type` 的现有调用方无需修改。显示收据不是采纳授权，不应写入模型输入或作为 HIS 决策依据；客户 Token 不变。线上实际部署以 `health.build` 为准，不能仅凭本文档版本判断已切流 |
| V2.10 | 2026-09-07 | M03/M04 新增明确标记的只读临床预览，规范正文与签名结果不变；M04供应商提案去除服务端自有字段，客户端字段仍兼容；临床覆盖质量意见继续随结果展示；限定普通药的历史参考剂量偏离保留为待核对建议 | 不使用预览的调用方忽略 `module_draft`。解析事件时须先识别 `type`，不能把草稿content混入规范正文。历史参考剂量偏离显示原始建议量、范围与来源，核验等级为 `unverified_dose`；对应HIS饮片项 `referenceOnly=true`、`adoptable=false`，不得因有AI签名而自动执行，仍须医生核对和机构处方确认。客户Token不变；具体部署身份查看health.build |
| V2.9 | 2026-09-07 | 临床意见随方案交付：HIS 和处方后审新增 `warnings[]`，M05/HIS 正文同步显示；已形成结果不再因药味方向、说明待补等临床意见整份返回 `422`。加减动作/药味双字段保持不变，接口 Token 不变 | 新增字段；临床意见类结果由 `422` 改为 `200`+提示。调用方须展示提示，不应仅用 HTTP 状态判断临床问题是否存在 |
| V2.8 | 2026-08-28 | **① 流派谱系勘误。** 原 `warm-tonify-yang` 拆为 `warm-tonify`（温补学派）与 `support-yang`（扶阳学派/火神派）；旧码仅作请求兼容并归一到温补学派，「温阳」作为治法术语不再冒充流派。两派拥有独立代表医家、典籍、追问重点与用药安全边界。**② 随证加减结构化。** `formula.modifications[]` 与 HIS 对应投影新增必有药味字段 `herbName`；`action` 收口为 `加` / `减` / `调整`，不再输出 `加川芎` 这类动作药味混合值。服务端仍能只读消费旧签名快照中的混合值，但所有新响应只输出分字段结构。 | **是（字段语义）**：仍把 `action` 当完整展示字符串的调用方须改为组合展示 `action + herbName`；旧请求流派码仍可用，但应尽快迁移。新增药味字段不影响忽略未知字段的宽松解析器 |
| V2.7 | 2026-08-25 | **接口语义统一与稳定性收口。** `safetyGate` 新增 `candidateMode`（full_dose/limited_dose/non_dose_only/blocked），明确 `allowDosePrescription=false` 下 limited_dose 仍显示参考剂量；`question/interpret` 的模型超时与契约失败改为 `200 + ok:false + retryable`（业务降级，医生原话由调用方保留，不再出现 5xx）；审方对"药典小毒但不在医疗用毒性药品管制目录"药材（如苦杏仁）的处方权限误报纠偏覆盖供应商真实返回形态（issueType=PRIVILEGE）。 | **否**：新增字段向后兼容；依赖 interpret 5xx 判失败的调用方改为检查 `ok` 字段 |
| V2.6 | 2026-08-25 | **JIT 登记事务顺序整改（PROV-08）。** 库存载荷结构校验先于 JIT 登记：载荷不合法的首次请求返回 4xx/413 且不登记客户；条目级错误整批拒绝并回报 `rejectedEntries`/`rejectedEntryCount`（缺 `name`、`kind` 非枚举、`available` 非布尔不再静默丢弃或强转）；空 `items` 不再生成零条目库存。JIT 登记成功的库存/分片响应与 `/api/customers/register` 响应新增 `customerRegistered` 字段（`created` 保留兼容）。审计轮转仅作用于普通文件，路径误配置为目录时审计判不可用并 fail-closed。 | **否**：既有合法调用不受影响；此前依赖「空 items 也返回 200」或「非法条目被静默跳过」的调用方需改为提交合法载荷 |
| V2.5 | 2026-08-24 | **多租户真实接口验收整改。** M03/M04、急症解除和临床事实证明签名域绑定 `clientId + customerId` 并升版；新增幂等、限额、持久化的客户 JIT 登记，首次库存 POST 可自动登记；新增租户隔离的结构化审计查询；严格 JSON Schema、usage/cached token 观测、Qwen effort 映射与租户公平并发队列同步上线。 | **是（签名版本）**：升级前的 M03/M04/急症解除/临床事实证明凭证失效并安全降级，需重新生成；既定 `CDSS_API_TOKEN` 保持不变。首次新客户写入请增加 `Idempotency-Key` |
| V2.4 | 2026-08-21 | **固定 Token 多租户授权加固。** 同一既定接口 Token 只允许访问 `CDSS_API_CUSTOMER_IDS` 中预授权的客户；未知/未授权客户统一 `403 customer_forbidden`，登录接口也不会为其签发客户 Cookie。库存文件升级为带 `schemaVersion/customerId` 的 v2 并做读取归属复核；同客户导入串行、不同客户独立，缓存增加容量与空闲淘汰。所有 API 响应增加 `private, no-store` 与租户鉴权 `Vary`，库存成功响应返回经验证的 `x-cdss-customer-id`。严格健康检查纳入授权配置但不回显白名单。 | **是（配置项）**：部署必须新增 `CDSS_API_CLIENT_ID` 与 `CDSS_API_CUSTOMER_IDS`；既定 `CDSS_API_TOKEN` 不变。原已接入客户加入白名单后请求格式无需变化；未授权客户从此前可能被接受改为 403。旧库存需按部署手册显式迁移为 v2 |
| V2.3 | 2026-08-19 | **① 客户药品库全链路隔离。** 临床、审方、HIS、快照与库存接口新增必填请求头 `x-cdss-customer-id`；浏览器登录请求体新增 `customerId` 并签发客户上下文 Cookie。客户标识进入病例签名、快照 AAD、限流、库存文件和审方租户头；不同客户的饮片、中成药和西药库存独立，M04 只保留当前客户有货候选。**② M03 补齐中医辨病与辨证的循证依据**：`overview.tcmDiseaseReferences[]`、`overview.tcmSyndromeReferences[]`；西医鉴别项新增可选 `guidelineReferences[]`，参考文献栏只显示标准引用，不混入模型思考过程。**③ 中成药用法按说明书展示**：新增 `administrationTiming`，`route`、`singleDose`、`frequency`、`course` 均只在说明书原文存在时输出；删除“本候选不形成疗程医嘱”占位文案 | **是（一处）**：临床、审方、HIS、快照和库存调用必须提供客户标识。未适配调用返回 `400 customer_id_required`；同一病例跨客户调用返回 `409 customer_context_mismatch`。新增诊断与用药字段均向后兼容 |
| V2.2 | 2026-08-13 | **① 流派功能补齐「报告说明」与「排序影响」两层。** 此前 `lineageAdaptation` 只存在于 JSON 出参，报告/页面/HIS 一处都不渲染。现在：选择了具体流派（非「不限定」）且模型产出非空适配内容时，可见正文与医生页面新增 **「流派适配记录」** 段（诊疗思路、本例适用性、适配说明、受影响决策、安全边界——安全让位声明恒随段落出现）；HIS 出参 `aiMedicalRecord` 新增**可选**字段 `tcmLineageAdaptation`（`label` / `applicability`（适用/部分适用/不适用）/ `reason` / `influencedDecisions[]{aspect,detail}` / `safetyBoundary`）。同时上线流派对候选方**展示顺序**的有限影响机制：方剂出处书名→流派映射逐条带中医师终审状态，**未签字条目零影响（当前全部待签，故本版行为无任何变化）**；签字后也只在已通过全部安全与证据准入的候选池内做封顶加分的展示排序，不参与准入、不参与系统自动锁方、不改变剂量/禁忌/审方任何校验。**② M03 复合证候两处判据修复（线上心悸案实测）。** 「心阳不振，水气凌心」这类**并列国标证候**此前被误判为「病名+病机」缺陷形态（病名前缀包含式匹配被「水气」截胡），导致修复轮空转、方名锁定被搁置；已修。主证候可确定性归一时，方名撤销原因不再误写为「等术语确认」（`semantic_mapping_pending_clinician_confirmation`），改为如实的 `governed_syndrome_relation_unverified`——医生不再被引导等待一个不改变结果的确认 | **否。** 新增字段均为可选（缺省即不下发），V1/V2 契约不破坏；`deferredFormulaSelection.reason` 枚举集合未变，仅取值分布更准确。集成方若想使用流派适配内容，按可选字段读取即可 |
| V2.1 | 2026-08-12 | **西医诊断依据的分类与事实来源更正（呈现层，出参字段未变）。** 线上实测发现三处错分：**①** 既往史 / 用药史 / 过敏史此前被并入「症状依据」，于是「高血压病史5年，规律服药」「氨氯地平 5mg 每日一次」被印成症状。现新增第五个分栏 **「病史依据」**，这三个字段的落点即结论、模型标注不得覆盖（现病史里记录的体征仍由模型判定，不变）。**②** 事实来源标注把 HIS 直传字段一律标成「（来源：现病史）」——接地正文里 HIS 字段是不带标题的裸行，解析时被兜底猜成现病史。现区分「读出来的」与「猜出来的」归属，前者优先，并改为直接读受治理字段路径。**③** 主诉与现病史描述同一临床事件时合并，保留信息更全的那条 | **否。** `westernDiagnosis.primary.supportingFacts` 字段与取值不变，仍是未分类的事实数组，HIS 出参亦不变。仅**医生页面与可见正文**的分栏与来源标注发生变化：新增「病史依据」一栏（无内容时不出现），来源标注可能从「现病史」变为「既往史 / 当前用药 / 生命体征」等更准确的字段名 |
| V2.0 | 2026-08-12 | **① 随访时间轴改为模型驱动。** 此前该结构里只有观察项是按本例生成的、且两条目共用同一份；时间点第二条恒为「治疗期间随时」、随访动作是两条写死的字符串、触发条件主体是一句固定话术——不同证型的病例拿到的时间轴逐字相同。现由 M05 撰写层按本例证候/病机/治法/处方整条生成（2–4 条，时间点各异、动作与触发条件因例而异）。**三条边界不变**：第一条时间点恒等于正文「首次复诊时间」；处方后审方得出的安全触发条件**只增不减**并入第一条；红旗 / 无结构化剂量 / 硬剂量边界三条降级路径完全不走模型、保持确定性。模型不可用或校验不通过时逐字回落原模板。**② 勘误 `timelineItems[].indication`**：该字段从未存在，实现产出的是 `indicators[]` 与 `triggers[]`，本版按实现更正 | **否。** 出参字段集未变（`indication` 从未真实存在，取它一直是 `undefined`）。**内容分布会变**：时间点不再固定为两条、不再出现「治疗期间随时」这一固定值；若贵方按固定字符串匹配过时间轴行，请改为按数组遍历 |
| V1.9 | 2026-08-11 | **普通咳嗽·风寒袭肺证模板经中医师签字终审，已启用。** V1.8 里该模板处于 `pending_clinician_review`（整条不启用、走评估态、通过 `deferredGovernedTemplate` 告知）；现签字生效：命中该模板的病例返回 `protocolStatus = governed_patient_specific_plan`、`tailoringStatus = syndrome_tailored`，候选穴位为 肺俞、中府、列缺、太渊、风门、合谷（兼鼻窍或头项症状时加风池），**不再下发 `deferredGovernedTemplate`**。同时修正一处呈现口径：经精确证型闸门准入的模板，其准入条件本身即含"本例已签名证型 + 已终审"，因此不得再被标注为「尚未按本例证型加减」 | **否**，但**取值分布会变**：此类病例的 `protocolStatus` 由 `assessment_only_no_patient_specific_protocol` 变为 `governed_patient_specific_plan`（V1、V2 下该值相同，不涉及折叠），`deferredGovernedTemplate` 不再出现。若贵方按"针刺项目恒为评估态"做过特殊处理，请撤销 |
| V1.8 | 2026-08-11 | **普通咳嗽·风寒袭肺证独立取穴模板（中医师裁定，待签字）**：此前针刺目录只有「流感专项」与「感染恢复期」两条呼吸类模板，普通风寒咳嗽落回评估态并由关键词召回给出取穴（实测出现承灵、孔最、肩中俞）。按《咳嗽中医诊疗专家共识意见（2021）》建独立模板：主穴 肺俞、中府、列缺、太渊，风寒加穴 风门、合谷；风池按中医师裁定**只作条件加穴**（鼻窍或头项症状明显时加入），不进固定主穴。模板由「当前咳嗽事实 + 已签名风寒袭肺/风寒束肺」双钥匙闸门锁定，显式排除流感、感染恢复期、风热与恢复期证型，**不改变全局适应证标签优先级**。该模板在 V1.8 发布时处于 `pending_clinician_review`（不启用、走评估态），**已于 V1.9 经中医师签字启用**。另新增逐穴角色 `conditional_point`（V2 才出现，V1 折叠为 `syndrome_refinement`） | **否。** V1 出参枚举取值不变（新角色在 V1 下折叠）；`deferredGovernedTemplate` 为新增可选字段。签字生效后该项目的 `protocolStatus` 会从评估态升为病种模板态，届时另行通知 |
| V1.7 | 2026-08-11 | **中医师终审落库**：原 13 条待终审证型配穴全部裁定完毕并生效。删除重复穴（咳嗽风寒袭肺的太渊、中风痰热腑实的曲池）；整条删除「感染恢复期·风热犯肺→大椎、曲池」（病程阶段不匹配，该证改走第三态）；替换 4 处（肺脾气虚 脾俞→关元、胃阴不足 内庭→太溪、瘀血停胃 三阴交→血海、痛经湿热 次髎→曲池）；寒凝血瘀删中极；痛经证型规范名 `湿热蕴结`→`湿热瘀阻`。新增权威等级档位 `professional_society_consensus`（专家共识），并对**组合推导**的配穴封顶等级为 `project_governed_source`，不继承被引来源等级。三条规则新增病历证据门槛（表寒/痰湿/肝肾亏虚证据成立才自动加穴） | **否。** 出参字段未变；`authorityTier` 新增一个取值 `professional_society_consensus`（按可扩展枚举处理即可），证型配穴内容按临床终审结论更新 |
| V1.6 | 2026-08-11 | **① V1 契约兼容闭环（勘误 V1.4）**：`protocolStatus` 的第三态此前在 `schemaVersion` 不变的前提下上线，对严格枚举反序列化的集成方是破坏性变更。现改为 **V1 默认只回旧两态**（第三态向保守侧折叠），新增非破坏字段 `tailoringStatus` 承载三态真实值，**V2 显式请求**才开放真三态；同时随文档发布 JSON Schema。**② 证型配穴逐条、逐穴分级**：新增 `pointProvenance[]`（逐穴来源/权威等级/终审状态/分歧说明）、`sourceAuthorityTier`、`adjudicationStatus`、`deferredSyndromeRefinement`。45 条证型加减经逐条复核，32 条已核验、13 条待中医师终审；**未终审条目不再标为患者级个体化方案**，其加穴不予应用（剔除穴仍应用，保守方向） | **否。** V1 出参的枚举取值反而**收窄**回 V1.3 的两态，比 V1.4 更兼容；其余均为新增可选字段。若贵方已按 V1.4 适配了三态，请改用 `?schemaVersion=v2` 保持原行为 |
| V1.5 | 2026-08-11 | **① 方名可追溯性修复（甲方 0807 起的最大遗留项）**：`formula.candidates[].formulaSource` 此前对 10 类常用经方判为「无出处」，进而把方名改写成「本例辨证组方」——根因是「这张处方是不是 X 方」在系统内有两个互不相识的判据。收敛为一个之后，参苓白术散、四君子汤加减（党参代人参）、异功散加减、五子衍宗丸加减、缩泉丸加味、五磨饮子加减、六神散加减、杏仁煎、四神散加味、调经方加味等均可正常给出方名与出处。同一批归档 M04 重放：医生页面带方名 5/39→15/39。**② 页面与载荷不再各说各的**：方名身份恢复此前发生在可见正文重建之后，导致同一份响应里页面写「自拟方」、签名载荷与 HIS 写经方名；已改为恢复在前、渲染在后。**③ 中医外治项目不再整条丢失**（见上方 A.1 说明）。**④ 新增 HIS 出参** `prescriptions.modifications[].triggerSource`、`diagnoses.terminologyMappings[]`。**⑤ 文档安全**：全部 curl 示例改用 `$TOKEN` 占位，不再内联真实令牌 | **否。** 出参只增不删，字段语义未变。`formulaSource.evidenceLevel` 与 `constructionType` 的**取值分布**会明显变化（更多候选从 `model_inference`/`self_devised` 变为 `kb_entry`/`classic_text`+`single_base`），这是修复结果不是契约变更；若贵方按「方名恒为自拟」做过特殊处理，请撤销 |
| V1.4 | 2026-08-10 | **① 文档更正**：R5"不可跳段返回 409"与实现不符，改为如实写出真实存在的三道门（M02 阶段门、M04/M05 签名门）；M01 流程图标签由"结构化病历"更正为"舌象图片解析"，与出参表一致。**② 补回丢失章节**：新增 §3.11 `CDSS_GATE_DISPOSITION` 处置档位（advise 默认 / block 回滚），该语义在 20260803 版写过、V1.3 整段丢失。**③ 行为修复**：`symptoms` 支持字符串与字符串数组（此前被静默丢成 `{}`，导致现病史整段消失与红旗漏检）；急症排查确认由字数校验改为逐条红旗处置留痕契约（签名版本 v1→v2，旧凭证失效）；库存导入新增分片整批替换，`413` 不再建议会导致数据丢失的"分批"。**④ 新增出参**：`guidelineReferences[]`、`protocolStatus` 第三态、`protocolGapNote`、`clinicalReviewMethod`、加减 `riskNote` 补齐到全部出口 | **是（三处）**：<br>① 急症排查确认接口**入参新增必填 `findings`**，旧调用会返回 `400`；<br>② `protocolStatus` **新增枚举值** `governed_class_template_not_syndrome_tailored`，按"非个体化即评估态"的旧解析会误降级；<br>③ 升级前签发的 `emergencyClearance` 凭证一律失效（fail-closed 方向，见 §4.8） |
| V1.3 | 2026-08-07 | 补齐 NDJSON 四种帧的完整定义（新增 `heartbeat`、`followup_timeline` 两种此前未文档化的帧）与流响应头；明确"首字节前/后失败"的两种错误表现；错误响应体形态与结构化 `code` 速查表；新增 §3.8 调用频率限制、§3.9 超时与重试、§3.10 请求体上限；补失败响应示例；解析示例改为边收边解析并处理分片与截断 | 否。均为既有行为的补充说明，接口本身未变 |
| V1.2 | 2026-08-07 | 接口按对象分组、字段补中文名、补完整调用示例；新增 CaseState 入参字段表（含 `tcmLineagePreference`、`herbCountPreference`）；流派对外收敛为 5 档 | 否 |
| V1.1 | 2026-08-06 | 按《核对内容（2026-08-05）》「接口缺失内容」补齐：方义/组成逻辑/方证鉴别/经典条文、剂数与煎服法、随证加减与可替换药味、中成药完整字段、健康调护、中医外治、药品目录下发与院内库存导入 | 否，均为新增出参与新增接口 |
| V1.0 | 2026-08-05 | 首次正式发布，8 个接口 | — |

**版本与兼容策略**

1. 出参字段**只增不删**。新增字段一律可选，老集成忽略即可，不需要同步升级。
   **例外须显式登记**：V1.4 的三处破坏性变更已在上表"是否影响已完成的集成"列逐条写明，
   不属于静默上线。枚举字段（如 `protocolStatus`）的新增取值按"可扩展枚举"处理，
   请用白名单匹配已知值 + 未知值降级展示，不要用"非 A 即 B"的二分逻辑。
2. 新增 NDJSON 帧类型时不改变既有帧语义。请按 §3.5 的三条解析要求实现，即可自动兼容。
3. 若确需破坏性变更，会提前在本表登记并单独通知，不会静默上线。
4. 线上实际运行的服务版本可通过 `GET /api/diagnosis/health` 的版本标识核对，与本文档表头的"服务版本"一致即为对齐。
