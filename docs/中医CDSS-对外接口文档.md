# 中医临床决策支持系统（中医 CDSS）接口文档

| 项 | 内容 |
|---|---|
| 文档版本 | V2.0 |
| 发布日期 | 2026-08-11 |
| 服务版本 | `tcm-cdss-20260811-clinician-verdict-r1-amd64` |
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

接口详细定义见 §4。诊疗结果各项内容在响应中的字段位置见 §5。

另有两项能力（HIS 诊疗方案打包导出、服务健康检查）与主链路无关，见附录 A。

### 2.1 快速开始：先跑通第一次调用

在对接五阶段主链路之前，建议先用这三步确认网络、鉴权与版本三件事都对齐，
把环境问题与业务问题分开排查。

```bash
BASE="https://82.156.128.153/tcm-cdss"
TOKEN="<接口令牌>"

# ① 连通性与版本核对：确认所连服务与本文档表头的「服务版本」一致
curl -s "$BASE/api/diagnosis/health" -H "x-cdss-api-token: $TOKEN"

# ② 鉴权校验：令牌正确返回 {"ok":true}，错误返回 401
curl -s -X POST "$BASE/api/auth/access" \
  -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}"

# ③ 业务路由连通性：库存查询不经模型、不计入调用频率限制，响应即时，
#    适合作为首个业务接口冒烟（未导入库存时返回 inventoryLoaded=false，属正常）
curl -s "$BASE/api/drug-inventory" -H "x-cdss-api-token: $TOKEN"
```

三步都通过后，再按 §6.1 的完整链路示例接入 M01–M05。

> 首个**临床**接口建议直接用 M03（§4.4），它是主链路上信息量最大的一段。
> 注意红旗筛查（§4.7）虽然判定规则是确定性的，但会触发语义红旗预检，
> 属于计入调用频率限制的模型调用类接口（§3.8），不适合当作高频探活。
**首次接入务必先读 §3.3（五条强制要求）与 §3.5（流式帧解析），这两处是集成失败的主要来源。**

---

## 3. 通用约定

### 3.1 鉴权

所有接口均需鉴权。请求头二选一：

| 方式 | 请求头 |
|---|---|
| 自定义头 | `x-cdss-api-token: <令牌>` |
| 标准头 | `Authorization: Bearer <令牌>` |

未携带或令牌错误返回 `401`。

> **本文档中的所有 curl 示例统一使用 `$TOKEN` 占位**，请先在 shell 中导出真实令牌再执行：
> ```bash
> export TOKEN="<贵方接口令牌>"
> ```
> V1.4 之前的版本在示例里内联了生产环境的真实令牌。本次（V1.5）已全部改为占位符，
> 但**旧版本文档与其历史副本仍含明文令牌**；请按贵方安全规范决定是否轮换该令牌，
> 轮换需同步更新服务端 `CDSS_API_TOKEN` 与全部集成方配置（轮换后旧令牌立即失效）。

### 3.2 请求头

| 请求头 | 必填 | 值 |
|---|---|---|
| `Content-Type` | 是 | `application/json` |
| `x-cdss-api-token` | 是 | 接口访问令牌 |

### 3.3 参数传递要求

**以下五条为强制要求，不满足将导致接口报错或链路中断。**

| 编号 | 要求 | 不满足的后果 |
|---|---|---|
| R1 | `caseState.id` 必填，且**同一次就诊全流程使用同一个值** | M04 返回 `409` 签名校验失败 |
| R2 | 上一阶段返回的结构化结论必须**原样**合并回 `caseState`，不得改写、精简或重新格式化 | 签名校验失败，返回 `409` |
| R3 | M03 结论中的签名字段名为 `contractSignature`（非 `signature`） | 取值为空，回传后 `409` |
| R4 | 查询参数中的中文必须 URL 编码 | 反向代理返回 `400` |
| R5 | 建议按 M01→M02→M03→M04→M05 顺序调用；**真实门禁只有三道**，不是"任意跳段即 409" | 见下方 R5 说明 |

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
| `phase` | enum | 建议 | `idle`/`collect`/`question`/`diagnose`/`prescribe`/`assess`/`done`/`error` | 全阶段 | **枚举外的值会让整个 caseState 被拒**（400），不是被忽略。M02 要求 `phase="question"` |
| `patient.sex` | string | 建议 | 男/女 | 全阶段 | `hisRecord.fields.sex` 优先 |
| `patient.age` | number | 建议 | — | 全阶段 | 影响特殊人群剂量规则与儿科门禁 |
| `patient.name` | string | 否 | — | — | **提交后恒被服务端清空**（脱敏），不要用它传身份信息 |
| `chiefComplaint` | string | 是 | — | M01 起 | 缺失时 M03 不进入完整诊断 |
| `symptoms` | string \| string[] \| object | 建议 | — | M01 起 | 现病史等症状信息。**三种形态等价**：给字符串或字符串数组时归一到 `symptoms.presentHistory`；给对象时按键原样保留。<br>V1.3 及以前的实现只认 object，字符串会被静默丢成 `{}`（整段现病史消失且请求仍返回 200），**V1.4 已修复**。<br>与 `hisRecord.fields.xianbingshi` 同时存在时以后者为准，自由文本并入 `symptoms.extraText`，不丢字 |
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
| `warm-tonify-yang` | 温补/扶阳思路 | 学术流派 | 温补、扶阳、温阳、火神 |

