# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> **Next.js 16 — read before writing framework code.** Per AGENTS.md, this is not the Next.js in your training data. The bundled docs are the source of truth: `node_modules/next/dist/docs/` (e.g. `01-app/01-getting-started/16-proxy.md`, `01-app/04-glossary.md`). The most consequential rename here: **there is no `middleware.ts`** — request gating lives in `src/proxy.ts`, which exports `proxy()` + `config.matcher`.
>
> **Where AGENTS.md and this file disagree, this file wins.** (The two known 2026-08 drifts — M03/M04 deadline values and the `typecheck` NODE_OPTIONS requirement — were fixed in AGENTS.md on 2026-08-13; if you spot a new contradiction, fix AGENTS.md rather than working around it.)

## What this is

中医 CDSS — an outpatient Traditional Chinese Medicine clinical decision support "copilot". A doctor enters a case (一诉五史 / vitals / 四诊 / labs); the system does red-flag screening, gap-driven follow-up, western + TCM diagnosis, pathogenesis breakdown, candidate herbal/patent-medicine prescriptions, prescription-risk warnings, and follow-up planning. It is **advisory only** — every conclusion must trace to a patient fact, a deterministic rule hit, or a knowledge-base/evidence entry, or be explicitly marked "证据不足/待检索". Never let the model output hard verdicts, fabricated citations, or bypass the deterministic safety layer.

## Commands

```bash
npm run dev                 # next dev (Turbopack); root → /diagnosis; login at /login
npm run build && npm start  # standalone production build + serve
npm run lint                # eslint --max-warnings=0 — warnings fail, treat them as errors
npm run typecheck           # tsc --noEmit — run this after edits to src/lib
npm run verify:release      # THE release gate: typecheck + lint + test:deterministic + test:deterministic:fresh + build
npm run build:tcm-knowledge # regenerate src/data/tcm-knowledge.json (needs external CSVs, see below)
# Pure unit tests — no server needed; they exercise the deterministic safety/facts/contract layer.
# All live under scripts/test-*.mjs via jiti (TS imports) or node --test / --experimental-strip-types.
npm run test:deterministic        # chains all deterministic suites in order; the default pre-change gate (~minutes)
npm run test:deterministic:fresh  # 同一套闸门，但屏蔽本机 artifacts/（CDSS_IGNORE_LOCAL_ARTIFACTS=1）
                                  # 几条套件会「本机若有归档则一并扫描」，于是同一提交可能
                                  # fresh clone 绿、留有归档的机器红。2026-08-15 实测踩过一次
                                  # 并带着红上线，故 verify:release 两态各跑一次。
npm run test:safety-mutations     # ONE suite — this is how you run a single test
npx jiti scripts/test-safety-mutation-matrix.mjs   # same suite, bypassing npm (faster iteration)
npm run test:clinical-facts       # clinical-facts.ts additive backstop + schema rejects
npm run test:stage-contract       # M03/M04 structured-stream contracts + sentinel boundaries
npm run test:rxaudit-contract     # rxaudit normalize/payload contract
npm run test:stream-safety        # diagnosis-structured-repair (sentinel-aware repair)
npm run test:gi-alarm-features    # 上消化道警示征象 + 咖啡样呕吐物构词式；含一条 M02↔安全门防漂移断言
npm run test:colloquial-redflag   # 口语化表述的红旗覆盖（卒中口语走硬门 / 出血口语走提示档）
# Live HTTP regressions — REQUIRES A RUNNING SERVER and matching CDSS_API_TOKEN.
npm run regress:tcm-cdss    # golden-case regression harness (100+ requests, see below)
npm run regress:robustness  # 真实公开医案压测；断点续跑，REEVALUATE=1 可离线重评已落盘结果
npm run regress:incompatibility  # 药味工作台改方后重新审方：十八反类别展开 / 超药典上限 / 阴性对照
```

