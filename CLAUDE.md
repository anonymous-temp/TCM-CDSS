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

`npm run test:deterministic` (`scripts/run-deterministic-regression.mjs`) chains the registered `test:*` suites — the array in that file is the registry. **Before the first suite it fails loudly if any `test:*` npm script is neither registered nor listed with a reason in its `NOT_IN_GATE` table** (the runner itself, `*-live` suites), and if a suite reads `artifacts/` or a `src` file gains an `artifacts/runtime` default path without being declared in `scripts/lib/gate-local-state.mjs`. `--list` runs only those checks and prints the selection; `--only=test:a,test:b` runs a subset. It spawns each via `npm run`, fails fast on the first non-zero exit, scrubs inherited `RXAI_AUDIT_*` env vars so a stray shell override can't leak into a child suite, and points each suite's runtime state (terminology cache, drug inventory, customer registry, tenant audit — `cwd/artifacts/runtime/*` by default) at a fresh temp dir, so files left on this machine can't leak into results (two suites used to append to the checkout's `tenant-audit.ndjson` and fail when it was unusable). Its per-entry comments are the best available changelog of which customer defect each suite pins — read them before deleting or weakening an assertion.

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
| `health`, `model-health`, `tcm-knowledge/search`, `tcm-knowledge/herb-function` | — | Status/health + local KB search. Note `health` is under `/api/diagnosis/`, `model-health` is top-level `/api/model-health`. `health?strict=1` returns `strictReady` and **503s when false** — it ANDs model + evidence + tongue-vision-if-required + rx-audit + snapshot encryption + reasoning signing + clinical-facts + TCM-treatment config + controlled terminology + syndrome-hypothesis rerank + **rate-limit identity** (that last one is why prod must set `CDSS_TRUST_PROXY_HEADERS` behind a header-scrubbing proxy). `strict=1` also fires **live probes** of evidence / facts / tongue-vision / rx-audit / terminology in parallel, so it is slow and costs real upstream calls. Docker's healthcheck hits the **non-strict** form by default (live probes paused 2026-09-20: a strict call every 60 s cost ~1000 upstream model calls a day). Non-strict still computes `strictReady` from configuration, so a new unconfigured dependency still marks the container unhealthy; the live check happens at deploy time via `verify:deployed-image`. `CDSS_HEALTHCHECK_LIVE_PROBES=true` restores live probes. `model-health?check=1` does a live model call |
| `auth/access` | — | Token → UI cookie login; timing-safe compare, rate-limited (8 fails / 10-min lock) |

### Model / streaming layer — `src/lib/diagnosis-api.ts`

`callDiagnosisStream(prompt, backend, images, kind)` is the single entry point. Backends: `deepseek`/`openai` → primary OpenAI-compatible model; `glm` → GLM vision (tongue-image extraction only). EviMed is not a model backend; it is injected separately as multi-source evidence context in M03/M04 prompts.