以上五档即全部取值。**传入其他值不会报错，按 `unrestricted` 处理**——请不要依赖服务端对未知流派名报错来做前端校验。

默认档 `unrestricted` 不是"没有流派"，它是**以脏腑辨证 + 通用方为主**的工作路径（归脾汤、逍遥散、参苓白术散、六味地黄丸这类方在默认档下正常出现）。选择其余四档，是让系统在同等安全条件下优先按该体系的辨证眼目和常用方组织思路。

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
| M04 签名门 | `/api/diagnosis/prescribe` | 缺少有效的 M03 `contractSignature`（未原样回传 R2/R3） | `409` |
| M05 签名门 | `/api/diagnosis/assess` | 缺少有效的 M03/M04 签名 | `409` |

也就是说：**M01 与 M02 都可以跳过**；M03 之后的两段必须携带上一段的原样签名结论。

---

### 3.11 处置档位 `CDSS_GATE_DISPOSITION`（红旗命中后系统怎么表现）

这一节在 20260803 版写过，V1.3 整段丢失，导致同一份文档在不同环境下"说的和看到的不一样"。
红旗**检测**在两档下完全相同，差别只在**处置**：

| 档位 | 部署默认 | 红旗命中后的表现 |
|---|---|---|
| `advise` | **是**（未设置该环境变量即为本档） | 检测照常、红旗照常输出，**M03/M04 继续生成完整结论与剂量级候选**；可见正文置顶一段确定性安全警示横幅（`<!-- CDSS_SAFETY_ADVISORY -->`），用药风险段把急诊/转诊评估列为第一优先级。`derivePrescriptionPermission` 返回 `full_dose` |
| `block` | 否（仅用于运维回滚） | 恢复旧的 fail-closed 拦截：M03/M04 只输出风险、处置与建议检查，不生成剂量级候选 |

> 若贵方在测试中看到的是"只输出风险/处置/检查"，说明该环境设置了 `CDSS_GATE_DISPOSITION=block`
> 或运行的是旧版本。对账前请先核对该环境变量与 §2.1 的服务版本。
>
> 逐味硬规则不受档位影响：药典剂量上下限、十八反十九畏、特殊人群禁忌、管制毒性药材扣除、
> PHI 脱敏在两档下逐字节相同。"不阻断"只作用于**处置**，不作用于**检测**，
> 也绝不把"未知"当成"无风险"。

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

每行一个完整 JSON 对象，以 `\n` 分隔。**共四种帧**：

| 帧 | 出现时机 | 处理方式 |
|---|---|---|
| `{"content":"<文本片段>"}` | 全程 | 按到达顺序拼接为正文 |
| `{"content":"[END]"}` | 流正常结束 | 结束解析；**未收到该帧即视为流被截断** |
| `{"error":"<错误描述>"}` | 流内错误 | 终止解析并向上报错；该帧之后不会再有内容 |
| `{"type":"heartbeat","status":"<进度描述>","processedChars":<已处理字符数>}` | 模型长时间推理期间，每 5 秒一帧 | **跳过，不计入正文**；可用于驱动前端进度提示 |

当本阶段结果含结构化随访节点时（最常见于 M05），流内还会多下发一帧：

| 帧 | 说明 |
|---|---|
| `{"type":"followup_timeline","timelineItems":[<随访节点数组>]}` | 随访节点数组，与正文并行下发；该帧**出现在正文之前**。不需要时跳过即可 |