There is **no jest/vitest/playwright config**, but the deterministic layer has a real unit-test suite: **180 scripts under `scripts/test-*.mjs`, wired to 181 `test:*` npm scripts (177 in the gate registry; counts as of 2026-08-27, growing with every pinned defect)**, that import `src/lib/*.ts` directly (via `jiti`, or `node --test` / `--experimental-strip-types`) and assert with `node:assert`. They need no server. **There is no name filter and no watch mode** — a single suite is just its own npm script (`npm run test:<name>`), which is what you should run while iterating; save the full chain for the end.

`npm run test:deterministic` (`scripts/run-deterministic-regression.mjs`) chains **every** `test:*` script except itself — the array in that file is the registry, so **a new `test:*` npm script is not in the gate until you add it there**. It spawns each via `npm run`, fails fast on the first non-zero exit, and scrubs inherited `RXAI_AUDIT_*` env vars so a stray shell override can't leak into a child suite. Its per-entry comments are the best available changelog of which customer defect each suite pins — read them before deleting or weakening an assertion.

The **live** HTTP safety net is `scripts/regress-tcm-cdss.mjs` — start `npm run dev` (or a prod server) first, then:

```bash
BASE_URL=http://localhost:3000 CDSS_API_TOKEN=<token> npm run regress:tcm-cdss
```

It fires 100+ requests, asserts on red-flag handling, negated history, safety-net false-positive avoidance, post-prescription risk, KB search, boundary inputs and auth bootstrap, prints a JSON summary, and exits 1 on any failure. `CDSS_API_TOKEN` must match the server's, or auth-gated routes 401. Treat this as the golden baseline: run it before and after any change to the diagnosis pipeline or safety layer.

## Architecture

### Current reality vs. the docs — read this first

`docs/*.md` describe an **aspirational LangGraph/ReAct rebuild** (`/api/tcm-cdss/run`, SSE, a unified `TcmCdssAiSupportPayload`, structured-JSON prescriptions). **None of that is built.** The current implementation is a **linear M01–M05 pipeline** streaming Markdown+NDJSON, with the frontend doing flow orchestration. The docs themselves say (§20) not to mistake the compatibility layer for the target. When a doc type/endpoint doesn't exist in `src/`, it's a target spec, not something to call.

### Request flow

`src/app/diagnosis/DiagnosisClient.tsx` (a ~9.7k-line client component) drives the whole clinical flow and calls the stage routes under `src/app/api/diagnosis/`. Routes are thin — validate → deterministic safety gate → build prompt → stream — with all logic in `src/lib/`.

| Route | Stage | Notes |
|---|---|---|
| `collect` | M01 | Structure free text; tongue image → **GLM vision**, which is **on unless `GLM_VISION_ENABLED=false`**. Only that explicit opt-out rejects uploads — there is never a silent fallback to the text model |
| `question` | M02 | Generate follow-up questions (primary model) |
| `question/interpret` | M02 | Deterministically interpret a doctor's free-text answers into structured status updates |
| `diagnose` | M03 | Western dx + TCM syndrome + pathogenesis; gated by safety + completeness=C; attaches the clinical-facts backstop first |
| `prescribe` | M04 | Herbal prescription; also requires an actionable M03 diagnosis |
| `assess` | M05 | **Split as of 2026-08-10.** The *safety verdict* (最高提示强度 / 综合风险判断 / 评级依据 / 医生需确认事项) stays fully deterministic off the Lingxi post-prescription review — the model never writes a risk verdict. The *clinical content* (复诊评估重点 / 疗效评价口径 / 生活管理 / 六维里挑哪几维) is now model-authored per case via `m05-followup-authoring.server.ts`, validated against a governed prohibition table (`tcm-patient-instruction-prohibitions.source.json`) plus the reused `PRECAUTION_DOSE_LIKE`, falling back verbatim to the old template on any failure. Before this, 生活管理 was one hardcoded sentence identical for every patient and `sixHealthFollowupTable()` took no arguments. The route also runs `maybeAttachClinicalFactsBackstop`, which calls the model — so "M05 makes no LLM calls" was never accurate and is now doubly wrong |
| `red-flags` | — | Deterministic red-flag / safety summary for the current case state |
| `post-prescription-risk` | — | Lingxi unified rx-audit JSON; fail-closed with manual-review lock when unavailable or missing structured herbs |
| `emergency-clearance` | — | Doctor explicitly clears an urgent-disposition hold (`emergency-clearance.server.ts`); the clearance is validated + re-stripped on every subsequent read, so a stale/forged one can't ride along in `caseState` |
| `terminology/confirm` | — | Doctor confirms one controlled-vocabulary mapping (`tcm_syndrome` / `icd10` **only** — other namespaces are rejected by name, not silently ignored) |
| `snapshot` | — | Encrypted case-state snapshot (AES-256-GCM, `CASE_SNAPSHOT_ENCRYPTION_KEY`); binds auth to snapshot owner |
| `his-scheme` | — | Builds HIS "AI 诊疗支持方案" JSON (`src/lib/his-scheme.ts`) |
| `health`, `model-health`, `tcm-knowledge/search`, `tcm-knowledge/herb-function` | — | Status/health + local KB search. Note `health` is under `/api/diagnosis/`, `model-health` is top-level `/api/model-health`. `health?strict=1` returns `strictReady` and **503s when false** — it ANDs model + clinical reviewer + evidence + tongue-vision-if-required + rx-audit + snapshot encryption + reasoning signing + clinical-facts + TCM-treatment config + controlled terminology + syndrome-hypothesis rerank + **rate-limit identity** (that last one is why prod must set `CDSS_TRUST_PROXY_HEADERS` behind a header-scrubbing proxy). `strict=1` also fires **live probes** of evidence / reviewer / facts / tongue-vision / rx-audit / terminology in parallel, so it is slow and costs real upstream calls. Docker's healthcheck hits it, so a new unconfigured dependency here blocks deploys. `model-health?check=1` does a live model call |
| `auth/access` | — | Token → UI cookie login; timing-safe compare, rate-limited (8 fails / 10-min lock) |

