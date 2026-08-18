# Progressive M03 Module Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变最终结构合同、独立复核与签名权威路径的前提下，让 M03 的西医判断、证候、病机链和治法以明确的未定稿模块卡渐进显示。

**Architecture:** 服务端从已闭合的顶层 JSON 片段中读取白名单字段，经片段合同与确定性 Markdown 投影后发出独立 `module_draft` NDJSON 帧。客户端在独立回调中维护仅内存的模块草稿，不把它们拼入最终 content；签名终稿到达后清空草稿并继续使用既有 `STREAM_REPLACE_MARKER` 权威替换。

**Tech Stack:** Next.js 16、React 19、TypeScript strict、NDJSON、Zod 4、Node/Jiti 确定性测试。

---

## 文件职责

- `src/lib/diagnosis-stream-protocol.ts`：共享模块 ID、帧类型与形状解析；不含临床渲染。
- `src/lib/diagnosis-stream-modules.ts`：不完整 JSON 的顶层闭合识别与片段提取。
- `src/lib/diagnosis-stream-module-drafts.ts`：M03 片段合同、白名单 Markdown 投影与禁区扫描。
- `src/lib/diagnosis-api.ts`：在主流和并行西医半完成时发出模块帧，最终正文路径不变。
- `src/lib/diagnosis-engine.ts`：消费模块帧并通过独立回调上报，最终 content 累计不变。
- `src/app/diagnosis/DiagnosisClient.tsx`：维护请求级草稿状态并渲染水印卡；不持久化、不写回。
- `scripts/test-stream-modules.mjs`：片段合同和服务端发帧源守卫。
- `scripts/test-stream-module-frames.mjs`：客户端 NDJSON 消费合同。

### Task 1: 定义共享模块帧协议

**Files:**
- Modify: `src/lib/diagnosis-stream-protocol.ts`
- Create: `scripts/test-stream-module-frames.mjs`
- Modify: `package.json`
- Modify: `scripts/run-deterministic-regression.mjs`

- [ ] **Step 1: 写协议 RED 测试**

测试导入并断言：

```js
const valid = parseStreamModuleDraftFrame({
  type: "module_draft",
  module: "m03.western",
  revision: 1,
  content: "## 西医判断\n**诊断倾向**：反酸",
});
assert.equal(valid?.module, "m03.western");
assert.equal(parseStreamModuleDraftFrame({ type: "module_draft", module: "m04.formula", revision: 1, content: "x" }), null);
assert.equal(parseStreamModuleDraftFrame({ type: "module_draft", module: "m03.western", revision: 0, content: "x" }), null);
assert.equal(parseStreamModuleDraftFrame({ type: "module_draft", module: "m03.western", revision: 1, content: "" }), null);
```

在 `package.json` 注册 `test:stream-module-frames`，并加入 `run-deterministic-regression.mjs`。

- [ ] **Step 2: 运行 RED**

Run: `npm run test:stream-module-frames`

Expected: 因 `parseStreamModuleDraftFrame` 与共享类型尚不存在而失败。

- [ ] **Step 3: 提交 RED 检查点**

```bash
git add scripts/test-stream-module-frames.mjs package.json scripts/run-deterministic-regression.mjs
git commit -m "test: define progressive module frame protocol"
```

- [ ] **Step 4: 实现最小共享协议**

在 `diagnosis-stream-protocol.ts` 增加：