**解析器必须做到三点**，否则后续版本新增帧类型时会误判为故障：

1. 只拼接**含 `content` 字段**的帧，其余一律跳过；
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
| `409` | 流程状态或签名不满足前置条件 | 否 | 见 §3.3 强制要求；须回到上一阶段重新取结论 |
| `413` | 请求体超出上限 | 否 | 见 §3.10；分批或压缩后重试 |
| `422` | 业务前置条件不满足（内容合法但当前状态下不可执行） | 否 | 见各接口说明与 `code` |
| `429` | 触发调用频率限制 | **是** | 按 `Retry-After` 秒数退避后重试，见 §3.8 |
| `503` | 依赖未就绪或服务暂不可用 | **是** | 指数退避后重试 |
| `304` | 增量拉取时目录未变更（仅药品目录下发） | — | 沿用本地缓存 |

**结构化错误码速查**

| `code` | 状态码 | 触发条件 |
|---|---|---|
| `required_field_missing` | `400` | 必填字段缺失 |
| `invalid_m03_signature` | `409` | M03 结论被改写或未原样回传（R2/R3） |
| `invalid_m04_signature` | `409` | M04 结论被改写或未原样回传（R2） |
| `invalid_candidate_index` | `422` | 指定的候选方序号不存在 |
| `invalid_structured_herb` | `422` | 药味缺名称、剂量非单一正数，或缺对应病机/功用 |
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
| M03 整体编排（含复核与修复轮） | 180 秒 |
| M04 整体编排（含复核与修复轮） | 120 秒 |
| 舌象图片识别 | 120 秒 |
| 心跳间隔 | 5 秒 |

**客户端超时建议不低于 200 秒**，否则会在服务端仍在正常推理时被客户端单方面切断。
心跳帧（§3.5）的作用正是让连接在长推理期间保持活跃，请勿把"一段时间没有正文"判为超时。

**重试语义**：M01–M05 均为**非幂等**接口——同一 `caseState` 重复调用会重新生成内容，
结论文字可能不同，但不会产生重复的业务副作用（系统无处方落库，结论由贵方决定是否采纳）。
`429`/`503` 可安全重试；`4xx` 中的其余状态原样重试必然重复失败，须先修正请求。

### 3.10 请求体上限

| 接口 | 上限 |
|---|---|
| M01 病历采集 | 约 5.6 MB（舌象图片 ≤4 MB，自由文本 ≤12000 字符） |
| M02–M05 及其余诊疗流程接口 | 1 MB |
| 院内库存导入 | 8 MB，且条目数 ≤20000 |

超限返回 `413`，响应体写明实际字节上限。库存导入超限时请**分批**，不要截断——
被截掉的药会被判为"院内无库存"。

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
| `m02Plan.decision` | 追问决策 | string | `ask`（需追问）/ `proceed`（无需追问） |
| `m02Plan.rationale` | 决策理由 | string | 决策理由 |
| `m02Plan.questions` | 追问列表 | array | 追问列表，`decision=proceed` 时为空数组 |
| `m02Plan.questions[].id` | 问题标识 | string | 问题标识 |
| `m02Plan.questions[].question` | 问题文本 | string | 问题文本 |
| `completeness` | 病历完整度 | object | 病历完整度评估 |

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
| `primarySyndrome` | 主证候 | string | 采用 GB/T 16751 国标证候名，不含病机描述 |
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
| `name` | 西医主要诊断 | string | 症状级工作诊断统一写成「规范症状名，病因待查」形态。**取值可能为空串**，表示本次未形成西医工作诊断，请按缺失处理 |
| `status` | 诊断程度 | string | `考虑` / `需排除` / `证据有限` |
| `confidence` | 置信度 | string | `高` / `中` / `低` |
| `supportingFacts` | 支持依据 | array | 只收与该诊断直接相关的当前患者事实；舌脉、证候、病机不进此栏 |
| `limitations` | 待查依据·资料限制 | array | 当前证据不足在哪、缺哪一条判定条件 |
| `suggestedChecks` | 待查依据·建议检查 | array | 补什么能推进诊断。分层给出——先补充问诊/生命体征/查体，仅在已有红旗或明确鉴别指征时才列影像与成套化验 |
| `clinicalRationale` | 推理说明 | string | 事实到诊断倾向的推理，不复述病史 |
| `coding` | ICD-10 编码 | object | `{system, code, display, source}`，服务端确定性编码。可选：仅当匹配到受控医保码时输出 |