### Model / streaming layer — `src/lib/diagnosis-api.ts`

`callDiagnosisStream(prompt, backend, images, kind)` is the single entry point. Backends: `deepseek`/`openai` → primary OpenAI-compatible model; `glm` → GLM vision (tongue-image extraction only). EviMed is not a model backend; it is injected separately as multi-source evidence context in M03/M04 prompts.

- **Per-stage models (see `.env.example`; verified against production env + 30h of `model_usage` telemetry on 2026-08-27).** The provider is `AI_TEXT_PROVIDER=bailian-qwen` (DashScope compatible-mode), and the tiers are **not** uniform — each is a deliberate, drilled trade-off:

  | Phase | Model | Why |
  |---|---|---|
  | M02 追问 | `BAILIAN_QWEN_MODEL` (`qwen3.7-plus`) | M02 has no `PRIMARY_QUESTION_MODEL`; it follows the provider base model |
  | **M03 first pass** | **`qwen3.8-flash`** | Owner-selected production model since 2026-08-28. It runs with thinking disabled and strict JSON Schema; keep `qwen3.7-flash` as the single-variable rollback and re-run the production drill before any further change |
  | M04 first pass | `qwen3.7-plus`, `reasoning_effort=medium` | M04 builds selection/dose/君臣佐使/pathogenesis binding from scratch — strictly harder than a repair round, so it must not sit below the repair tier |
  | M03/M04 repair rounds | `qwen3.8-max` | Rare path; quality decides the outcome |
  | Independent review | M03 → `qwen3.7-plus`, M04 → `qwen3.8-max` (both fall back to Plus) | Reviewer identity differs from the generator ⇒ `independentFromGenerator=true` without a second vendor |
  | Clinical facts | extract `qwen3.7-flash` / review `qwen3.8-max` / adjudicate `qwen3.7-plus` | Makes `independentReview` and `independentAdjudication` both true |

  DeepSeek (`OPENAI_MODEL=deepseek-v4-flash` + `OPENAI_BASE_URL`) stays configured as the **wholesale rollback tier** — set `AI_TEXT_PROVIDER=openai-compatible` to switch the whole chain back. It is not active in production. `isApprovedTextModel` = qwen\* ∪ deepseek\*. Review phases remain separate requests with review-only prompts and no generator conversation state; safety phases may add risk but can never erase or downgrade grounded risk. `reasoning_effort` / `thinking_enabled` remain per-stage controls, both defaulting OFF (reasoning-only streams are treated as errors).
