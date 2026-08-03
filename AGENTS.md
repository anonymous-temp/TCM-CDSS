<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 中医 CDSS — 项目指南（面向 AI 编码代理）

## 项目概述

中医 CDSS（`tcm-cdss`）是一个面向门诊场景的中医临床决策支持"副驾驶"（copilot）。医生录入病例（一诉五史 / 生命体征 / 四诊 / 检验检查），系统完成：红旗筛查、缺口驱动的追问、西医 + 中医辨证诊断、病机拆解、候选方药/中成药推荐、处方风险提示与随访规划。流程分为 M01–M05 五个阶段。

**核心定位：系统仅为建议性质（advisory only）。** 每一条结论必须可追溯到患者事实、确定性规则命中或知识库/证据条目，否则必须显式标注"证据不足/待检索"。绝不允许模型输出硬性 verdict、编造文献引用，或绕过确定性安全层。

## 技术栈

- **框架**：Next.js 16（App Router，Turbopack，`output: "standalone"`）+ React 19 + TypeScript 5（strict）
- **样式/UI**：Tailwind CSS 4 + shadcn（`src/components/ui`）、lucide-react、react-markdown
- **模型接入**：`openai` SDK，OpenAI 兼容协议；全部文本生成、修复和复核阶段统一使用 DeepSeek V4 Flash（`deepseek-v4-flash`，0731 正式版）；GLM 视觉默认开启且仅用于舌象图片
- **校验**：zod 4
- **数据库**：无 —— 病例状态在浏览器 localStorage（加密快照经服务端 AES-256-GCM）+ 本地 JSON 知识库
- **重要**：本项目没有 `middleware.ts`。请求门控在 `src/proxy.ts`（导出 `proxy()` + `config.matcher`）。写框架代码前先读 `node_modules/next/dist/docs/` 中的官方文档，不要凭训练数据中的 Next.js 经验行事

## 常用命令

```bash
npm run dev                 # 开发服务器（Turbopack）；根路径 → /diagnosis；登录页 /login
npm run build && npm start  # standalone 生产构建 + 启动
npm run lint                # eslint（eslint-config-next）
npm run typecheck           # tsc --noEmit —— 改动 src/lib 后必跑
npm run verify:release      # 发布前总闸：typecheck + lint + test:deterministic + build

# 知识库构建（生成物，见下文"知识库"一节）
npm run build:tcm-knowledge          # 重新生成 src/data/tcm-knowledge.json（依赖外部 CSV，见下）
npm run build:tcm-herb-functions     # python3 脚本
npm run build:tcm-formula-sources    # python3 脚本
```

## 测试策略

项目**没有 jest/vitest/playwright 配置**。测试分两层，全部在 `scripts/` 下：

1. **纯单元测试（约 40 个 `scripts/test-*.mjs`）**：不需要服务器，直接通过 `jiti`（TS 导入）、`node --test` 或 `node --experimental-strip-types` 导入 `src/lib/*.ts`，用 `node:assert` 断言。覆盖确定性安全层 / 临床事实 / 流式契约 / 解析修复等。**改动安全、事实、契约、解析相关代码后必须运行对应的测试**，例如：
   - `npm run test:safety-mutations` —— diagnosis-safety.ts 红旗/儿科门禁变异矩阵
   - `npm run test:clinical-facts` —— 临床事实回补层 + schema 拒绝
   - `npm run test:stage-contract` —— M03/M04 结构化流契约 + sentinel 边界
   - `npm run test:rxaudit-contract` / `test:stream-safety` / `test:m02-contract` / `test:clinical-polarity` / `test:prescription-permission` 等
   - `npm run test:deterministic` —— 确定性回归汇总

2. **Live HTTP 回归**：需要本地运行的服务器和匹配的 `CDSS_API_TOKEN`，否则鉴权路由 401：
   ```bash
   BASE_URL=http://localhost:3000 CDSS_API_TOKEN=<token> npm run regress:tcm-cdss
   ```
   `scripts/regress-tcm-cdss.mjs` 是黄金基线：100+ 请求，断言红旗处理、否定式既往史、安全网误报规避、处方后风险、KB 检索、边界输入与鉴权引导，输出 JSON 摘要，任何失败 exit 1。**改动诊断流水线或安全层前后都应运行。** 其余 `regress:live-*` / `regress:primary-care-50` 等脚本针对特定子系统（模型质量、临床复核、prompt 注入、红旗矩阵等）。

