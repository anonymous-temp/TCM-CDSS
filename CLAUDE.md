# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> **Next.js 16 — read before writing framework code.** Per AGENTS.md, this is not the Next.js in your training data. The bundled docs are the source of truth: `node_modules/next/dist/docs/` (e.g. `01-app/01-getting-started/16-proxy.md`, `01-app/04-glossary.md`). The most consequential rename here: **there is no `middleware.ts`** — request gating lives in `src/proxy.ts`, which exports `proxy()` + `config.matcher`.
>
> **This file is the single source of project guidance.** AGENTS.md (read by other coding agents) carries only the Next.js notice, a pointer here and a few hard rules; until 2026-09-25 it was a parallel Chinese copy of most of this file and the two had drifted apart in at least six places. Update this file, not a second copy.

## What this is

中医 CDSS — an outpatient Traditional Chinese Medicine clinical decision support "copilot". A doctor enters a case (一诉五史 / vitals / 四诊 / labs); the system does red-flag screening, gap-driven follow-up, western + TCM diagnosis, pathogenesis breakdown, candidate herbal/patent-medicine prescriptions, prescription-risk warnings, and follow-up planning. It is **advisory only** — every conclusion must trace to a patient fact, a deterministic rule hit, or a knowledge-base/evidence entry, or be explicitly marked "证据不足/待检索". Never let the model output hard verdicts, fabricated citations, or bypass the deterministic safety layer.

## Commands

```bash
npm run dev                 # next dev (Turbopack); root → /diagnosis; login at /login
npm run build && npm start  # standalone production build + serve
npm run lint                # eslint --max-warnings=0 — warnings fail, treat them as errors
npm run typecheck           # tsc --noEmit — run this after edits to src/lib
npm run verify:release      # THE release gate: typecheck + lint + test:deterministic + test:deterministic:fresh-artifacts (no build: deploys compile via scripts/deploy/prebuild-local.sh)
npm run build:tcm-knowledge # regenerate src/data/tcm-knowledge.json (needs external CSVs, see below)
# Pure unit tests — no server needed; they exercise the deterministic safety/facts/contract layer.
# All live under scripts/test-*.mjs via jiti (TS imports) or node --test / --experimental-strip-types.
npm run test:deterministic        # chains all deterministic suites in order; the default pre-change gate (~minutes)
npm run test:deterministic:fresh-artifacts  # 只把「本机若有归档则一并扫描」的 4 个套件在
                                  # CDSS_IGNORE_LOCAL_ARTIFACTS=1 下再跑一遍（~4s）。同一提交可能
                                  # fresh clone 绿、留有归档的机器红，2026-08-15 实测带着红上线过；
                                  # 开关只对经 scripts/lib/local-artifacts.mjs 读归档的套件起作用，
                                  # 名单与静态自检在 scripts/lib/gate-local-state.mjs。
npm run test:deterministic:fresh  # 整条闸门 fresh 态（以前 verify:release 跑它，~3.7 分钟；现为手动选项）
npm run test:pediatric-dose-rule  # 儿童年龄分数法（档位/逐味上限/禁慎用药/合同/编译/婴幼儿喂养词）
npm run test:pediatric-vitals     # 未满 12 岁生命体征分档 + 年龄记录冲突按数值比较
npm run test:kb-gap-ratchets      # 方剂/药味目录缺口的常驻判据（解析残片、章节标题冒充方名、出处简称、别名错链…）
npm run test:safety-mutations     # ONE suite — this is how you run a single test
npx jiti scripts/test-safety-mutation-matrix.mjs   # same suite, bypassing npm (faster iteration)
npm run test:clinical-facts       # clinical-facts.ts additive backstop + schema rejects
npm run test:stage-contract       # M03/M04 structured-stream contracts + sentinel boundaries
npm run test:rxaudit-contract     # 本地处方核对（十八反/十九畏、缺剂量、服法、现用药）+ 对外冻结的收据词表
npm run test:stream-safety        # diagnosis-structured-repair (sentinel-aware repair)
npm run test:gi-alarm-features    # 上消化道警示征象 + 咖啡样呕吐物构词式；含一条 M02↔安全门防漂移断言
npm run test:colloquial-redflag   # 口语化表述的红旗覆盖（卒中口语走硬门 / 出血口语走提示档）
npm run test:customer-request-shape # 甲方真实传参形状：6 类风险 × 无追问/跳过/一题/两题 必须同一闸门结论
npm run test:delivered-surface    # 交付面投影：哪些字段不带内容、系统句式换临床写法；结构逐字段不变、幂等
npm run test:textbook-syndromes   # 教材病—证—法—方对照：候选检索、病名/治法/方名锚定、教材加减触发
# Live HTTP regressions — REQUIRES A RUNNING SERVER and matching CDSS_API_TOKEN.
npm run regress:tcm-cdss    # golden-case regression harness (100+ requests, see below)
npm run regress:robustness  # 真实公开医案压测；断点续跑，REEVALUATE=1 可离线重评已落盘结果
npm run regress:incompatibility  # 药味工作台改方后重新审方：十八反类别展开 / 超药典上限 / 阴性对照
npm run regress:facts-class-parity # 开放语言整类 parity：直连事实模型，按 fixture 各句采样 N 次（RUNS/CLASS_FILTER/SET_FILTER）
node scripts/regress-customer-shape.mjs <cases.json> <outDir>  # 按甲方传参形状跑全链路；缺省直调路由（CDSS_ENV_FILE），BASE_URL 则打已部署服务
```