- **GLM tongue vision is opt-*out*, and the two switches are not the same switch.** `glmVisionEnabled()` is `process.env.GLM_VISION_ENABLED !== "false"` — enabled by default, and `.env.example` / `docker-compose.yml` both pin `true` (a regression assertion enforces that). `GLM_API_KEY` does *not* gate the feature; a missing key means vision is still "required" but unconfigured, which fails `health?strict=1` (`tongue_vision_api_key_not_configured`) rather than quietly degrading. Only an explicit `GLM_VISION_ENABLED=false` rejects uploads and asks for manual entry. There is no silent fallback to the text model in any configuration.
- **NDJSON contract (shared by every backend and the deterministic responses):** `{"content":"…"}\n` per chunk, terminated by `{"content":"[END]"}\n`; errors as `{"error":"…"}\n`. Anything you add to the pipeline must speak this exact contract — `markdownNdjsonResponse()` wraps deterministic Markdown into it.
- **Critical reasoning-only-stream gotcha:** if a stream returns only `reasoning_content` and no `content`, that's treated as an error ("模型仅返回推理过程"). This is why `model-health?check=1` verifies *final content*, not just reasoning — a provider that only streams reasoning will fail health and every stage.
- Timeouts are enforced per-stream: connect 90s / idle 60s / total 180s, with upstream `AbortController` cancellation and a 5s client heartbeat that keeps the UI alive during provider reasoning.
- Provider config lives in `src/lib/text-model.ts` via `AI_TEXT_PROVIDER` (`openai-compatible` per `.env.example`; or `bailian-qwen`) — read it with `getPrimaryTextModelConfig()`.
- **M03/M04 have a whole-orchestration deadline on top of the per-stream timeouts** (`M03_ORCHESTRATION_DEADLINE_MS` / `M04_ORCHESTRATION_DEADLINE_MS` in `diagnosis-api.ts`, both default to **180s** as of 2026-08-28 (`d9ee8d4` raised the M04 code default from 120s to match what production had been running; clamped 60–180s, and a recorded M03 run already spends ~88s of its budget). Blowing the deadline — or re-injecting the same repair prompt twice (fixpoint) — finalizes into the existing signature-limited / non-dose contract instead of burning unbounded repair rounds. If you add a repair round, it must respect the deadline and be fixpoint-detectable.

### Deterministic safety is the load-bearing layer — `src/lib/diagnosis-safety.ts`

The model never decides safety. Stage routes call `withSafetyGate(caseState)` first; the gate deterministically parses vitals (BP/T/P/R/SpO2 with critical thresholds) and text for red flags and sets `allowDiagnosis` / `allowDosePrescription`.

**Disposition doctrine (owner decision 2026-08-01): detection never blocks.** `CDSS_GATE_DISPOSITION` defaults to `advise`: red flags / completeness / encounter-scope hits still run and are fully surfaced, but the routes proceed to full M03/M04 generation with a deterministic safety-advisory banner (`<!-- CDSS_SAFETY_ADVISORY -->`, built server-side from the gate result) prepended to the visible output. Same doctrine at the last mile of M03/M04 contracts: after repair exhaustion, quality-class findings become annotations (`m04-repair-policy.ts` is the single authority), and a non-dose/blank page is only allowed when there is genuinely nothing to show (no chief complaint, no signed M03, truncated output with no salvageable candidate). `block` restores the old fail-closed interception for ops rollback; the unit suites that exercise gate mechanics pin that mode explicitly. **剂量授权是另一根轴（2026-08-15 拆开）**：`CDSS_REDFLAG_DOSE_AUTHORIZATION` 默认 `withhold` —— 红旗未解除时 M04 只给非剂量内容；`allow` 是运维回退档，切回「红旗也照常出剂量方」。拆开的原因是实测缺陷：两轴绑在一个开关上时，为了「不阻断流程」而放行剂量会顺带放行儿科体重、妊娠阳性这些**与红旗无关**的独立硬边界（旧 advise 档下 6 岁儿童 + 红旗实测给出 `full_dose`）。独立硬边界不受任何一个开关影响；`test:redflag-dose-authorization` 两头都钉。 Per-herb hard rules (pharmacopoeia dose bounds, 十八反十九畏 as repair drivers, regulatory herb exclusion from auto-dose, PHI sanitization) are unchanged — "never block" governs disposition, not detection, and never silently treats "unknown" as "no risk".

- Always run `sanitizeCaseStateForModel` / `sanitizeFreeTextForModel` before sending case data to a model.
- Clinical facts use a status vocabulary (`positive/possible/negative/historical/unknown`) in `src/lib/clinical-state.ts`. **Do not treat "未提及/unknown" as negative** — generic "过敏史/用药史未提及" pollution is an explicitly tested false-positive class in the regression suite. When you fix one such false positive, extend coverage to the whole class, not just the one case.
- **Completeness** (`src/lib/diagnosis-parse.ts`): the model embeds structured JSON in the stream between `<!-- DIAGNOSIS_JSON_START -->` / `<!-- DIAGNOSIS_JSON_END -->` sentinels (injected via `SENTINEL_INSTRUCTION` in `diagnosis-prompts.ts`). `determineCompletenessLevel` **recomputes the level in code and overrides the model's** — C requires `redFlag≥0.7` and other dims `≥0.6` (redFlag has the higher bar); any dim `<0.3` ⇒ A; else B. Only level C proceeds to full diagnosis/prescription.
- **Semantic clinical-facts backstop (`src/lib/clinical-facts.ts` + `clinical-facts-runtime.ts`):** an **additive-only** model-derived layer that supplements spoken-language red flags / follow-up clues; **on by default** (disable with `CDSS_CLINICAL_FACTS_BACKSTOP=false`). It may only *add* urgent advisories — never cancel a deterministic positive red flag or a critical vital. `additiveRedFlagsFromFacts` / `priorityEvaluationItemsFromFacts` feed the gate; schema-invalid entries are isolated so a fabricated item cannot erase a valid one in the same output.
- **Client orchestration** lives in `src/lib/diagnosis-engine.ts` (browser localStorage case persistence keyed `diagnosis_case_*`, stream consume with its own idle/total timeouts + `AbortController`) consumed by `DiagnosisClient.tsx`. It is client-side flow glue, not a server pipeline — the server routes stay thin.

### Knowledge base — `src/lib/tcm-knowledge.ts` + `src/data/tcm-knowledge.json`

The 48k-line JSON is a **generated build artifact** — do not hand-edit it. `scripts/build-tcm-knowledge.mjs` compiles it from CSV/JSON sources in a **sibling `合理用药` repo** (`../../合理用药/…`, overridable via `RXAI_DATA_ROOT` / `RXAI_RELEASE_ROOT`); without those sources the rebuild can't run. It carries dose limits, 十八反十九畏 incompatibilities, special-population rules, decoction methods, herb-risk categories, patent-medicine & western-interaction rules, and HIS alias/spec mappings. The local knowledge layer is evidence/context support and legacy parsing only; post-prescription safety authority is the Lingxi unified audit path in `src/lib/rxaudit.ts`, and unavailable audit must fail closed to doctor/pharmacist review.

### Auth — `src/proxy.ts` + `src/lib/cdss-auth.ts`

`proxy()` gates `/`, `/diagnosis`, `/api/:path*`. Auth is on when `CDSS_REQUIRE_API_AUTH=true`, in production, or whenever `CDSS_API_TOKEN` is set. API callers send `x-cdss-api-token` or `Authorization: Bearer <token>`; browsers get an httpOnly cookie `tcm_cdss_ui_access` = `SHA-256("tcm-cdss-ui:"+token)` from `/api/auth/access`. `proxy()` also rate-limits model-calling routes (`CDSS_MODEL_RATE_LIMIT_PER_10_MIN`, default 60 per 10 min) — the bucket is **in-memory and assumes a single instance**, so horizontal scaling would silently multiply the real limit. If you add API routes, keep them under the matcher and never introduce an unauthenticated bypass.

### Deploy, and proving what's actually running

This exists because of a real failure mode: local regressions were green while production behaved the opposite way, and there was no way to tell "the fix is wrong" from "the fix never shipped." The chain that makes that decidable:

```bash
node scripts/build-source-digest.mjs      # npm run build:source-digest
IMAGE_TAG=<immutable-tag> ./scripts/deploy-prod.sh
BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=… npm run verify:deployed-image
BASE_URL=… CDSS_API_TOKEN=… npm run regress:prod-smoke
```

- `build-source-digest.mjs` hashes only **clinical-behavior** files — `src/lib`, `src/app/api`, `src/data` — deliberately excluding docs/tests, so editing this file doesn't move the digest but editing one line of safety logic does. It's baked in at build time via `CDSS_BUILD_COMMIT` / `CDSS_BUILD_SOURCE_DIGEST` / `CDSS_BUILD_TIMESTAMP` build args and echoed back by `/api/diagnosis/health`.
- `verify:deployed-image` recomputes the digest locally and compares. **Non-zero exit means the deploy failed, including "couldn't prove it"** — don't debug source until it's zero.
- `scripts/deploy-prod.sh` carries five hard-won constraints in its header comment (whitelist rsync — the repo root holds 4.6GB of data assets and blacklisting took two hours per sync; `--env-file` not `source`; prune before build; explicit `-p tcm-cdss-prod`; never `| tail` away an exit code). Read them before editing it. It lives in the repo precisely because a `/tmp` copy was once lost.

### 本机执行纪律（2026-08-16 实测，各栽过 ≥2 次）

- **改了 `src/lib/diagnosis-safety.ts` / `diagnosis-types.ts` 之后，生成器和闸门必须一起发。**
  这两个文件的摘要在受治理来源注册表里，不重跑
  `build-clinical-governance-static-tables.mjs` + `build-tcm-governance-tables.py`，
  `test:clinical-governance-tables` 必红（「表内 … 实际 …」指纹分叉）。同一天栽两次。
- **闸门不能与工作流/dev server 并发。** 6G 内存，`test:deterministic` 自带
  `--max-old-space-size=8192`；并发时闸门进程被内存回收直接杀掉，**日志为空、无退出码**——
  这与「跑完了但没写标记」长得一模一样，别把它当成绿。判别：`ps` 里进程没了且日志 0 行 ⇒ 被杀。
- **源码级断言必须自带越界守卫。** 用 `indexOf("};")` 切对象字面量会切过头到下一张表，
  于是「从第一张表里删一项」照样能在第二张表里找到，断言静默空转。
  本仓多个对象以 `} as const;` 结尾。可靠信号是**去重后数量变少**，加一条 Set 大小断言。
- **每条新断言都要跑反证。** 今天 3 条断言写完是绿的、反证一跑才发现抓不住；
  另有 3 次「照推断直接改」全部改错（判分器关键词、sentinel 丢失、finalize 硬拦 T2）。
  这个代码库判据链很长，读代码形成的直觉可靠度低——以日志与实测数字为准。

## Conventions & gotchas

- **Imports:** `@/*` → `src/*` (tsconfig paths). Match the existing thin-route / logic-in-`lib` split; keep routes validating + streaming only.
- **Open-language detection freeze:** for colloquial red flags, polarity/negation, encounter scope, symptom confirmation, and terminology normalization, a new miss or false positive must produce a governed category example, class-level parity regression with negative controls, and a layer-attribution note. Iterate the semantic prompt by default; do not add a one-phrase surface regex. Deterministic regex additions are limited to numeric thresholds, finite closed sets, and morphological/lexical guards, and the commit must name the applicable exception.
- **`src/lib/*.server.ts` is a real boundary, not a suffix.** ~14 modules (`emergency-clearance.server.ts`, `m02-answer-interpreter.server.ts`, `icd10-diagnosis-coding.server.ts`, `tcm-classic-evidence.server.ts`, …) are server-only — they read env/secrets, call models, or load governed data. `DiagnosisClient.tsx` is a client component; keep it out of these. New server-only logic gets the suffix.
- **Everything is fail-closed and evidence-bound.** Don't add model calls that emit dose-level prescriptions, guideline/DOI citations, or risk verdicts without a deterministic rule or KB entry behind them.
- **`NEXT_PUBLIC_BASE_PATH`** lets the app mount under a sub-path; it's threaded through `next.config.ts`, `cdss-auth.ts` and `proxy.ts` — respect it when building URLs/redirects.
- **Build/deploy:** `output:"standalone"` (`next.config.ts`); `Dockerfile` + `docker-compose.yml` build the standalone image and pass the env below. `.env*` is gitignored.
- New request bodies go through `readJsonBodyWithLimit` / `readCaseStateRequest` (`src/lib/http-guard.ts`, `diagnosis-request.ts`) for size caps and 413/400 handling — reuse them.
- **Not application source.** In tsconfig `exclude`: `artifacts/`, `deeptest/`, `test-results/` (eval output that churns in `git status`; the latter two may not exist on disk at any given moment) and the vendored `open-code-review-main/`. Also outside the app: `uploads/` (customer-supplied evaluation docs — untracked *and* un-gitignored, so it shows up dirty), and the ~4.6GB of build inputs in `中医补充数据/` (2.3G), `药学基础数据/` (2.3G), `参考/` (150M) — gitignored, kept out of the image, and inventoried by `src/data/external-data-manifest.json` (regenerate with `node scripts/build-external-data-manifest.mjs`; check it before trusting an ingest on a new machine). Don't read any of these for architecture, don't "fix" them, and don't let their diffs into a change you're describing as source-only.
- **`src/data/*.json` are generated**, not hand-maintained — 74 files (as of 2026-08-27) (`tcm-knowledge.json`, `tcm-formula-sources.json`, lexicons, evidence corpora, retrieval indexes) come from the `build:*` / `import:*` scripts. Fix the generator, not the artifact. The `*.source.json` files are the curated inputs those generators consume — those *are* hand-edited, and editing one means re-running its build script.

## Environment variables

Set in `.env.local` (see `.env.example`, which annotates every key). **Never read or commit the real `.env.local` / `.env.development.local`.**

- **Primary model:** `AI_TEXT_PROVIDER` (production: `bailian-qwen`), `BAILIAN_QWEN_API_KEY` / `BAILIAN_QWEN_BASE_URL` / `BAILIAN_QWEN_MODEL` for the active path; `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` for the DeepSeek rollback tier. Plus the per-stage `PRIMARY_*_MODEL` / `*_REASONING_EFFORT` / `*_THINKING_ENABLED` overrides — see the tier table above, they are not uniform.
- **Adapters:** `GLM_API_KEY` + `GLM_VISION_ENABLED` (tongue vision — enabled unless explicitly `false`; a missing key fails strict health rather than disabling the feature), `EVIMED_API_KEY` / `EVIMED_EVIDENCE_API_KEY` / `EVIMED_GUIDE_API_KEY` (evidence). Both are strict-health dependencies, so neither is truly optional in production.
- **Auth:** `CDSS_API_TOKEN`, `CDSS_REQUIRE_API_AUTH` (default `true`), `CDSS_TRUST_PROXY_HEADERS` (only behind a trusted header-scrubbing proxy — it keys the rate limiters).
- **Crypto (required, and gated by `health?strict=1`):** `CASE_SNAPSHOT_ENCRYPTION_KEY` must be its own random secret, never reused from the access token or a model key; `REASONING_CONTRACT_SIGNING_KEY` signs the reasoning contract.
- **Rx audit presentation:** `CDSS_SHOW_RX_AUDIT_SECTION` (default `false`). 合理用药审方是**独立交付的接口与产品页面**（owner 裁定 2026-08-28），CDSS 默认不重复呈现三方审方内容。这是**呈现**开关，不是检测开关：审方仍照常调用（遥测与 `health?strict=1` 依赖它），本地确定性检测（十八反十九畏、药典剂量边界、特殊人群）、病历质量提示（现用药无法可靠结构化、候选缺剂量）与 M05 确定性安全总评一律照出。
- **Rx audit:** `RXAI_AUDIT_*` (Lingxi). Audit results are advisory, but an unavailable audit falls back to human pharmacist review rather than hard-stopping the flow — *except* that missing structured herbs is fail-closed.