回归/评测输出写入 `artifacts/`（已 gitignore 式的产出目录，勿当源码）；`deeptest/`、`test-results/` 同属测试产出。修复一个误报/漏报时，按项目惯例要**扩展到整个类别**而非单个 case。

## 架构与代码组织

### 现状 vs 文档 —— 先读这段

`docs/*.md` 描述的是一个**尚未实现的 LangGraph/ReAct 目标架构**（`/api/tcm-cdss/run`、SSE、统一 `TcmCdssAiSupportPayload`、结构化 JSON 处方）。**当前实现是线性的 M01–M05 流水线**，流式输出 Markdown+NDJSON，由前端做流程编排。文档自身（§20）也声明不要把兼容层当成目标。当文档中的类型/端点在 `src/` 里不存在时，它是目标规格，不是可调用对象。`docs/` 中还有多份深度测试/评审报告（中文），记录历史问题清单与整改方案。

### 请求流

`src/app/diagnosis/DiagnosisClient.tsx`（约 7.7k 行客户端组件）驱动整个临床流程，调用 `src/app/api/diagnosis/` 下的阶段路由。路由保持薄层：校验 → 确定性安全门 → 构造 prompt → 流式转发，**全部业务逻辑在 `src/lib/`**。

| 路由 | 阶段 | 说明 |
|---|---|---|
| `collect` | M01 | 结构化自由文本；舌象图片默认走 GLM 视觉，只有显式设置 `GLM_VISION_ENABLED=false` 时拒绝上传并要求手工录入（无静默降级） |
| `question` / `question/interpret` | M02 | 生成追问；确定性解析医生自由文本回答为结构化状态更新 |
| `diagnose` | M03 | 西医诊断 + 中医证候 + 病机；由安全门 + 完整度=C 门控；先挂临床事实回补层 |
| `prescribe` | M04 | 中药处方；要求存在可执行的 M03 诊断 |
| `assess` | M05 | 随访/风险汇总本身**完全确定性**（消费灵犀处方后审，不经模型生成）。注意：该路由仍会经 `maybeAttachClinicalFactsBackstop` 触发临床事实回补，指纹未命中缓存时会发生 extract+review(+adjudicate) 模型调用——"M05 不调用 LLM"的旧表述不准确 |
| `red-flags` | — | 当前病例状态的确定性红旗/安全汇总 |
| `post-prescription-risk` | — | 灵犀统一审方 JSON；不可用或缺结构化药味时 fail-closed 并锁定人工复核 |
| `snapshot` | — | 加密病例快照（AES-256-GCM，`CASE_SNAPSHOT_ENCRYPTION_KEY`），鉴权绑定快照所有者 |
| `his-scheme` | — | 生成 HIS "AI 诊疗支持方案" JSON（`src/lib/his-scheme.ts`） |
| `health` / `model-health` / `tcm-knowledge/search` / `tcm-knowledge/herb-function` | — | 健康检查 + 本地 KB 检索。`health?strict=1` 返回 `strictReady`；`model-health?check=1` 做真实模型调用 |
| `auth/access` | — | Token → UI cookie 登录；timing-safe 比较，限流（10 分钟内失败 8 次锁定） |

### 模型 / 流式层 —— `src/lib/diagnosis-api.ts`

`callDiagnosisStream(prompt, backend, images, kind)` 是唯一入口。backend：`deepseek`/`openai` → 主 OpenAI 兼容模型；`glm` → GLM 视觉（仅舌象提取）。EviMed 不是模型后端，而是作为多源证据上下文注入 M03/M04 prompt。

- **分阶段模型配置**（见 `.env.example`）：M03/M04、独立临床复核（`PRIMARY_CLINICAL_REVIEW_MODEL`）、临床事实抽取（`CLINICAL_FACTS_MODEL`）可独立配置；`reasoning_effort` / `thinking_enabled` 也是分阶段环境变量。
  - **实际不存在 `PRIMARY_COLLECT_MODEL` / `PRIMARY_QUESTION_MODEL`**：M01 文本路径根本不调模型（无舌象图时 collect 路由直接返回确定性 NDJSON），M02 只能跟随 `OPENAI_MODEL`。
  - **"独立复核"在默认全 V4-Flash 配置下不是跨模型**：候选链去重后只剩一个模型身份，`independentFromGenerator=false`，实际是对同一模型的第二次无对话状态请求。跨模型拓扑（`PRIMARY_CLINICAL_REVIEW_PROVIDER` ≠ primary）在 `src/` 里是直接判 unconfigured 的死路径。
  - **M04 修复轮的 `reasoning_effort` 硬编码 `"medium"`**，没有环境变量可改；`PRIMARY_PRESCRIBE_REASONING_EFFORT` 只作用于首轮。