There is **no jest/vitest/playwright config**, but the deterministic layer has a real unit-test suite: **~200 scripts under `scripts/test-*.mjs`, each wired to a `test:*` npm script and registered in the gate** (the runner's preflight enforces that; run `node scripts/run-deterministic-regression.mjs --list` for the current count), that import `src/lib/*.ts` directly (via `jiti`, or `node --test` / `--experimental-strip-types`) and assert with `node:assert`. They need no server. **There is no name filter and no watch mode** — a single suite is just its own npm script (`npm run test:<name>`), which is what you should run while iterating; save the full chain for the end.

`npm run test:deterministic` (`scripts/run-deterministic-regression.mjs`) chains the registered `test:*` suites — the array in that file is the registry. **Before the first suite it fails loudly if any `test:*` npm script is neither registered nor listed with a reason in its `NOT_IN_GATE` table** (the runner itself, `*-live` suites), and if a suite reads `artifacts/` or a `src` file gains an `artifacts/runtime` default path without being declared in `scripts/lib/gate-local-state.mjs`. `--list` runs only those checks and prints the selection; `--only=test:a,test:b` runs a subset. It spawns each via `npm run`, fails fast on the first non-zero exit, and points each suite's runtime state (terminology cache, drug inventory, customer registry, tenant audit — `cwd/artifacts/runtime/*` by default) at a fresh temp dir, so files left on this machine can't leak into results (two suites used to append to the checkout's `tenant-audit.ndjson` and fail when it was unusable). Its per-entry comments are the best available changelog of which customer defect each suite pins — read them before deleting or weakening an assertion.

The **live** HTTP safety net is `scripts/regress-tcm-cdss.mjs` — start `npm run dev` (or a prod server) first, then:

```bash
BASE_URL=http://localhost:3000 CDSS_API_TOKEN=<token> npm run regress:tcm-cdss
```

It fires 100+ requests, asserts on red-flag handling, negated history, safety-net false-positive avoidance, post-prescription risk, KB search, boundary inputs and auth bootstrap, prints a JSON summary, and exits 1 on any failure. `CDSS_API_TOKEN` must match the server's, or auth-gated routes 401. Treat this as the golden baseline: run it before and after any change to the diagnosis pipeline or safety layer.

**打远端环境时,本地环境必须配齐,否则失败数以千计却与被测服务无关。** 这一类已栽过两次
(`c5f3dc1`「245 条失败里 233 条是本地少一个环境变量」;2026-08-29 打生产时 2819 条全部源于缺
租户鉴权三件套)。放大机制:**M03 合同签名绑定 clientId**——本地没配客户鉴权时
`authorizeCustomerId(…, required=false)` 返回 `LOCAL_DEVELOPMENT_CLIENT_ID`,服务端用真实
clientId 重算,于是每个需要已签名 M03 的用例全线 `409 invalid_m03_signature` 并级联。
必需变量与排障开关见 `scripts/regress-tcm-cdss.mjs` 头部注释;其中易漏的是
`CDSS_API_CLIENT_ID` / `CDSS_API_CUSTOMER_IDS` / `CDSS_DEFAULT_CUSTOMER_ID`,
且 `CDSS_CUSTOMER_ID` 必须取 `CDSS_API_CUSTOMER_IDS` **静态白名单**里的值(生产为 `hospital-a`/`hospital-b`)——
只存在于服务端注册表的租户会让本地签名直接抛 `Cannot sign M03 without an authorized customer binding`。

还有一条与被测代码无关的硬约束:**生产的模型调用限流是 60 次 POST/10 分钟**(9 条模型路由,按 token+租户计),
而本 harness 一轮打几百次且无节流开关。直接打生产会有几百条 429 并级联出数千条断言失败(2026-08-29 实测
2882 条里带状态码的 100% 是 429)。要在生产上跑完整一轮,必须临时抬高 `CDSS_MODEL_RATE_LIMIT_PER_10_MIN`
再复原;抬高后实测降到 **25 条**,其余全部是限流噪声。

## Architecture

### Current reality vs. the docs — read this first

`docs/*.md` describe an **aspirational LangGraph/ReAct rebuild** (`/api/tcm-cdss/run`, SSE, a unified `TcmCdssAiSupportPayload`, structured-JSON prescriptions). **None of that is built.** The current implementation is a **linear M01–M05 pipeline** streaming Markdown+NDJSON, with the frontend doing flow orchestration. The docs themselves say (§20) not to mistake the compatibility layer for the target. When a doc type/endpoint doesn't exist in `src/`, it's a target spec, not something to call.

### Request flow

`src/app/diagnosis/DiagnosisClient.tsx` (a ~9.7k-line client component) drives the whole clinical flow and calls the stage routes under `src/app/api/diagnosis/`. Routes are thin — validate → deterministic safety gate → build prompt → stream — with all logic in `src/lib/`.

| Route | Stage | Notes |
|---|---|---|
| `collect` | M01 | Structure free text; tongue image → **GLM vision**, which is **on unless `GLM_VISION_ENABLED=false`**. Only that explicit opt-out rejects uploads — there is never a silent fallback to the text model |
| `question` | M02 | Generate **one** follow-up question (`PRIMARY_QUESTION_MODEL`; see "10.12 customer evaluation remediation" for the question policy and the no-answer precompute), then a **deterministic** plan finalizer (drop questions the record already answers or whose options aren't mutually exclusive, neutralize leading rationales, fall back to a server-owned question if the plan empties). The model reviewer that used to run here was removed 2026-09-25: it was the same model as the generator, and on 34 replayed cases it removed 13 questions vs the deterministic path's 14, with disagreements in both directions, for +1.2 s per call. The emitted `completeness` object is computed by the route from the record, not by the model |
| `question/interpret` | M02 | **Deterministic** since 2026-09-25 and no longer called by the page, which writes each typed answer verbatim into its question's field. The endpoint stays for API callers: answers are attributed per question by the `问题<id>：` prefixes the page uses (single-question plans take the whole answer), blanket answers (都没有/不清楚) go through the governed vocabulary, and an unattributable blob returns `200 {ok:false, failure.code:"answer_not_attributable"}` so the caller keeps the raw words. Why: on 65 doctor-style answers to real M02 questions the old model interpreter trimmed 30 (dropping e.g. 「降压药一直吃着」「烟抽二十年」「无紫绀咯血」), wrote nothing for 14 (e.g. 「说不清有无黑便」) and failed 2, at p50 2.6 s |
| `diagnose` | M03 | Western dx + TCM syndrome + pathogenesis; gated by safety + completeness=C; attaches the clinical-facts backstop first |
| `prescribe` | M04 | Herbal prescription; also requires an actionable M03 diagnosis |
| `assess` | M05 | **Split as of 2026-08-10.** The *safety verdict* (最高提示强度 / 综合风险判断 / 评级依据 / 医生需确认事项) stays fully deterministic off the local prescription checks — the model never writes a risk verdict. The *clinical content* (复诊评估重点 / 疗效评价口径 / 生活管理 / 六维里挑哪几维) is now model-authored per case via `m05-followup-authoring.server.ts`, validated against a governed prohibition table (`tcm-patient-instruction-prohibitions.source.json`) plus the reused `PRECAUTION_DOSE_LIKE`, falling back verbatim to the old template on any failure. Before this, 生活管理 was one hardcoded sentence identical for every patient and `sixHealthFollowupTable()` took no arguments. The route also runs `maybeAttachClinicalFactsBackstop`, which calls the model — so "M05 makes no LLM calls" was never accurate and is now doubly wrong |
| `red-flags` | — | Deterministic red-flag / safety summary for the current case state |
| `post-prescription-risk` | — | Re-checks a workbench-edited prescription with the **local deterministic checks** (`local-prescription-checks.ts`: 十八反/十九畏, pharmacopoeia dose bounds, missing/unparseable dose, regimen, current-medication scope) and signs a version receipt. The Lingxi external audit was removed 2026-09-25 (owner: never to be enabled); the receipt keeps its frozen vocabulary (`source:"skipped"`, `auditReason:"rxaudit_disabled"`, `auditResult:"NOT_SUBMITTED"`) because integrators and signed receipts depend on it. Missing structured herbs stays fail-closed |
| `emergency-clearance` | — | Doctor explicitly clears an urgent-disposition hold (`emergency-clearance.server.ts`); the clearance is validated + re-stripped on every subsequent read, so a stale/forged one can't ride along in `caseState` |
| `terminology/confirm` | — | Doctor confirms one controlled-vocabulary mapping (`tcm_syndrome` / `icd10` **only** — other namespaces are rejected by name, not silently ignored) |
| `snapshot` | — | Encrypted case-state snapshot (AES-256-GCM, `CASE_SNAPSHOT_ENCRYPTION_KEY`); binds auth to snapshot owner |
| `his-scheme` | — | Builds HIS "AI 诊疗支持方案" JSON (`src/lib/his-scheme.ts`) |
| `health`, `model-health`, `tcm-knowledge/search`, `tcm-knowledge/herb-function` | — | Status/health + local KB search. Note `health` is under `/api/diagnosis/`, `model-health` is top-level `/api/model-health`. `health?strict=1` returns `strictReady` and **503s when false** — it ANDs the per-stage models + evidence + tongue-vision-if-required + snapshot encryption + reasoning signing + customer authorization + clinical-facts extractor + TCM-treatment config + **rate-limit identity** (that last one is why prod must set `CDSS_TRUST_PROXY_HEADERS` behind a header-scrubbing proxy). Controlled terminology and syndrome rerank fail open (their failure falls back to deterministic behaviour), so since 2026-09-25 they are reported in `degradedReasons` but no longer block `strictReady`. `strict=1` also fires **live probes** of evidence / facts / tongue-vision / terminology in parallel, so it is slow and costs real upstream calls. Docker's healthcheck hits the **non-strict** form by default (live probes paused 2026-09-20: a strict call every 60 s cost ~1000 upstream model calls a day). Non-strict still computes `strictReady` from configuration, so a new unconfigured dependency still marks the container unhealthy. `CDSS_HEALTHCHECK_LIVE_PROBES=true` restores live probes. `model-health?check=1` makes one live call **per configured model family** (DashScope and DeepSeek since 2026-09-25 — before, only the primary family was probed, so a DeepSeek outage would have passed deploy verification); `verify:deployed-image` requires every family ok. Both health endpoints apply the same public-view redaction (`health-public-view.ts`); the full view needs `?diagnostics=1` **and** `CDSS_HEALTH_DIAGNOSTICS=true` |
| `auth/access` | — | Token → UI cookie login; timing-safe compare, rate-limited (8 fails / 10-min lock) |

### Model / streaming layer — `src/lib/diagnosis-api.ts`

`callDiagnosisStream(prompt, backend, images, kind)` is the single entry point. Backends: `deepseek`/`openai` → primary OpenAI-compatible model; `glm` → GLM vision (tongue-image extraction only). EviMed is not a model backend; it is injected separately as multi-source evidence context in M03/M04 prompts.

- **Per-stage models (see `.env.example`; owner decision 2026-09-19: Qwen two tiers only, `qwen3.8-flash` + `qwen3.8-max`; owner 2026-09-24: first passes move to `deepseek-flash` behind a strict-schema net).** The provider is `AI_TEXT_PROVIDER=bailian-qwen` (DashScope compatible-mode). Production sets every model variable explicitly in the release override (`artifacts/tencent-release-20260924-dsfirst/release-ops/production.override.yml` on the host; `…-20260919-qwen38/…` is the all-Qwen rollback), so the runtime env's leftover values do not leak in. History: 2026-09-11→09-19 production ran every text phase on `deepseek-flash`, whose `json_object` mode does not enforce the schema — the M03 Western half came back as misnested JSON on every case and the page showed the placeholder diagnosis. Both remaining tiers enforce strict JSON Schema; that is the reason for the switch back:

  | Phase | Model | Why |
  |---|---|---|
  | **First passes: M02 追问, M03 both halves, M04** | **`deepseek-flash`** via `PRIMARY_QUESTION_MODEL` / `PRIMARY_DIAGNOSE_MODEL` / `PRIMARY_PRESCRIBE_MODEL`, with **`PRIMARY_STRUCTURED_FALLBACK_MODEL` = `qwen3.8-flash`** as the strict net | **Since 2026-09-24 (speed).** Paired replay of this week's real prompts, sent from the production host: Western half 24→8 s, TCM half 29→10 s, M04 27→11 s, M02 15→4 s; production p50 was M02 15.5 s / M03 43 s / M04 40 s, almost all Qwen decode (~60 tok/s vs DeepSeek ~200). DeepSeek only has `json_object`, which is what broke 9/11–9/19, so three things are load-bearing: ① the M03 halves get the **same provider schema** in the system message (`structuredOutputSchemaInstruction`; Western half 0/18 → 18/18 compliant, TCM half 12/18 → 18/18; M04 deliberately gets none — it went 14/14 → 11/14 with it) plus a restatement of the prompt's own per-axis `resolution` rule (DeepSeek otherwise writes `bounded` on all three axes in 16/18); ② the server validates every non-strict first pass against that same schema (`checkNonStrictStructuredContent`: completes only *trailing* missing brackets, clamps arrays over `maxItems` — zod would `.catch([])` the whole array — treats `""`/omitted nullable fields as absent, tolerates server-owned keys; anything else is a violation); ③ a violation, a connect failure or any non-2xx (402 included) regenerates **the same prompt** on the strict fallback (non-streamed), so the quality floor is the pre-change behaviour. Endpoints resolve per model family everywhere (`textModelConfigForModel`), so repair rounds and facts stay on DashScope. `health` reports `question/diagnose/prescribe_model_not_configured` per stage. Telemetry: `non-strict structured output violates provider schema`, `structured_strict_fallback`. Rollback = set the three stage variables back to `qwen3.8-flash`, no rebuild |
  | Medicine planner | `BAILIAN_QWEN_MODEL` = `qwen3.8-flash` | Follows the provider base model |
  | **Small json_object tasks** (terminology, syndrome rerank, formula recall, polarity assist, M05 authoring) | **`deepseek-flash`** via `CONTROLLED_TERMINOLOGY_MODEL` | **Cross-provider since 2026-09-20.** These never needed strict JSON Schema, and DeepSeek decodes 2–5× faster. Same-machine, same-window A/B on real prompts: terminology 6673→1354 ms, syndrome rerank 5549→984 ms, M05 authoring 9587→4163 ms; 154–215 tok/s vs 8–61. Clinical fields identical. **Terminology normalization makes one call** (owner 2026-09-20): it used to send the byte-identical prompt twice at temperature 0 and take agreement — a second draw of the same lottery at double the cost. Syndrome rerank is **not** idle work: on the 300 TCMEval-SDT cases it changed the top-8 syndrome hypotheses in 237, the formula top-5 set in 103 and the top-1 formula in 32 (2026-09-25), so it stays. Polarity assist caches a settled answer (including an explicit "none") so M04 doesn't re-ask what M03 already asked; an unavailable/timeout result is never cached. Terminology still enforces closed-set IDs, the confidence floor and abstention (`validatedClosedSetDecision`); mappings remain suggestions pending clinician confirmation. `textModelConfigForModel` resolves endpoint+key **by model family**, so a DeepSeek model never rides the DashScope endpoint; a family that is not fully configured is **fail-closed** and each task falls back to its deterministic result. Rollback is one env var back to `qwen3.8-flash`, no rebuild. Note `health?strict=1` now probes DeepSeek too, so a DeepSeek outage marks the container unhealthy even though clinical generation is unaffected |
  | M03 strict fallback (both parallel halves) | `qwen3.8-flash` | Thinking disabled, strict JSON Schema. The provider schema also pins 8 clinically mandatory arrays to `minItems:1` (`requireGeneratedM03Content` in `model-response-format.ts`): without it strict decoding returned 主证候依据/病名与证候鉴别/病位/病性/子治法/待核实信息 empty in most runs while marking them `resolved` (paired replay 2026-09-19). `qwen3.7-flash` is **not** a rollback — it has no strict mode |
  | M03/M04 repair rounds | `qwen3.8-max` (M03); **M04 = `deepseek-flash` in production since 2026-09-27** | Code/compose/`.env.example` defaults stay `qwen3.8-max`; production sets `PRIMARY_PRESCRIBE_REPAIR_MODEL=deepseek-flash` in the release override `artifacts/tencent-release-20260927-dsrepair/`. Measured on the 65-case local A/B: candidate-patch repairs 3.7–5.3s instead of 18–27s, M04 p90 39–43s → 20s, non-dose fallbacks after repair 3–5 → 1, judged quality unchanged (3.00 vs 3.00/3.02). Rollback = point the override back to `20260926-cap8`, no rebuild. (With a Qwen first pass, the M04 transport fallback is `PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL` = max; with a DeepSeek first pass it is the strict fallback) |
  | Independent review | **removed 2026-09-16; leftovers swept 2026-09-25** | The M03/M04 second-model reviewer was deleted by owner decision: in production it was the same model as the generator at low reasoning effort (median 1.4 s), demanded repair 84% of the time, and withheld dose on candidates that passed every deterministic contract (15/35 M04 runs, `contractIssues=[]`), with no measurable benefit anywhere. The stubs, the prompt/parse modules, ~50 dead branches, the page's 「临床复核状态」 line and the M04 prompt's 【辨证复核状态】 suffix are gone. `clinicalReview` in the signed payload is a constant `unavailable/not_configured` attestation (`clinicalReviewNotPerformedAttestation`) kept for contract compatibility. Don't add a second-model review back to fix clinical plausibility — safety floors live in the deterministic layer, plausibility is the doctor's call |
  | Clinical facts | `qwen3.8-max` extraction (+ structure / quote-grounding repair). **Review and adjudication phases removed 2026-09-25** (off since 2026-09-20) | Extractor tier chosen from full golden-baseline runs on 2026-09-19 (flash extraction missed spoken-language risks such as `advisory-low-temp-35-5`). Review was measured on 198 unique golden cases: extract-only vs extract+review differed on **zero** safety-gate inputs; it cost ~3.6 s per cold call, twice per patient. The result is `reviewStatus: "single_pass"`, and `clinicalFactsReviewSettled()` is the single predicate that the gate's emergency escalation, the screening-complete check, attestation signing, cache validation and the red-flags route all use — before it existed, "not reviewed" meant "not complete" and would have withheld dose from every case. `historical_or_stable_only` no longer changes any output (the case is treated as active); the parser also stopped accepting a model-written `reviewAgreement`, which had let a single pass certify its own downgrade. Attestation v9 — older browser snapshots are re-extracted |

  DeepSeek credentials (`OPENAI_API_KEY` + `OPENAI_BASE_URL`) are the DeepSeek family's endpoint for every `deepseek-*` stage variable above; `AI_TEXT_PROVIDER` stays `bailian-qwen`. Moving the clinical-facts phases to DeepSeek is **not** safe (2026-09-11: 35.5 ℃ low temperature released dose). `isApprovedTextModel` = qwen\* ∪ deepseek\*. The facts layer may add risk but can never erase or downgrade grounded risk. `reasoning_effort` / `thinking_enabled` remain per-stage controls, both defaulting OFF (reasoning-only streams are treated as errors).
- **GLM tongue vision is opt-*out*, and the two switches are not the same switch.** `glmVisionEnabled()` is `process.env.GLM_VISION_ENABLED !== "false"` — enabled by default, and `.env.example` / `docker-compose.yml` both pin `true` (a regression assertion enforces that). `GLM_API_KEY` does *not* gate the feature; a missing key means vision is still "required" but unconfigured, which fails `health?strict=1` (`tongue_vision_api_key_not_configured`) rather than quietly degrading. Only an explicit `GLM_VISION_ENABLED=false` rejects uploads and asks for manual entry. There is no silent fallback to the text model in any configuration.
- **NDJSON contract (shared by every backend and the deterministic responses):** `{"content":"…"}\n` per chunk, terminated by `{"content":"[END]"}\n`; errors as `{"error":"…"}\n`. Anything you add to the pipeline must speak this exact contract — `markdownNdjsonResponse()` wraps deterministic Markdown into it.
- **Critical reasoning-only-stream gotcha:** if a stream returns only `reasoning_content` and no `content`, that's treated as an error ("模型仅返回推理过程"). This is why `model-health?check=1` verifies *final content*, not just reasoning — a provider that only streams reasoning will fail health and every stage.
- Timeouts are enforced per-stream: connect 90s / idle 60s / total 180s, with upstream `AbortController` cancellation and a 5s client heartbeat that keeps the UI alive during provider reasoning.
- Provider config lives in `src/lib/text-model.ts` via `AI_TEXT_PROVIDER` (`bailian-qwen` in `.env.example` and production; `openai-compatible` is the all-DeepSeek rollback) — read it with `getPrimaryTextModelConfig()`, or `textModelConfigForModel(model)` for a specific stage model.
- **M03/M04 have a whole-orchestration deadline on top of the per-stream timeouts** (`M03_ORCHESTRATION_DEADLINE_MS` / `M04_ORCHESTRATION_DEADLINE_MS` in `diagnosis-api.ts`, both default to **180s** as of 2026-08-28 (`d9ee8d4` raised the M04 code default from 120s to match what production had been running; clamped 60–180s, and a recorded M03 run already spends ~88s of its budget). Blowing the deadline — or re-injecting the same repair prompt twice (fixpoint) — finalizes into the existing signature-limited / non-dose contract instead of burning unbounded repair rounds. If you add a repair round, it must respect the deadline and be fixpoint-detectable. **M04 repairs are candidate-scoped since 2026-09-20:** when the rejection reason and every T1 finding in the same batch sit inside `candidate` (herbs, composition, dose, emperor, pairing, decoction), the repair asks only for `{candidate}` (`m04_candidate_patch` schema) and the server splices it back onto the previous raw proposal; patent/western medicines, modifications and non-pharma sections are kept byte-for-byte. Any T1 finding outside `candidate` still triggers a full rewrite. All production repair triggers observed so far were candidate-scoped.

- **Latency & knowledge-layer changes (2026-09-27).** A production API-flow chain (collect → question → diagnose → prescribe → assess) measured M02 10.3s / M03 17.2s / M04 16.5s / M05 5.5s. Telemetry showed the model calls themselves were already fast; the time went to serial pre-model work. What changed:
  - **M02 facts ∥ question** (`question/route.ts`): M02 reads clinical facts only through `m02ClinicalFactsFootprint` (prompt `redFlagSemanticFacts` + grounded risk question). The question call starts on the fact-free case while `qwen3.8-max` extraction runs; if the extracted facts give the same footprint the speculative result is used byte-for-byte, otherwise it is discarded and regenerated. Any new M02 read of `clinicalFacts` must join that footprint.
  - **Caches + stage prefetch** (`evimed-guide.ts` fetch cache, `small-task-memo.server.ts`, planner cache in `medicine-candidate-planner.server.ts`, `stage-prefetch.server.ts`): M02 prefetches M03's EviMed / formula-recall / polarity / syndrome-rerank inputs; the diagnose route taps its final NDJSON (`tapFinalStageContent`) and prefetches M04's planner + EviMed with the documented M03→M04 handoff shape. Caches key on the actual request content, store successes only, and never bind a shared computation to one caller's abort signal. Kill switches: `CDSS_EVIDENCE_FETCH_CACHE`, `CDSS_SMALL_TASK_MEMO`.
  - **M04 external-evidence soft deadline** (`PRIMARY_PRESCRIBE_EXTERNAL_EVIDENCE_SOFT_DEADLINE_MS`, default 2000 from route start): EviMed often returned off-topic items for M04 (a gastritis case got dermatology consensus statements) and cost 2–3s beyond the planner leg.
  - **Evidence relevance + priority compaction** (`CDSS_EVIDENCE_RELEVANCE_FILTER`, `CDSS_EVIDENCE_PRIORITY_COMPACTION`): guide/literature items that share no governed clinical-problem concept with the case are dropped; over-budget evidence is trimmed by section (generic dose index first, then EviMed) instead of head-60%/tail-40%, which used to cut exactly the case-bound formula provenance and local patent-medicine candidates in the middle.
  - **DeepSeek strict tool calling** is used only as the **first retry** after an M03 half fails the schema check (then Qwen strict). Two paired replays showed DeepSeek's `strict` does not really constrain these large schemas (extra trailing `}`, `{"parameter":"…"}` wrappers, M04 nesting drift) and is 1.7–2.5s slower, so first passes stay on `json_object`. `test:model-structured-output` allows exactly one `tool_choice` (the forced `submit_<task>`; tools are never executed). Non-strict output whose only violations are unknown keys, or an out-of-range enum in one `patentAndWestern` item, is normalized instead of regenerated.
  - **Formula identity** (`tcm-formula-tier.ts`, `trustedModelFormulaIdentityNames`): only the common tier (official standard / classic catalog / ≥3 modern cases, 732 formulas) can be *locked* in M03; a formula the model names itself is kept if it is in that tier and passes the owner-approved exact therapy alignment (`formulaTherapyAlignedWithSigned`), even without a curated syndrome→formula relation. Trusted-only locks are **soft** in M04 (`lockedFormulaNamesIncludeModelTrustedOnly`: self-devising is accepted without a qwen3.8-max repair); relation-verified locks stay strict. M04 compilation and reverse lookup still use the full catalog. Switches: `CDSS_FORMULA_LOCK_TIER`, `CDSS_FORMULA_TRUST_MODEL`.
  - **Hedged overall pathogenesis is T2** (`overall_pathogenesis_hedged`); only a structurally empty one (`isStructurallyEmptyM03CoreText`) stays T1 `overall_pathogenesis_unstable`.
  - **Similar modern cases** (`modern-case-exemplars.server.ts`, data `tcm-modern-case-exemplars.json` built by `scripts/build-modern-case-exemplars.mjs`; the customer confirmed full copyright on 2026-09-27): deterministic BM25-style retrieval of 3 cases (no doses) into the M03 TCM half and M04. M04 must account for them in a top-level `referenceCaseUse` (adopted IDs or why none apply) — guided + accountable, never forced adoption, no extra model call. The key is telemetry-only: it is stripped before compile, and the candidate-patch base ignores it (an unknown top-level key used to push every repair onto a 41s full rewrite). Switches: `CDSS_SIMILAR_CASES`, `CDSS_SIMILAR_CASES_MODE`; evaluation-only exclusion hook `CDSS_SIMILAR_CASES_EXCLUDE_FILE` (never set in production).
  - **M04 → M05 prefetch + gzip request bodies (aa6692e).** The M04 route taps its final stream and runs `prefetchAssessFollowupFromSignedPrescribe`, which mirrors the assess route step for step up to `authorFollowupForCase` (facts backstop → gate → selected candidate → the three local risk sections) and writes only the authoring cache (`CDSS_M05_PREFETCH=false` disables it). If the shapes diverge, the only effect is a cache miss; `test:m05-prefetch-request-compression` pins that both the frontend shape and the direct-API shape hit the cache, including a 十八反 case where the local risk section rewrites the first review timing. `readJsonBodyWithLimit` accepts `Content-Encoding: gzip|deflate`, caps both decompressed and transferred bytes, returns 415 for unknown encodings, and the browser gzips bodies of 16K+ chars. Why: M05 bodies are 140–180KB and uploads to the production host run at ~38KB/s from outside, so the client-side M05 was twice the server-side one. Production on the same link: M05 7.8–8.6s → 3.8–5.2s immediate / 3.1–4.1s immediate+gzip / 0.7–1.3s when M05 is called a few seconds after M04. Splitting the authoring call into two parallel calls was measured and **rejected**: it saved only ~0.7s (3.5 → 2.8s), because the timeline half alone takes ~2.8s.
  - **Signed reasoning keeps its keys through the PHI sanitizer (5c6d225).** `sanitizeCaseStateForModel` used to run reasoningDiagnose/Prescribe/V2 through the generic unknown-object scrubber, which drops every key matching `/name/i`. The M04 prompt is built from that sanitized state, so `recommendedFormulaNames`/`tcmDiseaseName` never reached the model: the "服务端方剂目录编译基准" section always said "M03 未锁定命名方", the model wrote a self-devised formula, and the contract then rejected it against the real lock (`formula_reference_declassified`, 14 of 64 M04 first passes in the base run, 11 of them purely this). Signed reasoning now keeps schema keys and every string value is still scrubbed. **Prompt tests must build from the sanitized seam the route uses**; the old ones fed the raw state and never saw this.
  - **Facts quote grounding (10b7aa6, 1876fc5).** `clinicalEventTemporalScopeAt(…, { groundingQuote: true })` is used only by the facts quote check. The quote's own current/recent-onset cues count ("近两天来", "N天/周前…出现"), but historical anchors are searched only before the quote, because quote words can contain them literally (晕过去了 ⊃ 过去). The safety gate does not pass the option: widening the gate's own temporal rule changed 255 of 27,329 corpus sentences, e.g. "6个月前发热41℃" became an emergency. That is a separate safety decision. "半月/半个月前…出现" counts like weeks. **Distributed negation (9/28):** for a record "否认A、B、C" the model quotes "否认C", which is not verbatim, so every such case paid a 5–6s grounding repair (all 4 production facts repairs after the 72044a9 deploy). `groundClinicalFacts` rewrites a *negative* finding's quote to the verbatim span "否认A、B、C" when the item sits in a list led by the same negation, with only 、及和或与 between and only a closed set of subject/time words (患者, 病程中, 近日…) before the head. Negative findings never reach the gate's risk categories. This is a morphological-guard exception to the open-language freeze. Replaying 428 recorded first passes: repair triggers 31 → 29, one gate-category change (the half-month case, equal to what its repair round produced). The remaining triggers are real history, imaging-report text and model typos in quotes (mmHp). CMB-Clin's "病史摘要" heading reads as a historical anchor in the shared rule, but only that dataset uses it, so the rule was left alone.
  - **M04 JSON failures (10b7aa6).** `removePrematureRootClosers` drops an extra closer that ends the root early before `,"key"` (the only syntax-error shape observed); keys the repair pushes to the root are reported as misnesting, never stripped. Other content violations race a same-model redraw at temperature 0.3 against the Qwen strict fallback (`CDSS_M04_SAME_MODEL_REDRAW=false` restores fallback-only).
  - **M05 from the M04 draft (b9aae2f).** The first-pass M04 stream reports its `candidate` object once it closes (median 49% of the output), and `prefetchAssessFollowupFromDraftCandidate` fills the authoring cache through the same assess pipeline, deriving the follow-up node with the server's own function. A draft that differs from the final prescription is only a cache miss (`CDSS_M05_DRAFT_PREFETCH=false`). The draft first goes through the compiler's own normalization (`normalizeM04DraftCandidate`: 炒白扁豆→白扁豆, 山栀→栀子, 橘皮→陈皮, dose count/course), because 16 of 21 local misses differed only there (3932d4e; hit rate 44/65 → 61/65). Production, M05 called right after M04: 0.6–2.0s, median 0.9s (was 3.1–4.1s).
  - **Evidence queries from signed M03 topics (b9aae2f).** M04/M05 evidence fans out short queries (Western diagnosis, TCM disease + syndrome, formula/therapy), and **the first query whose results survive the case relevance filter wins**; the narrative query stays last. Narrative queries drop dates, years and age/sex openers. 65-case replay with an LLM relevance judge: irrelevant injected titles 60% → 31%, cases with ≥1 relevant item 13 → 30 (`CDSS_EVIDENCE_TOPIC_QUERIES=false`).
  - **原典出处 from a compact index (b9aae2f).** Production never read the classic corpora: webpack rewrites `new URL(…, import.meta.url)`, and the 347MB tcmoc corpus would not fit the container anyway. `npm run build:classic-evidence-index` derives `tcm-classic-evidence-formula-index.json`. It keeps the top 24 per formula plus cross-titled sections, with dose-isolated excerpts, using the runtime's own gate and sort key. The runtime reads it via `process.cwd()`, and the raw `.jsonl` are excluded from the image. It is identical to the full scan on 2,397 single and paired queries; `/api/diagnosis/health` reports `classicEvidence`.
  - **Formula functions (c2bd6e4, bd6a319).** Before this, 545 of 2,969 catalog formulas had `functions`. Now `tcm-formula-textbook-functions.json` (from the 《方剂学》 textbook in 中医补充数据/灵丹GitHub/TCM Educational Materials.txt) and `tcm-formula-curated-functions.source.json` (54 common-tier formulas checked online, with URLs) fill empty entries, only when source book or ≥60% composition proves it is the same formula. The lockable tier went 543 → 705 of 732. Therapy alignment accepts the same controlled method or an ancestor/descendant in GB/T 16751.3 numbering (ancestor ≥3 levels; siblings like 补气/补血 do not count). Supplementary functions are **positive evidence only**, because the vocabulary matches whole terms and textbook phrasing often extracts nothing. Result: 完带汤 is kept, 导赤散 for 阳黄 is still dropped.
  - **Answer-time warm-up (d351d70).** The page builds the post-answer case with `buildQuestionAnswerSubmission` (the same function handleSubmit uses), and after a 1.2s pause posts it to `red-flags?prefetch=diagnose`. Facts (cached by record-text fingerprint, with in-flight joining) and the M03 pre-model inputs are warm by the time the doctor submits. The warm-up is not tied to the run abort scope; aborting it would cancel the server-side extraction.
  - **M05 follow-up is written to the patient (9/28, customer feedback).** Section names and fields are unchanged, but every section of 「随访管理方案」 now speaks to the patient:
    - first review is `patientFacingFirstReview` («请在服完7剂药后（约7天后）复诊…», same source as timeline row 1);
    - the worsening plan says to come back and not change medicines on your own, then lists emergency signs;
    - the six-dimension questions and the template timeline are in plain language.
    - The model now writes `urgentSigns` (case-specific emergency signs); with fewer than 2, a generic set is used.
    - Authoring rejects record-status sentences (`isRecordCompletenessStatement`) and internal workflow words («候选方案/审方/复评/采纳/辨证/阳性», a new group in `tcm-patient-instruction-prohibitions.source.json`, also applied to M04 precautions).
    - **Why the page and HIS used to differ:** `sanitizeUngroundedRedFlagNegations` ran over the assess follow-up, turning «有无新出现发热» into «病历已记录否认发热». Now it only touches the post-prescription risk text.
    - The sanitizer shields prospective clauses from the conditional word to the end of the sentence (`PROSPECTIVE_CLINICAL_SENTENCE`). It does not shield the whole sentence, because it also runs on the visible M03/M04 text: «患者否认便血、黑便，如出现…» still gets its first half corrected.
  - **Home acupoint care and exercise (9/28, customer decisions: source = the 2013 technical specification, moxibustion included, HIS field added, exercise as its own section).**
    - `nonPharma.acupointCare` is compiled server-side in `applyTcmTreatmentCapabilityPriority` → `home-acupoint-care.server.ts` from `tcm-home-acupoint-care.source.json`. That file holds the original text of 《老年人/0～36个月儿童中医药健康管理服务技术规范》.
    - **Selection:** signed M03 nature (controlled `tcm-nature-lexicon`) maps to a constitution, deficiency first (阳虚 > 阴虚 > 气虚), then 湿热 > 血瘀 > 气滞 > 痰湿. 痰热 and external/acute natures (风/暑/毒/动风/气脱) map to nothing.
    - **Contraindications reuse the project-level rules:** acupressure as `tuina`, moxibustion as `moxibustion`, plus a burn-risk check (糖尿病/感觉减退/T≥37.3).
    - **Nothing is output for:** red flags, `non_dose_only`/`blocked` (limited_dose still gets it: it is mostly undocumented pregnancy/medication detail), pregnancy positive/possible, age 3–17 or under 6 months.
    - **Women aged 10–59 with unrecorded pregnancy status:** contraindicated points, abdominal/lumbosacral points and moxibustion are dropped.
    - **Review gate:** every entry is `pending_clinician_review` and is not applied by default. `CDSS_HOME_ACUPOINT_CARE=include_pending` enables it; `=off` disables it. **Production runs `include_pending` since 2026-09-28 (user decision, before clinician sign-off)**, set in the dsrepair release override on the host (backup `production.override.yml.pre-acupoint-20260928`).
    - **Exercise:** `nonPharma.exercise` is model-authored and optional; the M04 prompt now asks for four care sections, and `lifestyle` holds only 起居/睡眠. It sits under exam-claim sanitization, since a new narrative field may not join the frozen naked list.
    - **HIS:** `healthGuidance` gains `exercise` and `acupointCare`.
    - **Existing defect fixed on the way:** the project-level pregnancy check read only affirmed sentences, so «可能怀孕» was filtered out and acupuncture/moxibustion cards were still recommended. It now reads the raw text (`treatmentPregnancyText`); the state layer handles «否认妊娠» itself.
  - **Dose bounds are the pharmacopoeia only (9/28).** `getTcmHerbDoseLimit` used to intersect the ChP range with `curatedDose`, called "clinic/dispensing range" in the code. It is actually `tcm_curated_llm_candidates_20260626`: 99 LLM-generated rows, every basis «待人工复核», never reviewed, and nothing institutional. The stated reason was avoiding warnings from the downstream audit, which was removed on 9/25.
    - **Effect:** 23 ranges were narrowed, and 杜仲 10, 板蓝根 15 and 川贝母 3 collapsed to a single value while the basis still read 药典.
    - **Side effect:** the combined basis kept those 95 herbs out of the 9/26 ordinary-herb cap/annotate path (`ordinaryHistoricalDoseDeviation` requires the single ChP basis), so every deviation became a T1 repair round.
    - **Measured:** 4 of 7 local dose repairs were ChP-legal doses (北沙参 12g, 牛膝 6g), and all 7 needed no repair after the fix. In the 65-case arm, repair prompts went 7 → 4 and dose repairs 2 → 0.
    - **Unchanged:** `curatedDose` still supplies decoction and risk annotations. 天南星 (no internal ChP dose) now has no bound and is clinician-dosed.
    - **Still unreviewed but labelled honestly:** 五灵脂, 神曲, 藜芦, 败酱草 and 龙骨 fall back to the «高置信中药饮片剂量校准层» route rows.
  - **Measured and rejected (9/28).** ① Speculative M03 before facts: after answers, EviMed/recall/polarity/rerank are cold too (~3s, in parallel with facts ~4s), so the gain is ~1s; it would also need facts removed from the prompt and a quality re-run. ② Prompt diet (M03 herb-rule section 23% of the TCM prompt, M04 dictionaries, alternatives when locked): no latency change (decode-bound); safety concerns 8 → 13 and 方切合病例 36 → 33 over 65 cases; reverted (1d62ad5).

- **9.24/9.27 customer medical-evaluation remediation (2026-09-29, `docs/甲方测评整改方案-9.24与9.27医学测评-20260929.md` §6).** The root causes were measured, not read off the code, and most were server-side:
  - **Formula analysis (方义方解) was discarded 9/9 by the server, not written badly by the model.** The old grounding check scanned 2–4 char windows, so substrings of the candidate's own herb names (杏仁 in 苦杏仁, 地黄, 枣仁, 屏风 in 玉屏风散) counted as foreign herbs. `formula-analysis-review.ts` does longest-match mentions with identity normalization and deletes **only the clause naming a truly foreign herb**; the template fallback is only for placeholder / repeated (12-char window ≥3) / <60% herb coverage. Owner doctrine: a foreign herb in a real rationale is a correction, never a hard block that swaps in stitched template text.
  - **Same case only once (`stage-result-coalescing.server.ts`, wired into `diagnose`/`prescribe`).** Fingerprint = tenant + stage + case content minus the stage's own outputs; in-flight requests join, finished ones replay for 30 min, and the compute is decoupled from the caller's connection (the HIS cancels at 30 s, so "饮片暂未生成" retried from zero forever). `x-cdss-regenerate: 1` / `?regenerate=1` bypasses; degraded/interrupted results are never cached; response header `x-cdss-stage-result: joined|reused` (absent on the originating request). **Default ON only when `NODE_ENV=production`** (tests and dev re-run the same input against swapped stubs); `CDSS_STAGE_RESULT_REUSE=true|false` overrides. The 65-case A/B runs in dev, so it does not exercise this.
  - **Named-formula sufficiency loop.** `namedFormulaPositiveSufficiencyIssue` is skipped for an already-declassified self-devised candidate and the M04 repair loop skips that reason code (before: 4 consecutive 0-herb runs for one case).
  - **Treatment principles** are asked as a concrete principle first (虚则补之 / 实则泻之 …) with 总纲 only as a supplement; `treatmentPrincipleIsGenericOnly` + `concreteTreatmentPrincipleFromSignedNature` are the deterministic floor. **Decoction method** uses the 方剂学 textbook profile for named formulas (`formula-decoction-profile.ts`, 233 formulas), otherwise the *primary* sub-therapy, not any keyword. **Formula naming** by composition is restricted to the common tier; self-devised formulas are labelled with a reference formula and its 出处; 5 catalog 出处 errors are corrected through `FORMULA_STANDARD_SOURCE_CORRECTIONS` in `build-tcm-governance-tables.py`.
  - **Non-drug treatment "教材方案"** (`tcm-nondrug-textbook-plan.server.ts`, data generated by `build-tcm-nondrug-textbook-protocols.py` from the 十三五 textbooks with book+line; `CDSS_NONDRUG_TEXTBOOK_PLANS=false` disables). Syndrome match needs ≥1 shared non-generic 2-gram with the current facts; recipes are limited to the 药食同源 catalog + common foods; point-free projects (食疗/导引/情志) never say "取穴". Awaiting 中医师 sign-off, like the rest of the catalog.
  - **Also**: history reconciliation (`record-history-consistency.ts`: no "过敏史未提及" against a recorded allergy), TCM disease-name differentials normalized through GB/T 15657 + a textbook crosswalk, `symptomPathogenesis` for modifications, and a latent bug — `m04KnowledgeShortlistFromPrompt`'s START marker must include the full-width "（" or a prompt reference earlier than the real header makes the slice miss it.
  - **A/B (65 cases, dev mode, 9656d7f vs d1d3b4d):** no detectable change in diagnosis / syndrome / formula fit / acceptability (paired sign test p=1.0 gold, 0.58 blind), latency unchanged, 0 dose violations. The LLM judge's "safety concern" count moved 2→8/40, but its range over every earlier arm is 2–8/40 (same-config base/base2 = 5 and 7) — noise, recorded, not acted on.

- **Round 2 of the same evaluation (2026-09-29, `docs/甲方测评整改方案-…-20260929.md` §7).** Owner direction: no 中医师/药师 is available to sign anything, so every "pending clinician review" / placeholder was replaced by web/original-text verification (Sonnet sub-agents; every quote machine-checked; material in `~/runlogs/eval924/research2/`), and model-authored content is kept instead of gated. What now exists and what it must not become:
  - **Verified herb-function dictionary** (`src/data/tcm-herb-verified-functions.json`, built by `scripts/build-herb-verified-functions.py`, ~300 herbs). It **removes** clauses proven wrong (炙甘草 carrying 生甘草's 清热解毒) and feeds the 方义 column when the KB has nothing aligned with the therapy. It must **not** append high-impact directions to `getTcmHerbFunctionText`: that text also drives 君药/配伍面 admission, and adding one true 「凉血消痈」 to 丹参 made it ineligible as 活血 chief herb (`test:herb-breadth-surface`). Additions live only in the display path (`verifiedHerbFunctionAdditions`). Only the 使 role phrase is used as a fallback; 佐 phrases are formula-specific.
  - **Finalize keeps a reasonable model-written 方义** (`herbFunctionMatchesKnowledge(…, lenient=true)`: marketing words, unsupported high-impact directions and toxic herbs without a toxicity mention are still rejected). The HIS write-back path (`trustedWorkbenchEdit`) uses the same lenient form, otherwise finalize-accepted text is rejected at export by the strict form.
  - **Catalog corrections go through the collation channel** (`tcm-formula-catalog-collation.source.json`, ref `ADJ-WEB-20260929`, rows generated from the research parts; 国家《古代经典名方目录》 source columns are deliberately left alone). Changing a catalog `source` also changes the join key of `tcm-formula-name-composition-adjudications.source.json` (name, source) — re-key those rows or doctor-restored entries silently drop out of the catalog.
  - **Non-dose page structured copy**: `<!-- CDSS_NON_DOSE_CANDIDATE_JSON:{…} -->` (one comment; JSON `-<>` escaped) — herbs/roles/functions/方义/`reasonCode`/`doseWithheldReasons`, no dose, `adoptable:false`. The internal-tag scrubber erases camelCase keys, so `scrubInternalVocabularyFromVisibleText` passes the block through verbatim. Inventory never gates herbs; red flag / child / pregnancy-lactation are the dose-authorization boundaries and remain owner decisions (child dosing is still withheld: no verifiable pediatric rule).
  - **Ledgers**: textbook add-points, home acupoint care and lineage affinity are `approved`/`evidence_approved`; rejected lineage rows are `evidence_rejected` (zero effect). Home acupoint care is on by default now.
  - **PHI scrubber vs. clinical lexemes** (root cause of "no herbs" for elderly/male-genital cases): `scrubRelationPrefixedName` / `scrubSubjectPrefixedName` now consult the governed clinical-lexeme set (`phi-clinical-lexemes.json`, built from `phi-clinical-lexical-grammar.source.json`); "患者高龄，…" used to become "患者[姓名已脱敏]，…", the M04 model copied the rewritten pathogenesis and the server compared it with the signed M03 → `pathogenesis_drift` (T1) → candidate withdrawn. Any new surname-initial clinical word that shows up rewritten goes into the grammar source as a finite closed group, with the privacy counter-controls in `test:eval924-round2` (surname × given-name × sentence-pattern must still be redacted) and a before/after corpus replay.
  - **DeepSeek JSON defects**: `repairMismatchedClosers` (a `]` written as `}`; syntax only, ≤3 replacements, still schema-checked) — the case behind production 0059's 47–85 s M04 (same-model redraw repeats the mistake, then the 34 s Qwen fallback). `strictToolFinishReason` maps the forced tool call's `tool_calls` to `stop`, otherwise an *accepted* tool retry is rejected by the terminal-state gate and M03 becomes the limited placeholder result.
  - **M04 repair-start cutoff** (`M04_REPAIR_START_CUTOFF_MS`, default 20 s): no new *repair* round after 20 s (delivered as repair-exhausted). The strict-fallback/same-model-redraw race is the only way to get output when the first pass failed, so it is not cut.

### Deterministic safety is the load-bearing layer — `src/lib/diagnosis-safety.ts`

The model never decides safety. Stage routes call `withSafetyGate(caseState)` first; the gate deterministically parses vitals (BP/T/P/R/SpO2 with critical thresholds) and text for red flags and sets `allowDiagnosis` / `allowDosePrescription`.

**Disposition doctrine (owner decision 2026-08-01): detection never blocks.** There is one disposition (the `CDSS_GATE_DISPOSITION` switch and its `block` rollback mode were removed 2026-09-25): red flags / completeness / encounter-scope hits still run and are fully surfaced, but the routes proceed to full M03/M04 generation with a deterministic safety-advisory banner (`<!-- CDSS_SAFETY_ADVISORY -->`, built server-side from the gate result) prepended to the visible output. Same doctrine at the last mile of M03/M04 contracts: after repair exhaustion, quality-class findings become annotations (`m04-repair-policy.ts` is the single authority), and a non-dose/blank page is only allowed when there is genuinely nothing to show (no chief complaint, no signed M03, truncated output with no salvageable candidate). **剂量授权是另一根轴（2026-08-15 拆开）**：`CDSS_REDFLAG_DOSE_AUTHORIZATION` 默认 `withhold` —— 红旗未解除时 M04 只给非剂量内容；`allow` 是运维回退档，切回「红旗也照常出剂量方」。拆开的原因是实测缺陷：两轴绑在一个开关上时，为了「不阻断流程」而放行剂量会顺带放行妊娠/哺乳阳性、儿童这些**与红旗无关**的独立硬边界（旧 advise 档下 6 岁儿童 + 红旗实测给出 `full_dose`；2026-09-30 起年龄段可判的儿童改按年龄分数法折算、不再是硬边界，只写「患儿」判不出年龄段的仍是，见下一段）。独立硬边界不受任何一个开关影响；`test:redflag-dose-authorization` 两头都钉。 Per-herb hard rules (pharmacopoeia dose bounds, 十八反十九畏 as repair drivers, regulatory herb exclusion from auto-dose, PHI sanitization) are unchanged — except that since 2026-09-26 the M04 compiler caps an *ordinary* herb (identity resolved, non-toxic, not clinician-dosed, single 药典2020 source) above its pharmacopoeia ceiling at the ceiling and states the original dose in `verificationReasons` (`m04-proposal-compiler.ts`); below-floor doses are left alone (children/elderly) and still annotated — "never block" governs disposition, not detection, and never silently treats "unknown" as "no risk".

- **Pediatric dosing is age-fraction, not withheld (owner 2026-09-30).** Under 18 used to withhold dose outright ("no verifiable child rule"). Now `src/lib/pediatric-dose-rule.ts` (data: `src/data/tcm-pediatric-dose-rule.source.json`, with the textbook quotes) computes the stage **once** and the gate, the M04 contract, the compiler, the delivery advisory and the HIS scheme all read it: 新生儿 1/6、乳婴儿 1/3、幼儿 1/2、学龄前(3–7)按幼儿 1/2、学龄期(7–12) 2/3、12–17 岁 1；per-herb ceiling = 药典成人上限 × fraction, floored to 0.5 g, **no lower bound**; 麻黄/附子/细辛/乌头/大黄/巴豆/芒硝 ≤ 2/3 at every stage; prohibited/caution herb lists; decoction volume by stage (50/100/150/200/250, ≥12 y as adult). The two 十三五 textbooks (《中药学》1/6,1/3,1/2,2/3 vs 《中医儿科学》 wider) disagree; the more conservative one is used, and 12–17 → 2/3 instead of 1 is a one-number change in the JSON. "患儿" alone (no age, no stage word) still withholds: `pediatric_age_unknown`. Pitfalls found by live replay, all pinned in `test:pediatric-dose-rule` / `test:pediatric-vitals`: ① `PrescriptionPermission.reasons` is the "正式采纳前需确认" list, so **never put explanatory text in it** (the fraction summary lives in `pediatricDose`); ② adult vital-sign lines flagged every healthy neonate (RR 40) — under 12 y the red-flag/recheck lines are age-banded (`tcm-pediatric-vital-reference.source.json`, only ever loosening the false-positive direction; low-end and 体温/血氧/高血压 untouched); ③ age conflict compares numbers (`8个月` = 0.6667 岁), not literals; ④ 「母乳喂养」in an infant record is the infant's feeding, not maternal lactation (`stripInfantFeedingPhrases`, <10 y, same bound as `pregnancyScreenRequired`; explicit pregnancy statements still lock dose). Web search budget ran out mid-work: the PALS 220/180 and hypotension lines were confirmed by page fetch, the 中医儿科学 age table was not re-fetched.
- Always run `sanitizeCaseStateForModel` / `sanitizeFreeTextForModel` before sending case data to a model.
- Clinical facts use a status vocabulary (`positive/possible/negative/historical/unknown`) in `src/lib/clinical-state.ts`. **Do not treat "未提及/unknown" as negative** — generic "过敏史/用药史未提及" pollution is an explicitly tested false-positive class in the regression suite. When you fix one such false positive, extend coverage to the whole class, not just the one case.
- **Completeness** is deterministic and no model scores it: `deriveOperationalCompleteness` (`diagnosis-safety.ts`) scores the current record and `determineCompletenessLevel` (`diagnosis-types.ts`, the single copy) grades it — C requires `redFlag≥0.7` and other dims `≥0.6` (redFlag has the higher bar); any dim `<0.3` ⇒ A; else B. M02's emitted `completeness` object is written by the question route from that same function (since 2026-09-25; before, the M02 model self-scored it). Only level C proceeds to full diagnosis/prescription.
- **Semantic clinical-facts backstop (`src/lib/clinical-facts.ts` + `clinical-facts-runtime.ts`):** an **additive-only** model-derived layer that supplements spoken-language red flags / follow-up clues; **on by default** (disable with `CDSS_CLINICAL_FACTS_BACKSTOP=false`). It may only *add* urgent advisories — never cancel a deterministic positive red flag or a critical vital. `additiveRedFlagsFromFacts` / `priorityEvaluationItemsFromFacts` feed the gate; schema-invalid entries are isolated so a fabricated item cannot erase a valid one in the same output.
- **Client orchestration** lives in `src/lib/diagnosis-engine.ts` (browser localStorage case persistence keyed `diagnosis_case_*`, stream consume with its own idle/total timeouts + `AbortController`) consumed by `DiagnosisClient.tsx`. It is client-side flow glue, not a server pipeline — the server routes stay thin.

### Knowledge base — `src/lib/tcm-knowledge.ts` + `src/data/tcm-knowledge.json`

The 48k-line JSON is a **generated build artifact** — do not hand-edit it. `scripts/build-tcm-knowledge.mjs` compiles it from CSV/JSON sources in a **sibling `合理用药` repo** (`../../合理用药/…`, overridable via `RXAI_DATA_ROOT` / `RXAI_RELEASE_ROOT`); without those sources the rebuild can't run. It carries dose limits, 十八反十九畏 incompatibilities, special-population rules, decoction methods, herb-risk categories, patent-medicine & western-interaction rules, and HIS alias/spec mappings. It is also the **post-prescription safety authority**: dose bounds and 十八反十九畏 are enforced by the deterministic layer (`diagnosis-safety.ts`, `local-prescription-checks.ts`). The Lingxi external audit that used to sit on top was removed on 2026-09-25 (owner: it will never be enabled; production had it off anyway — every M05 logged `audit_rxaudit_disabled`).

**Dose layers (2026-09-28).** `getTcmHerbDoseLimit` order: 药典 dose entry → 药典 decoction route entry → `tcm-herb-nonpharmacopoeia-dose.source.json` (`sourceType: "reference"`, 17 non-ChP herbs, ≥2 web-verified sources each, 煎服 only, ChP always wins). The upstream 「高置信中药饮片剂量校准层」 rows (hand-typed `_CURATED_LIMITS`, no per-row sources; powder doses written as decoction doses) are **stripped at load in `tcm-knowledge.ts`** — the generator cannot be rerun because its `tcm_curated_llm_candidates_20260626.json` input is gone. Clinician-dose herbs are still exempt from contract repairs, but `compileHerbVerification` now compares them with the reference range: inside → "参考区间内（来源）", outside → annotated. Before, any dose showed 「已按标准区间完成规则校验」 (败酱草 45g). Identity: the index is NFKC-keyed like the input, so the 8 ChP names with full-width brackets (延胡索（元胡）, 土鳖虫（䗪虫）…) resolve to themselves; 败酱 → 败酱草 (was 小蓟).

### Lineage (流派) — `tcm-lineages.ts`, `tcm-formula-lineage-affinity.ts` (2026-10-12)

Six cards (`unrestricted` + five schools). A lineage reaches the output through four channels:
- card text in the M03/M04 prompts — weak; the 9/27 measurement showed passive prompt knowledge is barely used;
- three M02 strategy lists (`inquiryFocus` / `syndromeAnchors` / `contraindicationBoundaries`). The strategy `templates` have **no runtime consumer**;
- the model-written `lineageAdaptation`;
- a capped **+2 display-order bonus** inside one positive-sufficiency × dose-compilable stratum. This never takes part in admission, locking or dose.

**What changed on 10/12, and the ratchets that hold it:**
- **Cards.** The school cards were rewritten field by field from local originals (`中医补充数据/TCM-Ancient-Books-master`, byte-identical to github.com/xiaopangxia/TCM-Ancient-Books) and web textbooks. Before, the 扶阳 card's four representative formulas were all 仲景/宋 formulas, and only one of 丹溪's four was a 丹溪 formula. `src/data/tcm-lineage-card-evidence.source.json` holds every field's value and sources. `test:lineage-governance` pins card text == evidence value, representative formulas in the catalog and never a 「A合B」 form, and reviewer metadata saying 「无执业医师签字」. The old fictitious 2026-07-12 reviewer roles are gone.
- **Two attribution paths.**
  - The **source-book rule** (`bookRules` × `formulaAdjudications`) can give a formula only one lineage, so 扶阳 had **0** rankable formulas.
  - **`schoolUsage`** rows bind a catalog (name, source) pair to a lineage, with a quote from that school's original text. A formula can therefore belong to several lineages; 四逆汤 is both 经方 and 扶阳.
  - `test:lineage-affinity` has a coverage floor per lineage: 经方 120 / 温病 37 / 丹溪 8 / 温补 29 / 扶阳 5 common-tier formulas.
- **Catalog source class.** 68 仲景 formulas plus 景岳 新方 and 封髓丹 had a later anthology as their source (《绛雪园古方选注》《医方考》《古今名医方论》…). That emptied the 经方/扶阳 attribution and put wrong 出处 into HIS. They were restored through the collation channel (`ADJ-WEB-20261012-JINGFANG`), and keyed side tables were re-keyed. 50 missing internal-use 伤寒/金匮 formulas and 5 school-own formulas (潜阳丹…, 壮原汤) were added.
- **Catalog ratchets.** `tcm-jingfang-canonical.source.json` (113 + 184 formulas) backs `test:kb-gap-ratchets` 7.x: same name + same composition ⇒ the source must be the original book, and no original internal-use formula may go missing except a listed set. Rewrite `indications` **replace** the existing ones (build line ~1944), so keep the old ones when adding a school's documented uses.

### Customer inventory & medicine sources — `drug-inventory.server.ts`, `medicine-candidate-planner.server.ts`

Owner requirement 2026-09-28: inventory is only a reference; never error when a clinic has no herbs; recommend in-stock drugs first, then our own KB / EviMed / model-proposed. Production then had 105 inventories, 100 of them herb-only.
- **Rank, never filter.** The planner used to drop patent/western drugs not in the clinic's inventory, which left herb-only clinics with no patent or western recommendations at all. Now in-stock items are ordered first and the rest are kept. Up to 5 in-stock drugs from outside the top 10 are added: case-relevant (score ≥3), from the OTC index or the new prescription index `local-patent-medicine-rx-index.json` (4,899 items, no injections, built by `build-local-patent-medicine-index.py --scope rx`). These use IDs `LOCAL-INST-5xx`, and their label records travel in `plan.evidenceContext`. Model-proposed patent drugs (`patentMedicines`) are offered **only when the local label search returns nothing** (prompt + enforced). On the 65-case arm, offering them on every case gave ~2 proposals per case, 70-72 of 82 unverifiable, and planner median 2.2 s → 2.9-4.6 s. Proposals are checked by name against all 8,807 local labels (same safety exclusions, label indication must cover the problem); EviMed only for names absent locally, capped at 1.5 s.
- **Per-kind `coverage`.** Each kind is `synced`, `declared_none` (declared via `kinds` with no items) or absent. An absent kind is **not** out of stock: its availability is `unknown`, labelled 库存外用药. `kinds` replaces only the declared kinds. An empty list without `kinds` returns 200 `unchanged` (the old behaviour was 400).
- **Name cleaning is for availability only** (`drug-inventory-names.ts`). It strips billing prefixes (（免）, Y/Z), spec suffixes, brackets, trailing codes, 片/段/粉, and same-herb processing prefixes (炒/焦/蜜/酒/醋/盐…). It never strips 制/煅/炭, and it never feeds identity, function, dose or 十八反. Tested on 55 real inventories: match rate went from 63% to 82%.
- **Labels 院内有货 / 缺货 / 库存外用药** are computed at render time and are never part of the signed payload. They appear in HIS (`herbAvailability[]`, `medicineAvailability[]`) and through `POST /api/drug-inventory/availability` (page chips).
- **Reads have a time budget.** Clinical reads are capped at 300 ms (`CDSS_DRUG_INVENTORY_READ_BUDGET_MS`); on timeout the request proceeds as "no inventory". Inventory older than 30 days is flagged stale (`CDSS_DRUG_INVENTORY_STALE_DAYS`).
- **Customer registry.** The quota clamp is 1..50,000 and production is set to 20,000. Before this change the quota was 100, the code hard-cap was 1,000, and a registry with more than 1,000 entries was rejected as a whole. On 2026-09-28, 1,821 of 1,926 clinics got 429. The registry is now parsed once per file identity and indexed; before, every request reparsed it, which took 67 ms at 20k entries.

**Catalog gap classes (2026-09-30, `test:kb-gap-ratchets`).** "One problem → one class": parse debris in herb names (剂量/用法文字、单字残片), chapter headings posing as formulas (`治…方`, ≥8 味 → quarantined: no name lock, no dose, not evidence), 出处 field holding an author/abbreviation/typo instead of a book, suffix-form 炮制 names losing their preparation after canonicalisation, and **alias chains that map herb A to herb B**. The last one is the dangerous one: `tcm-herb-identity-catalog.json` is generated from a local alias dataset and auto-resolved medium-confidence "同名异物" as `unique_source_backed` — 茵陈蒿→青蒿 (茵陈蒿汤's 君药 became another herb), 大附子→狼毒, 汉防己→北豆根, 沙参→银柴胡, 葵子→天葵子, and 关木通→木通 / 广防己→穿山龙 / 雷公藤→杠板归 (banned or very toxic herbs passing as ordinary ones). Fix is a row in `tcm-herb-identity-supplements.json` (it overrides the generated index; batch `ADJ-WEB-20260930-ALIAS`): correct target, or several candidates (`ambiguityGroup`, not auto-resolvable), or `canonicalName: null` + `autoResolvable:false` for banned/toxic names. A herb that becomes its own entity with no numeric dose must be registered in `tcm-herb-dose-clinician-policy.source.json` **by the raw name used in formulas** (the policy is keyed by raw ingredient name, not canonical), or every formula containing it silently loses `doseCompilationEligible`. Ratchets 6.x: hazard names never resolve to a herb without a `herbRisk` entry; a dose-bearing KB name is never remapped; formula links whose raw name contains another standard name but resolves elsewhere must be on a reviewed list.

### Output slimming — what the models no longer write (2026-10-12)

Latency is decode-bound: DeepSeek writes ~150–175 tok/s, while reading a 20k-token prompt costs 0.3–0.8 s. Each stage's time is therefore its output length, not its step count. (The question that started this was whether 锁定方 and 候选方案 duplicate each other. They do not: the formula lock is ~2% of the M03 TCM half.)

A field-by-field audit of 15 cases took everything the server already overwrites, derives or never shows out of the model's output, and capped the visible prose. The audit used the DeepSeek tokenizer and traced every field's consumers. The pin is `test:output-slimming`; the measurement harness is in `~/runlogs/fieldtok-20261012`.

**What changed in the provider schemas (`model-response-format.ts`).**
- M03 no longer asks for:
  - `recommendedFormulaNames` / `formulaSelectionMode` — `withDeterministicFormulaReferences` re-derives them from `recommendedFormulaDirection`, so that sentence is now the only lock input;
  - `deferredFormulaSelection`;
  - the citation lists, Western `coding`, and citation/url;
  - `overallTherapy` — copied from `overallMethod`;
  - chain `nodeId` / `pathogenesisType` / `biaoBen`, and `caseRelationship`;
  - axis `resolutionReason` — written by the server;
  - `subTherapies` — projected from the chain in `applyM03AdvisoryQualityBoundaries`;
  - `alternativeDirection`.
- **Habitual writes are tolerated.** The dropped names are in `SERVER_OWNED_FIELD_NAMES`, so a model that still writes them by habit does not push the half onto the 24 s strict fallback.
- **The one exception is `deferredFormulaSelection`.** It is stripped, and `mergeParallelM03Halves` drops it too. A model-written one made the system lock believe it had already acted.

**M04 envelope drift is now repaired before validation.** DeepSeek sometimes puts `patentAndWestern` / `modifications` / `nonPharma` inside `candidate`, or closes `nonPharma` early and leaves the care fields at the root. `checkNonStrictStructuredValue` now moves them back: the key names fix their place, and the compiler already did the same lift. It also drops only the offending `tcmTreatments` row on an out-of-range code. Before this, each such slip sent the whole proposal to the 10–30 s Qwen regeneration. In 113 local M04 first passes, 7 were one of these slips and 1 was unparseable JSON.

**What changed in M04.**
- **Herbs.** `targetKind` is inferred from `targetRef` in `normalizeHerb`, and null/false defaults are omitted.
- **Medicine rows.** They carry only `type`, `evidenceId`, `correspondingProblem` and `positioning`.
  - The label fields are completed from the record the model actually saw: `instruction-record-pool.ts` parses it from the M04 prompt in `callDiagnosisStream`.
  - Completed rows still pass `medicineEvidenceBindingValid` and the chart check.
- **Compiler-generated fields.** `applicable` and `notApplicable` are written by the compiler.
- **`referenceCaseUse`.** It keeps only `adoptedCaseIds`.

**What changed in the prompts.**
- The "不得删短" rule is gone.
- New caps:
  - differentials: 1–3 TCM disease, 1–3 TCM syndrome, ≤8 Western, must-not-miss directions first;
  - Western limitations ≤5, suggested checks and must-collect ≤6, candidate evidence ≤3 per side; the follow-up safety net is one or two sentences naming emergency signs;
  - uncertainties ≤3; symptom clusters ≤2; overall pathogenesis ≤100 字;
  - herb `function` 4–12 字; 方解 120–150 字 (it must still name most herbs);
  - precautions ≤5, unverified pregnancy/lactation, medication overlap and emergency signs first; one or two sentences per care section.
- **Precaution wording has to survive two existing server filters.** Emergency lines must be written as 「若出现……，须……」, because without the conditional word the ungrounded-negation sanitizer rewrites them into 「病历尚未确认…是否存在」. They must also avoid workflow words such as 「采纳」, because the patient-instruction prohibition table drops the whole line. Under the shorter caps the model wrote 「出现…须立即急诊」 and 「再决定是否采纳」; the pregnancy and emergency lines then disappeared in 2–3 of 15 cases.
- **Check list counts as well as lengths.** The Western `candidates` list silently fell from about three to one under the brevity rule; the 10/13 regression found it (see the next section).
- **Do not tighten the safety-bearing lists again without a blind comparison.** The first version capped them at 3–4 items. A blind judge then scored completeness 4.20 → 3.27: 10 of 15 cases were worse and none better. What went missing was red-flag differentials (spinal tumour, tuberculosis), pregnancy checks, emergency signs and medication overlap. Relaxing those lists cost ~200 tokens on the Western half, which is not on the critical path.
- `lineageAdaptation` is null when no school is chosen.
- M04 now receives `westernDiagnosis.primary.supportingFacts`. Its modification rule always told the model to read them, but they were never in its M03 block.
- **Enumerate enum values in the prompt.** The first draft described `positioning` as 「联用或替代定位」. The model wrote free text, and the non-strict check dropped 13/38 medicine rows. With the four values listed, it was back to 6/35 (before the change: 6/40).

**Measured (local, same environment, 15 cases, medians before → after).**

| | Output tokens | Model time |
|---|---|---|
| M03 TCM half | 2,303 → 1,160 | 15.1 → 6.9 s |
| M03 Western half | 1,558 → 947 | 10.4 → 6.3 s |
| M04 first pass | 2,310 → 1,027 | 13.9 → 6.3 s |

Herb-function grounding misses were unchanged (~2.1–2.2 per case), and 方义 was never replaced by the server fallback.

**Blind comparison of the final version against before** (15 cases, judged by a clinician-persona agent, arms randomized as X/Y): overall 3.53 → 3.73, completeness 3.87 → 3.80, concision 3.00 → 3.67, prescription 3.53 → 3.60, diagnosis 3.80 → 3.60. Preference: after 6, before 2, tie 7. The same unchanged outputs drifted ±0.15 between judging rounds, so treat any single-dimension difference under ~0.2 as noise. The judge material and scripts are in `~/runlogs/fieldtok-20261012` (`render.py`, `judge-scores-r*.json`; the X/Y keys are kept outside the judge directory).

M04 raw JSON now more often closes the root early: 0/48 syntax errors before the change, 9/34 in the last two arms. The existing closer repairs fix almost all of them, and a replay of the final prompts gave 0/30 regenerations, so this costs no time. Watch `non-strict structured output violates provider schema` for `m04_proposal` after deploy.

### Full regression after the slimming release (2026-10-13)

185 cases were run end to end on the deployed code (a53cd95) and compared with the pre-slimming build (1fca8ea, 100 cases): the customer's 10 test cases with their standard answers, 31 boundary scenarios (children, pregnancy, lactation, anticoagulant, red flags, sparse records, lineage, herb count), 21 cases rebuilt from the August feedback, 100 mixed cases with expected syndrome and formula, and a 30-case lineage / herb-count matrix. Harness and outputs: `~/runlogs/fullreg-20261013` (`chain.mjs`, `evaluate.mjs`, `scenarios.mjs`, `out/*`).

**What it found, and what now holds.**
- **Independent hard boundaries were skipped on incomplete records.** `derivePrescriptionPermission` returned `limited_dose` for "completeness below C and no question round answered" *before* it looked at pregnancy positive/possible, lactation, anticoagulants, a child of unknown age, or an unavailable semantic screen. The same record written more completely was correctly `non_dose_only`; M05 (`hardDoseSafetyBoundaryReasons`) said "不得采纳" about a prescription M04 had just dosed. A direct API caller that does not answer follow-ups always has `questionRounds = 0`. The boundaries are now evaluated first. `test:redflag-dose-authorization` §6 pins 5 boundaries × 2 completeness levels × 2 round counts plus four controls — every older fixture in that suite had `questionRounds: 1`.
- **"反复上腹痛1年，无呕血黑便" was an active-GI-bleeding red flag.** The qualifier rule (大量/反复/多次… + 16-character window + bleed term) judged negation only at the qualifier. Negation is now also judged at the bleed term; class fixture `gi-bleed-qualifier-negated-term.json`. Corpus replay: 34,494 gate evaluations, 0 changed.
- **Western `candidates` had fallen to one.** After slimming 64% of cases listed a single candidate (before: mostly three). The task text now asks for 2–3. When changing output caps, check list *counts*, not only token totals.
- **A drinking history sent M03 to the placeholder after 144 s.** "每日饮白酒3两" quoted into supporting facts counted as dose-level content (酒 is a herb name) → three qwen3.8-max repair rounds. A herb + quantity span that is verbatim in the record is a quote (`m03DoseLevelInstructionFindings(…, sourceText)`); regimen wording is still rejected.
- **Precautions without 若/如 were still rewritten** ("服药2周失眠心悸无改善，须复诊" → "病历已记录心悸、失眠阳性，须复诊"; 4 of 87). The prospective shield also starts at "服药/用药 + N天/剂/周" and at "出现/发生 X", but only when the same sentence carries a care directive (复诊/就医/停药…). A sentence that ends in such a directive and has no chart-assertion marker (患者/否认/病历…) is shielded as a whole.
- **`notApplicable` carried raw rule rows and grew on every recompile** ("麻黄（孕期/妊娠:MEDIUM/麻黄…）", then "；；；；。命中相应人群…" residues; printed on every non-dose page). `candidate-boundary-text.ts` now owns both writing and stripping the per-herb tail; the text reads "麻黄（孕期/妊娠、心血管病、老年人慎用）".
- **PHI scrubber.** Governed clinical lexemes were not exempt right after a person label, so "患者全身发热3天", "患者左侧头痛1周", "患者劳累后出现胸闷", "患者干咳已有2月" lost the symptom, side or trigger before any model saw them. The three name rules now share one exemption. New closed groups: 经色/经血/经量/经质 descriptors, 经期/经行 + 小腹/少腹, 劳力性, a few pathomechanism forms. 病人/患儿/本例/病例 now go through the same surname table as 患者 (names with the surnames 经/平/充 after "病人" used to leak). Corpus: false redactions 66 → 35 with none added; 23,553 surname × given-name × pattern cases still redacted.
- **Four common formulas could not be recalled by presentation.** The hand-written rows for 六味地黄丸, 补中益气汤 and 丹栀逍遥散 in `build-tcm-governance-tables.py` had placeholder indications ("肝肾阴虚相关表现；…"), and 龙胆泻肝汤 had two syndrome names only. M03's fact-based recall reads that text, so the customer's 腰痛·肾阴虚 case locked 七味都气丸 six times out of six. They now carry the 《方剂学》 textbook 【主治】 text; `test:kb-gap-ratchets` §8 pins "no placeholder indications" and the four recalls.
- **HIS.** `aiMedicalRecord.vitals` was a JSON string for API callers; it is now "T 37.5℃；P 80次/分…". The per-field text budget is 120,000 characters (was 30,000): a verbatim M04 body with its embedded JSON is 35–45k and was being clipped, which made his-scheme report "生成被截断，不允许写回采纳".
- **Lineage `applicable` is the model's judgement** (three values; missing or invalid falls to `partial`). The server used to write `applicable` for any selected school, next to a model-written reason saying the school did not fit (13 of 20).
- **Formula 出处 followed whichever homonym looked most similar.** The name catalog holds a dozen later reprints per common formula, and the governed entry itself was only a fallback, so a prescription identical to the governed composition was signed 补中益气汤《幼科金针》卷下, 八珍汤《元戎》, 逍遥散《局方》卷九 (20 of 263 saved candidates). The governed entry is now a candidate too; closest composition still ranks first (温胆汤 with 茯苓 stays 《三因》), and on a tie the order is national classic catalog → governed book → the rest.
- **Split differential names borrow a shared location** ("颅内占位/肿瘤" → 颅内占位 + 颅内肿瘤), the mirror of the 9/29 shared-tail fix.

**Left as is, on purpose.**
- HIS marks a case `candidateStatus: invalid` whenever M04 lists any patent or western medicine (`medicineOutsideSubmittedScope`, the conservative rule from when the external audit was removed). Since 9/28 almost every case has such rows, so about nine in ten HIS payloads are not adoptable. This is an owner decision.
- Lineage still changes little: across 4 cases × 5 schools the locked formula changed once. The herb-count preference "15 味及以上" gave 11–12 herbs in 3 of 3.
- The model writes "具体病名，病因待查" in about 12% of cases, compound syndrome names in about 8%, adds a sedative to an acute-cold formula for a passing mention of poor sleep, and names a prescription that contains a whole classic formula "本例辨证组方" when it has not kept enough of the catalog composition.
- `regress:tcm-cdss` (golden baseline) crashed in `runKnowledgeCalls` against a local server on both the old and the new build: after a failed assertion it dereferenced a missing `audit`. The harness no longer crashes there; a full old-versus-new golden run was not completed in this round.

**Running this again.** This machine is shared and its swap fills up: `next dev` (3 GB within two minutes) was killed silently again and again, sometimes within a minute, and a dead server looks like a finished run with `status 0` results. Use a supervisor that restarts the server and reruns only invalid cases (`run-final2.sh`), or better, run the prebuilt standalone server, which needs a fraction of the memory.

### 10.12 customer evaluation remediation (2026-10-13)

Plan and evidence: `docs/甲方测评整改方案-10.12测评与竞品对标-20261013.md`. Owner constraints for this and later rounds: **the interface is frozen** (field names, structure, enums and call order do not change; a field may only stop carrying content or be written better), delete only what the customer explicitly does not want, and content is written by the model for the case, not stitched from server templates.

**The customer's request shape is not the page's shape — test with theirs.** Read from the production request archive: the whole record sits in `symptoms` under Chinese keys (现病史/既往史/过敏史/个人史/家族史/婚育史/辅助检查), tongue/pulse/vitals are usually absent, follow-up answers arrive in `conversation` as assistant question + user option text, a skip is one user message `本次未能确认，请继续现场评估`, and later calls carry only the previous stage's structured result (no `questionRounds`, `safetyGate`, `clinicalFacts`). Their panel reads the structured JSON fields and shows them under its own labels.
- `scripts/regress-customer-shape.mjs` drives question → skip/answer → red-flags → diagnose → prescribe → assess in exactly that shape. Default mode calls the route handlers directly through jiti (no Next server, ~1 GB); `BASE_URL` targets a deployed service. `SHARD=i/n` splits a case file across processes: in one process the pipeline's CPU work queues, so `CONC` alone does not parallelize.
- `test:customer-request-shape` is the gated half: six risks (GI bleed, stroke, chest pain, pregnancy, lactation, anticoagulant) × four shapes (no follow-up, skip, one answer, two answers) must give the same gate result.

**Safety gap found there (live until this release).** `trustedInputText` / `authoritativeFieldOrFallback` treated "the conversation has a user message" as "the record is in the conversation" and dropped `symptoms`. After one answer or one skip, a record with haematemesis in 现病史 raised no red flag, and pregnancy or warfarin got dosed prescriptions. `followup-conversation.ts` is now the single authority on what a user message is:
- the skip sentence is removed at normalization, together with the unanswered question before it;
- a user message right after an assistant question is a follow-up answer and supplements the record;
- only other user messages are a primary narrative, the old chat-style caller, which still evicts model-derived `symptoms`;
- the generic positive option of a server-owned emergency screening question counts as a confirmed red flag only together with its question text;
- record-style Chinese keys in `symptoms` are lifted to the canonical slots at normalization, and non-scalar vitals such as .NET's `{"ValueKind":3}` are dropped.
An older assertion in `test:recorded-fact-visibility` pinned the unsafe behaviour as "conservative"; it was rewritten.

**Delivery surface (`delivered-surface.ts`), applied last before attestation and signing.** Internal contracts still need some of what the customer does not want (Western supporting facts ground several checks), so the model keeps writing them and the projection empties them:
- `westernDiagnosis.primary.supportingFacts` / `limitations` / `suggestedChecks` → `[]`, except on the server's limited M03, where the facts carry the red-flag findings;
- the Western name loses parentheses and 「，病因待查」; a symptom-level name (ICD-10 chapter R) becomes 「X待查」;
- the sanitizer's closed set of system sentences becomes clinical wording (病历尚未确认X是否存在 → 未诉X, 病历已记录X阳性 → 有X); the sanitizer itself is untouched;
- 「完整度未达C级…」, 「本例辨证组方」 (→ 自拟方), the `applicable` template sentence, patent-medicine system notes and treatment items with no concrete content are removed.
The prescribe route restores supporting facts from the record's affirmed clauses into its in-memory copy of M03 (modification triggers are grounded on them), while the M04 signature context keeps the delivered M03. For prescriptions the projection swaps only the JSON; re-rendering the Markdown dropped content added after rendering (儿童用药说明). `test:delivered-surface` pins field-by-field structural equality and idempotence — the idempotence check caught a second pass wiping `notApplicable`.

**Textbook anchor (`tcm-textbook-syndromes.ts`).** `scripts/build-tcm-textbook-syndrome-table.py` cuts 2,495 病—证—治法—代表方—加减 rows verbatim from ten 规划教材 in the local corpus (book and line on every row); `tcm-textbook-syndrome-supplement.source.json` adds what the corpus lacks (牙痛, web-checked). Candidates come from the TCM-named books only (内科/妇科/外科/儿科/眼科/骨伤 + supplement).
- **Which diseases' rows the model sees is the bottleneck.** The first cut was purely lexical (complaint → disease bridge, then manifestation term overlap on affirmed text). On 172 synthetic cases with a textbook answer it put the right disease among the candidates in 79%: 「胃脘刺痛」「腰部冷痛」「不爱吃饭」「便后滴血」「排尿费力」 match no bridge phrase, and when the disease is missing the model names syndrome, 治法 and formula freely. `textbook-disease-pick.server.ts` now asks the small-task model (deepseek-flash, temperature 0, ~0.7 s, in parallel with formula recall and polarity; prefetched by M02) to pick up to three names **from the closed list of textbook disease names** for the patient's department. Names not in the list are dropped; timeout, missing configuration or invalid output returns `[]` and the lexical candidates are used as before. Picked diseases lead the candidate list and get all their rows (`preferredDiseases`). Recall went to 98.8% (170/172). `CDSS_TEXTBOOK_DISEASE_PICK=false` disables it. M02's own prompt still uses the lexical candidates (waiting for the pick would add ~1 s to M02).
- A disease that has a section in several books (便秘: 内科 「气秘」 vs 外科 「气机阻滞证」; 阳痿) is taken in one order everywhere — children 儿科 first, otherwise 内科, 妇科, 外科 — in the candidates as well as in the lookup by name. Before, the candidates took the higher-scoring section and the lookup took the first book.
- Candidates go into the M02 and M03 prompts; M04 gets the chosen row's composition and 加减.
- `withDeterministicFormulaReferences` anchors M03 to the matched row: disease name, 治法 (when no 兼证 is written) and formula direction. A textbook formula the catalog cannot lock keeps its name in the direction and M04 names the prescription after it.
- The textbook pairing counts as positive formula evidence in `trustedModelFormulaIdentityNames`. Without that, 龙胆泻肝汤 for 蛇串疮·肝经郁热 failed `named_formula_positive_sufficiency_missing` and the whole prescription became a non-dose page.
- `canonicalTcmDiseaseName` keeps textbook section names. GB/T 15657 maps 头痛 → 头风病 and 虚劳 → 虚劳类病, which is what the customer saw. The name list is a small generated file (`build-tcm-textbook-disease-names.mjs`) because that module reaches the browser bundle.
- A modification trigger is valid when it quotes a recorded current symptom **or** matches a 加减 condition of the matched row (「若恶寒甚」); the latter has no `triggerSource`. Added herbs carry a dose inside the pharmacopoeia range (`modificationDoseWithinPharmacopoeia`; every other dose form is still rejected). See "Modifications (加减)" below for the third kind and the direction rule.
- Measured on the customer's ten standard cases: disease 10/10, syndrome on a textbook row 10/10, textbook representative formula 10/10 (before: syndrome 2/10, formula 2/10).

**Other content rules.**
- 治则 is derived from the settled syndrome name and 治法 (`nationalTreatmentPrinciple`): one term from the 33 GB/T 16751.3 治则 entries, no parentheses; a tonifying verb in 治法 means deficiency, a dispelling verb means excess. `natureDifferentiation.items` is no longer read (one stray 「脾虚」 used to turn an excess case into 扶正祛邪).
- 兼证 defaults to empty; the "every positive finding must land somewhere" and 「兼以/佐以」 prompt rules are gone, and incidental symptoms go to 加减, never the main formula.
- `decoction.method` is one usage line that names every 先煎/后下/包煎/另煎/烊化 herb. Its wording must still satisfy `decoctionMethodMissing` (「共取药液约N mL」「分N次服」).
- Herbs that cannot be decocted with the rest (芒硝, 朱砂) are announced to the M04 model up front; otherwise it copies them from the formula and the contract rejects every round.

**Follow-up (M02).** One question per round, plus one emergency screening question only for a facts finding graded `urgent`. The model is asked for the fact that separates the two nearest textbook syndromes; the server-owned fallback is the same kind of question built from the table (tongue and pulse when missing), ahead of the complaint-family fallback. `CDSS_M02_PROCEED_WHEN_SETTLED` (default false) decides whether "nothing worth asking" is returned as `decision=proceed`: the customer's panel has never received that value, so by default one question is always delivered.

**Skip costs nothing; the same record gives the same result.**
- When a question is issued, `no-answer-precompute.server.ts` calls the service's own diagnose and prescribe routes over loopback with the unanswered record. The marker header (`internal-precompute.ts`) exempts these from the model rate limit and the request archive.
- The stage-result fingerprint no longer includes workflow fields (`questionRounds`, `completeness`, `safetyGate`, `clinicalFacts` …), normalizes whitespace and punctuation variants, and includes the build digest and model names.
- Reusable results are also written encrypted to `CDSS_STAGE_RESULT_STORE_PATH` for 30 days; the in-memory cache alone lost them on restart.

**Red flags.** `redFlagExplicitOnly()` (default on; `CDSS_REDFLAG_EXPLICIT_ONLY=false` restores): semantic findings with status `possible`, uncertain subject, disposition `insufficient_info`, and `urgent_specialist` backed only by `plausibility: possible` no longer prompt or withhold dose. Positive findings at every urgency, `likely` dispositions, emergencies and the whole deterministic layer are unchanged. The first cut also silenced positive + `clarify` findings and would have dosed 「晕倒后被家人扶起」; the open-language class fixtures caught it. `test:clinical-facts` and `test:clinical-disposition` run the legacy switch because they test that mechanism; `test:redflag-explicit-only` pins the default.

**Defects the synthetic evaluation set found (each has a test and a counter-proof).**
- **Obstetric history read as pregnancy.** `assessState` removed all whitespace before matching, so the `[^。；\n]` windows never saw a field boundary: 「工具避孕\n13岁初潮」 became 「孕13」 (13 weeks pregnant), and 「不孕3年」「避孕3年」「备孕3个月」 matched `孕\d+` too. Five ordinary gynaecology records in 190 lost their dose. Newlines are now sentence boundaries, `孕N` needs a non-避/不/备/未 prefix and no 岁/年/次/胎 after it, and 备孕 / 解除避孕 / 停止避孕 are caught by the conception assessor itself (before, 「备孕3个月」 was held only through that misreading). Corpus replay, 69,615 texts: 64 no longer held (all 不孕N年 / 避孕N年 / cross-field), 24 newly held (all 解除/停止避孕). 「不孕」 was **not** added as trying-to-conceive: it would newly withhold 227 corpus texts and is an owner decision. (Since 2026-10-14 trying to conceive no longer withholds dose at all; see the conception paragraph in the 10/14 follow-up section.)
- **Chronic complaints had "no current fact".** `isCurrentPositiveTcmAnchor` judged a whole anchor at once: one negation anywhere (「面色没有光泽」) negated a quoted 现病史 sentence, and the Western rule "N years without a current cue = background history" made the chief complaint 「入睡困难、易醒1年」 historical. Both anchors failed → `tcm_syndrome_current_fact_missing` → placeholder M03. It now judges history per sentence and negation per clause; disease-name labels are still excluded by `DIAGNOSIS_LABEL_ONLY`.
- **A recorded 无汗 could cost the whole M03.** `chain_key_discriminator_missing` (T1 on purpose) has two branches; only the 风寒束表 one had a deterministic projection. With textbook names (阳虚感冒) the other branch — 无汗/自汗 in the basis but not in the chain — went to three repair rounds, 99 s, and the placeholder. `projectM03KeySyndromeDiscriminators` now copies the model's own basis item into the chain evidence.
- **Two deterministic red-flag false alarms.** Measured weight loss needs ≥3 kg (6 斤; ranges take the upper bound; `Kg` is now recognised) — 「体重下降约2kg」 in a cough case was an upper-GI alarm. A degree word followed directly by a comma closes the previous symptom and does not modify a later abdominal pain (「瘙痒剧烈，同时胃脘、腹部疼痛」). Gate replay over 17,505 corpus cases: 8 changed, all read.
- **Server-owned follow-up question.** When the model has nothing to ask and no textbook or complaint-family question applies, the question is now the first basic inquiry item the record does not mention (寒热 → 口渴 → 大便 → 汗, `basicInquiryFallback`) instead of 「总体在加重、缓解还是反复波动」. Textbook option fragments must contain a symptom predicate character; 「伴颜面」 was a body part cut at a 、.
- **Non-dose pages** now go through the same delivery projection (they showed 「本例辨证组方」「本方以本方案为基础加减」「锁定证候」).
- **Internal wording at the source:** axis `resolutionReason` no longer says 「结构化可回溯依据」, modification `evidence.source` is 「患者原文：…」 (was a JSON path plus 「对应病机节点：P3」), and the limited-M03 reason no longer mentions 服务端完整性校验.
- **方义 opening clause.** The provenance layer replaces formula names in a self-devised candidate's analysis with 「本方案」, which also breaks compound names (「本方以本方案合脾约本方案为基础加减」). When the delivered name is a real formula the opening clause is rewritten as a whole (「本方以X为基础加减」); for a self-devised formula it becomes 「本方为自拟方。」. Replacing word by word left 「本方以本方。」 in 3 of 84 cases.
- **Formula name across the two stages.** The delivered name follows M03's textbook formula only when the prescription really is that formula: herb names are compared by composition identity (龙胆草 = 龙胆, 当归尾 = 当归) against the textbook row's composition **and** the catalog composition of each formula, whichever is higher. For 「A合B」 with only A present the name is 「A加减」. Literal comparison had left six real textbook prescriptions named 自拟方.
- **OCR typos in the textbook table** (革薢/草薢, 黄苓, 意苡仁, 瓜萎, 螟蚣 …) are corrected when the table is loaded (`TEXTBOOK_OCR_FIXES`, a closed list checked against "names the KB does not recognise"); the generator keeps the scanned text verbatim. 「龙胆泻肝汤合革薢渗湿汤加减」 had reached the delivered M03.
- **Common processed forms missing from the identity catalog** (煅海螵蛸, 炒谷芽, 炒鸡内金) now use the ordinary-herb cap path when "ordinary processing prefix + exact pharmacopoeia name" holds and the base herb is not toxic (`ordinaryProcessedBaseHerbName`; 制/炮 are not in the prefix set). Two ordinary prescriptions in 190 had become non-dose pages over one digestive herb's dose.
- **Non-decocted herbs** (芒硝) are announced to M04 from the catalog composition too; the textbook row for 防风通圣散 lists only a few herbs.
- **A syndrome name whose core is one character** (吐酸·热证) is looked up by full name inside the settled disease; it used to find no row.
- **Modifications (加减).** Three kinds of trigger are valid now, checked by the same predicates in the compiler and the final contract:
  1. a 加减 condition of the matched textbook row, with the herb named in that entry — exempt from the present-direction check, because the condition itself says the syndrome has shifted (「若见口苦、苔黄腻，加黄连、竹茹」 for 痰浊头痛 used to be dropped as "heat-clearing conflicts with the syndrome");
  2. a recorded current symptom (unchanged);
  3. when the row lists no usable 加减 (about 40% of 外科 rows, 20% of 妇科 rows), a model-written 「若 + concrete symptom」 (`conditionalModificationWithoutTextbook`). Process phrases (复诊时, 症状变化时, 必要时, 效果不佳 …) are still rejected, and this kind is **not** exempt from the direction check.
  Every added herb must be known, dosed inside the pharmacopoeia range, absent from the formula, and — new — not 十八反 with any herb in the formula (`modificationHerbIncompatibleWithCandidate`; only substitutes were screened before). The M04 prompt requires modifications whenever the textbook lists them and asks for the textbook's herb names verbatim (枳壳 is not 枳实).

- **「未哺乳」 was lactation.** `m04GenerationSpecialPopulationIssue` matches population words per clause, and 「未 + verb」 is not in the clause negation list: a record saying 「现否认妊娠，未哺乳」 made 苦杏仁 a lactation high-risk herb → three repair rounds → non-dose page (found on the customer-history replay). The pregnancy and lactation matchers now defer to the governed state assessors when those say `negative`; 未哺乳 / 不哺乳 / 已断奶 are lactation negatives.
- **Habitual colds.** 「反复感冒1+年」 is 虚劳, not 感冒 (the customer's standard case 5). The closed-set pick put 感冒 first and M03 followed it to 气虚感冒·参苏饮 in three of three generations; when the chief complaint only has the habitual form, a picked 感冒 is dropped and 虚劳 leads.
- **`route_not_decoction` has its own repair hint** ("remove this herb"). It shared the hint for a missing decoction requirement ("fill in decoctionRequirement"), which can never satisfy the check.

**What an independent reviewer found that the scorer could not (32 sampled cases, clinician-persona agent, `evalset/rubric.md`; verdicts in `~/runlogs/fix1012/out/judge1`).** The deterministic scorer checks names against the textbook and structure; it cannot see whether an option repeats the record or an acupoint fits the joint. Blocks the reviewer put under 90% and what was done:
- **追问 (69%).** The lexical textbook question 「除病历已记录的表现外，还伴有哪一组」 offered symptoms the record already had in other words (头晕眼花 vs 头晕目眩) in 7 of 29 cases; it is no longer used (the tongue-and-pulse form stays). When the model has nothing to ask, the question is the first unrecorded basic inquiry item (`settled` in `buildCaseAwareQuestionFallback`); the complaint-family danger-sign questions are kept for model failures only. The honest answer for a sufficient record is `decision=proceed` — still off by default until the customer confirms their panel handles it.
- **中医治疗 (71%).** 痹病 points are grouped by joint region in the textbook and were flattened to the first twelve (all shoulder, elbow, wrist) — now only the affected regions (`REGIONAL_MAIN_POINT_GROUPS`). A catalog template matched through an incidental symptom (失眠 points for 眩晕 with 多梦, a gastrointestinal ear template for a cough with 胃脘) yields to the disease's own textbook plan. 神阙 / 乳中 never appear in a needling list. Acupuncture for a child under 12 carries the standard paediatric note.
- **复诊计划与注意事项 (81%).** Pregnancy and lactation advice is dropped for patients it cannot apply to (`reproductiveAdviceRelevant`: not female, under 12, 60 or older, post-menopausal); the prompt asks for one age-related line for the very old and the very young; a red-flag follow-up plan no longer says 「服完本次的药后请来复诊」.
- **辨病依据 (83%).** An unrecorded 「无X」 written to tell neighbouring diseases apart becomes 「未诉X」 (`unrecordedNegativesAsNotReported`; a term the record contains is left alone).
- **工程用语 (84%).** The safety banner and the non-dose status line no longer say 候选 / 独立硬边界 / 采纳前须经院内审方复核.
- **方名·出处 (89%).** A renamed formula's 出处 is the original book from the catalog (三子养亲汤《韩氏医通》), the textbook only when the catalog has no entry.
- **治则.** 健脾 / 温中 / 温肾 count as tonifying verbs (脾胃虚寒证 with 温中健脾 was 实则泻之). **煎服.** 鹿角胶 and 龟甲胶 are 烊化 (pharmacopoeia), so 左归丸 / 右归丸 name them.
- **Not fixed: 西医诊断 (86%).** Three sampled cases named a disease the recorded tests do not support (gout with normal uric acid, vaginitis with a clean smear, POI on one low AMH). A prompt line was added; the three reran unchanged. This is the Western half's judgement and needs its own work.

**Second independent review, after those fixes (same 32 cases, a fresh reviewer; `out/judge2`).** 辨病依据 83 → 100, 方名·出处 89 → 100, 中医治疗 71 → 93, 复诊计划与注意事项 81 → 97; 治则治法, 方义, 加减, 煎服法 96–97; still under 90: 西医诊断 89.7, 辨证依据 89.7, 中医鉴别诊断 89.7, 追问 89.7 (each 26/29) and 工程用语 81 (26/32). The second brief told the reviewer that the basic-inquiry question is a required step and that a textbook 出处 is acceptable when the catalog has no original book, so 追问 and 方名 are not strictly comparable between the two rounds. What it found:
- **The formula name 生脉散 was rewritten to 「生脉象待核实」** whenever no pulse was recorded: the ungrounded-pulse rewrite matched 脉散 (散 is a pulse quality). Twelve places in one case — M03 direction, prescription page, 方义. Fixed with a `(?<!生)` guard; real pulse claims are still rewritten.
- **A basic-inquiry question on a red-flag case** (「怕冷还是怕热」 in haemorrhagic shock). When the deterministic gate says red flag, the settled question stays the safety fallback.
- **Not fixed.** The non-dose page still says 「本次候选方药（非剂量，供医生审阅）」「尚未通过全部确定性校验」「处方补充提示」 (five red-flag or withheld cases; that page's wording is matched by tests and by the page). Location basis text can cite a symptom the record denies (「病位在肾（据尿频）」 with 「无尿频」). A textbook differential used as fallback is the textbook's definition, not a case-specific distinction. Elderly patients get no acupuncture adjustment.

**Measured on the final build (direct route harness, fresh generation every time; `~/runlogs/fix1012/out/final2-*`).**

| Set | Result |
|---|---|
| 190 synthetic cases, by customer block | 西医诊断 100, 中医诊断 97.9, 证候 98.9, 治则治法 95.8, 中医鉴别诊断 100, 辅助中药饮片 92.4 (all twelve checks of the block), 中医治疗 100, 复诊计划 100, 注意事项 100, 追问 96.3, 红旗与剂量边界 100, 工程用语 100, 链路 100 |
| Same set before this round's second half (`out/synth2`) | 证候 83.7, 治则治法 86.3, 中医鉴别诊断 89.5, 辅助中药饮片 69.6, 追问 87.4, 工程用语 77.9 (after removing scorer false positives) |
| 52 customer-history cases | every block ≥ 95 |
| Customer's 10 standard cases × 3 generations | disease 30/30, textbook formula 30/30, syndrome 27/30 (case 5 is 虚劳·肺气虚证 three times; the customer's answer says 肺脾两虚证, the textbook's 虚劳 rows are single-organ). Disease, syndrome, formula, 治则 and 治法 identical across the three generations in 10/10; herb overlap 0.94 (10/13 production: formula name identical in about half, overlap 0.83) |
| 16 archived real cases | every chain completes; 3 red flags, all from the customer's own vital signs |
| Stage medians | question 5.4 s, diagnose 8.4 s, prescribe 9.9 s, assess 1.8 s |

Remaining misses are judgement calls (喘证·表寒肺热 read as 咳嗽·风热犯肺; 虚劳·肝血虚 read as 眩晕·气血亏虚), one prescription that is honestly not the textbook formula (通窍活血汤 without its special ingredients → 自拟方), and `doseOrHandling: null` on added herbs that have no single pharmacopoeia range (萆薢, 琥珀, 贯众).

**In production (8188017, deployed 2026-10-14 05:15 Beijing; tag `20261013-8188017-prebuilt`, override `20260927-dsrepair`).** The customer's ten standard cases in the customer's request shape, skipping the follow-up after a 30 s pause: diagnose 0.09–0.47 s, prescribe 0.15–0.30 s, assess 0.24–0.37 s, all ten `x-cdss-stage-result: reused` (10/13: about 12 s, 11 s and 4 s); disease 10/10, textbook formula 10/10. A skip within 3 s joins the running computation. Seven safety cases with an **answered** follow-up — the shape that was broken — all hold: 黑便, 胸痛, 卒中口语 → `red_flag`; 妊娠, 可疑妊娠, 哺乳, 华法林 → `non_dose_only`. Thirty minutes of logs: 17 precomputes (17 complete), 18 disease picks (18 ok), no error lines; container at 0.96 of 2 GiB. Rollback: host image `tcm-cdss:20261013-353e227-prebuilt` with `docker-compose.yml.pre-8188017` in the release directory; lighter switches are `CDSS_M02_PRECOMPUTE_NO_ANSWER=false`, `CDSS_TEXTBOOK_DISEASE_PICK=false`, `CDSS_REDFLAG_EXPLICIT_ONLY=false`.

**Before deploying a build with result reuse, run that build locally in production mode** (`~/runlogs/fix1012/scripts/start-prod-reuse.mjs <prebuilt dir>`, then `regress-customer-shape.mjs` with `BASE_URL`, `REGENERATE=0` and `THINK_MS`). The evaluation harness sets `CDSS_STAGE_RESULT_REUSE=false` and always sends `x-cdss-regenerate`, so the loopback precompute is never exercised by it.

**Evaluation set and how to score (`~/runlogs/fix1012`, outside the repo).** `evalset/cases-synth.json`: 190 synthetic cases in the customer's request shape with a textbook answer (disease, syndrome, 治法, formula, book) and expectations (red flag, dose mode, incidental-sleep, special decoction, lineage fit); `evalset/cases-customer-history.json`: 52 cases rebuilt from earlier customer feedback. `scripts/run-shards.sh <cases> <outDir> 4 2` runs them through `regress-customer-shape.mjs` (first cases take ~8 minutes: four processes each compile the route tree), `scripts/score.py <outDir> [--cases <file>] [--fail <check>]` scores every check and groups them by the customer's evaluation blocks. A block passes only when all its checks pass. When an expectation turns out to disagree with the system's standing doctrine, correct the expectation in the case file and rescore with `--cases`; four were corrected this way and are marked 【10/13 订正】.

**Left as is.**
- Sparse records still vary between fresh generations (a two-line record can flip between 风寒 and 风热); persisted reuse makes repeats identical, it does not make the judgement itself stable.
- About 15% of textbook formulas have no lockable catalog entry, so their composition is not checked against a baseline.
- (Superseded 2026-10-14: 「未避孕」 and 备孕 no longer withhold dose; see the conception paragraph in the 10/14 follow-up section.)
- The deterministic chest-tightness rule still raises a red flag for 「半年来反复胸闷，每次持续数分钟至十余分钟」 with an explicit 「近期无加重」.
- `COMPLAINT_DISEASE_BRIDGE` lives in code; with the closed-set pick it is only the fallback and M02's source.

### Follow-up to the 10.12 remediation (2026-10-14)

The second independent review of the 10.12 work (`~/runlogs/fix1012/out/judge2`) left five blocks under 90% and fourteen clinical errors. This round worked through every item after web research (four reports in `~/runlogs/fix1014/research/`: LLM faithfulness methods, follow-up questions and determinism, Western diagnostic criteria and chest-pain triage, TCM rules) and measured each root cause before changing code. Running notes: `~/runlogs/fix1014/notes/findings.md`; assertions and counter-proofs: `test:eval1014-remediation`.

**Root causes that were the server's, not the model's.**
- **The syndrome rationale was a stitched template in 135 of 242 cases.** `m03SemanticIssue` judged "rationale missing" with a closed list of connector words; TCM reasoning ends with 「故为…」「故属…」「均示…」, which were not on it, so the model's sentence was replaced by 「四诊要点：…据此辨病位在X（据Y）…」. Its 「据Y」 matched symptom words without reading negation (「无尿频」 → 「据尿频」). Now only structural emptiness counts as missing (`tcmRationaleStructurallyMissing`); the template, when still used, reads affirmed clauses only.
- **Not changed, on purpose: the record text sent to the facts model.** In the customer's shape `trustedInputText` flattens `vitals` and record-style `symptoms` to bare values (「生命体征：90」, unlabelled 家族史/个人史 lines); the M02 model once asked which vital sign "90" is. Labelling them looked like an obvious fix, and it moved a safety judgement: for the golden low-temperature case (76 y, hypothyroid off medication, 35.5 ℃, 嗜睡, 反应迟钝) the facts model called an emergency in 2 of 5 extractions instead of 5 of 5, and the evaluation run released a dose for it. Reverted. Any change to that text needs a class-level `regress:facts-class-parity` measurement first. The "which vital is 90" question is now dropped in M02 when all four structured vitals are recorded (`structuredVitalsComplete`).
- **The diet field had one generic sentence appended in 90 of 157 prescriptions** (the contract only recognised a closed list of words that introduce food examples). A diet paragraph of 24+ characters with a directive is now kept as written.
- **A copied prompt example**: 「饭后温服，服药期间忌食生冷油腻、辛辣之品」 appeared verbatim in 138 of 197 precaution lists. The prompt now describes how timing and food restrictions follow the formula and the syndrome.

**Follow-up questions (M02).**
- One question per round, always (before: an emergency screening question plus one more in 5 of 242 cases).
- Before a category screening question is asked, a small task checks whether the record already answers it (`m02-risk-question-answerability.server.ts`; quotes must be verbatim in the record; `CDSS_M02_RISK_QUESTION_ANSWERABILITY=false` disables). 13 of the 17 screening questions in the previous run asked what the record had already written. An answered category is also removed from the question prompt, otherwise the model asks it again.
- `other_critical` has no content of its own: the model's triage question about that finding is used, or the screening question quotes the record so 「该异常」 has a referent; the gate still recognises the answer.
- When the gate already says red flag, M02 calls no model and asks whether emergency assessment or referral has been arranged (`redFlagDispositionQuestion`; with `CDSS_M02_PROCEED_WHEN_SETTLED=true` it returns `proceed`). The speculative fact-free result is reused only when the red-flag state also matches.
- When the record already covers 寒热/口渴/大便/汗 and the model has nothing to ask, the last question is an open agenda question (「还有没有其他不适」) instead of a complaint-family screening question.

**Western diagnosis.** A narrow check runs on the Western half before the merge (`western-name-evidence-check.server.ts`, ~0.8 s in parallel with the TCM half; `CDSS_WESTERN_NAME_EVIDENCE_CHECK=false`). It asks only whether recorded content contradicts the name or shows it overstated (three cases: a test that should be positive is recorded negative; a defining condition is recorded absent; the name is a heavier grade than the recorded findings), and requires a verbatim quote. If accepted, only `primary.name` changes; the old name moves to the candidates and differentials. Offline over 252 saved diagnoses: 9–10 of 190 synthetic cases flagged (7 correct, 1 false: a nonspecific T-wave change against CAD), 0 of the 52 customer-history and 0 of the 10 standard cases. Rejected first attempt: an extra 「检查结果→意义」 field before the name. The model's reading of the tests was right and the names did not change, and first-pass schema violations went from 0/190 to 30/40.

**TCM differentials.** The textbook table's differential extraction now covers 266 of 331 disease names (was 158; generator change, every other field byte-identical). When the closed-set pick names diseases, only those diseases are candidates (a joint case had picked up 热疮 and 接触性皮炎 by word overlap and used them as differentials). When the TCM half has no retainable disease-level differential, a small task writes the case-specific distinction for the textbook-listed differentials (`tcm-disease-differential-authoring.server.ts`, `CDSS_TCM_DIFFERENTIAL_AUTHORING=false`); the textbook-text fallback in the delivered surface remains the floor.

**Other fixes.** Non-dose pages and red-flag reasons are written in clinical language (no 「候选方」「确定性校验」「AI语义分诊提示」); the 十八反 receipt still says 不得采纳. Precautions that say 「方中有X」 for a herb not in the formula, or mention a treatment not delivered, are dropped. Toxic herbs that need long decoction (附子, 制川乌, 制草乌) are listed first in the usage line: 先煎45–60分钟（至口尝无麻辣感）. 「外用＋功效」 is no longer shown as an oral herb's function (蜂蜜). Acupuncture plans: textbook 实证/虚证 variants are chosen by the signed syndrome (`variants` in the protocol data); without syndrome-specific points the disease-level 治法 is not printed; no bloodletting for patients 65+, deficiency syndromes or broken skin; patients 65+ get a smaller-dose note; schedules from a hypertension-specific source need hypertension in the case. Medicine planner: patent medicines are chosen by syndrome, an empty choice is respected, injections and drugs already in use are excluded (also in the compiler). Chest tightness: an episode duration under 20 minutes in a recurrent course of a month or more no longer counts as an acute cue unless rest or nocturnal symptoms are recorded (class fixture `chronic-stable-chest-tightness-episode-duration.json`; 252 cases × 3 shapes changed only S020; 4,400 corpus evaluations unchanged). A guard against reading 「反复发作」 as 「复发」 was tried and reverted: it also dropped cases whose worsening was written in another clause.

**Third independent review and what followed (same day; `~/runlogs/fix1014/out/judge3a` = the original 32 cases, `judge3b` = 32 held-out cases).** Most of what the reviewer failed on the held-out set was again the server damaging the model's output:
- **Decoction line contradicting the herb table** (5 of 32): 大黄's pharmacopoeia rule is one-of 后下/先煎/冲服, and the line matched the whole alternative string, hitting 先煎 first. One table (`SPECIAL_DECOCTION_ORDER` + `specialDecoctionOrderIndex` in `herb-decoction-rules.ts`) drives both the decoction line and the note on an added herb: a modification that adds 附子 says 「附子先煎45–60分钟（至口尝无麻辣感）」 in its `riskNote`, because `doseOrHandling` only accepts `Ng`.
- **Acupuncture cards.** One seam in `tcm-treatment-capabilities` now covers textbook and catalog cards:
  - `manipulationMatchedToSyndrome` turns a general 补/泻 clause that contradicts a pure excess or deficiency syndrome into 「针用泻法/补法」. Clauses naming a point, 平补平泻 and 「按虚补实泻」 are left alone (醒脑开窍's 「三阴交用提插补法」 is a fixed method).
  - `clinicalTreatmentScheduleWording` rewrites 复评 and drops the 课程索引 sentence. The delivery projection uses the same function and still drops 「实际取穴…由现场医师复核」.
  - The textbook's 「外感…；内伤…」 sentence keeps only the half that matches the syndrome. Other projects no longer borrow the acupuncture operation as their schedule (an auricular card said 「外感咳嗽针用泻法，肺俞可配闪罐」).
  - `signedSyndromeDeficiencyExcess` is the single deficiency/excess predicate (variant choice, bloodletting, manipulation; there were three copies).
- **Syndrome matching for add-points.** 「阴阳两虚」 parsed as the generic 虚 only, so any deficiency syndrome (肾阴亏虚, 肝肾不足) got 关元/命门. It is now listed under both 阴虚 and 阳虚 in `tcm-syndrome-label-concepts.source.json`, like 气血两虚. A textbook label with no nature concept (消渴 上消/中消/下消) is compared through the 「为X」 at the end of its key symptoms.
- **A catalog template matched through an incidental symptom now yields to the disease's own textbook plan even when the template is syndrome-tailored.** 甲流 used to get the headache template, and a 遗尿 child got the post-infection respiratory template through the shared syndrome name 肺脾气虚. `test:customer-review-20260810` ⑪ has a textbook-card branch for this.
- **The negation sanitizer rewrote a differential's typical manifestation** (肠结 「腹痛、呕吐、无排气排便」 → 「否认腹痛；未诉呕吐」). `typicalManifestation` describes the other disease, so it is exempt in JSON, and its rendered 「常见：」 clause is exempt in prose.
- **方义 losing herb names.**
  - 「芳香」 was an unreviewed medium-confidence alias of 白芷 in the identity catalog (`unique_source_backed`). 「香薷辛温芳香」 counted as a foreign herb and the 君药 clause was deleted. Fixed with supplement row `ADJ-WEB-20261014-DESCRIPTOR`, regenerated with `build-tcm-governance-tables.py`; the diff was that row plus hashes.
  - A clause that names own herbs and a foreign one now loses only the foreign name, and 「二药/三臣」 are recounted (「黄柏、苍术二药共为君」 with 苍术 pruned had become 「直清下注足部之湿热」).
- **Precautions, care and the non-dose page.**
  - `casePrecautions` in the compiler:
    - no 「如已怀孕或备孕」 clause for a recorded pregnancy (the rest of the line stays);
    - no administration lines (温服, 服药后…) while the gate says red flag.
  - The non-dose page drops only the clause the dose mask rewrote (「每日食盐控制在（剂量以审定处方为准）以下」), not the whole line.
  - Western differentials that the model itself marks 「不适用」 are dropped.
  - The textbook differential fallback no longer says 「教材列为本病的鉴别病证」 or 「本病与X相鉴别。」.
  - The label 「频次/复评」 is now 「频次/疗程」 (page and Markdown).

**Measured after these fixes (`~/runlogs/fix1014/out/e4-*`, fresh generation; scanner `~/runlogs/fix1014/scripts/scan-defects.py`).**
- Defect counts on the 190 synthetic cases, before (e1) → after (e4):

  | Defect | e1 | e4 |
  |---|---|---|
  | 复评/课程索引 on cards | 29 | 0 |
  | 教材 fallback meta wording | 16 | 1 (model-written) |
  | acupuncture operation as another project's schedule | 13 | 0 |
  | 进针深度 on cupping | 12 | 0 |
  | 大黄 先煎 | 10 | 3 (copied one-of string; fixed after the run) |
  | 外感 operation on an internal syndrome | 4 | 0 |
  | typical manifestation as the patient's negatives | 4 | 0 |
  | 「不适用」 Western differentials | 2 | 0 |
  | masked care lines | 2 | 0 |
  | 「有X；否认X」 | 5 | 5 (left, see below) |

- Synthetic blocks moved: 中医鉴别 97.9 → 100, 辅助中药饮片 92.4 → 94.9, 注意事项 96.8 → 98.1. 追问 98.9 → 98.4 (screening questions; M02 untouched). 工程用语 100 → 99.5 (「次级病机」 in 方义, rewritten since). The other blocks did not move.
- History cases: every block ≥ 94%. 红旗 51/52: rf-lowtemp, see below.
- Customer's ten standard cases × 3: disease 30/30, syndrome 27/30, formula 30/30.
- Medians: question 5.8 s, diagnose 9.8 s, prescribe 10.7 s.
- Regenerating the identity catalog also requires `build:nihaisha-fusion`: its manifest records the catalog hash, and `test:nihaisha-fusion` fails otherwise. Core herbs and the classic index did not change.

**Left as is after the third review.**
- **rf-lowtemp was model variance, not a regression; closed later the same day.** The case is a 76-year-old with T 35.5 ℃, drowsiness, slowed responses and hypothyroid medication stopped, and only the facts layer raised it. In 6 fresh extractions 1 graded the metabolic finding `urgent` instead of `emergency`, so dose was released; the e4 run hit the same draw. The owner then approved a deterministic floor (see the hypothermia paragraph below).
- **Mixed polarity in the negation sanitizer.** A record with both 「手心脚心发热」 or 「发热感」 and 「无发热」 gets 「有发热；否认发热」 in a differential. This is the frozen open-language polarity class: it needs a class fixture and a corpus replay in both directions.
- **Western names more specific than the record:**
  - 缺铁性贫血 without iron studies;
  - PCOS with a normal ultrasound and normal hormones;
  - functional dyspepsia after two weeks.

  The narrow check says consistent. A criteria-count variant of rule B was measured on 252 saved cases and rejected: it still passed PCOS and brought back the 冠心病/T 波 false positive.
- **A suspected OCR typo.** 遗尿·肺脾气虚 in 《针灸治疗学》 reads 「配肝腧、脾俞」 in the scanned text. It is probably 肺俞 (the other textbook gives 肺俞、气海、足三里), but it was not changed without the original page; web search found no copy.
- **Dropped textbook differential names.** A name that normalization drops (抱儿痨, 脱汗) still falls back to textbook text. Keeping every textbook-listed name would also let Western names through (an ICD-10 filter missed 胰腺炎 and 尖锐湿疣), against the 9.24 rule that TCM differentials list TCM names only.
- **Model judgement:**
  - follow-up questions that repeat recorded items;
  - 加减 adding sedatives for incidental insomnia;
  - no antibiotic advice for 丹毒 with leukocytosis.

**Trying to conceive: dose given, pharmacopoeia pregnancy labels applied (owner decision 2026-10-14).** Before this, 备孕/未避孕 (positive or possible) sat in the same independent hard boundary as pregnancy and lactation, so an infertility consultation written as 「未避孕1年未孕」 got a non-dose page. Research (`D-tcm-rules.md` §5): the 药典 wording is about 孕妇; the 《中医妇科学》 不孕症 chapter and the 2023 《女性不孕症中西医结合诊疗指南》 prescribe dosed decoctions to these women, including 孕妇慎用 herbs (桂枝, 牡丹皮, 桃仁, 红花, 附子, 肉桂).
- **One predicate:** `conceptionWithoutPregnancyOrLactation` in `clinical-state.ts`, true when conception is positive or possible and neither pregnancy nor lactation is. The gate (`hasPositivePregnancyOrLactationRisk` now covers pregnancy and lactation only), the M04 contract, the compiler and the M04 prompt all read it. 停经 / 月经逾期 are still judged possible pregnancy by the pregnancy assessor, so they keep the hard boundary.
- **Herb data:** `src/data/tcm-chp-pregnancy-herb-labels.source.json` lists 药典 2020 一部 孕妇禁用/忌用 37 and 孕妇慎用 60, with each monograph's 【注意】 wording. The 37 match the 2023 医药导报 tabulation exactly. Read through `conception-herb-policy.ts`: exact name and aliases first, then identity-preserving prefixes, never 制/煅/炭 (制川乌 is 慎用, 川乌 is 禁用), then governed identity.
- **What changes for these patients:**
  - a 禁用 herb in the candidate is a special-population T1 (`..._high_risk_pregnancy`, repair removes it);
  - a 禁用 herb added as a modification is dropped (`special_population_conflict`);
  - a 慎用 herb is kept and annotated in its `verificationReasons` («药典2020「孕妇慎用。」本例备孕/未避孕，使用前请确认未妊娠，月经逾期者先验孕。»), and an added one in the modification's `riskNote`;
  - the knowledge base's own pregnancy rules do **not** apply to this tier: they mark 红花, 桃仁, 益母草, 附子 and 牛黄 HIGH, so applying them would delete the very herbs the 药典 only marks 慎用.
- **Reason text unchanged:** 「已记录妊娠、哺乳或备孕阳性/可疑状态」 is kept for pregnancy and lactation cases, because integrators read it.
- **Measured:** gate and permission replay over the 242 evaluation cases × 3 shapes — the two conception cases (S102 「未避孕1年未孕」, S134 「未避孕」) went from non_dose_only to limited_dose, and their expectations were corrected 【10/14 订正】. The modern-case corpus (604 cases × 2 shapes) did not change.
- **Pinned by** `test:conception-dose-policy`. No assertion had pinned the old rule: every suite stayed green when it was changed.
- **Known gap, not changed:** the M04 special-population matcher recognises pregnancy by literal words (妊娠/怀孕/孕妇/孕期), so 「停经8周，宫内早孕」 does not trigger the knowledge-base pregnancy herb rules in the non-dose candidate. Those cases get no dose either way.

**Hypothermia with a recorded consciousness change is a deterministic red flag (owner decision 2026-10-14).**
- **What changed:** the gate already flags T < 35 ℃. Now 35.0–35.5 ℃ plus a current, non-negated 嗜睡 / 昏睡 / 谵妄 / 昏迷 / 呼之不应 / 意识模糊 / 意识障碍 / 神志不清 / 神志模糊 / 神志恍惚, or 「反应（较平时/较前）迟钝」, also raises one (`currentConsciousnessChangeTerm` in `detectProgrammaticRedFlags`).
- **Why:** rf-lowtemp (76 y, 35.5 ℃, drowsy, slowed responses) depended on the facts layer alone, which graded it `urgent` in 1 of 6 extractions and released dose.
- **Class fixture:** `scripts/fixtures/open-language-classes/hypothermia-with-consciousness-change.json` (sibling parity against 34.x ℃, plus controls).
- **Replay:** the corpus did not change. In the evaluation set only rf-lowtemp and S188 changed, both expected red flags.

**Records without tongue/pulse, and records with only the chief complaint (2026-10-14).** The customer asked in the 10.12 evaluation (item 3) whether tongue, face and pulse are required for reasoning. They are not.
- **Customer's own case:** their 胃痛半月 case was run in production with and without tongue/pulse. Both gave the same disease, syndrome and formula (胃痛 / 肝气犯胃证 / 柴胡疏肝散). Without tongue/pulse:
  - the syndrome is `bounded`;
  - tongue and pulse go to uncertainties and `mustCollect`;
  - M02 asks for them once.
- **Evaluation set:** across the 101 cases without tongue/pulse, syndrome accuracy equals the cases that have them (84/85 each). No tongue or pulse sign is invented in the patient's basis, rationale or pathogenesis.
- **What was wrong:** a record that holds only the main symptom (「胃痛3天」「腰部疼痛2周」「腹泻」) got a specific cold/heat/deficiency syndrome and a dosed formula; 12 such records went 22/24 that way. Two causes:
  - the model took the first textbook row, because the candidate list is in textbook order;
  - when the model itself wrote a neutral method, `withTextbookSyndromeName` / `textbookNearestRow` could still rename the syndrome onto a row. The anchoring then copied that row's 治法 and 代表方 (温胃散寒, 香苏散合良附丸; 清热利湿, 四妙丸).
- **Prompt change** (the candidate header plus rule 7 of the M03 prompt):
  - 「贴合」 needs a recorded feature that separates the row from the disease's other rows. The main symptom and the course length do not count, and the list order is not a likelihood.
  - With no such feature the model writes:
    - a neutral functional syndrome name (location + qi disorder, e.g. 胃气不和证, 肺气失宣证);
    - a regulating method and a mild formula, or a self-devised one;
    - a rationale that says which separating features are missing, in clinical words.
  - The level words (工作判断, 有边界, 症状层, 中性) stay out of doctor-facing text. Before the change they appeared in 12 of 32 sparse rationales.
- **Server change:** `textbookNearestRow` will not rename onto a row whose name adds nature characters the model did not write. This applies when the model's name and method contain none, or when no row's manifestations match the record. Only the winning row is vetoed. Filtering rows before ranking was tried and turned 心神不宁证 into 心肾不交证, because removing competitors widened the margin.
- **Measured** (local, customer request shape, M03+M04; material in `~/runlogs/tonguepulse-20261014`):

  | Set | Before | After |
  |---|---|---|
  | Development (12 records) — clear unsupported commits | about 9 of 12 | 2–3 of 12 |
  | Held-out 1 | 11 of 12 | 5 of 12 |
  | Held-out 2 (written after the wording was frozen) | barely moved | barely moved |
  | Cue-bearing controls (6) | correct | unchanged |
  | 14 gold cases without tongue/pulse | correct | unchanged (14/14 textbook syndrome) |
  | 胃痛半月 | correct | unchanged |

  Held-out 2's complaints mostly imply a pattern by themselves (盗汗 → 阴虚, 咽部异物感 → 痰气郁结, 月经量少 → 血虚); that is treated as a cue and is defensible.
- **Still left:** 头晕 / 耳鸣 / 健忘 → a deficiency syndrome, neck or knee pain → 痹 with 湿, and 瘙痒 → 风热血热 in about a quarter of sparse records.
- **`compositionLogic` (组成逻辑):** the generator (`build-nihaisha-fusion-assets.mjs`) now writes 「组成：…。出处：…。」.
  - Before, 155 entries ended with 「仍须逐项核对患者事实、鉴别边与禁忌后才能进入处方编译」, and 7 quoted course notes (「课程强调…」「糖尿病足课程案例」).
  - This field goes to HIS (`formulaRationale.compositionLogic`) and the prescription JSON. The page already hid it.
  - A composition-only entry is not used as the 方义 fallback.
- **Tests:** `test:eval1014-remediation` §13.

**In production (5c85a55, deployed 2026-10-14 19:08 Beijing; tag `20261014-5c85a55-prebuilt`, same release directory and `20260927-dsrepair` override).**
- **Verification:** `verify:deployed-image` (commit + digest + strictReady) and `regress:prod-smoke` both passed, with 0 failures.
- **Live check on hospital-b:**
  - 「胃痛3天」 → 胃气不和证, 理气和胃, a mild self-devised formula; the follow-up asks how the pain relates to cold and warmth;
  - the 寒邪客胃 control is unchanged;
  - 胃痛半月 without tongue/pulse is unchanged, and now carries the new `compositionLogic` wording.
- **Rollback:** image `tcm-cdss:20261014-244ab82-prebuilt` with `docker-compose.yml.pre-5c85a55`.
- **Build resources:** the local prebuild peaks at about 5.8 GB RSS and needs about 3 GB free on `/home`.
  - With other sessions' jobs running, it was OOM-killed nine times.
  - It succeeded once they stopped. It was built from the main checkout with its untracked files moved aside: the script refuses a dirty tree, and a separate worktree costs about 580 MB more disk.

**In production (244ab82, deployed 2026-10-14 14:47 Beijing; tag `20261014-244ab82-prebuilt`, same release directory and `20260927-dsrepair` override).**
- **Deploys:** 60e0f12 (third-review fixes) went out first at 13:40, then 244ab82 (conception dosing + hypothermia floor).
- **Switch:** the override now also sets `CDSS_M02_PROCEED_WHEN_SETTLED: "true"` (user decision: `decision=proceed` was always in the documented interface, §4.3).
- **When `proceed` is returned:**
  - when nothing is worth asking: no basic-inquiry or agenda question is added;
  - on a red-flag case: no disposition question.
- **Verification:** both deploys passed `verify:deployed-image` (commit + digest + strictReady + both model families) and `regress:prod-smoke` (0 failures).
- **Live check on hospital-b:**
  - rf-lowtemp → `proceed` + red flag + no dose;
  - S102 (未避孕) → dosed, with 制天南星/枳壳 annotated as 孕妇慎用;
  - two standard cases → one question each + dose.
- **API doc:** V2.36 records the three behaviour changes.
- **Rollback:**
  - image `tcm-cdss:20261014-60e0f12-prebuilt` or `…8188017…` with `docker-compose.yml.pre-244ab82` / `.pre-60e0f12`;
  - the override backup is `production.override.yml.pre-proceed-20261014`;
  - the proceed switch alone: set it to `"false"` and run compose up.

### 10.12 delivery round (2026-10-17)

The owner set the bar for "done": the customer re-runs their 10 standard cases and fills the same 8-column table as in 10.12 (中医诊断、西医诊断、治则治法、中医鉴别诊断、辅助中药饮片、中医治疗、复诊计划、注意事项). Acceptance:
- each column fails at most 1 of 10 under an independent clinician-persona review;
- the held-out set reaches ≥90% per block;
- no red flag on cases 1, 2, 7 and 9;
- the same record gives the same output;
- skip-to-prescription p90 ≤ 15 s.

**Status: deployed with the second pass as d2bbe09 on 2026-10-17 (see "In production (d2bbe09…)" below); commits not pushed.** The build needs about 6.5 GB of memory plus swap; `~/runlogs/deliver1017/deploy/prebuild-when-free.sh` waits for that, moves the three untracked files aside and always restores them.

The interface stays frozen. Material: `~/runlogs/deliver1017` (cases, paced runner, outputs, review briefs and verdicts).

**Measure the way the customer judges.**
- The deterministic scorer (`~/runlogs/fix1012/scripts/score.py`) said ≥94% on every block, including 西医诊断 100%, but it checks form only. The independent review of the held-out set on the same code had 西医诊断 72% and 辅助中药饮片 66%, and the customer judges like the reviewer.
- The customer's 10 cases had never been reviewed on all 8 columns before this round.
- Briefs:
  - customer cases: `judge/brief-c10.md` (rubric + the customer's 10.12 comments, 8 columns);
  - held-out set: `~/runlogs/fix1014/notes/judge-brief.md`. Its 口径 1 predates `decision=proceed`; one reviewer counted proceed as a failure, another did not, so 追问 numbers are not comparable across reviewers.
- The review renderer must show every field the customer's panel shows. The old one omitted `faceNote`, and the reviewer called a recorded 面色萎黄 fabricated (`deliver1017/scripts/panel.py`).

**Production baseline (5c85a55, before this round).** Customer cases × 3 fresh generations, customer request shape. Failures per column out of 30:

| 中医诊断 | 西医诊断 | 治则治法 | 中医鉴别 | 辅助中药饮片 | 中医治疗 | 复诊计划 | 注意事项 |
|---|---|---|---|---|---|---|---|
| 10 | 8 | 4 | 8 | 10 | 8/28 | 4 | 15 |

- Disease, syndrome and formula were identical across the three generations, and cases 1/2/7/9 raised no red flag.
- Speed on the 32 held-out cases, real path (question, a 20 s pause, skip): red-flags + diagnose + prescribe median 1.3 s, p90 3.0 s. A full chain without precompute is about 26 s.
- Safety probes all held: bleeding, pregnancy, warfarin and lactation with an answered follow-up; hypothermia with drowsiness; an infant with HR 55.

**Most failures were the server's.** Each of these has a test in `test:eval1014-remediation` §3.5–3.6, 4.4b, 7.6–7.27, 10.3, 10b, a counter-proof, and, for sanitizer classes, a class fixture.

- **Western names more specific than the record.** `western-name-evidence-check.server.ts` gains case D: a name needs a test or course threshold the record lacks (缺铁性贫血 without iron studies, 功能性消化不良/肠易激/功能性便秘 under six months, PCOS, 甲减 without thyroid tests, 慢性胃炎 without endoscopy). The supported broader name is used instead, and the old name stays in the differentials as "尚未取得确诊所需的检查或病程依据".
  - D is not applied on red-flag records (an emergency name is not softened to 待查).
  - Clinically diagnosable diseases and causes already named in the record are listed as consistent in the prompt.
  - Offline over 272 saved diagnoses, two runs: synthetic 29–30/190, history 16–17/52, customer 5–6/30 flagged; the runs differ by one case per set.
- **TCM differential names had two predicates.**
  - The authoring task took only names `resolveTcmDiseaseDifferentialName` keeps, but the delivery fallback pasted every textbook-listed name with its definition: 腰痛 got 背痛/尻痛 definitions, 瘾疹 got the 丘疹性荨麻疹 definition.
  - The national-standard alias renamed 真头痛 to 厥头痛 while keeping 真头痛's description.
  - Now one predicate serves all three uses: a textbook-listed name for this disease with a TCM form (≤4 chars ending in 痛/疮/痹/汗/衄/证/痨, not a Western mapping key) is kept; when nothing survives, the authoring task proposes TCM names through the same predicate.
  - Over all 460 textbook pairs only 18 changed, all TCM names (including the 10/14 residuals 脱汗/战汗/抱儿痨). The first, broader version also admitted 肠梗阻, 尖锐湿疣 and 血友病, and stopped renaming 荨麻疹 to 瘾疹.
- **Textbook rows borrowed across diseases.** `textbookRowForSyndrome` fell back to another disease's row even when the settled disease had its own section: 虚劳·肺脾两虚证 found 肺胀's row, and anchoring would have copied 降气化痰 and renamed the disease. The fallback is now only for a disease name that matches no section.
- **Precautions.**
  - Undelivered treatments are rechecked after the delivery surface drops empty cards (导引 added).
  - Timing follows the decoction line (饭前 vs 饭后).
  - Age-specific lines appear only for that age.
  - A line telling the patient not to take a medicine that `patentAndWestern` recommends is dropped. The new "already-taken medicines" prompt line had produced 「不宜再服人参口服液」 next to a 人参口服液 recommendation.
  - Home acupressure (按揉) no longer counts as a delivered 推拿 project.
- **Per-herb population cautions** (`notApplicable`) list only populations the patient can belong to. Before, 96% of prescriptions for men, children and patients over 60 carried 孕期/哺乳 cautions. `candidate-boundary-text.ts` takes an audience; the prescribe route passes `structuredHerbBoundaryAudience`.
- **Treatment cards.**
  - Card text goes through `cardSentencesMatchedToSyndrome`: a sentence qualified by another syndrome is dropped (「瘀血腰痛和寒湿腰痛可行刺络拔罐」, 「风热证大椎可行刺络拔罐」 on 风寒), and so is moxibustion advice for yin-deficiency, heat or 火 syndromes.
  - Pure excess-heat syndromes get 泻法 instead of 「平补平泻或补法」. Mixed patterns keep 平补平泻, the 10/14 rule.
  - 「皮肤针重叩出血」 counts as bloodletting.
  - Class templates whose content is only a 治则 paragraph are not delivered, and neither are diet cards with rich food (猪排, 猪肺) when the diet field says 清淡/避免滋腻.
  - The COVID home-care schedule needs COVID context.
  - Home acupoint care no longer starts with 「也可以」.
- **Server text that damaged correct model output.**
  - The 风寒 discriminator projection pasted the whole record segment (「辨证采用病历原文中的关键鉴别事实：…二便调。」). Now it adds one clinical clause for the missing 恶寒重发热轻/无汗/脉浮紧.
  - 方义 loses false removal claims (「去原方中…之品」 when every catalog herb is present) and model self-talk (「…川芎？不，川芎保留。」).
  - Modification targets no longer read 「兼见若兼见…」.
  - An added herb that is the raw form of a formula herb (生地黄 vs 地黄) is a duplicate.
  - A one-of decoction rule is written as its first option, the same choice the decoction line makes (大黄「后下、禁止久煎」, not the whole one-of string).
  - 黑芝麻's knowledge-base function wrongly includes 清热解毒/补中益气. The verified-function generator's input is gone, so new corrections go in `src/data/tcm-herb-function-corrections.source.json`, each with a textbook quote and line number.
- **Negation sanitizer.** These are deterministic morphological guards on closed sets; the class fixtures use the new `mode: "sanitizer"` in `test:open-language-classes`.
  - Local heat (手心/关节/局部发热, 发热感) is not fever, and 低烧 joins the fever synonyms. Fixture `local-heat-not-fever`; corpus replay of 1,076 cases changed 67, all local heat.
  - Fixed 无-expressions (发无定处, 无故, 无度…) are not denials. Fixture `fixed-wu-collocation-not-negation`. This one surfaced only after the rationale prompt asked for every accompanying finding: 病历9's rationale became 「有瘙痒，与丘疹性荨麻疹相区分」 in 3 of 3 runs.
  - 有无/是否 in a check item is not an exam claim (a 鼻渊 check became 「未记录腹部查体结果」).
- **Incidental sleep.** A 佐/使 herb in the 安神药 category that is not in the named formula's catalog composition is removed when neither syndrome nor disease involves 心/神/寐/悸/郁. The prompt already forbade it; the model still added 首乌藤 and 酸枣仁.
- **Prompts.**
  - The syndrome rationale (≤200字) explains each recorded accompanying finding and keeps the recorded trigger.
  - The follow-up plan opens with 「请服完本次的药后复诊」.
  - Precautions cover medicines the record says the patient already takes (not the recommended ones) and unrecorded lactation after childbirth.
  - The candidate header allows a two-organ name when both organs have their own group of findings.

**Measured after.** Local route harness on the final code, same customer cases × 3 fresh generations, same review brief. Failures per column out of 30, production baseline → after:

| 中医诊断 | 西医诊断 | 治则治法 | 中医鉴别 | 辅助中药饮片 | 中医治疗 | 复诊计划 | 注意事项 |
|---|---|---|---|---|---|---|---|
| 10 → 5 | 8 → 4 | 4 → 4 | 8 → 1 | 10 → 7 | 8/28 → 2/29 | 4 → 0 | 15 → 4 |

- Held-out 32, merged blocks, production → after: 中医诊断 79 → 86%, 证候 90 → 97%, 辅助中药饮片 55 → 90%. 中医治疗 66 → 85%, 西医 83 → 90%.
- Production's held-out run lost two chains to a client-side failure; the rates above count them as failures.
- 病历5 alone costs one failure per generation in 中医诊断, 治则 and 饮片 (see below). Without it, 中医诊断 and 治则 are at most 1 per generation.

**Left as is.** (病历5, 病历7, the missing precautions and the repeated follow-up questions were fixed later the same day; see the next subsection.)
- **Model-written 方义 slips:** a role named but not explained.
- **Catalog 出处 for 补肺汤** (《妇人大全良方》 vs 《永类钤方》) and the textbook note used as the 出处 of 加味四物汤.
- **`formula_direction_drift`** rejections are frequent on production (55 in this round's traffic) and cost a full regeneration each. They predate this round and were not investigated.
- **The adolescent 145/95 probe still says 高血压.** Case D's quote check needs the record wording, and vitals are not in narrative form.

**Running this again.**
- Production allows 60 POSTs per 10 min per token + tenant. `deliver1017/scripts/paced.py` runs ≤11 chains per batch and alternates hospital-a/b with 640 s between batches on one tenant.
- Two held-out chains once failed client-side, with no nginx entry, while this machine was out of memory. Check status codes before counting a case.
- Never wait on `pgrep -f "<pattern>"` from a shell whose own command line contains the pattern: it matches itself and never exits. Wait on a completion marker in the log instead.
- `test:clinical-vocabulary` refuses new inline word lists (≥3 CJK alternatives, or ≥4 CJK strings) outside allowlisted files. Keep such tables in an allowlisted module or match the knowledge base's own labels.

### 10.12 delivery round, second pass: the four residuals (2026-10-17)

The owner asked to research the four remaining items online, fix them, commit, and deploy last. Research notes are in `~/runlogs/deliver1017/research/`: A = sources for 肺脾两虚, B = dental diagnosis and precautions, C = LLM methods. Most causes were again the server's. Tests: `test:eval1014-remediation` §14 (14.1–14.18), `test:m02-contract`, and class fixture `preposed-negation-scope-forward`. Every assertion has a counter-proof.

**病历5 (虚劳·肺脾两虚证): the server renamed it.**
- **Cause.** The model wrote the two-organ name. `textbookNearestRow` renamed it to the closest single-organ row (肺气虚证, sharing 肺/气/虚), rewrote the rationale to 「两脏各有成组表现，故为肺气虚证」, and anchoring then copied 补益肺气.
- **Fix.** A rename may not drop an organ that the model wrote both in the name and in its 病位 column.
  - A row that names no organ (气血亏虚证) can still be chosen.
  - 肝肾阴虚 with only 肾 in the 病位 column still becomes 肾阴虚证.
- **Sources.**
  - 国中医药医政发〔2020〕3号 证候 5.6.3.2.2 脾肺气虚证: 「疲乏无力，语声低怯，自汗、畏风，反复感冒，腹胀，食少、便溏…」.
  - 《中医内科学》 虚劳: 「临证常采取复合证辨治…数脏均损，须分清主次，兼顾治疗」.
- **Result, 3 of 3 runs.**
  - 肺脾两虚证, with 治法 补益肺气、健脾益气、固表止汗.
  - 补中益气汤合玉屏风散; both are on the customer's accepted list.
  - No 熟地黄. 《中药学》: 熟地黄 「食少便溏者忌服」.

**病历1: the negation sanitizer's scope.**
- **Cause.** In 「恶寒重、发热轻、无汗」 the 无 was taken to deny 发热. The clause became 「病历已记录发热阳性」, and the 风寒 projection then added the clause a second time.
- **Fix.** A preposed cue (无/否认/未见…) governs only what follows it. Postposed cues (均无, 均否认, a cue at the end of the clause) still govern the whole clause.
- **Replay.** Of 40,544 corpus record sentences, 56 changed, all record self-quotes that used to be rewritten (咳嗽无痰, 发热无汗, 面色苍白无华…). Of 101,447 output strings, 56 changed, in the same direction.

**病历7 急性牙髓炎 → 牙痛.**
- **Fix.** Case D now says that dental subtypes need an oral exam (pulp or thermal tests, percussion, probing, X-ray). AAE and MSD both say these diagnoses need exam findings. The supported name is 牙痛 (K08.8).
- **Where the sentence sits matters.** Placed before the six-month threshold sentence, 功能性便秘 at three months (S161) was missed in 2 of 2 runs. At the end of D it is caught.
- **Offline replay.**
  - 病历7 is flagged in 3 of 3.
  - The stable new synthetic flags are three dental cases plus BPPV without a positional test.
  - The old prompt alone varies by up to 7 cases between runs.
- **D's differential wording.** The model's reason (「无口腔专科检查…」) was read as a patient negative. Its opening is now written 「尚缺」.

**Precautions: rule-computed items (`required-precautions.server.ts`).**
- **Self-taken medicine in 现病史.**
  - The name must carry a dosage form or match a label name exactly (「吃山楂后」 does not count).
  - Composition comes from the governed formula row, or from the herbs shared by ≥2 catalog versions.
  - The alcohol warning comes from any label sentence that names the drug together with 双硫仑/戒酒.
- **Childbirth within 12 months with lactation unrecorded.**
- **丹毒 / 蜂窝织炎.** 《中西医结合外科学》 「全身应用抗生素」; IDSA 2014.
- **How it is applied.**
  - Items are listed in the M04 prompt and checked per item on the delivered surface. A missing item gets the rule's sentence.
  - Overlap herbs named by the model are pruned to the herbs actually in the prescription; the model had copied the whole 黄连上清丸 composition.
  - Lactation herbs use the same KB tier as the per-herb notes, and a model line saying there are none is replaced.
- **Why rules.** Research C: LLM judges detect omissions at near chance (0.50–0.63). A deterministic must-list with per-item checks is the documented fix.

**Follow-up questions.**
- **Fallback questions.** Most server fallback questions came from `sourceEvidence`. More than 4 entries, or one entry that was not verbatim, discarded the whole model question. Round 3 had 9 such fallbacks in 30 customer runs and 4 in 32 held-out cases; offline, 病历3 failed 4 of 4.
  - Entries are now isolated one by one. If none of them grounds, the question is still rejected.
  - Round 4 had 0 fallbacks.
- **Narrow redundancy check on model-written questions** (`m02-question-redundancy.server.ts`).
  - A question judged answered or partly answered, with verbatim quotes, is removed through the same path as deterministic removal.
  - Character overlap did not separate the cases: the reviewer-confirmed repeats scored 0–0.4.
  - Offline, of 289 questions, 20 were answered and 24 partly answered.
  - v2 also flags questions asking which recorded group predominates, and questions about a feature already recorded.
  - It costs about 0.85 s. Switch: `CDSS_M02_QUESTION_REDUNDANCY_CHECK`.
  - The route test now allows exactly this one narrow call; the general reviewer removed on 9/25 stays removed.
- **Trend fallback.** When the record already describes the course, the 「总体在加重还是缓解」 fallback becomes the open agenda question. The stem no longer embeds the chief complaint.

**Other server text found by the round-3 and round-4 reviews.**
- Differentials and inspection text:
  - 「病历未记录X（需问诊核实…）」 now also matches when X contains its own parentheses;
  - 「颞动脉无压痛」 is no longer read as an abdominal exam (2 changes in 142k replayed strings, both right);
  - 「泌尿系结石/感染」 becomes 泌尿系感染;
  - 「脉微欲绝」 is replaced as a whole;
  - a literal 「null」 in 建议核实 is emptied.
- 方义:
  - false 「加X」 claims are removed when X is in the catalog composition;
  - 「二药」 is recounted when it sits in the next clause.
- Precautions:
  - 「可改为饭后」 is dropped when the usage line already says 饭后;
  - the conditional form under a 饭前 usage line is kept.
- Treatment cards:
  - on acupuncture cards, a sentence that names only points not on the card is dropped (少商/商阳 on 风寒); caution sentences stay;
  - a precaution that forbids lesion needling is dropped when the card does 围刺 or uses 阿是穴;
  - moxibustion cards are not delivered for yin-deficiency, excess-heat, damp-heat or 火 syndromes;
  - the ear point 「…相应耳穴」 is restored.
- The exercise prompt now follows recorded mobility limits.

**Measured.** Local route harness in the customer request shape, independent clinician-persona review with the same briefs. Failures per column out of 30:

| | 中医诊断 | 西医诊断 | 治则治法 | 中医鉴别 | 辅助中药饮片 | 中医治疗 | 复诊计划 | 注意事项 |
|---|---|---|---|---|---|---|---|---|
| production 5c85a55 | 10 | 8 | 4 | 8 | 10 | 8 | 4 | 15 |
| first pass | 5 | 4 | 4 | 1 | 7 | 2 | 0 | 4 |
| second pass (round 4) | 2 | 0 | 1 | 0 | 3 | 1 | 0 | 0 |

- Every column is at most 1 per run in all three runs, which is the acceptance line.
- Held-out 32, round 4 (two of the four fixes in the last group came after it): 中医诊断 93.1, 证候 96.6, 西医 93.1, 追问 96.6, 中医鉴别 89.7, 中医治疗 88.5, 复诊与注意事项 87.5, 辅助中药饮片 82.8.
  - The 87.5 is four children without a child-specific line, a judgement call.
  - The five 饮片 failures:
    - S078 is a judgement (虚劳·肝血虚 read as 眩晕·气血亏虚);
    - S046 is a catalog 出处;
    - S132 and S158 add sedatives in 加减 for itch or night crying;
    - S145 was the 「二药」 defect, fixed afterwards.

**Left as is.**
- Sedatives added in 加减 for secondary sleep loss (the 10/17 filter covers the candidate, not modifications).
- Model-written herb functions that pass the overlap-based grounding check (鹿角胶 「补血滋阴，润燥生津」). Tightening that check changes herb admission (`test:herb-breadth-surface`).
- 病历3's 治法 is 「滋阴养血」. That is our local 《中医内科学》 verbatim; the reviewer expects 「和络止痛」 from another edition.
- Questions that ask two things at once; diet text that contradicts itself (忌鱼虾 next to 清蒸鱼).

**In production (d2bbe09, deployed 2026-10-17 about 22:50 Beijing; tag `20261017-d2bbe09-prebuilt`, same release directory and `20260927-dsrepair` override).**
- **Verification:** `verify:deployed-image` passed (commit + digest + strictReady + both model families) and `regress:prod-smoke` had 0 failures. Container logs before the replacement are in `~/telemetry-archive` on the host.
- **Customer 10 × 3, production, independent review:** failures per run, columns 中医诊断/西医/治则/鉴别/饮片/治疗/复诊/注意:
  - run 1: 1/2/0/0/1/0/0/0;
  - run 2: 1/0/0/0/0/0/0/0;
  - run 3: 0/0/0/0/2/0/0/0.
  Two of these failures are server text fixed after the deploy, in commits that are **not deployed yet**: cb2392e (「去石膏、加生地黄」, 病历9 方义) and 7d192ca (「无法分型」 delivered as 「未诉法分型」, 病历7 Western differential; saved outputs held over 100 「未诉法判断」). With them every run is at most 1 per column.
- **Held-out 32 on production:** 中医诊断 96.6, 证候 93.1, 辅助中药饮片 82.8, 中医治疗 88.5. Every other block is 93–100.
- **Skip to prescription** (question, 20 s pause, skip): median 1.28 s, p90 3.02 s. All 64 diagnose/prescribe calls were reused precomputations.
- **Safety probes hold:** bleeding, hypothermia with drowsiness and an infant with HR 55 → `red_flag`; pregnancy, warfarin and lactation with an answered follow-up → `non_dose_only`. 缺铁/PCOS/功能性消化不良 probes → 贫血/月经稀发/消化不良. The adolescent 145/95 probe now says 血压升高待查.
- **Rollback:** image `tcm-cdss:20261014-5c85a55-prebuilt` with the compose backup in the release directory.
- **Disk was the deploy's real constraint.**
  - The local prebuild needs about 3.5 GB free on /home. 2.8 GB ran out of space (ENOSPC) mid-build: the hard-linked `node_modules` tree and the copied sources take room before `.next` is written.
  - The host floor is 12 GB. The owner approved 10 GB for this deploy, after 19 old uploaded build contexts (3.8 GB, images long gone) were removed from `/home/ubuntu/tcm-cdss/prebuilt`. The host had about 9 GB free afterwards.
  - The owner also approved deleting `~/.synergy_dataset_source` and two `node_modules` directories (深圳医保局, EviMedScience/OpenScience) to make local room.
- **The patch deploy was stopped for disk.** Local /home fell back to 1.9 GB while another session's git work and the t3code database grew. The owner chose to ship cb2392e/7d192ca with the next deploy.
- **Production rate limits:** the first hospital-a batch after `regress:prod-smoke` lost 3 chains to 429. M05 calls also hit 429 on both tenants late in the run, which suggests the tenants share quota with real traffic. Start with the other tenant after a smoke run, and check statuses before counting a case.

### 10/18 round: model check, web search, ≥300 texts per module (2026-10-18)

**What the owner asked for:**
- confirm the model is DeepSeek V4.1 Flash 1017;
- use the newly opened Search/Fetch API, the local KB and EviMed wherever they improve reasoning;
- fix the remaining defects one class at a time;
- accept every module on at least 300 public input/output texts.

Material is in `~/runlogs/r1018`: `PLAN.md`, `research/`, `sets/`, `out/*-final*`, `judge/*-final*`, `calib/` and `scripts/`. All commits are local; deploy comes last.

**Model.**
- Production `deepseek-flash` already serves V4.1-Flash-1017, per the pricing page and the 10/17 changelog. `deepseek-v4-flash` is a retired alias.
- The code, compose and `.env.example` defaults now say `deepseek-flash`, and `test:upstream-guards` pins the compose model matrix.
- API notes that matter here:
  - thinking is on by default, so we send `thinking:{type:"disabled"}`;
  - `json_object` still does not enforce a schema;
  - strict tools are still beta.

**Search/Fetch API: where it is used, and where it is not.**
- **The API.** `POST {base}/v1/tools/search` returns `authority` (0–4) and `rerank_score` (0–3). The limit is 5 QPS per account, and from 2026-11-01 it costs $0.75 per 1,000 calls.
- **The client.** `deepseek-web-search.server.ts` (`webSearchGovernedTerm`) sends governed names only, never record text. Results are memoized, calls time out at 2 s, and `CDSS_WEB_SEARCH=false` turns it off.
- **Used for one thing: the criteria behind the Western-name check.**
  - `western-diagnostic-criteria.source.json` covers 132 diseases. It was built offline by `scripts/build-western-diagnostic-criteria.mjs` from authority≥3 pages, with every quote checked verbatim.
  - Every entry was read and 27 were corrected; `reviewCorrection` records the basis and the prior value.
  - A name not in the table gets up to two live excerpts (authority≥3, rerank≥1.5).
  - Lookup qualifiers (急性/慢性…, 左/右…) live in the data file (`nameLookupQualifiers`), not in code.
- **Not used in M03/M04 generation.** The literature (`research/R-retrieval.md`) says retrieval adds little or hurts strong models on case reasoning:
  - MIRAGE: GPT-4 on MedQA went 83.97 → 82.80;
  - MedDistractQA: up to −17.9%;
  - TCM TOSRR: plain RAG 49.8 vs no RAG 55.8.

  Closed-set selection and narrow, criteria-grounded verification do help. That is the same pattern as this project's textbook disease pick and the 9/27 finding that pasted-in knowledge is barely used. EviMed and the local KB keep their existing roles (relevance-filtered evidence, textbook rows, formula catalog). The Fetch API is unused at runtime.

**Acceptance sets** (public datasets converted to the customer request shape; `scripts/build_acceptance_sets.py`):

| Set | n | Used for |
|---|---|---|
| M | 360 | TCM chains: MTCMB, TCM-BEST4SDT, TCM-RobustSDT, TCM-SD, TCMChat |
| X | 330 | exam-style TCM disease/syndrome, 治法 and formula |
| H | 330 | acupuncture and other treatment cards |
| D | 320 | Western diagnosis exam vignettes |
| A | 340 | red-flag triage |
| B | 335 | IMCS-21/MedDG next-question dialogues |

- **Judge.** `scripts/judge.mjs` runs deepseek-v4-pro with thinking, one call per case, scored against the customer's rubric. It is a different model from the generator.
- **Calibration.** Four Claude agents judged 72 sampled verdicts blind (`calib/`, `calib-agree.py`). They agreed on 49. Of the 23 disagreements, 21 were DeepSeek failing a case Claude passed. The numbers below are therefore a conservative lower bound.
- **Converter bugs.** Two voided earlier outputs: the MSDD 病史 split put 现病史 into 既往史, and 「3个月前」 was read as an infant's age. Check the converters before trusting a red module.

**Class fixes.** Each has a test in `test:eval1014-remediation` §15–16 with a counter-proof. Each gate class also has a fixture under `scripts/fixtures/open-language-classes/` and an old-versus-new corpus replay, and every changed sentence was read.

- **Red-flag over-calls (deterministic):**
  - a change cue that heads a sibling symptom (「胸闷、频繁肠鸣」);
  - 「突发…头痛」 inside a list of cold symptoms;
  - chronic abdominal severity with a known trigger;
  - stable post-acute neuro events (a clause-level new-onset check keeps 「今日突然右侧肢体无力」);
  - lab values with units read as temperatures (T3 …);
  - historical BP extremes (最高/曾达) read as current readings;
  - a relative after 与/跟/同/和 is a companion, not the subject (「与丈夫发生争吵时突然出现剧烈头痛」 had been attributed to the husband).
- **Red-flag under-calls** (closed sets in T6 `detection`; every first cut needed a corpus replay to remove over-calls):
  - peritoneal sign wording;
  - 停止排气排便 with current abdominal pain or vomiting (the governed companion had no reader);
  - meningeal signs (颈项强直 excluded: 落枕);
  - central cyanosis written forms (bare 发绀 hit 20+ Raynaud/脱疽 cases, so peripheral sites are excluded);
  - acute traumatic fracture ≤3 days;
  - incarceration (「不能自行还纳」 is grade III prolapse, not incarceration).
- **Record-stated child age vs an adult registered age** is now a hard dose boundary (shared `highRiskDoseBoundaryReasons`).
- **M03 grounding.** `splitIntoClinicalClauses` carried 无 across commas. In 「无牵扯痛，反酸偶作，…食纳欠佳」 every affirmed item became 「无…」, quotes failed, the chain emptied and M03 fell back to the placeholder (9 of 360 in M). A sentence that writes 无 before each comma item no longer inherits it. 1,062 of 52,207 corpus sentences changed, and every change read was correct.
- **Textbook formula identity.**
  - A textbook name the catalog lacks is one formula: 知柏地黄汤 no longer locks 地黄汤 (21 of 594 names did this).
  - 栝蒌/栝楼/瓜蒌 spellings resolve to the catalog entry, and so do 丸/散 formulas used as decoctions.
  - 「…散」 + a verb character (散结) is not a formula name.
- **Provenance.**
  - Identity normalization (麦门冬→麦冬, 橘皮→陈皮) applies only to anchor sources: the national catalog and the governed row. Reprints compare as written; normalizing them had made 清胃散 《金鉴》 and 普济消毒饮 《卫生鸿宝》.
  - The original-book margin applies only when the original explains every herb the reprint explains.
  - Ties are broken by substantive coverage, which counts neither 姜枣 nor the other component's herbs in a 合方.
  - 724-candidate replay: 50 changed, all read.
- **Western.**
  - 慢性支气管炎 course length is read as numbers.
  - Case D with no broader disease name keeps the hypothesis as 「原病名待查」 instead of a symptom.
  - The prompt's 「主要症状＋待查」 placeholder is rejected as a name.
- **M02 (follow-up questions).**
  - `decision=proceed` only when the record is sufficient: tongue and pulse, or 3 of 寒热/口渴/二便/汗.
  - The server's textbook question asks about tongue, else pulse, and its two options must differ on a dimension both name (tongue body, coating colour or coating texture).
  - A narrow small task removes model questions that ask two things (`CDSS_M02_QUESTION_SINGLE_POINT_CHECK`). It must quote both points verbatim from the stem.
    - Two things means two separate descriptions (「精神反应和吃奶情况」, 「舌象与脉象」). A yes/no about a group of signs (「是否伴有气短、自汗」) is one point.
    - The first wording judged any two joined symptoms as two things. On the customer's ten cases, 6 of 30 runs then went to `proceed` after questions the reviewers had passed were dropped.
    - B set: two-part failures went from 40 to 17.
- **M04/M05.**
  - Rule-computed precautions for children under 12, adults 65+ and current medications, including Western drugs after a formal administration verb.
  - A line for toxic herbs.
  - Category bans that contradict a recommended medicine are dropped, and so are diet contradictions (忌鱼 next to 鱼).
  - Incidental sedatives are dropped from modifications.
  - 川贝母 is not forced to 冲服 at decoction dose.
  - 马勃/青黛/儿茶 are 包煎.
  - The colorectal 50+ safety net is written to the patient.
- **Delivered text.**
  - **Herb functions.** Direction words the KB and the verified dictionary do not give are removed clause by clause. A clause is kept whole or dropped, never left as a fragment (「补益肝肾」 had become 「肝肾」).
  - **KB correction.** 青蒿's KB entry was corrected using the textbook line.
  - **方义.**
    - A 「去X」 is dropped when X is in the prescription;
    - 「二药」 is recounted per full sentence.
  - **无 → 未诉:**
    - not applied to inference (「示无里热」);
    - not applied to two-character terms the record has with a gap (「腹中冷痛」).
  - **治法 anchoring.** The model's symptom clause appended to the textbook 治法 drops a leading overlap, so 「清热凉血调经，调经止血」 becomes 「…调经，止血」.
  - **Differential points.** A 无 written before each list item does not survive into 「未诉A、无B」.
  - **Herb labels.** 生津 counts as a yin claim.
  - **Cards:**
    - no moxibustion text for 风热/燥热/热秘 and similar heat syndromes;
    - subtype schedules (结肠慢传输型, 便秘型肠易激) need that Western diagnosis;
    - pregnancy and lactation text only for patients it can apply to;
    - textbook 「禁忌：」 sentences whose points are not on the card are dropped;
    - a catalog template that does not match the disease and has no textbook plan becomes assessment-only;
    - no facial or lesion bloodletting.

**Acceptance on the final code.** These are DeepSeek-judge pass rates; per the calibration, read them as lower bounds.

| Module | Texts | Pass |
|---|---|---|
| 中医诊断 C | M 360 + X 110 | 56.7% / 74.5% |
| 西医诊断 D | 319 | 58.9% |
| 治则治法 E | M 360 + X 109 | 75.3% / 88.1% |
| 中医鉴别 F | 360 | 91.1% |
| 辅助中药饮片 G | M 360 + X 110 | 76.9% / 82.7% |
| 中医治疗 H | M 208 + H 241 (cases with cards) | 88.5% / 83.8% |
| 复诊计划 I | 360 | 96.9% |
| 注意事项 J | 358 | 88.8% |
| 追问 B | 335 | 88.4% (was 80.2%) |
| 红旗 RF | A 340 + M 360 | 92.9% / 88.1–89.4% |

- **C and D are mostly not server defects.**
  - The references are exam answers or compound syndromes. Customer doctrine sets no 兼证 without grouped evidence, so a reference with an extra 兼证 counts as a miss.
  - The Western check's A/B/C downgrades fail exam vignettes that expect the full diagnosis. That is by customer doctrine, so it is reported here and was not changed.
- **M red-flag variance is judge noise.** The same gate outputs were judged differently between runs: 8 of 360 flipped with the gate unchanged.
- **Customer 10 × 3 (local, b2164d2, independent Claude review with the 10/17 brief).**

  | Run | Failing column(s), 1 each | All other columns |
  |---|---|---|
  | 1 | 西医, 中医鉴别, 饮片 | 0 |
  | 2 | 治则 | 0 |
  | 3 | 饮片 | 0 |

  - No red flag on 1/2/7/9.
  - Disease, syndrome and formula were the same in all three runs.
  - The acceptance line holds.
  - A second review on 540fe8f (local8):
    - runs 2 and 3 were at most 1 per column;
    - run 1 had 2 in 西医. One was 「无夜间痛」 left as a denial, fixed in 98d3a93. The other was a model-written false negative.
  - A third review on 2aa09d6 (local10):
    - runs 2 and 3 were at most 1 per column;
    - run 1 had 饮片 3. One was server-caused and fixed in eafd86d: the 方义 kept a subjectless clause after an incidental sedative herb was removed. The other two were model prose (左归丸 「阴中求阳」, 青蒿 「生津」).
  - Across the nine reviewed runs, the line held in seven. Each of the two misses had one server defect, fixed afterwards.
- **Held-out 32 (same build).**

  | Block | Pass |
  |---|---|
  | 证候 | 96.6 |
  | 中医诊断 | 89.7 |
  | 中医鉴别 | 89.7 |
  | 方义 | 89.7 |
  | 中医治疗 | 88.9 |
  | 饮片 | 82.8 |

  - Every other block scored 93–100.
  - The server-caused items among the failures were fixed afterwards: S058 未诉腹痛, S145 二药, S151 去桑皮, and the herb-label fragments.
  - The local8 review (540fe8f) put 中医诊断 at 93.1 and 饮片 at 86.2. 中医治疗 was at 80.8, and its server causes were fixed in 3e73fd5: S002 moxibustion on 风热, and S055/S161 slow-transit schedules.
  - **Final review on 2aa09d6 (local10):** every customer block is at or above 90% (中医诊断 93.1, 证候 96.6, 饮片 93.1); 中医治疗 is 85.2.
    - S002 still showed 「灸5分钟」. The moxibustion filter matched 灸 inside citations (《刺法灸法学》, 针灸), dropped every sentence, and then fell back to the original text. Fixed in 4a6e9cc.
    - S161 is a child given timed needle retention. Fixed in 4a6e9cc too: timed retention is no longer applied under 12.
  - Still open:
    - S079 has no knee points;
    - S160 uses 肝俞 (the suspected OCR 肺俞);
    - S078 is a misjudgement (虚劳·肝血虚 read as 眩晕).

**Left as is (policy or model).**
- **Red flag where it may be over-cautious (policy).**
  - BP ≥180/120 without organ symptoms stays a red flag.
  - Upper-GI alarm features (weight loss, a malignancy history with GI symptoms) withhold dose.
  - An acute fracture within 3 days is now a red flag, although 骨伤科 clinics treat these.
- **Haemorrhoidal bleeding over-calls** come from the facts model.
- **Model-written defects, not fixed:**
  - two-part questions the narrow check misses (17 remain in B), and questions that repeat answered dialogue items (10);
  - medicines recommended next to a decoction that already contains them (人参口服液 + 人参; 三黄片 next to a precaution about 黄连 overlap);
  - 熟地黄 with 便溏.
- **蚕沙 has no KB function.**
- **The effect of web search was not A/B tested;** the criteria table is static.

**In production (4a6e9cc, deployed 2026-10-18 about 18:25 Beijing; tag `20261018-4a6e9cc-prebuilt`, same release directory and `20260927-dsrepair` override).**
- **Gate and verification.**
  - `verify:release` was green on 4a6e9cc.
  - `verify:deployed-image` passed: commit and digest match, strictReady is true, and the qwen and deepseek families are both live.
  - `regress:prod-smoke` had 0 failures (cold M03 P95 12.9 s, M04 P95 15.1 s).
- **Probes on hospital-b:**
  - 呕血, hypothermia with drowsiness, and an infant at HR 55 → `red_flag` / `non_dose_only`;
  - pregnancy, warfarin and lactation with an answered follow-up → `non_dose_only`;
  - the iron-deficiency, PCOS and two-week-dyspepsia probes → 贫血 / 月经稀发 / 消化不良待查.
  - The adolescent 145/95 probe said 高血压 this time (血压升高待查 on 10/17).
- **Customer's 10 cases on hospital-a,** follow-up skipped after a 20 s pause. Question to prescription took median 1.6 s, p90 2.7 s, max 4.3 s. All 200, no red flag, and disease and syndrome were correct on all ten.
- **Host disk.** The host was at 6.9 GB free in the afternoon, because another project's delivery work used about 14 GB. After that project's own cleanup, and after we removed our 5c85a55 image (the rollback of the rollback), it was at 12 GB, which is the deploy floor.
- **Rollback.** Image `tcm-cdss:20261017-d2bbe09-prebuilt` with the compose backup in the release directory. The pre-deploy container log is in `~/telemetry-archive` on the host.

**Running it again.**
- **Sets:** `scripts/final-run*.sh` (`OUTSET`/`OUT_SUFFIX`), then `judge.mjs <set>`, `rf-judge.mjs <set>` and `summarize.py <judgeDir>`.
- **Customer cases:** `~/runlogs/deliver1017/cases` and `scripts/make-sample.py`.
- **Machine limits.**
  - `tsc` is OOM-killed while runs are active.
  - `pkill -f` matches its own shell; kill by PID.
- **Subagent reviewers** cannot write .md files; ask for the summary in the reply.

### 10/19 round: every remaining gap by class, eight review passes (2026-10-19)

The user asked for every remaining gap to be researched online, fixed and retested against the acceptance line (customer 10 cases × 3 runs: each of the 8 columns fails at most 1/10; held-out 32 ≥90% per block; no red flag on cases 1/2/7/9; same record → same output; skip-to-prescription p90 ≤15 s). Commits a609be4 → af6d892, all local. Plan, counter-proof log and agent notes: `~/runlogs/r1018/work/r1019/` (`PLAN.md`, `counterproofs.txt`, `agentB|D|G|H/`, `r3/`). Suites: `test:r1019-remediation`, `-round3`, `-cards`, `-herbs`, `-herbs-r3`, `-herbs-surface`, `-safety-m02`, `-western`, `-western-r3`, `-claim-check`; class fixture `negation-scope-ends-at-affirmed-item`.

**How the work was split.** Four agents in the main tree, each with its own file list, its own new test file and counter-proof duty (B safety/M02/claim check, D Western, G herbs/方义/加减, H cards); I took precautions, the sanitizer and integration. Rules that held: never copy-and-restore a shared file while an agent works (my counter-proofs once did — warn them, or wait); agents leave `src/lib/zz-*` scratch files and inline vocab that `test:clinical-vocabulary` rejects; review every agent claim against saved outputs before merging.

**Server-caused defects found by the independent reviews (each with a test and counter-proof).**
- **Customer case 1's rationale became 「咳嗽，为风寒袭表…」 in 2 of 3 runs.** It did not reproduce in 4 sequential traces; it did with three concurrent runs, because the model's wording varies. The negation sanitizer let the 无 of 无汗 govern 「…无汗、鼻塞流清涕、稍有咳嗽」 to the end and rewrote the clause to 「病历已记录咳嗽阳性」. A preposed 无 now stops at a lexicalized sign (无汗/无痰) and at a list item with its own 有/伴/见 (`clauseNegationScope`). Replay 366,772 strings: 13 changed, all rewrite→keep.
- **`formula_direction_drift` ten times per customer run on case 3.** 加味四物汤 has several same-name catalog versions, so M03 locks nothing and writes the textbook formula in its direction; M04 naming it was rejected, one repair returned invalid JSON and the page fell back to non-dose. `isSignedTextbookFormulaIdentity` (both drift producers) accepts the settled textbook row's formula when it is in the M03 direction and half its composition is present; the textbook-ingredient exemption from direction findings covers such directed, unlocked formulas.
- **出处 from a same-name later formula** (加味四物汤《朱氏集验方》, 竹叶石膏汤《症因脉治》): when the prescription covers a textbook representative formula, the compilation catalog's source (or the entry identical to the textbook composition) wins; another writing of the same book is left alone.
- **消风散《外科正宗》 was catalogued with 煅石膏** (granule writing, external-only in ChP), so 石膏 was treated as doctor-dosed and left out of case 9. Collation row ADJ-WEB-20261019-XIAOFENG. G's new 「原方中的X本次未列入药味表」 note is limited to toxic or controlled herbs.
- **My own regression:** required precautions read the gate's `allowDosePrescription`, which is false on every needs-information case even when M04 gives a limited dose; the child, elderly and administration lines disappeared (held-out S158/S160). They now follow `derivePrescriptionPermission`.
- **Lab abbreviations erased as internal field names** (dsDNA, cTnI → 「抗及」): the camelCase rule now needs English-word humps.
- **骨折 had no textbook entry**, so rib fractures were named 胸部屏挫伤: supplement rows from 《中医骨伤科学》 三期 (compositions from the governed catalog).
- Smaller: differential rows whose subject is the other disease are not sanitized; specific skin lesions document 皮疹 (mucosal 疱疹 excluded); 「示/为…无X」, 「…象/…性」, 「口不渴」, 「无脓无屑」 in the 未诉 rewrite; precaution herb names follow the table; per-herb toxic coverage; bare 「方中有X等药。」 dropped; self-stopped medication; red-flag pages carry medicines to the ER; mobility-limited exercise; dangling 「并告知医生」; 「…为臣、透热」; follow-up text on dose-withheld cases; 兼证 trigger on self-declared 兼象/同病; textbook differential text in the candidate block.

**New narrow small task: patient-claim check** (`m03-patient-claim-check.server.ts`, `CDSS_M03_PATIENT_CLAIM_CHECK`). It removes patient findings the record does not contain from rationales and differentials (口不渴, 双侧, 疱壁紧张, 脱屑, 3月龄…): two agreeing passes plus a verification call, verbatim and record-substring guards, smallest-unit removal, a predicate-bearing list head is never cut. Precision 23/23 on the development set, 23/31 on 200 exam vignettes (terminology substitutions and inferences); ~0.5–1 s on M03.

**Tried and reverted.** A broad 兼证 trigger (any mechanism word the primary does not cover): 157 newly triggered, 52 gained a 兼证, including customer case 4 (肝气犯胃 + 肝郁脾虚; the standard answer has none) — only self-declared markers trigger. Dropping a modification whose stated action is not in the herb's KB function (大枣 「固表止汗」): on 563 prescriptions it dropped 38 and trimmed 76, mostly wrongly (仙鹤草 for bleeding). A 固摄/缩尿 claim group: 乌药, 鹿茸, 熟地黄 are used that way legitimately.

**Rounds 4–5 (same day): Claude reviews instead of a model judge.** The user ruled that acceptance reviews are done by Claude reviewers (subagents), not by calling deepseek-v4-pro. Packets of 24 cases per reviewer: `~/runlogs/r1018/scripts/make-review-packets.py <set> <suffix> 24`, brief `~/runlogs/r1018/claude-review/BRIEF.md`, tally `summarize-claude.py <set><suffix> [--fails]`. Customer 10 and held-out reviews keep the 10/17 briefs (`deliver1017/judge/brief-c10.md`, `fix1014/notes/judge-brief.md`). Fixes were made in a separate worktree (`~/worktrees/r1019-fix`, branch `fix/r1019-round4`) so the main checkout could keep running acceptance sets on one commit; agents worked from `~/runlogs/r1018/work/r1019/agents/COMMON.md`. Suites: `test:r1019-round4` (main session, 16.x = round 5), `-round4-cards|formula|m02|facts|decoction`, `-round5-cards|formula|precautions|therapy`; class fixtures `pain-quality-chouchu-not-seizure`, `comma-affirmed-clause-after-negation`, `negation-clause-describing-differential-entity`, `disposition-time-window-emergency`.

Server-caused classes found by the reviews (each with a test, a counter-proof and, for shared predicates, a replay):
- **Negation and polarity.** The red-flag sanitizer read 「无汗出，偶有胸痛」 as a denial of chest pain, so a false 「无胸痛」 stayed and became 「未诉胸痛」: `sourceDocumentsAffirmation` and `clauseNegationsAreLiterallyDocumented` now use the same comma rule as `hasNonNegatedClinicalPattern`, and `hasCommaSeparatedPositiveEvidence` accepts a clause that opens with 有/偶有/时有/见 (the gate also gained 「无抽搐昏迷，有意识障碍」). Synonym groups: 咳喘/喘促/喘息 = 气促, 体重下降 = 消瘦. 「无神疲乏力」「无关节痛」 are denials, 「无神」「无关」 are not.
- **Gate morphology.** 「抽搐痛/抽搐感/抽搐样痛」 is a pain quality, not a seizure. Family-history text is not the patient's own condition for dose boundaries (「母亲…患有心力衰竭」 had withheld dose). Red-flag reasons name only what fired (upper-GI alarm item; cyanosis vs orthopnoea).
- **Visible text the server damaged.** 「舌苔厚腻」 became 「舌舌象待核实腻」 (coating rewrite now takes the whole phrase); 「以减少苦寒药对胃肠的刺激」 appeared on warming formulas; the diet filter that removes toxic or pregnancy-labelled formula herbs offered as food never ran when the line also contained 「忌…」 (`withoutTimingClauses` tested the whole line before splitting) and treated 「少量」 as a restriction.
- **治则/治法.** 扶脾/扶土 tonify, 抑肝/抑木 dispel, 乘/旺/肝阳 are excess names, 健脾/健胃 tonify only when the syndrome name shows deficiency, 毒 alone is not heat; two four-character methods that differ only in the first character are one method (和血通络/活血通络).
- **兼证.** 「为兼夹之象」「属兼夹」「…为兼」 now trigger the consistency check (hedges such as 「是否兼夹…尚待」 do not); after a 兼证 is added, rationale clauses saying it is not a separate syndrome are removed and the method is de-duplicated.
- **Patient-claim check.** Negative-form spans flagged by only one of the two passes (「腹不胀大」「与咳唾呼吸无关」) now go to the verification call; positive spans still need both passes.
- **Other.** PHI: 后头部/后枕部 are body regions, not surname + name. Same-class antipyretic analgesics (label text 「其他非甾体抗炎药」「其他含有解热镇痛药」) keep one systemic and one skin-topical item; same-name products from two manufacturers keep one row. Non-dose pages: diet-only precautions that repeat the diet line are not listed, the toxic-herb line no longer says 「按医生开的剂量」, a repeated record quote in the pathogenesis list is shown once.

**Rounds 6–7 (same day).** Round 6 came from the Claude review of the round-5 final run; round 7 from the X (exam-style) and A/B reviews of the r19g run. Suites: `test:r1019-round6-formula|precautions`, `test:r1019-round7` (main session) and `-round7-<area>` (agents); class fixtures `antepartum-bleeding-after-20-weeks`, `severe-thrombocytopenia-count`, `melena-colour-word-forms`.
- **Safety gate.**
  - 「胎心率150」 was read as the mother's pulse (the three pulse patterns now exclude 胎 before 心率). Removing that misreading left A-eme-0142 (妊娠37周阴道流血) with no red flag, which exposed a real gap: bleeding after 20 weeks only fired with a quantity word. 妊娠≥20周 + non-negated 阴道出血/流血 is now its own red flag (ACOG/RCOG antepartum haemorrhage). Replay: 1,810 evaluations, 9 changed, all correct.
  - 「妊娠5个半月」「怀孕3个多月」「妊娠二十余周」 were not pregnancy, so two pregnant patients got dosed prescriptions (X-G-2961/2831). Replay of the assessor over 16,184 records: 5 changed, all real pregnancies.
  - Platelets: PLT <10×10⁹/L, or <20 with current bleeding, is a red flag (ASH 2019 ITP: newly diagnosed <20 → admission; known ITP without bleeding → outpatient). Units ×10^9/L, ×10⁹/L, OCR'd ×109/L, ×10^3/μL, G/L or none; ×10^11/12, 万, transfusion amounts (「机采血小板1u」 was the first draft's false positive) and 最低/曾/既往 readings do not count.
  - 「大便色黑」「黑色大便」「大便呈黑色」 join the melena group in both layers. Activity still needs a governed companion; 「易于疲劳」 (A-out-single_0242) is not one, so that case is unchanged — governed-list scope, not this class.
- **M03 current-fact floor.** A sentence opening with 既往 used to make every quote of it historical, so 「既往有胃病二十余年，每次均因饮食不慎，出现呕吐…舌质淡，脉濡弱」 sent M03 to the placeholder (X-G-2930). Tongue and pulse clauses are now current inside such a sentence, and 「手术后2个月出现腹胀」 is an onset anchor, not a post-operative state (X-D-4749). In the six r19g sets these were the only placeholder results besides a record with no clinical content.
- **Textbook OCR.** 治法 now goes through `fixTextbookOcr` too (「安神固月孚」 → 安神固脬 reached the 治法 column and the acupuncture card).

**Reviewers, and what changed when the reviewer changed.** Rounds 4–6 were reviewed by Claude subagents: Opus for the customer and held-out cases, Sonnet for the module sets. Sonnet was calibrated against Opus on 48 cases and agreed closely on C/G, was stricter on E and more lenient on F/J. During round 7 the user switched the reviewer to **qwen3.8-max** called directly through Bailian (thinking on, `thinking_budget` 6000, JSON output). Scripts in `~/runlogs/r1018/scripts`:
- `qwen-chat.mjs`: shared call;
- `judge-qwen.mjs` / `rf-judge-qwen.mjs`: module sets, same rubric as before;
- `judge-qwen-cust.mjs`: customer and held-out, same briefs and rubric as the Claude reviews;
- tallies: `tally-qwen-cust.py`, `tally-qwen-sets.py`.

Output goes to `~/runlogs/r1018/judge-qwen/`. Two things had to be fixed before the numbers meant anything:
- about 1 in 6 replies parsed to a single row, so incomplete replies are retried;
- the held-out brief never said that the panel's interface fields (gate/mode/missing/decision) are not engineering wording. qwen failed 工程用语 in 71% of cases until that line was added. The Claude reviewers had inferred it.

Round 5 (718e1ea) was re-judged with qwen, so that comparison uses one judge.

| | 718e1ea (round 5), qwen | af6d892 (round 7), qwen |
|---|---|---|
| Customer 10 × 3, failures per column | r1: 饮片 1; r2, r3: 0 | 0 in every column, all three runs |
| Held-out 32: 中医诊断 / 证候 / 饮片 (merged) | 96.6 / 96.6 / 82.8 | 93.1 / 93.1 / 82.8 |
| A red flags | 329/340 appropriate | 330/340 |
| B follow-up | 320/335 = 95.5% | 320/335 = 95.5% |
| X 中医诊断 / 治则治法 / 饮片 | 70.9 / 86.4 / 72.7 | 70.0 / 86.4 / 80.0 |

- **M, H and D were not rerun in round 7.** Sonnet on 718e1ea:
  - M: C 71.9, E 85.3, F 95.3, G 85.8, H 99.0, I 99.7, J 97.8;
  - H: 99.6;
  - D: 82.8 (mostly exam vignettes that expect the most specific name, against the customer's 「待查/上一级」 doctrine).
- **qwen is more lenient than Opus on the customer cases.** On the same 718e1ea outputs, Opus found 1–3 column failures per run and qwen found 0–1.
- **qwen is stricter than Sonnet on X** (Sonnet on 718e1ea: 81.8 / 89.1 / 85.5).
- **Differences of one case per block are inside the noise.** Each block has 29 cases, and judge and generation each vary from run to run. Under one judge, rounds 6–7 moved only X 饮片 (+8 of 110; formula, pregnancy and current-fact fixes). Held-out, B, A and X C/E did not move.
- **No red flag on cases 1/2/7/9.** Disease, syndrome and formula were identical across the three customer runs in both rounds.
- **Judges split on borderline red flags.** On A-non-0046 (PLT 13 with mucosal bleeding), Sonnet called the old output under-cautious and qwen calls the new one over-cautious. The ASH guideline supports the flag.

**What the round-7 reviews found that is left for the owner to direct (not fixed, by the user's decision to stop patching and choose the next direction):**
- **Exam-style syndrome names.** Most X 中医诊断 failures are exam answers written as 伤寒论 formula patterns (桂枝汤证, 吴茱萸汤证, 大陷胸汤证, 枳实栀子豉汤证, 苓桂术甘汤证…). The system names syndromes the way the 内科 textbook does. Some textbook row names are too broad for the reviewers (厥证 「实证/虚证」, 崩漏 「脾虚证」, 哮病 「肺虚证/肾虚证」).
- **Server text defects:**
  - the ungrounded-pulse rewrite matched 「经脉散寒」 (脉散) → 「经脉象待核实寒」 (same class as the 生脉散 fix; S079);
  - an acupuncture card said 「本例属热淋」 for 石淋 (S067);
  - 方义 fragments and 「黄芩片」-style names;
  - a placeholder herb function (冬瓜子);
  - 「若临床」 truncated modification conditions;
  - textbook-note 出处.
- **Follow-up questions:**
  - the server's trend question has no 「持续」 option;
  - model questions with two non-exclusive options;
  - questions that repeat what the dialogue already answered;
  - questions to infants about thirst.
- **Red-flag judgement calls:** S128 (hives with abdominal pain and vomiting after seafood: WAO 2020 anaphylaxis criteria support the flag; the case expectation does not), worsening myasthenia, toddler vomiting with distension, 1-month melena without a governed companion.
- **The agents' half-finished round-7 work** (M02 options, food-therapy conflicts, follow-up signs for post-menopausal women, diet vs 禁食) is saved as `~/runlogs/r1018/work/r1019/round7-agents-partial.patch`. It was not applied: the agents were cut off by a login failure before testing it.


**Round 8 (same day, after the user's direction).** The user delegated the disputed red-flag calls to me, asked for every server defect from the round-7 reviews to be fixed and the remaining problems to be researched first, and had five Sonnet subagents do the work while I distributed and accepted it. Plan and file ownership: `~/runlogs/r1018/work/r1020/` (`TODO.md`, `COMMON8.md`, `wpa|wpb|wpc|wpe/`). Commit b23e3e3. Suites `test:r1020-main|m02|m03text|formula|care|jingfang`.

- **Red-flag disputes (my calls, no gate rule added or changed).**
  - The 9 A-set cases qwen called over-cautious all hold under a named guideline: posterior-circulation TIA with a fall, infant Hb 50, jaundice with RUQ pain, chest pain within 72 h (NICE CG95), acute vertigo, urine ketones 4+, vomiting with distension and no stool, 3 days of rectal bleeding of unknown volume, PLT 13 with bleeding (ASH 2019).
  - Bare melena stays an advisory (T6 design; ACG 2021 lets GBS ≤1 be managed as an outpatient). Worsening myasthenia and the toddler with vomiting stay facts-model judgements.
  - **S128 (hives with abdominal pain and one vomit after seafood) is borderline, not a missed red flag.** WAO 2020 criterion 2 needs *severe* GI symptoms, airway and circulation are denied, and 《中医外科学》 瘾疹·肠胃湿热证 is exactly this presentation. Its expectation accepts either a red flag or a priority advisory; the facts model gave one in round 7 and the other in round 8. I first marked it red-flag-only and corrected that after reading the criterion.
  - The held-out brief's 口径 1 (every round must ask a question) predates `decision=proceed`; the qwen judge script now says proceed is fine when the record is sufficient or the gate is red.
- **经方方证候选 (WP-A, structural).**
  - Most X 中医诊断 failures were exam answers written as 伤寒/金匮 formula patterns, which the textbook rows cannot express.
  - The data: `src/data/tcm-jingfang-patterns.source.json` holds 103 patterns with 154 clauses and 494 key symptoms. Every clause and key symptom is verified verbatim against the local 《伤寒论》 (457) and 《金匮要略方论》 (499) with line numbers (`build:jingfang-patterns`). Syndrome names come from GB/T 16751.2, 《方剂学》 or 《伤寒论选读》.
  - `jingfang-pattern-pick.server.ts` makes **two** small-task calls: a closed-set pick with verbatim quotes, then a check that each quote really is that symptom. A single call picked a pattern for 9 of 10 customer cases.
  - M03 sees the picked patterns next to the textbook rows; textbook rows win when they fit. Anchoring keeps a table pattern's name and formula, and the pattern counts as positive formula evidence (otherwise 25 non-common-tier 经方 fall to non-dose pages).
  - Switch: `CDSS_JINGFANG_PATTERN_PICK`.
  - The customer's 10 cases were unchanged in all three runs (病历2 was picked offline, but M03 kept the textbook row).
- **Other round-8 classes:**
  - **M02 trend question.** It is now a yes/no 「有没有加重」 question, because a plan has exactly two clinical options and the old 「持续」 had no slot. It is skipped when the record already gives the course (one narrow check).
  - **M02 young children and conversation.** Neuro and respiratory screening uses observable signs under 3 years. The narrow checks read the conversation's Q/A. Same-value options are flagged inside the existing redundancy call. Proceed sufficiency counts answers, not the questions' words.
  - **PHI.** 「答：都没有」 was redacted as surname + name, which erased a denial; 都没/都没有/都不… are now a closed lexical group.
  - **M03 text.**
    - Vessel nouns (经脉/血脉/通脉/冲任脉…) are not pulse claims; one shared lookbehind is used in three places. Replay over 564k strings: 3 changed.
    - 「与本例…不符」 contrast clauses describe the other disease.
    - Textbook sections named in Western terms deliver the TCM name the section itself cites (血栓闭塞性脉管炎 → 脱疽, 股骨头缺血性坏死 → 骨蚀).
  - **M04 text.**
    - 方义 fragments and 「片」 names are fixed.
    - The placeholder herb function now falls back to the KB or the 方义 clause.
    - The 34 textbook 加减 rows with a generic 「临床」 condition are dropped.
    - 出处 is the book only.
    - Summary-effect claims that no herb supports are removed: 8 concept groups in `summaryEffectGroups`.
    - A symptom already in the record is delivered as 「本例已见X」, not 「若X」.
    - Dosage-form variants supply composition (四妙散 = 四妙丸; S145 had lost 苍术 and half its name).
    - Incidental-sleep textbook items are no longer offered (S132's empty 加减).
  - **Care.**
    - The card's type follows the signed rationale (S067 石淋, not 热淋).
    - Food therapy vs prescription antagonism (人参—莱菔子 from textbook lines).
    - Follow-up signs are filtered by population.
    - Fasting orders and antithrombotics filter the diet.
  - **Textbook names.** 厥证 rows carry their group (气厥实证/血厥虚证).

**Round 8 measured (qwen3.8-max, same judge both sides; round 7 = af6d892 outputs, round 8 = b23e3e3 fresh generation).**

| Set | Round 7 | Round 8 |
|---|---|---|
| Customer 10 × 3, failures per column | 0 everywhere | 0 everywhere; disease/syndrome/formula identical to round 7; no red flag on 1/2/7/9 |
| Held-out 32: 中医诊断 / 证候 / 饮片 (merged) | 93.1 / 93.1 / 82.8 | 93.1 / 93.1 / **93.1** — every block ≥ 90 (left: S078, S151, model judgement) |
| B follow-up | 95.5 | 97.3 |
| A red flags | 330/340 | 330/340 (same 9 disputed + A-eme-0321) |
| X 中医诊断 / 治则治法 / 饮片 | 70.0 / 86.4 / 80.0 | 69.1 / 89.1 / 78.2 |
| M C / E / F / G / H / I / J | 48.3 / 55.9 / 93.6 / 61.4 / 94.6 / 100 / 98.8 | 49.0 / 55.2 / 94.9 / 62.5 / 94.9 / 100 / 97.7 |
| H cards | 88.1 | 89.2 |
| D Western | 61.9 | 64.6 (no Western change this round: variance) |

- **qwen is far stricter than Sonnet on the module sets.** Sonnet on 718e1ea gave M C/E/G 71.9 / 85.3 / 85.8 and D 82.8. Only compare runs under one judge.
- **The 经方 channel did not move X yet.** On the 17 X cases whose answer is a formula pattern:
  - the pick returned the right pattern for 5, a wrong one for 1 (真武汤证), and nothing for 11 (the evidence-check call and the thresholds filter most proposals: evidence checks ran in 226 of 328 cases);
  - where the pick was right, M03 kept the textbook row in 4 of 5 under rule ①; only X-C-0439 switched (热扰胸膈证) and passed.
  - The channel is safe (customer and held-out unchanged) but too conservative to pay off. Calibrating it is the obvious next step if the owner wants it.
- **M's low C/E/G under qwen is mostly a doctrine mismatch, not server defects.**
  - The references are compound syndromes (肝郁脾虚, 气血两虚, 脾肾两虚 with 湿热). The system, following the customer rule 「兼证须有独立成组证据、默认不立」, usually writes one.
  - Some of these do have a recorded second group: RobustSDT-0442 has 食欲不振 + 大便溏薄 and still got only 肝气郁结证.
- **New qwen-visible gap in H:** when no acupuncture card matches the disease, only home acupressure is delivered (7+ cases: 噎膈, 腱鞘囊肿, 膝痹, 脑瘫, 眼病, 鼻衄, 脱肛).

**Production after round 8.** 324ff55 was deployed on 2026-10-19 23:19 Beijing (15:19 UTC) (tag `20261019-324ff55-prebuilt`, same release directory and `20260927-dsrepair` override); `verify:deployed-image` and `regress:prod-smoke` passed. The host's telemetry archive shows bd86afb had gone out earlier the same day. Rollback is the previous image with the compose backup in the release directory.

**Round 9 (same day): the customer's acceptance standard.** The user sent the customer's acceptance standard and asked that its P0/P1 modules be made sound first:
- **1.1 core metrics:**
  - P0: red flags ≥95% (over-warning counts as a miss), TCM diagnosis ≥95% (disease 0.5 + syndrome 0.5), traceable basis ≥90%, Western diagnosis ≥90%, dose safety / 十八反十九畏 / special-population contraindications 100%, 随证加减 ≥90%.
  - P1: differential coverage ≥90% (at least 2 disease and 2 syndrome differentials), 治则治法 / formula choice / 配伍 / 中成药推荐 ≥90%.
  - P2: lineage, pathogenesis, formula provenance, 外治 ≥85%, care, follow-up, same-case consistency.
- **1.2 red lines (one veto each):**
  - a missed red flag;
  - a dose over 2× the pharmacopoeia with no warning;
  - 十八反;
  - a contraindicated herb for a special population;
  - ≥5/30 cases wrong on both disease and syndrome;
  - ≥3 mutually exclusive 治法 within one case class.
- **2 latency:** the customer measured 灵犀 M02/M03/M04 P90 at 17/41/38 s, against a competitor at 3.5/8/8 s.

Plan and agent notes: `~/runlogs/r1018/work/r1021/` (`TODO9.md`, `COMMON9.md`, one directory per work package with a `diagnosis.md`); P0 audit `p0-audit.mjs`. Seven Sonnet agents (WP9-A…G) worked in the worktree `~/worktrees/r1021-fix`; commit 5b102e4. Suites `test:r1021-main|jingfang|differentials|compound|cards|western|diseasepick|medicines`.

- **P0 audit on round-8 outputs (1,082 prescriptions).** Dose over the pharmacopoeia ceiling: 0; over 2×: 0. Pregnancy-prohibited, child-toxic and organ-failure herbs: 0. 十八反: 2, both between two **added** herbs (理中丸 加半夏 + 加附子, X-H-0163/0174). Each addition was checked only against the formula, never against the other additions. `withoutMutuallyIncompatibleAdditions` in the compiler now keeps the first of an incompatible pair.
- **Latency on production** (customer request shape, answered follow-up, cold, 32 chains): M02 p50 6.0 / p90 10.1 s, red-flags 5.1 / 6.7, M03 12.1 / 14.3, M04 10.8 / 12.4, M05 1.0 / 2.9. Server telemetry for 10/17–10/19 agrees: M03's pre-model work is p50 2.9 / p90 6.0 s, mostly facts extraction, and the two parallel halves take p50 9.8 / p90 13.7 s. The customer's 41/38 s figures predate the 10/12 slimming.
  - **Answered-path precompute** (`precomputeAnsweredPath` in `no-answer-precompute.server.ts`, called by the red-flags route). The skip path was already precomputed (10/13); an answered follow-up was cold. Now, when the red-flags call carries an answered follow-up, it starts diagnose → prescribe over loopback with the same case state the HIS sends next, and the HIS's diagnose call joins it.
  - Conditions: result reuse on (production only), `CDSS_REDFLAGS_PRECOMPUTE` not `false`, no regenerate header or parameter, an API-token or Bearer caller (not the page), a chief complaint, and a user answer right after an assistant question.
  - `test:r1021-main` 2.1 pins that `answeredCaseState` has the same stage fingerprint as the HIS's diagnose request.
  - M02's own critical path is facts extraction on `qwen3.8-max`; it was not touched, because moving facts off the max tier has released dose before (9/11, 9/19).
- **WP9-B differentials ≥2.** In round 8, 30% of 1,340 outputs had fewer than two TCM disease differentials (syndrome: 7). There were three causes:
  - the prompt said 1–2;
  - normalization dropped Western and symptom-level names;
  - the authoring task ran only at zero.

  Now:
  - the prompt asks for 2–3;
  - the authoring task (`tcm-disease-differential-authoring.server.ts`) fills up to two from the textbook list, then from the standard TCM disease names of the patient's department (63% of textbook diseases list fewer than two retainable differentials), through the same predicate as delivery (`resolveTcmDiseaseDifferentialName`). It also fills syndrome differentials;
  - it is **prefetched while the TCM half streams** (`onInitialM03Overview` → `prefetchTcmDifferentialTopUp`) and joined at the merge through the small-task memo. Measured wait at the merge: 0–64 ms. It needs `CDSS_SMALL_TASK_MEMO` on and parallel M03;
  - the delivered-surface fallback also fills to two.

  Live, 20 cases: 13/20 under two → 0/20. Offline, 120 deficient outputs: 95% filled.
- **WP9-E Western over-downgrade.** Of 113 D-set failures:
  - 23 were the name check downgrading a name the record proves;
  - 25 were the model writing the parent name itself;
  - 28 were a wrong direction;
  - 11 missed a complication;
  - 20 were reference granularity, which matches the customer's doctrine.

  The A1 root cause was the **live web excerpts**: 「金标准是食管测压」「超声心动图可确诊」 made "the gold-standard test was not done" read as missing evidence (88 D hits with search on, 27 with it off). Changes:
  - the check now writes `decisive` (a verbatim test, imaging, pathology or sign; never a symptom or course) and `meetsCriteria` first;
  - `decisiveFindingVetoesD` rejects a D downgrade when either holds;
  - criteria-table rows with `clinicallyDiagnosable=false` + `requiredTests` still require one of those tests, so 缺铁/PCOS/dental/asthma keep the 10/17 behaviour;
  - a qualifier-only downgrade drops the qualifier (肺炎链球菌肺炎 → 肺炎), and 「病名伴症状」 becomes 「病名待查」, not the symptom;
  - Alzheimer's is clinically diagnosable (NIA-AA 2011, PubMed 21514250);
  - the Western task asks for the most specific level the decisive finding supports and for complications that have objective evidence.

  Live subset of 49, re-judged by the same judge: 18 → 31 pass.
- **WP9-F disease pick.** The closed-set pick now receives each candidate's textbook definition and diagnostic basis (`buildTextbookDiseasePickRequest`). A picked disease whose best row fits the record clearly better (margin `PICKED_DISEASE_ROW_FIT_MARGIN` = 4) moves first (`promoteBestFitPickedDisease`). `withTextbookSyndromeName` writes the textbook's 证 suffix form. Held-out S078 (虚劳) and S151 (咳嗽) are right in the live chain; the customer's ten are unchanged.
- **WP9-C compound syndromes.** M-set references are compound in 86 of 360 cases (27% pass). Only 33/360 outputs had a 兼证.
  - **What it is not.** Re-prompting was not the lever. The model cannot tell "should add" from "should not" by content: the customer's 病历3/4 second groups look as specific to it as a real compound case.
  - **Second path in `m03-secondary-syndrome-consistency.server.ts`.** A group finder plus a specificity verifier, each with verbatim quotes. It runs only when the record fits the main syndrome's textbook row poorly (`textbookPatternFit` < 0.30). Customer cases sit at 0.20–0.50, held-out at 0.10–0.44, and the hand-labelled compound cases at 0.00–0.27. Switch: `CDSS_M03_SECONDARY_GROUP_CHECK`.
  - **Renaming keeps compound names.** `textbookNearestRow` may not drop 气/郁滞 or the organs of a two-organ name. Renames over 6,233 probes went from 504 to 72, all synonyms.
  - **Live result.** On 15 should-add cases: 0/15 → 22 of 30 runs. On 50 protected runs (customer and held-out): 0 added.
  - **Judge result.** The qwen judge barely moved, because most failing compound cases have the **main** syndrome wrong, not a missing second group.
- **WP9-A 经方方证 calibration.** On the 17 X cases whose answer is a formula pattern, the pick went from 5 right / 1 wrong / 11 empty to 8 / 1 / 8. M03 adopted 3 of the 8 correct picks (was 1 of 5). The changes:
  - one verbatim quote containing two key symptoms counts twice;
  - 「不」-initial key symptoms (不大便) are not denials;
  - an in-clause corroboration branch: ≥2 confirmed key symptoms from the same 条文, at least one not generic, and no other pattern covering them all;
  - the evidence check has three levels (same / close / different). A "close" is accepted only next to a "same" in the same pattern, never for tongue or pulse, and with ≥3 distinct key symptoms;
  - red-flag cases get no candidates;
  - the M03 rule compares the textbook row and the pattern discriminator by discriminator.

  Customer cases are unchanged, and held-out cases gained no new picks.
- **WP9-D acupuncture coverage.** Of the H-set cases that got only home acupressure, most have no textbook section (the list is in `cards/diagnosis.md` §3; nothing is invented for them). Changes:
  - textbook aliases the generator had not collected: 五迟 → 小儿脑性瘫痪, 鼻衄/倒经, 突发性耳聋 = 暴聋, 踝关节外侧韧带损伤;
  - two-character Western names match acupuncture sections;
  - child-only sections need age < 18;
  - textbook points follow the **main** syndrome when the catalog matched only the 兼证;
  - vertex points are dropped and the reason is stated when the fontanelle is recorded open;
  - the textbook's general frequency and course are used when a section has none (it was missing on 64% of cards).

  Customer and held-out cards are verbatim unchanged except the frequency line.
- **WP9-G patent/Western medicines** (new judge module K, 中成药推荐, 87.2% on M-r19i). Changes:
  - same pharmacological class with the same problem and route keeps one (`src/data/western-drug-pharmacology-class.json` from `scripts/build-western-drug-class.py`);
  - a direction floor against the signed syndrome (warming medicines for a heat syndrome, and the reverse);
  - no recommendation that the precautions forbid, or that duplicates a medicine the record says is already taken.

  The 40-case K subset went from 22/40 to 33/34.
- **Gate wording.** `test:doctor-vocabulary` rejects internal words such as 闭集 and 受治理 inside prompt literals that can reach doctor-visible text. Two agent prompts had to be reworded.

**Round 9 measured (qwen3.8-max, same judge both sides; round 8 = 324ff55 outputs r19i/local22, round 9 = 5b102e4 fresh generation r19j/local23).** Deterministic checks first, because they do not depend on the judge.

| Check | Round 8 | Round 9 |
|---|---|---|
| P0 audit, all sets (~1,700 outputs): dose > ChP ceiling / > 2× / 十八反 incl. 加减 / pregnancy-prohibited / child-toxic / organ | 0 / 0 / 2 / 0 / 0 / 0 | 0 / 0 / 0 / 0 / 0 / 0 |
| Fewer than 2 TCM disease differentials | M 82/360, X 108/330, H 132/330 | M 0/360, X 5/330, H 5/330, customer + held-out 1/62 (黧黑斑: the only candidate is a synonym) |
| Disease 0.5 + syndrome 0.5 vs answer, customer 10 × 3 / held-out 29 | 100% / 91.4% (2 wrong on both) | 100% / 100%; identical across the three customer runs |
| A gate decisions | — | 0 of 340 changed |
| Local stage medians (M03 / M04) | 9.9 / 10.2 s | 9.9 / 10.3 s |

| Judged (qwen) | Round 8 | Round 9 |
|---|---|---|
| Customer 10 × 3, failures per column | 0 everywhere | run 1: 饮片 1 (病历7 empty 加减); runs 2–3: 0. Separately, 病历7 run 2 was a **non-dose page** (see below); the judge put it under 红旗与剂量档 |
| Held-out 32 | every block ≥ 90 | every block 100 except 西医 26/29 = 89.7 (S032 中度贫血 at Hb 92 and S102 PCOS were the same names that passed in round 8; S079 is check variance) |
| A red flags | 330/340 | 328/340 (outputs identical; the two flips are judge variance) |
| B follow-up | 97.3 | 97.9 |
| X C / E / G | 69.1 / 89.1 / 78.2 | 73.4 / 89.1 / 80.9; formula-pattern answers 3/22 → 7/22 |
| M C / E / F / G / H / I / J / K | 49.0 / 55.2 / 94.9 / 62.5 / 94.9 / 100 / 97.7 / 87.2 | 51.9 / 61.8 / 96.2 / 68.2 / 94.8 / 99.7 / 98.5 / 90.8 |
| H cards | 89.2 | 90.9 |
| D Western | 64.6 | 62.2 |

- **D did not move on the full set.** Among cases whose name changed, 23 went fail → pass (the over-downgrades this round targeted: 室间隔缺损, 贲门失弛缓症, 肥厚型心肌病, 阿尔茨海默病…) and 26 went pass → fail. The second group is the Western half writing a different disease on a fresh generation (腰椎转移瘤 → 甲状腺瘤), plus two side effects of the new rules: a complication appended to the name (「急性心肌炎伴心力衰竭」「支气管肺炎合并心力衰竭」) and qualifier dropping (急性肾盂肾炎 → 尿路感染, 脊髓型颈椎病 → 颈椎病). Among unchanged names, 15 of 198 verdicts flipped, which is the judge's own variance.
- **New server defect found by this run, not fixed (the user asked for a stop and summary first).** 病历7 run 2: the model wrote 「…白酒，辛热积于胃腑…」. `scrubPhi` in `diagnosis-safety.ts` (inside the evidence output transform) matches punctuation + surname 辛 + 1–2 characters + 于, and 辛热 is not in the clinical-lexeme exemption, so 「辛热积」 became 「[已脱敏]」. The signed M03 kept the original text, `crossStageReasoningIssue` reported `pathogenesis_drift` at the route's final T1 recheck, and the page lost its dose. It reproduces offline (`~/runlogs/r1018/work/r1021/final/drift.mjs <r2.json> <r3.json>`): every final-transform step leaves the text alone except the evidence transform. Same class as 9/29 「患者高龄」 and 10/13 「患者全身发热」. The fix belongs in the governed lexeme grammar (性味 forms 辛热/辛温/辛凉/辛燥… as a closed group) with the two-way corpus measurement.
- **S102 PCOS (held-out) is not downgraded** although the record has a normal ultrasound and normal hormones. The check does return D, but its quote joins the two findings in reversed order with 「；」 (「性激素六项大致正常；妇科彩超：…」), which is not a verbatim substring, so the downgrade is discarded (1 of 2 probe calls; `final/wprobe.mjs`). Not fixed.

**Deployment.** Round 9 went to production together with round 10's A and B as 604a33b on 2026-10-20 (see the next section).

### 10/20 round 10: the two round-9 defects, Western stability, ABC conventions for 证型/治法/治则 (2026-10-20)

The user chose: A (fix the two defects found by the round-9 acceptance run, deploy round 9, measure the answered path on production), B (Western stability; revert the two round-9 side effects), C (research the main-syndrome problem and act on it), then align 治法/治则/兼证 with the competitor ABC 诊所管家 ("别是我们推理的多了或者偏了"), check the customer's P0/P1 items, and run a wider test. Plan, research and agent notes: `~/runlogs/r1018/work/r1022/` (`TODO10.md`, `COMMON10.md`, `research/abc-format.txt`, `research/syndrome-methods.txt`, `phi/`, `western/`, `abc/`, `adj/`). Commits 8b1c8e2 + 604a33b (A+B, **deployed**), 7090d85 (C+ABC, local) and 392a237 (P0 population wording, local; `deploy/r10-p0` = 604a33b + this fix). Suites `test:r1022-main|phi|western|abc`.

**What ABC actually outputs** (five screenshots on its own blog, transcribed): 证型 is one line of 1–3 elements without main/secondary (a single element uses a standard name, 风燥伤肺证; several are mechanism phrases, 风邪犯肺，肺阴亏虚，卫表不固); 辨证要点 one line per element; 治法 2–3 items mapping to the elements; **no 治则** anywhere (AI output, record fields, open API); 加减 3–4 「若X：加A 剂量、B 剂量」 items. ABC grows elements from side signs (舌下络脉青紫 → 气滞血瘀), which is more aggressive than our "兼证 only with grouped evidence"; the customer's own 10.12 feedback called a forced 兼证 牵强, so that rule stays.

**A.**
- **The 病历7 non-dose page was the server's, not the scrubber's alone.** `restoreSignedM03ClinicalSections` (evidence output transform) restored the M03 sections into the prescription from `caseState.reasoningDiagnose`, and the prescribe route passed the PHI-sanitized `safeState`; the final T1 recheck compared with the unsanitized signed M03. Any M03 sentence the scrubber rewrote became `pathogenesis_drift` and withheld the dose. The route now passes the signed M03 (`{ ...safeState, reasoningDiagnose: signedPriorReasoning }`), so the class is closed whatever the scrubber does.
- **PHI scrubber vs model-written clinical text.** 769 of 189,040 round-9 model output strings were rewritten (方中有人参 → 「[已脱敏]有人参」, 查体有无, 明确腹痛, 黎明前腹痛 (五更泻!), 连声咳嗽, 辛热积于…). 24 construction groups in `phi-clinical-lexical-grammar.source.json`, context-bound exemptions (`isFormulaReadingOpening`: 方中 only before 有 + governed herb; `isStraddledClinicalWord`: 左小+腹), and one shared predicate `isGovernedClinicalLexemeCandidate` for the three name rules. False redactions: model outputs 660 → 139, 17k-case corpus 35 → 28, acceptance records 32 → 19; 5,573,568 surname × name × pattern probes leak exactly the same set (高寿 was removed from the exemptions: it let real names through).
- **Narrow-check quotes:** `src/lib/verbatim-quote.ts` (`quoteGroundedInText`): a quote made of record fragments joined by 「；，」 in another order counts when every fragment (≥3 chars) is verbatim. S102's PCOS downgrade had been dropped for that.
- **Deployed 604a33b** (tag `20261020-604a33b-prebuilt`, 2026-10-20 10:31 Beijing): `verify:deployed-image` ok, `regress:prod-smoke` 0 failures (cold M03 P95 14.3 s, M04 P95 10.7 s). Rollback image `tcm-cdss:20261019-324ff55-prebuilt`.
- **Answered-path latency on production** (customer request shape, answered follow-up, 20 s think time, REGENERATE=0, 32 chains, all 200): M03 p50/p90/p99 12.1/14.3/15.7 → 8.6/10.5/10.9 s; M04 10.8/12.1 → 9.5/10.7 s; red-flags p90 6.5 → 9.0 s (the precompute shares capacity). The round-9 measurement used REGENERATE=1, which bypasses reuse and therefore the precompute too.

**B (Western).**
- Complications with objective evidence are listed first in `differentials` with their basis instead of «必须写进 name» (r19j: 急性心肌炎伴心力衰竭, 支气管肺炎合并心力衰竭 without evidence).
- A D-type downgrade may only use a broader name of the same disease — a character subsequence of the original (脊髓型颈椎病 → 颈椎病, 急性化脓性扁桃体炎 → 急性扁桃体炎), a symptom-level name, or the record's own wording (主诉「牙痛3天」 → 牙痛); anything else becomes 「原病名待查」. The check had handed back other diseases: 附睾结核 → 附睾炎, 甲状腺癌骨转移 → 甲状腺瘤, 肾包虫病 → 肾囊肿, 糖尿病 → 消渴病. S102 is now 多囊卵巢综合征待查 (the reviewer asked for 待排).
- The name check runs twice in parallel (content order reversed, separate cache keys) and renames only when both agree; width-only D differences merge to the broader name (`CDSS_WESTERN_NAME_CHECK_AGREEMENT`, `…_NAME_MERGE`). Check renames fall by a third; protected customer downgrades unchanged.
- **Stability was measured and did not move significantly:** the same record gives a different Western primary name in 14/80 (17.5%) of paired runs on round-9 code and 11/80 after; four arms sit within one binomial standard error. Most remaining variance is the Western half rewording its own name, which a check cannot fix.

**C + ABC (7090d85, not deployed).**
- **Research** (`research/syndrome-methods.txt`): our TCM-half template made the model write `primarySyndrome` before its own location/nature analysis; with thinking off, field order is the reasoning order. Element-first (证素辨证 证候→证素→证名; TCMEval-SDT info → pathogenesis → syndrome) was the top recommendation (CHD-SEDD: syndrome F1 61 → 85% in a narrow setting).
- **Element-first:** provider schema key order, the parallel-half instruction and the template now put `pathogenesis` (location and nature elements with verbatim basis, 本虚/标实 separated) before `overview`; one prompt paragraph says the syndrome is composed of the listed elements, 本虚/标实 decides the head, 治法 maps element by element (main syndrome keeps the textbook 治法) with at most one symptomatic item, and no 治法 for a mechanism the syndrome line lacks.
- **治则** is now derived from the delivered syndrome elements (`signedNatureProfile`): a deficient element ⇒ 虚, a pathogen element ⇒ 实 (感冒/外感 count), both ⇒ 扶正祛邪; 治法 wording only for names that show neither (痛痹, 胸痹); 乘/伤X/两伤/耗伤 are deficiency; excess with a root tonification in 治法 ⇒ 标本兼治; 寒热错杂 names ⇒ 调理阴阳. Replay over 1,402 round-9 diagnoses: 112 changed, all read, customer cases unchanged. Before, a stray 「益气养阴」 in 治法 turned a pure heat case into 扶正祛邪 and 痛痹兼肾阳虚 became 虚则补之.
- **Same-day measurement matters.** A fresh generation of round-9 code today scored 中医诊断 ~45% on the M100 subset, against 50–52% for the stored round-9 outputs judged twice. Every arm generated today (A+B 42, old order 44, element-first 45) sits there; comparing a fresh arm with stored outputs would have blamed the new code. Only compare arms generated the same day.
- **Result (same day, qwen):** 中医诊断 unchanged (45 vs 42–45 per 100); 治则治法 M 47 (A+B) / 43 (same rules, old order) → 52/98, X 24–26 → 27/30. Customer 10 × 2 and held-out 32: disease and syndrome 100%, identical across runs; M03 output tokens +3%.
- **Not done here:** the research's second step (closed-set discriminator adjudication between the model's syndrome and 1–2 neighbouring textbook rows) was evaluated offline only (`adj/`).
  - **Offline evaluation of the adjudication step** (`adj/`, 392 calls): candidates = the model's syndrome + 1–2 (or all) rows of the same disease; the model marks each row's manifestations supported/contradicted with verbatim quotes, never a name; override only on score lead ≥2 with ≥1 contradiction and two agreeing passes. On 141 eligible M/X cases: **0 correct overrides**, 1–4 wrong ones (cases whose syndrome already matched the reference); the model's contradiction sets agree between the two orders only 0.29–0.47. Not shipped.
  - **Error classes of the remaining 中医诊断 failures** (63 on M100 + X60, hand-classified): deficiency/excess, cold/heat or deficiency-type flips 23 (5–7 are 苔黄腻 written as 痰浊/痰湿 without heat); disease name 14 (7 where the reference disease has its own textbook section the closed-set pick did not choose: 中风 for an old stroke with dizziness, 癌病, 心衰…); missing 兼证 10; organ 4; main/secondary 3; external/internal 1; reference from another system (经方方证, diagnostics names) 4. 43 of the 55 M failures failed in all four same-day arms; 12 flip between generations.

**P0 found by the wider test: pregnancy, lactation and warfarin in old case-record wording (392a237).** The new special-population set S (137 real records: pregnancy 20, lactation 15, anticoagulant 12, hepatic 15, renal 15, 75+ 15, five child age bands × 9) found 8 patients with an independent hard dose boundary who got dosed prescriptions (pregnancy 2/21, lactation 4/15, anticoagulant 2/12). The deterministic assessors did not read:
- 「妊娠已6个月」 (已/约/近/有 between 妊娠/怀孕 and the number, after whitespace removal);
- 「HCG（+）」「尿妊娠试验(+)」「早孕试验：弱阳性」 (test name + plus sign; 「（-）」 is a negative);
- 「产后缺乳」「乳汁稀少/量少/欠通畅/点滴不出」「挤出乳汁再喂」 (scant or blocked milk is lactation by itself; 「患儿自幼缺乳」 and 「喂奶粉」 are excluded, 「还能喂奶吗」 stays possible);
- 「哺乳中」「现哺乳」;
- 「华法令」, another transliteration of 华法林 (antithrombotic matcher and the medication alias map).

Open-language freeze exception: finite closed sets and morphological guards. Corpus replay over 20,496 texts (17k modern cases, the ten acceptance sets, synthetic sets): pregnancy 6, lactation 8, anticoagulant 3 changes, all read and all correct. Re-running S on the fix: 0 of 21/15/12 dosed. `test:r1022-main` §4 with counter-proofs. **Not deployed** (see below).

**Round 10 measured (qwen3.8-max; local, 7090d85 = A+B+C/ABC, before the P0 fix).** The wider test added four sets built for this round (`sets/round10-sets-report.txt`, fixed seed, no overlap with the old sets, leak-checked): M2 (360 real TCM records, five sources), X2 (330 exam-style, C/E/G × 110), S (above) and L (20 M2 records × 5 lineages), plus the 10/13 synthetic 190 and customer-history 52, and a judge that scores the customer's own 1.1 rows (`judge-qwen-p.mjs`: T 依据可追溯, R 随证加减, Q 治则治法与主证匹配, S 选方, P 配伍, K 中成药, L 病机, Y 出处方义, W 外治, N 调护, V 随访, Z 流派; it does not compare against dataset answers).

Deterministic checks (do not depend on the judge):

| Check | Round 10 |
|---|---|
| P0 audit, every set (dose > ChP ceiling / > 2× / 十八反 incl. 加减 / pregnancy-prohibited / child-toxic / organ) | 0 / 0 / 0 / 0 / 0 / 0. The independent-boundary gap above is a different class: the patient was not recognised as pregnant/lactating/anticoagulated at all |
| Disease 0.5 + syndrome 0.5 vs the answer (customer 1.1 P0 ≥95%) | customer 10 × 3: 100%, held-out 32 × 2: 100%; no case wrong on both |
| Same record, repeated fresh generations | customer 10 × 3: disease, syndrome, 兼证, formula identical 10/10, 治法 8/10, Western 8/10; held-out 32 × 2: disease and syndrome 32/32, formula 31/32, 兼证 30/32, Western 26/32, 治法 22/32 |
| Synthetic 190 / customer-history 52 (`score.py`) | every block ≥ 94% except 证候 90.0 / 80.8 (any 兼证 counts as forced: 10/190, 7/52) and 注意事项 84.3 / 87.5 (more than 5 lines once the rule-computed lines are added) |
| TCM disease differentials < 2 | L + HIST + SYN: 5/342 |
| Local stage medians / p90 (synthetic 190) | question 6.5 / 12.5 s, diagnose 10.6 / 12.3 s, prescribe 11.5 / 14.5 s |

Judged by qwen3.8-max, round 9 (5b102e4, r19j) → round 10 (7090d85, r20). Both judged with the same scripts; the round-9 outputs were generated on 10/19, so per the same-day note a few points either way are generation drift.

| Set | Round 9 | Round 10 |
|---|---|---|
| Customer 10 × 3, failures per column | run 1: 饮片 1; runs 2–3: 0 | run 1: 0; run 2: 中医诊断 1 (病历10's rationale ends 「尚需结合复诊舌脉修正」 although tongue and pulse are recorded); run 3: 饮片 1 (病历7 empty 加减). One 工程用语 fail was the review renderer printing the interface value `syndrome` (`panel.py` now labels it) |
| Held-out 32 | every block 100 except 西医 89.7 (one run) | two runs: every block ≥ 96.6 except merged 中医诊断 94.8; 西医 98.3 |
| A red flags | 328/340 | 331/340 (8 over, all guideline-backed calls from round 8; 1 under, A-eme-0175) |
| B follow-up | 97.9 | 96.7 |
| X C / E / G | 73.4 / 89.1 / 80.9 | 71.8 / 90.0 / 82.7 |
| M C / E / F / G / H / I / J / K | 51.9 / 61.8 / 96.2 / 68.2 / 94.8 / 99.7 / 98.5 / 90.8 | 54.4 / 64.0 / 96.6 / 68.9 / 95.3 / 100 / 97.7 / 92.4 |
| H cards | 90.9 | 88.6 |
| D Western | 62.2 | 64.9 |
| New: M2 C / E / F / G / H / I / J / K | — | 61.9 / 70.6 / 95.6 / 74.4 / 96.9 / 99.1 / 96.8 / 91.9 |
| New: X2 C / E / G | — | 71.8 / 85.5 / 78.2 |
| New: S C / G / J / K | — | 70.1 / 87.1 / 96.2 / 93.9 |
| New: L C / G | — | 44.0 / 59.6 (lineage consistency Z below is 100%; the misses are the main syndrome against the reference) |

The customer's 1.1 rows (`judge-qwen-p.mjs`; percentages, n in brackets where a row is not applicable to every case):

| Row | customer 10 × 3 | held-out 32 × 2 | S 137 | L 100 | M2 360 |
|---|---|---|---|---|---|
| T 依据可追溯 (P0 ≥90) | 100 | 98.4 | 94.9 | 96.0 | 97.2 |
| R 随证加减 (P0 ≥90) | 100 | 98.4 | 97.7 | 99.0 | 98.0 |
| Q 治则治法与主证匹配 (P1 ≥90) | 100 | 100 | 100 | 98.0 | 98.3 |
| S 选方 (P1 ≥90) | 100 | 100 | 98.5 | 100 | 98.6 |
| P 配伍 (P1 ≥90) | 100 | 100 | 100 | 100 | 100 |
| K 中成药 (P1 ≥90) | 100 (24) | 96.8 (31) | 97.1 (34) | 100 (48) | 97.7 (128) |
| L 病机 (P2 ≥90) | 100 | 100 | 99.3 | 95.0 | 93.6 |
| Y 出处方义 (P2 ≥90) | 100 | 100 | 99.3 | 100 | 98.9 |
| W 外治 (P2 ≥85) | 100 | 100 (54) | 98.2 (56) | 100 (71) | 98.0 (205) |
| N 调护 (P2 ≥90) | 100 | 100 | 99.3 | 100 | 99.7 |
| V 随访 (P2 ≥90) | 100 | 100 | 90.4 | 97.0 | 93.9 |
| Z 流派 (P2 ≥90) | — | 100 (2) | — | 100 | — |

- **Read the two judges together.** The 1.1 rubric checks the output against itself and the record (is every quoted basis in the record, does 治法 match the system's own syndrome); the module judges compare with dataset answers. Every 1.1 row is ≥90% on every set (lowest: M2 L 病机 93.6, S V 随访 90.4), while M/L C and G sit at 44–75% because the main syndrome differs from the reference (most often a compound reference such as 气虚血瘀 where we write one element, or the reverse).
- **The customer's own 1.1/1.2 numbers that we can compute:** red flags 97.4% (≥95), dose/十八反/special-population audit 100%, disease+syndrome on the customer and held-out cases 100% with no double misses, differentials ≥2 at 98.5%, Western 98.3% on the held-out set (the D exam set is 64.9% against the most specific exam answer).

**Found by the round-10 run, not fixed (per the stop rule).**
- **兼证 from the model's own 「兼」 wording, and duplicated 治法 items.** With pathogenesis written first, the model more often concludes 「病性属痰湿兼气虚」; the self-declared-marker path then adds the 兼证 and appends its method, giving 「燥湿化痰，理气止咳，健脾和胃，健脾益气」. 兼证 rate X 12.4 → 15.2%, H 18.8 → 20.9%, M flat (36.4 → 34.7%); synthetic 10/190 and history 7/52, where the scorer counts any 兼证 as forced. 治法 lists with two items starting with the same two characters: M 15 → 21/360, X 5 → 9/330. The opposite miss also exists: 心血瘀阻证 with six recorded 气虚 findings got no 兼证 (L set).
- **Non-dose pages' follow-up has no day.** 「按医生安排复诊」 on special-population non-dose pages fails the customer's V row 13/136 on S.
- **Model-written defects seen by the reviews:** 病历7 empty 加减 in about one run of three (`trigger_not_current_fact`; the 牙痛 supplement rows have no textbook 加减); 病历2 五味安神颗粒 (心脾两虚 label) for 心虚胆怯; S032 「中度贫血」 at Hb 92 (case C did not fire); S058 「未诉腹痛」 against 「腹中冷痛」; S-lactation-010 disease 鼻塞 with 「无鼻塞」 recorded; a 12–17 y record of 风湿性心肌炎 written as 病毒性.
- **Not a defect:** S131 滑石 先煎 follows ChP 2020 (滑石 先煎, 滑石粉 包煎); the held-out reviewer expected 包煎.
- **Acceptance-set data:** chief complaint taken from occupation or date in M 47/360, X 21, H 29, D 7, A 20 (`round10-sets-report.txt`); M2/X2/S/L are built without it.

**Deploy status.** 604a33b (round 9 + round 10 A/B) is in production. ea33d20 (`deploy/r10-p0`: 604a33b + the P0 fix, without C/ABC) passed `verify:release` and prebuilt, then the deploy script stopped at the host disk floor: 10.1 GB free < 12 GB. Our own reclaimable files on the host (build contexts of 4a6e9cc/bd86afb/324ff55, the bd86afb image) total about 1.5 GB; the rest of the 178 GB belongs to other projects (hecrs-state 20 GB, evimed/rxai images with 29.5 GB reclaimable). The floor was not lowered. Two hours later the host was at 4.4 GB free (98%) from other projects' writes. Production therefore still lacks the pregnancy/lactation/warfarin wording fix.

**Running it again.** `~/runlogs/r1018/scripts/final-run-r20.sh` (generation, resumable; judges detached), then `tally-qwen-sets.py <set>-r20`, `tally-qwen-p.py <P-dir>`, `tally-qwen-cust.py c10|held`, `~/runlogs/fix1012/scripts/score.py <out> --cases <file>`, `work/r1021/p0-audit.mjs <out>…` and `work/r1021/final/dx-halfscore.py <out>`. qwen throughput is about 12 judgements per minute across all processes regardless of worker count, so a full round of judging takes about four hours; give the comparable module sets priority and run the 1.1 rubric afterwards.

### Clinical request archive — `src/lib/request-archive.server.ts` (2026-10-12)

Until 10/12 the server kept no request bodies (nginx logs time/IP/path/status/bytes; container logs carry telemetry codes only), so a customer case could only be reverse-engineered from byte counts. The owner decided to keep request content server-side, with no time limit (compliance confirmed).
- **One capture point:** `readJsonRequest` in `diagnosis-request.ts`, which every clinical route reads its body through. It is fire-and-forget: never awaited, and failures leave only a reason code (`[tcm-cdss:telemetry] request_archive`).
- **Closed route set:** `ARCHIVED_ROUTES` (collect / question / interpret / red-flags / diagnose / prescribe / assess / post-prescription-risk / his-scheme / emergency-clearance / terminology). Login (the body is the API token), inventory, knowledge search and snapshot are never archived.
- **Encryption:** AES-256-GCM with a key HMAC-derived from `CASE_SNAPSHOT_ENCRYPTION_KEY`. Plaintext holds only the time and route, which are bound as AAD. **Rotating that key makes older archive lines undecryptable**; every line carries a `kid`.
- **Storage:** one file per Beijing date, `requests-YYYYMMDD.ndjson`, under `/app/runtime-data/request-archive` (the persistent volume). Nothing is deleted by age. Above `CDSS_REQUEST_ARCHIVE_MAX_BYTES` (4GB) writes pause and nothing is deleted.
- **Switch:** the code default is off; `docker-compose.yml` turns it on.
- **Coverage gap:** M04/M05 request bodies carry the earlier stages' output, so they hold most of "our output" too. The final M05 output itself is not archived.
- **Reading:** `ssh evimed "docker exec -i <container> node --input-type=module - [--since=ISO] [--route=prescribe] [--summary]" < scripts/request-archive-export.mjs`. The key never leaves the container. Keep exported files outside the repo with 0600 permissions; they are patient records.
- **Tests:** `test:request-archive` pins all of the above.

### Auth — `src/proxy.ts` + `src/lib/cdss-auth.ts`

`proxy()` gates `/`, `/diagnosis`, `/api/:path*`. Auth is on when `CDSS_REQUIRE_API_AUTH=true`, in production, or whenever `CDSS_API_TOKEN` is set. API callers send `x-cdss-api-token` or `Authorization: Bearer <token>`; browsers get an httpOnly cookie `tcm_cdss_ui_access` = `SHA-256("tcm-cdss-ui:"+token)` from `/api/auth/access`. `proxy()` also rate-limits model-calling routes (`CDSS_MODEL_RATE_LIMIT_PER_10_MIN`, default 60 per 10 min) — the bucket is **in-memory and assumes a single instance**, so horizontal scaling would silently multiply the real limit. If you add API routes, keep them under the matcher and never introduce an unauthenticated bypass.

### Deploy, and proving what's actually running

This exists because of a real failure mode: local regressions were green while production behaved the opposite way, and there was no way to tell "the fix is wrong" from "the fix never shipped." The chain that makes that decidable:

```bash
node scripts/build-source-digest.mjs      # npm run build:source-digest → DIGEST
scripts/deploy/prebuild-local.sh <clean-worktree> <TAG> <COMMIT> <DIGEST> <STAMP>   # compiles HERE, not on the host
IMAGE_TAG=<TAG> PREBUILT_DIR=~/build-prebuilt/<TAG> DEPLOY_REMOTE_DIR=<release dir> \
  DEPLOY_OVERRIDE_REL=<release-ops/production.override.yml> scripts/deploy/deploy-green-inplace-prebuilt.sh
BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=… npm run verify:deployed-image
BASE_URL=… CDSS_API_TOKEN=… npm run regress:prod-smoke
```

- `build-source-digest.mjs` hashes only **clinical-behavior** files — `src/lib`, `src/app/api`, `src/data` — deliberately excluding docs/tests, so editing this file doesn't move the digest but editing one line of safety logic does. It's baked in at build time via `CDSS_BUILD_COMMIT` / `CDSS_BUILD_SOURCE_DIGEST` / `CDSS_BUILD_TIMESTAMP` build args and echoed back by `/api/diagnosis/health`.
- `verify:deployed-image` recomputes the digest locally and compares. **Non-zero exit means the deploy failed, including "couldn't prove it"** — don't debug source until it's zero.
- **Production is the green container `tcm-cdss-deepseek-green-20260911` (port 3020) replaced in place**, not `-p tcm-cdss-prod`; the old `scripts/deploy-prod.sh` hard-coded the latter and "deployed" a container nginx never routes to, so it was deleted (2026-09-25). `scripts/deploy/` holds the real path, moved in from an out-of-repo `~/runlogs/` copy (a `/tmp` copy of the deploy script was lost once before): `prebuild-local.sh` compiles locally because `next build` needs ~6GB and building on the shared host took it offline twice; `deploy-green-inplace-prebuilt.sh` only packages the runtime layer on the host. Its header lists the load-bearing checks (prebuilt meta = commit + digest; runtime env digest before/after sync; whitelist rsync from `common.sh`, shared with prebuild; `env -i` + `--env-file` compose; token three-way match + 0600 baseline; count-based prune + disk floor; image existence re-checked after a tail-truncated build; compose backup for rollback). `IMAGE_TAG`, `PREBUILT_DIR`, `DEPLOY_REMOTE_DIR` and `DEPLOY_OVERRIDE_REL` are required because each stale default has already bitten (cold 481MB sync; wrong override silently changes the production model tiers). `test:deploy-runtime-env-protection` drives the real script through fake ssh/rsync to every refusal gate. Read the header before editing.

### 本机执行纪律（2026-08-16 实测，各栽过 ≥2 次）

- **受治理来源注册表只给数据输入记指纹，不给代码（2026-09-25 起）。** 改 `src/lib/diagnosis-safety.ts` /
  `diagnosis-types.ts` / `tcm-treatment-projects.ts` 不再需要重跑生成器——此前这三份代码的 sha256 登记在
  `clinical-governance-source-registry.json` 里，每改一次安全代码都得重跑两个生成器（同一天栽过两次），
  而实测它们的内容不进任何表格（三份同时改动后重跑，表格逐字节不变，只有哈希在动），指纹只是出处标签。
  改了注册表登记的**数据**源（`src/data/physical-exam-claim-lexicon.source.json`、`tcm-formula-sources.json`
  等）或生成器本身，仍须重跑 `build-clinical-governance-static-tables.mjs` + `build-tcm-governance-tables.py`，
  否则 `test:clinical-governance-tables` 报「表内 … 实际 …」。该套件同时钉住「代码条目不得带指纹、
  src/data 整文件条目必须带指纹」，别把代码指纹加回去。
- **闸门不能与工作流/dev server 并发。** 6G 内存，`test:deterministic` 自带
  `--max-old-space-size=8192`；并发时闸门进程被内存回收直接杀掉，**日志为空、无退出码**——
  这与「跑完了但没写标记」长得一模一样，别把它当成绿。判别：`ps` 里进程没了且日志 0 行 ⇒ 被杀。
- **源码级断言必须自带越界守卫。** 用 `indexOf("};")` 切对象字面量会切过头到下一张表，
  于是「从第一张表里删一项」照样能在第二张表里找到，断言静默空转。
  本仓多个对象以 `} as const;` 结尾。可靠信号是**去重后数量变少**，加一条 Set 大小断言。
- **本机起的桩服务只数模型端点的请求。** t3code 宿主进程会在任何新开的本机端口开始监听后约 250ms
  发一次 `GET /`（`ss -tnp` 实锤）。桩服务若数所有请求，重试计数就偶发多 1——闸门里
  「socket 重试计数 3≠2」那类偶发失败的真因（2026-09-25），不是 keep-alive。
  共用桩在 `scripts/lib/local-model-endpoint.mjs`：只数 `POST …/chat/completions`，其余回 404。
- **每条新断言都要跑反证。** 今天 3 条断言写完是绿的、反证一跑才发现抓不住；
  另有 3 次「照推断直接改」全部改错（判分器关键词、sentinel 丢失、finalize 硬拦 T2）。
  这个代码库判据链很长，读代码形成的直觉可靠度低——以日志与实测数字为准。

## Conventions & gotchas

- **Imports:** `@/*` → `src/*` (tsconfig paths). Match the existing thin-route / logic-in-`lib` split; keep routes validating + streaming only.
- **Open-language detection freeze:** for colloquial red flags, polarity/negation, encounter scope, symptom confirmation, and terminology normalization, a new miss or false positive must produce a governed category example, class-level parity regression with negative controls, and a layer-attribution note. Iterate the semantic prompt by default; do not add a one-phrase surface regex. Deterministic regex additions are limited to numeric thresholds, finite closed sets, and morphological/lexical guards, and the commit must name the applicable exception.
  - **Where those three artifacts live (since 2026-09-26):** one JSON per class under `scripts/fixtures/open-language-classes/` — development set, at least one held-out set written *after* the prompt wording was frozen, negative controls, the layer-attribution note, the measured before/after rates, and one expected semantic judgement per positive. `npm run regress:facts-class-parity` samples every sentence N times against the real facts model (no server needed; a fresh tenant per sample, because the facts cache is keyed on tenant+text). `test:open-language-classes` is the gated deterministic half: the prompt principle is still there, and feeding the recorded correct judgement through grounding → gate withholds dose while the pre-fix judgement does not. Held-out sets are the point: the first wording of the 9/26 fix passed its own development set 60/60 and still missed a held-out phrasing 4/5.
  - **When the defect is in the deterministic layer** (`"mode": "deterministic"` in the fixture), the whole class is measured in the gate instead: sibling parity ("background clause，current emergency" must get the same gate result as the emergency alone, and the emergency alone must not be `ready`) plus controls that must stay `ready`. Before touching a shared deterministic predicate, also replay a real corpus both ways and read every changed sentence: the 9/26 temporal-scope fix was green on its own parity set and still produced 3 false emergencies on real case narratives until the `…病史` form was taken back out.
- **`src/lib/*.server.ts` is a real boundary, not a suffix.** ~25 modules (`emergency-clearance.server.ts`, `icd10-diagnosis-coding.server.ts`, `tcm-classic-evidence.server.ts`, …) are server-only — they read env/secrets, call models, or load governed data. `DiagnosisClient.tsx` is a client component; keep it out of these. New server-only logic gets the suffix.
- **Everything is fail-closed and evidence-bound.** Don't add model calls that emit dose-level prescriptions, guideline/DOI citations, or risk verdicts without a deterministic rule or KB entry behind them.
- **`NEXT_PUBLIC_BASE_PATH`** lets the app mount under a sub-path; it's threaded through `next.config.ts`, `cdss-auth.ts` and `proxy.ts` — respect it when building URLs/redirects.
- **Build/deploy:** `output:"standalone"` (`next.config.ts`); `Dockerfile` + `docker-compose.yml` build the standalone image and pass the env below. `.env*` is gitignored.
- New request bodies go through `readJsonBodyWithLimit` / `readCaseStateRequest` (`src/lib/http-guard.ts`, `diagnosis-request.ts`) for size caps and 413/400 handling — reuse them.
- **Not application source.** In tsconfig `exclude`: `artifacts/`, `deeptest/`, `test-results/` (eval output that churns in `git status`; the latter two may not exist on disk at any given moment) and the vendored `open-code-review-main/`. Also outside the app: `uploads/` (customer-supplied evaluation docs — untracked *and* un-gitignored, so it shows up dirty), and the ~4.6GB of build inputs in `中医补充数据/` (2.3G), `药学基础数据/` (2.3G), `参考/` (150M) — gitignored, kept out of the image, and inventoried by `src/data/external-data-manifest.json` (regenerate with `node scripts/build-external-data-manifest.mjs`; check it before trusting an ingest on a new machine). Don't read any of these for architecture, don't "fix" them, and don't let their diffs into a change you're describing as source-only.
- **`src/data/*.json` are generated**, not hand-maintained (`tcm-knowledge.json`, `tcm-formula-sources.json`, lexicons, evidence corpora, retrieval indexes) come from the `build:*` / `import:*` scripts. Fix the generator, not the artifact. The `*.source.json` files are the curated inputs those generators consume — those *are* hand-edited, and editing one means re-running its build script.

## Stack

Next.js 16 (App Router, Turbopack, `output: "standalone"`) + React 19 + TypeScript 5 (strict); Tailwind CSS 4 + shadcn (`src/components/ui`), lucide-react, react-markdown; zod 4; the `openai` SDK against OpenAI-compatible endpoints (DashScope for Qwen, api.deepseek.com for DeepSeek). **No database**: case state lives in browser localStorage (server-encrypted AES-256-GCM snapshots) plus local JSON knowledge files.

## Deployment basics

- `next.config.ts` sets `output: "standalone"` and global security headers (CSP/HSTS/X-Frame-Options …).
- `Dockerfile` (node:24-alpine, multi-stage) + `docker-compose.yml`; image tags must be immutable `IMAGE_TAG`s. The container refuses to start if `NEXT_PUBLIC_BASE_PATH` / `NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE` differ from build time — changing them needs a rebuild.
- Compose binds `127.0.0.1:3000` by default (`APP_BIND_IP`/`APP_PORT`); production sits behind a TLS-terminating reverse proxy (ties in with `CDSS_TRUST_PROXY_HEADERS`). The real production deploy path is in "Deploy, and proving what's actually running" above; `docs/部署运行手册-20260713.md` predates the green container.

## Environment variables

Set in `.env.local` (see `.env.example`, which annotates every key). **Never read or commit the real `.env.local` / `.env.development.local`.**

- **Primary model:** `AI_TEXT_PROVIDER` (production: `bailian-qwen`), `BAILIAN_QWEN_API_KEY` / `BAILIAN_QWEN_BASE_URL` / `BAILIAN_QWEN_MODEL` for the Qwen family; `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` for the DeepSeek family (the first passes and small tasks run there). Plus the per-stage `PRIMARY_*_MODEL` / `*_REASONING_EFFORT` / `*_THINKING_ENABLED` overrides — see the tier table above, they are not uniform.
- **Adapters:** `GLM_API_KEY` + `GLM_VISION_ENABLED` (tongue vision — enabled unless explicitly `false`; a missing key fails strict health rather than disabling the feature), `EVIMED_API_KEY` / `EVIMED_EVIDENCE_API_KEY` / `EVIMED_GUIDE_API_KEY` (evidence). Both are strict-health dependencies, so neither is truly optional in production.
- **Auth:** `CDSS_API_TOKEN`, `CDSS_REQUIRE_API_AUTH` (default `true`), `CDSS_TRUST_PROXY_HEADERS` (only behind a trusted header-scrubbing proxy — it keys the rate limiters).
- **Crypto (required, and gated by `health?strict=1`):** `CASE_SNAPSHOT_ENCRYPTION_KEY` must be its own random secret, never reused from the access token or a model key; `REASONING_CONTRACT_SIGNING_KEY` signs the reasoning contract.
- **Removed 2026-09-25 (ignored if still set in an old override):** `CDSS_GATE_DISPOSITION`, `RXAI_AUDIT_*`, `RXAI_QUERY_*`, `CDSS_SHOW_RX_AUDIT_SECTION`, `CDSS_CLINICAL_FACTS_REVIEW`, `CLINICAL_FACTS_REVIEW_MODEL`, `CLINICAL_FACTS_ADJUDICATION_MODEL`, `STRUCTURED_QUALITY_REPAIR_ROUNDS`, `PRIMARY_REVIEW_MODEL`, `M02_QUESTION_REVIEW_TIMEOUT_MS`. Suites pin that they are not forwarded by compose or documented in `.env.example`.
- **Security baseline:** the auth cookie is httpOnly (+ Secure in production); login and API are rate-limited; snapshots are encrypted and owner-bound; PHI quasi-identifiers go through `phi-sanitizer.ts` before any model call; prompt-injection defense has its own suite (`test:prompt-injection-defense`).