`westernDiagnosis.differentials[]` 西医鉴别诊断：`{name, reason, distinguishingPoints, nextCheck}`

**病机 `pathogenesis`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `summary` | 病机概要 | string | — |
| `locationDifferentiation.items` | 病位 | array | 如 `["心","脾"]` |
| `natureDifferentiation.items` | 病性 | array | 如 `["气血亏虚"]` |
| `symptomClusters` | 症状群 | array | `{symptoms, mechanism}` |
| `chain` | 病机链 | array | 见下 |
| `uncertainties` | 待复核不确定项 | array | `{item, reason, affects}`；无待复核项时为空数组 |

`pathogenesis.chain[]` 病机链

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `nodeId` | 节点标识 | string | 如 `P1`。M04 的药味与外治项目用 `targetRef` 引用它 |
| `patientFact` | 患者事实 | string | — |
| `syndromeEvidence` | 证候依据 | string | — |
| `pathogenesis` | 病机描述 | string | — |
| `therapyDirection` | 对应治法方向 | string | — |

**治则治法 `therapy`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `overallPrinciple` | 治则 | string | — |
| `overallMethod` | 治法 | string | — |
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
| `applicable` | 适用情形 | string | — |
| `notApplicable` | 不适用情形 | string | — |
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
| `verificationTier` | 剂量核验等级 | string | `verified` 有药典剂量边界 / `unverified_dose` 用量由医师确定 / `identity_pending` 药名待确认 / `toxic_regulated` 管制毒性或法律禁用，须按监管要求单独处理 |
| `doseSource` | 剂量依据来源 | string | `governed_boundary` 受治理边界 / `classical_source` 古籍来源 / `none` 无 |
| `verificationReasons` | 核验依据 | array | 如 `["受治理剂量边界 9-30g 已用于生成后校验"]` |
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
| `targetVolumeMl` | 两煎合并药液量 | number | 儿童 200mL / 成人 500mL |
| `administration` | 服法 | string | 如「饭后温服」 |
| `followUpNode` | 复诊节点 | string | — |

**随证加减 `formula.modifications[]`**

加减针对的是**病历已记录、但主方覆盖不足的兼症**，不是预设的未来症状；加减行本身不携带克数——剂量由药味工作台与审方链路负责。

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `trigger` | 触发事实 | string | 病历已记录的患者事实，逐字引用 |
| `triggerSource` | 事实出处 | object | `{kind, sourceRef, sourceQuote}` |
| `targetPathogenesis` | 对应病机 | string | — |
| `action` | 加减动作 | string | 如 `加川芎` |
| `doseOrHandling` | 剂量或处理 | string / null | 恒为 `null`，加减不下发剂量 |
| `reason` | 加减理由 | string | — |
| `riskNote` | 风险提示 | string | 含「调整后须重新审方」 |
| `substitutions` | 可替换药味 | array | 可选，见下。**仅出现在「加某味药」类加减上**，且需推得出合规替代药 |

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
| `usageBoundary` | 适用边界 | string | 适用范围与服药注意 |
| `course` | 疗程 | string | — |
| `positioning` | 定位 | string | `联合治疗` / `替代方案` / `短期对症` / `需医生评估` |
| `correspondingProblem` | 对应本例问题 | string | — |
| `relationship` | 与饮片方的关系 | string | 是否可叠加 |
| `riskNote` | 风险说明 | string | — |
| `evidenceId` | 说明书条目标识 | string | `EVID-INST-*` / `LOCAL-INST-*` |

`formula.medicineCandidateStatus`：可选，仅当无匹配中成药候选时输出 `{status:"no_evidence_match", reason}`

**健康调护 `nonPharma`**

| 字段 | 中文名 | 类型 | 说明 |
|---|---|---|---|
| `diet` | 饮食调护 | string | — |
| `lifestyle` | 起居调护 | string | — |
| `emotion` | 情志调护 | string | — |
| `precautions` | 注意事项 | array | 0–6 条；无内容时为空数组 |
| `acupointCare` | 穴位保健 | string / null | 可选：无穴位保健建议时为 `null` |
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
| 1 | 审方状态标记 `<!-- TCM_CDSS_RXAUDIT_STATUS:... -->` |
| 2 | 审方关联标记 `<!-- TCM_CDSS_RXAUDIT_CORRELATION:... -->` |
| 3 | 审方范围、录入质量提示、用药风险分级 |
| 4 | 随访计划 |

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
| `409` | M03 签名无效 | `{"error":"...","code":"invalid_m03_signature"}` |
| `409` | M04 签名无效 | `{"error":"...","code":"invalid_m04_signature"}` |