```ts
export const M03_DRAFT_MODULES = [
  "m03.western",
  "m03.syndrome",
  "m03.pathogenesis",
  "m03.therapy",
] as const;

export type M03DraftModule = (typeof M03_DRAFT_MODULES)[number];
export type StreamModuleDraftFrame = {
  type: "module_draft";
  module: M03DraftModule;
  revision: number;
  content: string;
};

export function parseStreamModuleDraftFrame(value: unknown): StreamModuleDraftFrame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.type !== "module_draft" ||
      !M03_DRAFT_MODULES.includes(row.module as M03DraftModule) ||
      !Number.isInteger(row.revision) || Number(row.revision) < 1 ||
      typeof row.content !== "string" || !row.content.trim() || row.content.length > 8_000) return null;
  return row as StreamModuleDraftFrame;
}
```

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
npm run test:stream-module-frames
git add src/lib/diagnosis-stream-protocol.ts
git commit -m "feat: add typed progressive module frames"
```

### Task 2: 实现 M03 片段合同与白名单投影

**Files:**
- Modify: `src/lib/diagnosis-stream-modules.ts`
- Create: `src/lib/diagnosis-stream-module-drafts.ts`
- Modify: `scripts/test-stream-modules.mjs`

- [ ] **Step 1: 把既有测试改成草稿帧 RED**

保留现有“完成顺序/未知模块默认拒绝/M04 不露药名剂量”断言，并新增：

```js
const frames = newM03ModuleDraftFrames(serialized, new Set());
assert.deepEqual(frames.map((frame) => frame.module), [
  "m03.syndrome", "m03.western", "m03.pathogenesis", "m03.therapy",
]);
assert.match(frames[0].content, /生成中 · 未定稿/);
assert.match(frames[0].content, /心脾两虚证/);
assert.match(frames[1].content, /失眠障碍/);
for (const forbidden of ["12g", "DOI", "PMID", "http://", "审方结论", "contractSignature"]) {
  assert.ok(!frames.map((item) => item.content).join("\n").includes(forbidden));
}
```

再构造缺支持事实的 western、缺 chain 的 pathogenesis、含剂量/引用/安全结论的恶意片段，断言对应帧为 `undefined`。

- [ ] **Step 2: 运行 RED 并提交**

```bash
npm run test:stream-modules
git add scripts/test-stream-modules.mjs
git commit -m "test: define validated m03 module drafts"
```

Expected: 因 `newM03ModuleDraftFrames` 尚不存在而失败。

- [ ] **Step 3: 导出闭合顶层值读取器**

把 `topLevelValueJson()` 改为导出的 `completedTopLevelValueJson()`；仅在 `completedTopLevelKeys(partial)` 已包含 key 时返回闭合 JSON，避免未闭合值被误读。

- [ ] **Step 4: 新增片段投影器**

`diagnosis-stream-module-drafts.ts` 实现：

```ts
export function m03ModuleDraftFrame(partial: string, key: string): StreamModuleDraftFrame | undefined;
export function newM03ModuleDraftFrames(partial: string, emitted: Set<string>): StreamModuleDraftFrame[];
```

固定映射：

```ts
const MODULE_BY_KEY = {
  westernDiagnosis: "m03.western",
  overview: "m03.syndrome",
  pathogenesis: "m03.pathogenesis",
  therapy: "m03.therapy",
} as const;
```

每个 renderer 只读取设计文档列出的字段，第一行统一为：

```md
> 生成中 · 未定稿；最终结论以本阶段完成后的签名报告为准。
```

投影完成后用禁区扫描拒绝：剂量/频次模式、`DOI|PMID|https?://|参考文献|指南引用`、`审方结论|安全总评|红旗结论`、`contractSignature|attestation|reasonCode`。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
npm run test:stream-modules
npm run typecheck
git add src/lib/diagnosis-stream-modules.ts src/lib/diagnosis-stream-module-drafts.ts
git commit -m "feat: project validated m03 module drafts"
```

### Task 3: 服务端发出模块帧

**Files:**
- Modify: `src/lib/diagnosis-api.ts`
- Modify: `scripts/test-stream-modules.mjs`

- [ ] **Step 1: 增加服务端源守卫 RED**

断言 `diagnosis-api.ts` 同时存在：

```js
assert.match(apiSource, /enqModuleDraft\(ctrl, frame\)/);
assert.match(apiSource, /newM03ModuleDraftFrames\(/);
assert.match(apiSource, /m03WesternHalfPromise.*then/s);
assert.match(apiSource, /const bufferedClinicalStage = opts\.structuredStage != null/);
```

并断言 `newM03ModuleDraftFrames` 只在 `structuredStage === "diagnose"` 分支调用，M04 仍只有进度提示。

- [ ] **Step 2: 运行 RED 并提交**

```bash
npm run test:stream-modules
git add scripts/test-stream-modules.mjs
git commit -m "test: require server progressive module frames"
```

- [ ] **Step 3: 新增 NDJSON 发帧 helper**

在 `diagnosis-api.ts` 顶层增加：

```ts
function enqModuleDraft(ctrl: ReadableStreamDefaultController, frame: StreamModuleDraftFrame) {
  ctrl.enqueue(enc.encode(`${JSON.stringify(frame)}\n`));
}
```

stream start 内新增 `enqueueModuleDraft()`；写入前再次走 `parseStreamModuleDraftFrame`，非法帧不发送。

- [ ] **Step 4: 主流与并行半接线**

- 中医主流每累计约 200 字符后调用 `newM03ModuleDraftFrames()`，仅发送 overview/pathogenesis/therapy。
- `m03WesternHalfPromise` 创建后挂受控 `.then()`；西医半 `ok` 时从其完整 JSON 构造 `m03.western` 帧。回调必须检查 `clientStreamClosed` 和 `upstreamController.signal.aborted`，失败只跳过草稿。
- 合并后补扫只补漏，不重复发送；每模块 revision 初始为 1。
- 保留既有文本进度行和最终 `STREAM_REPLACE_MARKER`。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
npm run test:stream-modules
npm run test:stream-safety
npm run typecheck
git add src/lib/diagnosis-api.ts
git commit -m "feat: stream validated m03 module drafts"
```

### Task 4: 客户端独立消费模块帧

**Files:**
- Modify: `src/lib/diagnosis-engine.ts`
- Modify: `scripts/test-stream-module-frames.mjs`

- [ ] **Step 1: 写 NDJSON 消费 RED**

构造 Response：模块帧 → 普通 content → 最终替换 content → `[END]`。断言：

```js
const modules = [];
const result = await consumeMarkdownStreamWithMetadata(response, () => {}, {
  onModuleDraft: (frame) => modules.push(frame),
});
assert.equal(modules.length, 1);
assert.equal(modules[0].module, "m03.western");
assert.equal(result.content, "最终签名报告");
assert.ok(!result.content.includes("生成中"));
```

未知模块、revision=0、空 content 分别作为非法帧，断言消费失败为“模型流格式异常”。

- [ ] **Step 2: 运行 RED 并提交**

```bash
npm run test:stream-module-frames
git add scripts/test-stream-module-frames.mjs
git commit -m "test: require isolated module frame consumption"
```

- [ ] **Step 3: 扩展消费选项与两处解析循环**

```ts
type StreamConsumeOptions = {
  // existing fields
  onModuleDraft?: (frame: StreamModuleDraftFrame) => void;
};
```

正常行循环和尾 buffer flush 都在 heartbeat 之后、content 之前解析 `module_draft`。合法帧 `markValidFrame()` 并调用回调；不修改 accumulated。非法 `module_draft` 增加 malformedLines。

- [ ] **Step 4: 运行 GREEN 并提交**

```bash
npm run test:stream-module-frames
npm run test:stream-safety
npm run typecheck
git add src/lib/diagnosis-engine.ts
git commit -m "feat: consume module drafts outside final content"
```

### Task 5: 渲染请求级模块草稿卡

**Files:**
- Modify: `src/app/diagnosis/DiagnosisClient.tsx`
- Modify: `scripts/test-stream-module-frames.mjs`

- [ ] **Step 1: 写 UI 源合同 RED**

断言源码包含：

- `data-testid="streaming-module-drafts"`；
- `data-testid={`streaming-module-${draft.module}`}`；
- 固定 `M03_DRAFT_MODULES` 排序；
- `onModuleDraft` 回调；
- M03 开始、成功、catch、取消/病例切换时清空模块状态；
- “生成中 · 未定稿”可见文案；
- 草稿状态不进入 `saveCase`、snapshot body 或 `CaseState`。

- [ ] **Step 2: 运行 RED 并提交**

```bash
npm run test:stream-module-frames
git add scripts/test-stream-module-frames.mjs
git commit -m "test: require progressive m03 draft cards"
```

- [ ] **Step 3: 实现仅内存状态与回调**

新增：

```ts
type ModuleDraftState = Partial<Record<M03DraftModule, StreamModuleDraftFrame>>;
const [moduleDrafts, setModuleDrafts] = useState<ModuleDraftState>({});
```

M03 请求开始先清空；`consumeMarkdownStream` 的 options 传 `onModuleDraft`，只接受更高或相同 revision 的最新帧。最终返回、失败、取消和病例 ID 变化都清空。

- [ ] **Step 4: 渲染模块卡**

`StreamingPreviewCard` 接收 `moduleDrafts`。进度日志保留在上方；草稿按 `M03_DRAFT_MODULES` 固定顺序渲染，每卡使用 `MarkdownBlock`，外层带琥珀色未定稿水印。只有 `phase === "diagnose"` 且最终 Markdown 尚未到达时展示。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
npm run test:stream-module-frames
npm run test:stream-modules
npm run typecheck
npm run lint
git add src/app/diagnosis/DiagnosisClient.tsx
git commit -m "feat: show progressive m03 draft cards"
```

### Task 6: 发布闸与真实流证据

**Files:**
- Output only: `artifacts/progressive-m03/`

- [ ] **Step 1: 专项回归**

```bash
npm run test:stream-module-frames
npm run test:stream-modules
npm run test:stream-safety
npm run test:stage-contract
npm run typecheck
npm run lint
```

- [ ] **Step 2: 全量发布闸**

Run: `npm run verify:release`

Expected: 两轮 deterministic 全绿且生产构建成功。

- [ ] **Step 3: 真实 Qwen M03 采帧**

用独立本地生产实例运行反流病例，只记录安全元数据：首个模块、各模块到达毫秒、最终 M03 毫秒、模块列表、最终签名是否存在。不得保存 API Key、prompt、患者原文或未净化原始 JSON。

Expected:

```json
{
  "modules": ["m03.western", "m03.syndrome", "m03.pathogenesis", "m03.therapy"],
  "firstModuleBeforeFinal": true,
  "finalSigned": true,
  "failures": []
}
```

- [ ] **Step 4: 推送检查点**

```bash
git diff --check origin/codex/pharmacopoeia-case-regression...HEAD
git push origin codex/pharmacopoeia-case-regression
```

生产部署仍留到后续缓存、基线、M02/KB 包和全量 77 例全部通过后执行。
