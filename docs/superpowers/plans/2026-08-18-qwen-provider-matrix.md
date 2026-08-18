# Qwen Provider and Model Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留 DeepSeek 可回退路径的前提下，将百炼 Qwen 正式模型接入主生成、快速任务、修复与复核相位，并用统一请求塑形与真实健康探针阻止厂商参数漂移。

**Architecture:** `text-model.ts` 成为模型家族、端点政策、凭据选择和请求参数的单一权威。所有调用点只询问“已批准模型”和 `textModelRequestTuning()`，不再自行拼 DeepSeek/Qwen 参数；默认矩阵使用 Qwen，DeepSeek 配置完整保留为运维回退。任何默认切换都必须先通过离线合同与真实模型探针。

**Tech Stack:** Next.js 16、TypeScript 5 strict、OpenAI Chat Completions 兼容接口、阿里云百炼、Node/Jiti 确定性测试。

---

## 执行约束

- API Key 只从环境变量读取，不写入源码、文档、Git、测试快照或命令输出。
- 正式模型矩阵：主生成 `qwen3.7-plus`；快速任务 `qwen3.7-flash`；关键修复/复核 `qwen3.8-max`。
- Qwen 默认显式关闭思考；真实探针必须确认最终 `content`、`finish_reason` 与 JSON 合同。若正式 Max 不允许关闭思考或 JSON 不稳定，自动回退 `qwen3.7-plus`，不得让发布门变成凭运气通过。
- DeepSeek `deepseek-v4-flash` 回退路径和 `api.deepseek.com` 批准端点必须持续通过测试。
- 舌象视觉暂不切换，继续使用既有 GLM 路径。

### Task 1: 定义双家族模型政策的 RED 合同

**Files:**
- Modify: `scripts/test-upstream-guards.mjs`
- Create: `scripts/test-text-model-request-tuning.mjs`
- Modify: `package.json`
- Modify: `scripts/run-deterministic-regression.mjs`

- [ ] **Step 1: 写批准名单与配置测试**

测试必须断言：

```js
assert.equal(isApprovedTextModel("deepseek-v4-flash"), true);
assert.equal(isApprovedTextModel("qwen3.7-plus"), true);
assert.equal(isApprovedTextModel("qwen3.7-flash"), true);
assert.equal(isApprovedTextModel("qwen3.8-max"), true);
assert.equal(isApprovedTextModel("glm-5"), false);
```

并分别构造 `AI_TEXT_PROVIDER=openai-compatible` 与 `AI_TEXT_PROVIDER=bailian-qwen`，确认凭据、端点和模型来自各自变量，未知供应商 fail-closed。

- [ ] **Step 2: 写请求塑形测试**

```js
assert.deepEqual(
  textModelRequestTuning("deepseek-v4-flash", { reasoningEffort: "low", thinkingEnabled: false }),
  { reasoning_effort: "low", thinking: { type: "disabled" } },
);
assert.deepEqual(
  textModelRequestTuning("qwen3.7-plus", { reasoningEffort: "medium", thinkingEnabled: false }),
  { enable_thinking: false },
);
```

未知模型返回空对象，不得把任一厂商私有参数发给未知端点。

- [ ] **Step 3: 注册测试并验证 RED**

Run:

```bash
npm run test:text-model-tuning
```

Expected: 因 `isApprovedTextModel` / `textModelRequestTuning` 尚不存在而失败。

- [ ] **Step 4: 提交 RED 检查点**

```bash
git add scripts/test-text-model-request-tuning.mjs scripts/test-upstream-guards.mjs package.json scripts/run-deterministic-regression.mjs
git commit -m "test: define qwen model policy and request tuning"
```

### Task 2: 实现 provider-neutral 配置与参数塑形

**Files:**
- Modify: `src/lib/text-model.ts`
- Test: `scripts/test-text-model-request-tuning.mjs`

- [ ] **Step 1: 增加模型家族谓词**

```ts
export function isQwenModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("qwen");
}

export function isApprovedTextModel(model: string): boolean {
  return isDeepseekModel(model) || isQwenModel(model);
}
```