- **NDJSON 流式契约**（所有后端与确定性响应共享）：每块 `{"content":"…"}\n`，以 `{"content":"[END]"}\n` 结束；错误为 `{"error":"…"}\n`。任何新增流水线环节都必须说这套契约；`markdownNdjsonResponse()` 把确定性 Markdown 包装进去。
- **关键陷阱**：流只返回 `reasoning_content` 而无 `content` 视为错误（"模型仅返回推理过程"），`model-health?check=1` 校验的是最终内容。
- 超时按流强制：连接 90s / 空闲 60s / 总计 180s，带上游 `AbortController` 取消与 5s 客户端心跳。
- Provider 配置在 `src/lib/text-model.ts`（`AI_TEXT_PROVIDER`）—— 用 `getPrimaryTextModelConfig()` 读取。
- M03/M04 编排各有一道总时限门禁（`M03_ORCHESTRATION_DEADLINE_MS` / `M04_ORCHESTRATION_DEADLINE_MS`，默认各 120s，钳制 60–180s）：超时或同一修复提示重复注入（fixpoint）会提前走向既有的签名有限/非剂量合同，而不是无限烧模型轮次。

### 确定性安全层是承重墙 —— `src/lib/diagnosis-safety.ts`

模型永远不做安全决策。阶段路由先调 `withSafetyGate(caseState)`；安全门确定性地解析生命体征（BP/T/P/R/SpO2 危急阈值）和文本红旗，设置 `allowDiagnosis` / `allowDosePrescription`。失败时路由返回降级、非剂量输出（`buildSafetyLimited*`）—— **fail-closed**：未解风险或不可解析剂量 ⇒ 降级为建议 / "需药师复核"，绝不把"未知"当"无风险"。

- 送数据给模型前必须经过 `sanitizeCaseStateForModel` / `sanitizeFreeTextForModel`。
- 临床事实状态词汇表在 `src/lib/clinical-state.ts`（`positive/possible/negative/historical/unknown`）。**不要把"未提及/unknown"当作阴性** —— "过敏史/用药史未提及"污染是回归套件中显式测试的误报类别。
- **完整度**（`src/lib/diagnosis-parse.ts`）：模型在流中把结构化 JSON 嵌入 `<!-- DIAGNOSIS_JSON_START/END -->` sentinel 之间（经 `diagnosis-prompts.ts` 的 `SENTINEL_INSTRUCTION` 注入）。`determineCompletenessLevel` **在代码中重算等级并覆盖模型的自评** —— C 级要求 redFlag≥0.7 且其余维度 ≥0.6；任何维度 <0.3 ⇒ A；否则 B。只有 C 级进入完整诊断/处方。
- **语义临床事实回补**（`clinical-facts.ts` + `clinical-facts-runtime.ts`）：**仅可追加（additive-only）** 的模型衍生层，补充口语化红旗/随访线索；默认开启（`CDSS_CLINICAL_FACTS_BACKSTOP=false` 关闭）。它只能追加紧急建议，绝不能取消确定性阳性红旗或危急体征；schema 非法条目被隔离，单条编造不能抹掉同批有效条目。
- **客户端编排**在 `src/lib/diagnosis-engine.ts`（浏览器 localStorage 病例持久化，键 `diagnosis_case_*`；自带空闲/总超时 + `AbortController` 的流消费），被 `DiagnosisClient.tsx` 使用。这是客户端流程胶水，不是服务端流水线。

### 知识库 —— `src/lib/tcm-knowledge.ts` + `src/data/tcm-knowledge.json`

约 48k 行的 JSON 是**生成的构建产物，不要手改**。`scripts/build-tcm-knowledge.mjs` 从**兄弟仓库 `合理用药`**（`../../合理用药/…`，可用 `RXAI_DATA_ROOT` / `RXAI_RELEASE_ROOT` 覆盖）的 CSV/JSON 源编译；没有这些源就无法重建。内容含剂量上限、十八反十九畏配伍禁忌、特殊人群规则、煎服法、药材风险分级、中成药与西药相互作用规则、HIS 别名/规格映射。`src/data/` 下另有 `tcm-formula-sources.json` 等生成物。处方后安全权威是 `src/lib/rxaudit.ts` 的灵犀统一审方路径；审方不可用必须 fail-closed 转人工（医生/药师）复核。