---


**调用示例**

> `reasoningDiagnose`、`reasoningPrescribe` 均须原样回传。

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/assess" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
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
| `available` | 结果是否可用 | boolean | 筛查结果是否可用 |
| `semanticStatus` | 语义筛查状态 | string | `checked` / `unavailable` / `skipped_deterministic_critical_vital` |
| `redFlags` | 命中红旗项 | array | 命中的红旗项 |
| `advisories` | 建议项 | array | 建议项 |
| `clinicalFacts` | 临床事实 | object | 提取的临床事实 |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/red-flags" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
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
| `emergencyClearance.contractSignature` | 服务端签名 | string | `tcm-cdss-emergency-clearance-v2` |

返回对象需整体放入 `caseState.emergencyClearance` 供后续阶段使用。

> **旧凭证不再生效**：签名版本已从 v1 抬到 v2（签名域纳入 `findings`）。
> 升级前签发、且未带 `findings` 的历史凭证一律验签不过，回到"不解除"——这是有意为之的
> fail-closed 方向，请在升级窗口内避免复用跨版本的病例快照。

**错误码**

| 状态码 | `code` | 触发条件 |
|---|---|---|
| `400` | `invalid_emergency_clearance_request` | 缺 `caseState` 或 `assessmentSummary` |
| `400` | `emergency_clearance_assessment_summary_too_short` | 评估小结不足 12 字 |
| `400` | `emergency_clearance_attestations_missing` | 未提交 `findings` |
| `400` | `emergency_clearance_attestation_count_mismatch` | 处置记录与活动红旗未逐条对应 |
| `400` | `emergency_clearance_attestation_finding_unmatched` | 处置记录指向的红旗不在当前安全门内 |
| `400` | `emergency_clearance_attestation_basis_too_short` | 某条 `basis` 不足 10 字 |
| `400` | `emergency_clearance_attestation_basis_not_objective` | 某条 `basis` 未写明做过什么 |
| `409` | `no_active_emergency_finding` | 病例不处于红旗状态 |
| `503` | `emergency_clearance_signing_unavailable` | 服务端签名密钥未配置 |

---


**调用示例**

```bash
curl -X POST "https://82.156.128.153/tcm-cdss/api/diagnosis/emergency-clearance" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
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
| `inboundSyncStatus` | 入站同步状态 | string | 恒为 `not_supported_pending_persistence_decision` |

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
| `items[].kind` | 药品类别 | string | 否 | `herb`（饮片，默认）/ `patent`（中成药） |
| `items[].available` | 是否有货 | boolean | 否 | 是否有货，**缺省为 `true`**（推过来的即视为在售目录） |
| `items[].specification` | 规格 | string | 否 | 规格 |
| `items[].goodsId` | 院内商品号 | string | 否 | 院内商品号 |

**语义：整批替换。** 每次导入完全替换上一批，不做增量合并——增量要求调用方维护删除事件，
而"某药已下架却没推删除"会让系统长期以为它有货，比整批替换危险。

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
  -d '{"source":"HIS-A","items":[...4000条...],"part":{"importId":"imp-20260810","index":0,"total":2}}'
# → 202 {"missingParts":[1],"committed":false}   线上库存仍是上一版本

curl -X POST ".../api/drug-inventory" -H "Content-Type: application/json" \
  -H "x-cdss-api-token: <token>" \
  -d '{"source":"HIS-A","items":[...3000条...],"part":{"importId":"imp-20260810","index":1,"total":2}}'
# → 200 {"itemCount":7000, ...}                  此刻才发生一次原子替换
```

**出参**

| 字段 | 中文名 | 说明 |
|---|---|---|
| `inventoryVersion` | — | 库存版本（内容指纹） |
| `importedAt` / `source` / `itemCount` | 导入时间 / 来源 / 条目数 |
| `availableHerbCount` / `availablePatentCount` | 有货饮片数 / 有货中成药数 |
| `unresolvedNames` | — | **在受控药品目录中找不到对应正名的院内药名**。原样回报供调用方补充映射，不会被静默丢弃 |
| `ambiguousNames` | — | 存在多个候选的院内药名（如"一包针"→千年健/石韦）。系统**绝不自动择一** |

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