- [ ] **Step 2: 增加统一请求塑形**

```ts
export function textModelRequestTuning(
  model: string,
  options: { reasoningEffort?: string; thinkingEnabled?: boolean },
): Record<string, unknown> {
  if (isDeepseekModel(model)) {
    return {
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      ...(options.thinkingEnabled == null ? {} : { thinking: { type: options.thinkingEnabled ? "enabled" : "disabled" } }),
    };
  }
  if (isQwenModel(model)) {
    return options.thinkingEnabled == null ? {} : { enable_thinking: options.thinkingEnabled };
  }
  return {};
}
```

- [ ] **Step 3: 让主配置按 provider 选择**

`getPrimaryTextModelConfig()` 对 `bailian-qwen|bailian|qwen` 返回 `getBailianQwenConfig()`；`openai-compatible|deepseek` 返回 DeepSeek 配置；其他值 fail-closed。Qwen 与 DeepSeek 分别读取自己的 Key/Base URL/Model，不相互借用凭据。

- [ ] **Step 4: 双端点批准名单**

默认批准 `api.deepseek.com`、`dashscope.aliyuncs.com`；附加主机统一读取 `CDSS_TEXT_MODEL_ALLOWED_HOSTS`，历史 `CDSS_DEEPSEEK_ALLOWED_HOSTS` 继续兼容。

- [ ] **Step 5: 运行 GREEN**

```bash
npm run test:text-model-tuning
npm run test:upstream-guards
npm run typecheck
```

- [ ] **Step 6: 提交 GREEN 检查点**

```bash
git add src/lib/text-model.ts
git commit -m "feat: support approved qwen text models"
```

### Task 3: 收敛全部文本调用点

**Files:**
- Modify: `src/lib/diagnosis-api.ts`
- Modify: `src/lib/clinical-facts-runtime.ts`
- Modify: `src/lib/controlled-semantic-normalization.server.ts`
- Modify: `src/lib/formula-recall-normalization.server.ts`
- Modify: `src/lib/polarity-negation-assist.server.ts`
- Modify: `src/lib/syndrome-hypothesis-rerank.server.ts`
- Modify: `src/lib/m02-answer-interpreter.server.ts`
- Modify: `src/lib/m02-question-review.server.ts`
- Modify: `src/lib/m05-followup-authoring.server.ts`
- Modify: `src/lib/medicine-candidate-planner.server.ts`

- [ ] **Step 1: 扩展源码守卫为失败测试**

`test:text-model-tuning` 扫描上述文件，禁止新增或残留调用点内联：

```js
/reasoning_effort\s*:|thinking\s*:\s*\{|enable_thinking\s*:/
```

允许位置只有 `src/lib/text-model.ts`。

- [ ] **Step 2: 验证 RED**

Expected: 当前 14 处厂商参数散写触发失败。

- [ ] **Step 3: 替换政策门与参数散写**

- 配置/模型准入使用 `isApprovedTextModel`。
- 每次请求 spread `textModelRequestTuning(model, options)`。
- 原本仅 DeepSeek 才附加私有字段的调用，Qwen 自动得到 `enable_thinking`；未知模型不附加任何字段。
- `deepseek_text_policy` 原因码迁移为 `text_model_vendor_policy`，同步所有断言与遥测。

- [ ] **Step 4: 运行专项回归**

```bash
npm run test:text-model-tuning
npm run test:clinical-facts
npm run test:m03-clinical-review
npm run test:stream-safety
npm run test:controlled-semantic-normalization
```

- [ ] **Step 5: 提交调用点收敛**

```bash
git add src/lib scripts/test-*.mjs
git commit -m "refactor: centralize text model vendor tuning"
```

### Task 4: 落地模型矩阵与可回退配置

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `scripts/test-upstream-guards.mjs`

- [ ] **Step 1: 更新期望矩阵**