- **Per-stage models (see `.env.example`; owner decision 2026-09-19: Qwen two tiers only, `qwen3.8-flash` + `qwen3.8-max`; owner 2026-09-24: first passes move to `deepseek-flash` behind a strict-schema net).** The provider is `AI_TEXT_PROVIDER=bailian-qwen` (DashScope compatible-mode). Production sets every model variable explicitly in the release override (`artifacts/tencent-release-20260919-qwen38/release-ops/production.override.yml` on the host), so the runtime env's leftover values do not leak in. History: 2026-09-11→09-19 production ran every text phase on `deepseek-flash`, whose `json_object` mode does not enforce the schema — the M03 Western half came back as misnested JSON on every case and the page showed the placeholder diagnosis. Both remaining tiers enforce strict JSON Schema; that is the reason for the switch back:

  | Phase | Model | Why |
  |---|---|---|
  | **First passes: M02 追问, M03 both halves, M04** | **`deepseek-flash`** via `PRIMARY_QUESTION_MODEL` / `PRIMARY_DIAGNOSE_MODEL` / `PRIMARY_PRESCRIBE_MODEL`, with **`PRIMARY_STRUCTURED_FALLBACK_MODEL` = `qwen3.8-flash`** as the strict net | **Since 2026-09-24 (speed).** Paired replay of this week's real prompts, sent from the production host: Western half 24→8 s, TCM half 29→10 s, M04 27→11 s, M02 15→4 s; production p50 was M02 15.5 s / M03 43 s / M04 40 s, almost all Qwen decode (~60 tok/s vs DeepSeek ~200). DeepSeek only has `json_object`, which is what broke 9/11–9/19, so three things are load-bearing: ① the M03 halves get the **same provider schema** in the system message (`structuredOutputSchemaInstruction`; Western half 0/18 → 18/18 compliant, TCM half 12/18 → 18/18; M04 deliberately gets none — it went 14/14 → 11/14 with it) plus a restatement of the prompt's own per-axis `resolution` rule (DeepSeek otherwise writes `bounded` on all three axes in 16/18); ② the server validates every non-strict first pass against that same schema (`checkNonStrictStructuredContent`: completes only *trailing* missing brackets, clamps arrays over `maxItems` — zod would `.catch([])` the whole array — treats `""`/omitted nullable fields as absent, tolerates server-owned keys; anything else is a violation); ③ a violation, a connect failure or any non-2xx (402 included) regenerates **the same prompt** on the strict fallback (non-streamed), so the quality floor is the pre-change behaviour. Endpoints resolve per model family everywhere (`textModelConfigForModel`), so repair rounds and facts stay on DashScope. `health` reports `question/diagnose/prescribe_model_not_configured` per stage. Telemetry: `non-strict structured output violates provider schema`, `structured_strict_fallback`. Rollback = set the three stage variables back to `qwen3.8-flash`, no rebuild |
  | Medicine planner, M02 interpret | `BAILIAN_QWEN_MODEL` = `qwen3.8-flash` | Follow the provider base model |
  | **Small json_object tasks** (terminology, syndrome rerank, formula recall, polarity assist, M05 authoring) + M02 question review | **`deepseek-flash`** via `CONTROLLED_TERMINOLOGY_MODEL` / `PRIMARY_REVIEW_MODEL` | **Cross-provider since 2026-09-20.** These never needed strict JSON Schema, and DeepSeek decodes 2–5× faster. Same-machine, same-window A/B on real prompts: terminology 6673→1354 ms, syndrome rerank 5549→984 ms, M05 authoring 9587→4163 ms, M02 review ~5000→1150 ms; 154–215 tok/s vs 8–61. Clinical fields identical. **Both terminology normalization and M02 review now make one call** (owner 2026-09-20): they used to send the byte-identical prompt twice at temperature 0 and take agreement/union — a second draw of the same lottery at double the cost. Terminology still enforces closed-set IDs, the confidence floor and abstention (`validatedClosedSetDecision`); mappings remain suggestions pending clinician confirmation. `textModelConfigForModel` resolves endpoint+key **by model family**, so a DeepSeek model never rides the DashScope endpoint; a family that is not fully configured is **fail-closed** and each task falls back to its deterministic result. Rollback is one env var back to `qwen3.8-flash`, no rebuild. Note `health?strict=1` now probes DeepSeek too, so a DeepSeek outage marks the container unhealthy even though clinical generation is unaffected |
  | M03 strict fallback (both parallel halves) | `qwen3.8-flash` | Thinking disabled, strict JSON Schema. The provider schema also pins 8 clinically mandatory arrays to `minItems:1` (`requireGeneratedM03Content` in `model-response-format.ts`): without it strict decoding returned 主证候依据/病名与证候鉴别/病位/病性/子治法/待核实信息 empty in most runs while marking them `resolved` (paired replay 2026-09-19). `qwen3.7-flash` is **not** a rollback — it has no strict mode |
  | M03/M04 repair rounds | `qwen3.8-max` | Rare paths; quality decides the outcome. (With a Qwen first pass, the M04 transport fallback is `PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL` = max; with a DeepSeek first pass it is the strict fallback) |
  | Independent review | **removed 2026-09-16** | The M03/M04 second-model reviewer was deleted by owner decision: in production it was the same model as the generator at low reasoning effort (median 1.4 s), demanded repair 84% of the time, and withheld dose on candidates that passed every deterministic contract (15/35 M04 runs, `contractIssues=[]`), with no measurable benefit anywhere. `reviewM03DiagnosticCriteria` / `reviewM04ClinicalPlan` are now no-request stubs; `clinicalReview` in the signed payload is a constant `unavailable/not_configured` attestation kept for contract compatibility. The pure prompt/parse modules (`m03-diagnostic-review.ts`, `m04-clinical-review.ts`) remain as dead code pending a sweep |
  | Clinical facts | `qwen3.8-max` extraction; **review phase off by default since 2026-09-20** (`CDSS_CLINICAL_FACTS_REVIEW=true` re-enables it) | Extractor tier chosen from full golden-baseline runs on 2026-09-19 (flash extraction missed spoken-language risks such as `advisory-low-temp-35-5`). Review was then measured on 198 unique golden cases: extract-only vs extract+review differed on **zero** safety-gate inputs (additive red flags, priority items, encounter scope); the 5 textual differences were already covered by the deterministic gate. It cost ~3.6 s per cold call, twice per patient. **Do not just flip the switch in a new code path:** the result is now `reviewStatus: "single_pass"`, and `clinicalFactsReviewSettled()` is the single predicate that the gate's emergency escalation, the screening-complete check, attestation signing, cache validation and the red-flags route all use. Before that predicate existed, `skipped` meant "not complete": turning review off would have withheld dose from every case and demoted semantic emergencies to display-only. A downgrade such as `historical_or_stable_only` still needs two-pass `reviewAgreement === "agreed"`, so with review off it stays `unreviewed` and the case is treated as active (conservative) |

  DeepSeek credentials (`OPENAI_API_KEY` + `OPENAI_BASE_URL`) are the DeepSeek family's endpoint for every `deepseek-*` stage variable above; `AI_TEXT_PROVIDER` stays `bailian-qwen`. Moving the clinical-facts phases to DeepSeek is **not** safe (2026-09-11: 35.5 ℃ low temperature released dose). `isApprovedTextModel` = qwen\* ∪ deepseek\*. Clinical-facts review/adjudication phases remain separate requests; safety phases may add risk but can never erase or downgrade grounded risk. `reasoning_effort` / `thinking_enabled` remain per-stage controls, both defaulting OFF (reasoning-only streams are treated as errors).