### 4.11 院内药品库存查询

与 §4.10 的导入同一路径。返回当前生效的库存快照摘要（批次、条目数、解析状态、歧义与未识别名单）。
**未导入库存时链路行为与接入前逐字节相同**——库存是可得性约束，不是安全控制，缺数据不阻断出方。

---

## 5. 输出字段索引

诊疗结果各项内容在响应中的位置。字段完整定义见对应接口章节。

### 5.1 诊断与辨证（M03 响应）

| 内容 | 字段路径 |
|---|---|
| 西医诊断 | `westernDiagnosis.primary.name` |
| 西医诊断依据 | `westernDiagnosis.primary.supportingFacts` |
| 西医诊断待查依据 | `westernDiagnosis.primary.suggestedChecks`（建议检查）<br>`westernDiagnosis.primary.limitations`（依据不足之处） |
| 西医鉴别诊断 | `westernDiagnosis.differentials[]` |
| ICD-10 编码 | `westernDiagnosis.primary.coding`（可选：仅当匹配到受控医保码时输出） |
| **指南/文献依据** | `westernDiagnosis.primary.guidelineReferences[]`（V1.4 新增，可选）<br>`{evidenceId, citation, url?, appliesTo?}`。题名/机构/年份/URL 由服务端按 `evidenceId` 反查**本轮真检索到**的证据条目渲染，模型只提交条目号与一句适用说明；**本轮未检索到就不输出该字段**，不会回落到模型自撰题名 |
| 中医病名 | `overview.tcmDiseaseName` |
| 中医证候 | `overview.primarySyndrome` |
| 证候依据 | `overview.primarySyndromeBasis[]` |
| 中医病名鉴别 | `overview.tcmDiseaseDifferentials[]` |
| 中医证候鉴别 | `overview.tcmDifferentials[]` |
| 总体病机 | `overview.overallPathogenesis` |
| 病机拆解 | `pathogenesis.chain[]` |
| 病位辨证 | `pathogenesis.locationDifferentiation` |
| 病性辨证 | `pathogenesis.natureDifferentiation` |
| 治则 | `therapy.overallPrinciple` |
| 治法 | `therapy.overallMethod` |
| 分治法 | `therapy.subTherapies[]` |
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
| 随证加减 | `formula.modifications[]` |
| 可替换药味 | `formula.modifications[].substitutions[]`（可选，见下方说明） |
| 中成药与西药候选 | `formula.patentAndWestern[]` |
| 健康调护 · 饮食 | `nonPharma.diet` |
| 健康调护 · 起居 | `nonPharma.lifestyle` |
| 健康调护 · 情志 | `nonPharma.emotion` |
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

M05 响应为 Markdown 文本流，不采用结构化字段，内容依次为：审方范围、录入质量提示、
用药风险分级、随访计划。流中另含一帧结构化随访时间轴（**响应**帧，非入参）：

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
CASE_ID="OPD-20260807-000123"
```

**第 2 步：M03 辨病辨证**

```bash
curl -N -X POST "$BASE/api/diagnosis/diagnose" \
  -H "Content-Type: application/json" \
  -H "x-cdss-api-token: $TOKEN" \
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
        "pathogenesisType": "始动",
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
        "action": "加川芎",
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
        "course": "本候选不形成疗程医嘱",
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

**V1.4 新增出参**

| 字段 | 中文名 | 说明 |
|---|---|---|
| `clinicalReviewMethod` | 临床复核方式 | 本次临床复核的**实际拓扑**。`independence` 取 `cross_model`（换了模型身份的独立复核）或 `same_model_second_pass`（同一模型另起一次无生成侧对话状态的请求：复核专用提示词、只增不减风险提示，**不构成跨模型独立复核**）。当前默认部署为后者。`label`/`note` 是与之匹配的中文说明，医生可见正文里的措辞与该字段同源 |
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

`?strict=1` 会对模型、证据检索、审方、术语库等依赖执行真实探测，任一项未就绪返回 `503`。
该模式会产生真实的上游调用，**不适用于高频轮询**。

---

## 附录 B. 变更记录

| 版本 | 日期 | 变更 | 是否影响已完成的集成 |
|---|---|---|---|
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