```text
AI_TEXT_PROVIDER=bailian-qwen
BAILIAN_QWEN_MODEL=qwen3.7-plus
OPENAI_MODEL=deepseek-v4-flash
PRIMARY_DIAGNOSE_MODEL=qwen3.7-plus
PRIMARY_DIAGNOSE_REPAIR_MODEL=qwen3.8-max
PRIMARY_PRESCRIBE_MODEL=qwen3.7-plus
PRIMARY_PRESCRIBE_REPAIR_MODEL=qwen3.8-max
PRIMARY_CLINICAL_REVIEW_MODEL=qwen3.8-max
PRIMARY_DIAGNOSE_REVIEW_FALLBACK_MODEL=qwen3.7-plus
PRIMARY_PRESCRIBE_REVIEW_FALLBACK_MODEL=qwen3.7-plus
CLINICAL_FACTS_MODEL=qwen3.7-flash
CLINICAL_FACTS_REVIEW_MODEL=qwen3.7-plus
CLINICAL_FACTS_ADJUDICATION_MODEL=qwen3.8-max
CONTROLLED_TERMINOLOGY_MODEL=qwen3.7-flash
```

- [ ] **Step 2: 明确回退说明**

文档必须列出切回 DeepSeek 所需 provider 与阶段模型变量，且不要求删除百炼 Key。

- [ ] **Step 3: 验证配置合同**

```bash
npm run test:upstream-guards
```

- [ ] **Step 4: 提交配置矩阵**

```bash
git add .env.example docker-compose.yml scripts/test-upstream-guards.mjs
git commit -m "config: define qwen production model matrix"
```

### Task 5: 真实健康探针与正式 Max 降级策略

**Files:**
- Modify: `src/lib/text-model.ts`
- Modify: `src/lib/diagnosis-api.ts`
- Create: `scripts/probe-qwen-model-matrix.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写探针输出合同**

探针逐模型记录且不得记录 Key、prompt 或患者信息：

```ts
type ProbeRow = {
  model: string;
  phase: "primary" | "fast" | "critical";
  httpOk: boolean;
  finalContent: boolean;
  finishReason: boolean;
  jsonObject: boolean;
  thinkingDisabledAccepted: boolean;
  durationMs: number;
};
```

- [ ] **Step 2: 实现三个无患者数据请求**

- plus：流式最终正文探针。
- flash：`response_format=json_object` 非思考探针。
- max：非思考 JSON 探针；若供应商拒绝关闭思考或 JSON 不合法，标记 critical 不可用并验证回退 plus 成功。

- [ ] **Step 3: 健康检查复用统一塑形**

`runTextModelHealthCheck()` 与 `probeClinicalReviewCandidate()` 都使用 `textModelRequestTuning()`；只有最终 content 且有 finish reason 才算绿。

- [ ] **Step 4: 运行真实探针**

```bash
node --env-file-if-exists=.env.local scripts/probe-qwen-model-matrix.mjs
```

Expected: plus/flash 必须绿；max 绿则启用，max 红则自动回退 plus 且发布仍可继续，但报告必须明确 critical fallback。

- [ ] **Step 5: 提交探针**

```bash
git add src/lib/text-model.ts src/lib/diagnosis-api.ts scripts/probe-qwen-model-matrix.mjs package.json
git commit -m "test: add qwen production matrix probe"
```

### Task 6: 发布前验证

**Files:**
- Output only: `artifacts/qwen-model-matrix/`

- [ ] **Step 1: 运行发布总闸**

```bash
npm run verify:release
```

- [ ] **Step 2: 本地生产构建真实探针**

```bash
npm run build
npm start
curl -H "x-cdss-api-token: $CDSS_API_TOKEN" "http://localhost:3000/api/model-health?check=1"
curl -H "x-cdss-api-token: $CDSS_API_TOKEN" "http://localhost:3000/api/diagnosis/health?strict=1"
```

- [ ] **Step 3: 小规模临床回归**

至少运行红旗、普通反流、普通咳嗽、否定式既往史和处方审方各一例；任何模型切换导致的合同分布变化先归因后再扩大到 77 例。

- [ ] **Step 4: 推送但不生产部署**

模型体系包完成后推送当前协同分支；生产部署留到渐进输出、基线和可观测包全部完成。