- **GLM tongue vision is opt-*out*, and the two switches are not the same switch.** `glmVisionEnabled()` is `process.env.GLM_VISION_ENABLED !== "false"` — enabled by default, and `.env.example` / `docker-compose.yml` both pin `true` (a regression assertion enforces that). `GLM_API_KEY` does *not* gate the feature; a missing key means vision is still "required" but unconfigured, which fails `health?strict=1` (`tongue_vision_api_key_not_configured`) rather than quietly degrading. Only an explicit `GLM_VISION_ENABLED=false` rejects uploads and asks for manual entry. There is no silent fallback to the text model in any configuration.
- **NDJSON contract (shared by every backend and the deterministic responses):** `{"content":"…"}\n` per chunk, terminated by `{"content":"[END]"}\n`; errors as `{"error":"…"}\n`. Anything you add to the pipeline must speak this exact contract — `markdownNdjsonResponse()` wraps deterministic Markdown into it.
- **Critical reasoning-only-stream gotcha:** if a stream returns only `reasoning_content` and no `content`, that's treated as an error ("模型仅返回推理过程"). This is why `model-health?check=1` verifies *final content*, not just reasoning — a provider that only streams reasoning will fail health and every stage.
- Timeouts are enforced per-stream: connect 90s / idle 60s / total 180s, with upstream `AbortController` cancellation and a 5s client heartbeat that keeps the UI alive during provider reasoning.
- Provider config lives in `src/lib/text-model.ts` via `AI_TEXT_PROVIDER` (`openai-compatible` per `.env.example`; or `bailian-qwen`) — read it with `getPrimaryTextModelConfig()`.
- **M03/M04 have a whole-orchestration deadline on top of the per-stream timeouts** (`M03_ORCHESTRATION_DEADLINE_MS` / `M04_ORCHESTRATION_DEADLINE_MS` in `diagnosis-api.ts`, both default to **180s** as of 2026-08-28 (`d9ee8d4` raised the M04 code default from 120s to match what production had been running; clamped 60–180s, and a recorded M03 run already spends ~88s of its budget). Blowing the deadline — or re-injecting the same repair prompt twice (fixpoint) — finalizes into the existing signature-limited / non-dose contract instead of burning unbounded repair rounds. If you add a repair round, it must respect the deadline and be fixpoint-detectable. **M04 repairs are candidate-scoped since 2026-09-20:** when the rejection reason and every T1 finding in the same batch sit inside `candidate` (herbs, composition, dose, emperor, pairing, decoction), the repair asks only for `{candidate}` (`m04_candidate_patch` schema) and the server splices it back onto the previous raw proposal; patent/western medicines, modifications and non-pharma sections are kept byte-for-byte. Any T1 finding outside `candidate` still triggers a full rewrite. All production repair triggers observed so far were candidate-scoped.

### Deterministic safety is the load-bearing layer — `src/lib/diagnosis-safety.ts`

The model never decides safety. Stage routes call `withSafetyGate(caseState)` first; the gate deterministically parses vitals (BP/T/P/R/SpO2 with critical thresholds) and text for red flags and sets `allowDiagnosis` / `allowDosePrescription`.

**Disposition doctrine (owner decision 2026-08-01): detection never blocks.** There is one disposition (the `CDSS_GATE_DISPOSITION` switch and its `block` rollback mode were removed 2026-09-25): red flags / completeness / encounter-scope hits still run and are fully surfaced, but the routes proceed to full M03/M04 generation with a deterministic safety-advisory banner (`<!-- CDSS_SAFETY_ADVISORY -->`, built server-side from the gate result) prepended to the visible output. Same doctrine at the last mile of M03/M04 contracts: after repair exhaustion, quality-class findings become annotations (`m04-repair-policy.ts` is the single authority), and a non-dose/blank page is only allowed when there is genuinely nothing to show (no chief complaint, no signed M03, truncated output with no salvageable candidate). **剂量授权是另一根轴（2026-08-15 拆开）**：`CDSS_REDFLAG_DOSE_AUTHORIZATION` 默认 `withhold` —— 红旗未解除时 M04 只给非剂量内容；`allow` 是运维回退档，切回「红旗也照常出剂量方」。拆开的原因是实测缺陷：两轴绑在一个开关上时，为了「不阻断流程」而放行剂量会顺带放行儿科体重、妊娠阳性这些**与红旗无关**的独立硬边界（旧 advise 档下 6 岁儿童 + 红旗实测给出 `full_dose`）。独立硬边界不受任何一个开关影响；`test:redflag-dose-authorization` 两头都钉。 Per-herb hard rules (pharmacopoeia dose bounds, 十八反十九畏 as repair drivers, regulatory herb exclusion from auto-dose, PHI sanitization) are unchanged — "never block" governs disposition, not detection, and never silently treats "unknown" as "no risk".

- Always run `sanitizeCaseStateForModel` / `sanitizeFreeTextForModel` before sending case data to a model.
- Clinical facts use a status vocabulary (`positive/possible/negative/historical/unknown`) in `src/lib/clinical-state.ts`. **Do not treat "未提及/unknown" as negative** — generic "过敏史/用药史未提及" pollution is an explicitly tested false-positive class in the regression suite. When you fix one such false positive, extend coverage to the whole class, not just the one case.
- **Completeness** is deterministic and no model scores it: `deriveOperationalCompleteness` (`diagnosis-safety.ts`) scores the current record and `determineCompletenessLevel` (`diagnosis-types.ts`, the single copy) grades it — C requires `redFlag≥0.7` and other dims `≥0.6` (redFlag has the higher bar); any dim `<0.3` ⇒ A; else B. M02's emitted `completeness` object is written by the question route from that same function (since 2026-09-25; before, the M02 model self-scored it). Only level C proceeds to full diagnosis/prescription.
- **Semantic clinical-facts backstop (`src/lib/clinical-facts.ts` + `clinical-facts-runtime.ts`):** an **additive-only** model-derived layer that supplements spoken-language red flags / follow-up clues; **on by default** (disable with `CDSS_CLINICAL_FACTS_BACKSTOP=false`). It may only *add* urgent advisories — never cancel a deterministic positive red flag or a critical vital. `additiveRedFlagsFromFacts` / `priorityEvaluationItemsFromFacts` feed the gate; schema-invalid entries are isolated so a fabricated item cannot erase a valid one in the same output.
- **Client orchestration** lives in `src/lib/diagnosis-engine.ts` (browser localStorage case persistence keyed `diagnosis_case_*`, stream consume with its own idle/total timeouts + `AbortController`) consumed by `DiagnosisClient.tsx`. It is client-side flow glue, not a server pipeline — the server routes stay thin.

### Knowledge base — `src/lib/tcm-knowledge.ts` + `src/data/tcm-knowledge.json`

The 48k-line JSON is a **generated build artifact** — do not hand-edit it. `scripts/build-tcm-knowledge.mjs` compiles it from CSV/JSON sources in a **sibling `合理用药` repo** (`../../合理用药/…`, overridable via `RXAI_DATA_ROOT` / `RXAI_RELEASE_ROOT`); without those sources the rebuild can't run. It carries dose limits, 十八反十九畏 incompatibilities, special-population rules, decoction methods, herb-risk categories, patent-medicine & western-interaction rules, and HIS alias/spec mappings. The local knowledge layer is evidence/context support and legacy parsing only; post-prescription safety authority is the Lingxi unified audit path in `src/lib/rxaudit.ts`, and unavailable audit must fail closed to doctor/pharmacist review.

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