### 鉴权 —— `src/proxy.ts` + `src/lib/cdss-auth.ts`

`proxy()` 门控 `/`、`/diagnosis`、`/api/:path*`。当 `CDSS_REQUIRE_API_AUTH=true`、生产环境、或设置了 `CDSS_API_TOKEN` 时鉴权开启。API 调用方发送 `x-cdss-api-token` 或 `Authorization: Bearer <token>`；浏览器通过 `/api/auth/access` 获得 httpOnly cookie `tcm_cdss_ui_access` = `SHA-256("tcm-cdss-ui:"+token)`。proxy 还实现 API 鉴权失败限流与模型调用限流（`CDSS_MODEL_RATE_LIMIT_PER_10_MIN`，默认 60 次/10 分钟，内存态、单实例假设）。**新增 API 路由必须保持在 matcher 覆盖内，绝不允许引入未鉴权旁路。**

## 开发约定与注意事项

- **导入别名**：`@/*` → `src/*`（tsconfig paths）。保持"薄路由 / 逻辑在 lib"的既有分层。
- **一切 fail-closed、证据绑定**：不要新增会输出剂量级处方、指南/DOI 引用或风险结论、却没有确定性规则或 KB 条目支撑的模型调用。
- **`NEXT_PUBLIC_BASE_PATH`** 支持子路径挂载，贯穿 `next.config.ts`、`cdss-auth.ts`、`proxy.ts` —— 构造 URL/重定向时必须尊重它。
- 新请求体走 `readJsonBodyWithLimit` / `readCaseStateRequest`（`src/lib/http-guard.ts`、`diagnosis-request.ts`）做大小上限与 413/400 处理 —— 复用它们。
- `open-code-review-main/` 是 vendored 第三方工具目录，`artifacts/`、`deeptest/`、`test-results/` 是测试产出；四者都在 tsconfig `exclude` 中，不属于应用源码。
- `src/app/api/diagnosis/` 各路由为 `route.ts`；UI 页面在 `src/app/diagnosis/`、`src/app/login/`。

## 部署

- `next.config.ts` 设 `output: "standalone"`，并全局下发安全响应头（CSP/HSTS/X-Frame-Options 等）。
- 根目录 `Dockerfile`（node:24-alpine 多阶段）+ `docker-compose.yml` 构建 standalone 镜像；镜像 tag 必须是不可变的 `IMAGE_TAG`。容器启动时会校验 `NEXT_PUBLIC_BASE_PATH` 与 `NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE` 与构建期一致，不一致直接退出（改了必须重新构建镜像）。
- compose 默认绑定 `127.0.0.1:3000`（`APP_BIND_IP`/`APP_PORT` 可改），生产拓扑假设应用位于终止 TLS 的反向代理之后（与 `CDSS_TRUST_PROXY_HEADERS` 等限流 IP 配置联动，见 `.env.example` 注释）。
- 部署细节另见 `docs/部署运行手册-20260713.md`（中文）。

## 环境变量与安全考量

全部见 `.env.example`（含逐项注释），实际配置放 `.env.local`（`.env*` 已 gitignore，**不要读取/提交真实密钥文件**）。关键项：

- 主模型：`AI_TEXT_PROVIDER`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`，及各阶段模型/推理力度覆盖项
- 舌象视觉：`GLM_API_KEY` + `GLM_VISION_ENABLED`（默认开启；缺 key 或真实探针失败会阻断严格发布就绪，只有显式 `false` 才关闭）；`EVIMED_*`（证据检索）
- 鉴权：`CDSS_API_TOKEN`、`CDSS_REQUIRE_API_AUTH`（默认 true）、`CDSS_TRUST_PROXY_HEADERS`（仅在可信代理后开启）
- 加密/签名：`CASE_SNAPSHOT_ENCRYPTION_KEY`（病例快照，必需）、`REASONING_CONTRACT_SIGNING_KEY`
- 审方：`RXAI_AUDIT_*`（灵犀合理用药审方；结果仅为建议，审方不可用走人工复核而非流程硬停 —— 但缺失结构化药味时 fail-closed）
- 安全基线：鉴权 cookie 为 httpOnly +（生产）Secure；登录与 API 均限流；快照加密且绑定所有者；PHI 准标识符在送模型前经 `phi-sanitizer.ts` 脱敏；prompt 注入防御有专门测试（`test:prompt-injection-defense`）。
