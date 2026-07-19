# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> **Next.js 16 — read before writing framework code.** Per AGENTS.md, this is not the Next.js in your training data. The bundled docs are the source of truth: `node_modules/next/dist/docs/` (e.g. `01-app/01-getting-started/16-proxy.md`, `01-app/04-glossary.md`). The most consequential rename here: **there is no `middleware.ts`** — request gating lives in `src/proxy.ts`, which exports `proxy()` + `config.matcher`.

## What this is

中医 CDSS — an outpatient Traditional Chinese Medicine clinical decision support "copilot". A doctor enters a case (一诉五史 / vitals / 四诊 / labs); the system does red-flag screening, gap-driven follow-up, western + TCM diagnosis, pathogenesis breakdown, candidate herbal/patent-medicine prescriptions, prescription-risk warnings, and follow-up planning. It is **advisory only** — every conclusion must trace to a patient fact, a deterministic rule hit, or a knowledge-base/evidence entry, or be explicitly marked "证据不足/待检索". Never let the model output hard verdicts, fabricated citations, or bypass the deterministic safety layer.

## Commands

```bash
npm run dev                 # next dev (Turbopack); root → /diagnosis; login at /login
npm run build && npm start  # standalone production build + serve
npm run lint                # eslint (eslint-config-next)
npx tsc --noEmit            # typecheck — run this after edits to src/lib
npm run build:tcm-knowledge # regenerate src/data/tcm-knowledge.json (needs external CSVs, see below)
# Pure unit tests — no server needed; they exercise the deterministic safety/facts/contract layer.
# All live under scripts/test-*.mjs via jiti (TS imports) or node --test / --experimental-strip-types.
npm run test:safety-mutations     # diagnosis-safety.ts red-flag / pediatric-gate mutation matrix
npm run test:clinical-facts       # clinical-facts.ts additive backstop + schema rejects
npm run test:stage-contract       # M03/M04 structured-stream contracts + sentinel boundaries
npm run test:rxaudit-contract     # rxaudit normalize/payload contract
npm run test:stream-safety        # diagnosis-structured-repair (sentinel-aware repair)
# Live HTTP regressions — REQUIRES A RUNNING SERVER and matching CDSS_API_TOKEN.
npm run regress:tcm-cdss    # golden-case regression harness (100+ requests, see below)
```

There is **no jest/vitest/playwright config**, but the deterministic layer has a real unit-test suite: ~40 scripts in `scripts/test-*.mjs` that import `src/lib/*.ts` directly (via `jiti`, or `node --test` / `--experimental-strip-types`) and assert with `node:assert`. Run the relevant one after touching safety / facts / contracts / parsing — they need no server. Examples: `test:safety-mutations`, `test:clinical-facts`, `test:stage-contract`, `test:rxaudit-contract`, `test:m02-contract`, `test:clinical-polarity`, `test:prescription-permission`. The **live** HTTP safety net is `scripts/regress-tcm-cdss.mjs` — start `npm run dev` (or a prod server) first, then:

```bash
BASE_URL=http://localhost:3000 CDSS_API_TOKEN=<token> npm run regress:tcm-cdss
```

It fires 100+ requests, asserts on red-flag handling, negated history, safety-net false-positive avoidance, post-prescription risk, KB search, boundary inputs and auth bootstrap, prints a JSON summary, and exits 1 on any failure. `CDSS_API_TOKEN` must match the server's, or auth-gated routes 401. Treat this as the golden baseline: run it before and after any change to the diagnosis pipeline or safety layer.

## Architecture

### Current reality vs. the docs — read this first

`docs/*.md` describe an **aspirational LangGraph/ReAct rebuild** (`/api/tcm-cdss/run`, SSE, a unified `TcmCdssAiSupportPayload`, structured-JSON prescriptions). **None of that is built.** The current implementation is a **linear M01–M05 pipeline** streaming Markdown+NDJSON, with the frontend doing flow orchestration. The docs themselves say (§20) not to mistake the compatibility layer for the target. When a doc type/endpoint doesn't exist in `src/`, it's a target spec, not something to call.

### Request flow

`src/app/diagnosis/DiagnosisClient.tsx` (a ~4000-line client component) drives the whole clinical flow and calls the stage routes under `src/app/api/diagnosis/`. Routes are thin — validate → deterministic safety gate → build prompt → stream — with all logic in `src/lib/`.

| Route | Stage | Notes |
|---|---|---|
| `collect` | M01 | Structure free text; tongue image → **GLM vision** only when `GLM_VISION_ENABLED` (else uploads rejected, no silent fallback) |
| `question` | M02 | Generate follow-up questions (primary model) |
| `question/interpret` | M02 | Deterministically interpret a doctor's free-text answers into structured status updates |
| `diagnose` | M03 | Western dx + TCM syndrome + pathogenesis; gated by safety + completeness=C; attaches the clinical-facts backstop first |
| `prescribe` | M04 | Herbal prescription; also requires an actionable M03 diagnosis |
| `assess` | M05 | **Fully deterministic** — follow-up/risk summary that consumes the Lingxi post-prescription review, no LLM |
| `red-flags` | — | Deterministic red-flag / safety summary for the current case state |
| `post-prescription-risk` | — | Lingxi unified rx-audit JSON; fail-closed with manual-review lock when unavailable or missing structured herbs |
| `snapshot` | — | Encrypted case-state snapshot (AES-256-GCM, `CASE_SNAPSHOT_ENCRYPTION_KEY`); binds auth to snapshot owner |
| `his-scheme` | — | Builds HIS "AI 诊疗支持方案" JSON (`src/lib/his-scheme.ts`) |
| `health`, `model-health`, `tcm-knowledge/search`, `tcm-knowledge/herb-function` | — | Status/health + local KB search. `health?strict=1` returns `strictReady` (model + clinical reviewer + evidence + tongue-vision-if-required + encryption + reasoning signing + clinical-facts all configured); `model-health?check=1` does a live model call |
| `auth/access` | — | Token → UI cookie login; timing-safe compare, rate-limited (8 fails / 10-min lock) |

### Model / streaming layer — `src/lib/diagnosis-api.ts`

`callDiagnosisStream(prompt, backend, images, kind)` is the single entry point. Backends: `deepseek`/`openai` → primary OpenAI-compatible model; `glm` → GLM vision (tongue-image extraction only). EviMed is not a model backend; it is injected separately as multi-source evidence context in M03/M04 prompts.

- **Per-stage models (see `.env.example`):** the default primary is **DeepSeek V4 Flash** (`OPENAI_MODEL=deepseek-v4-flash`); M03 is upgraded to **V4 Pro** via `PRIMARY_DIAGNOSE_MODEL`. M01/M02/M04, the independent clinical reviewer (`PRIMARY_CLINICAL_REVIEW_MODEL`, defaulting to the opposite-stage model for cross-review), and the clinical-facts extractor (`CLINICAL_FACTS_MODEL`) are each separately configurable. `reasoning_effort` / `thinking_enabled` are **per-stage env knobs** (low/medium; thinking off by default) — not one global setting.
- **GLM tongue vision is opt-in:** it runs only when `GLM_VISION_ENABLED=true` **and** `GLM_API_KEY` is set. When disabled (the default), an uploaded tongue photo is **rejected with a friendly prompt** — there is *no* silent fallback to the text model.
- **NDJSON contract (shared by every backend and the deterministic responses):** `{"content":"…"}\n` per chunk, terminated by `{"content":"[END]"}\n`; errors as `{"error":"…"}\n`. Anything you add to the pipeline must speak this exact contract — `markdownNdjsonResponse()` wraps deterministic Markdown into it.
- **Critical reasoning-only-stream gotcha:** if a stream returns only `reasoning_content` and no `content`, that's treated as an error ("模型仅返回推理过程"). This is why `model-health?check=1` verifies *final content*, not just reasoning — a provider that only streams reasoning will fail health and every stage.
- Timeouts are enforced per-stream: connect 90s / idle 60s / total 180s, with upstream `AbortController` cancellation and a 5s client heartbeat that keeps the UI alive during provider reasoning.
- Provider config lives in `src/lib/text-model.ts` via `AI_TEXT_PROVIDER` (`openai-compatible` per `.env.example`; or `bailian-qwen`). `src/lib/openai.ts` is a minimal legacy client — prefer `getPrimaryTextModelConfig()`.

### Deterministic safety is the load-bearing layer — `src/lib/diagnosis-safety.ts`

The model never decides safety. Stage routes call `withSafetyGate(caseState)` first; the gate deterministically parses vitals (BP/T/P/R/SpO2 with critical thresholds) and text for red flags and sets `allowDiagnosis` / `allowDosePrescription`. On failure the route returns a degraded, non-dose output (`buildSafetyLimited*`) — **fail-closed**: unresolved risk or unparseable dose ⇒ downgrade to advice / "需药师复核", never silently treat "unknown" as "no risk".

- Always run `sanitizeCaseStateForModel` / `sanitizeFreeTextForModel` before sending case data to a model.
- Clinical facts use a status vocabulary (`positive/possible/negative/historical/unknown`) in `src/lib/clinical-state.ts`. **Do not treat "未提及/unknown" as negative** — generic "过敏史/用药史未提及" pollution is an explicitly tested false-positive class in the regression suite. When you fix one such false positive, extend coverage to the whole class, not just the one case.
- **Completeness** (`src/lib/diagnosis-parse.ts`): the model embeds structured JSON in the stream between `<!-- DIAGNOSIS_JSON_START -->` / `<!-- DIAGNOSIS_JSON_END -->` sentinels (injected via `SENTINEL_INSTRUCTION` in `diagnosis-prompts.ts`). `determineCompletenessLevel` **recomputes the level in code and overrides the model's** — C requires `redFlag≥0.7` and other dims `≥0.6` (redFlag has the higher bar); any dim `<0.3` ⇒ A; else B. Only level C proceeds to full diagnosis/prescription.
- **Semantic clinical-facts backstop (`src/lib/clinical-facts.ts` + `clinical-facts-runtime.ts`):** an **additive-only** model-derived layer that supplements spoken-language red flags / follow-up clues; **on by default** (disable with `CDSS_CLINICAL_FACTS_BACKSTOP=false`). It may only *add* urgent advisories — never cancel a deterministic positive red flag or a critical vital. `additiveRedFlagsFromFacts` / `priorityEvaluationItemsFromFacts` feed the gate; schema-invalid entries are isolated so a fabricated item cannot erase a valid one in the same output.
- **Client orchestration** lives in `src/lib/diagnosis-engine.ts` (browser localStorage case persistence keyed `diagnosis_case_*`, stream consume with its own idle/total timeouts + `AbortController`) consumed by the ~7.7k-line `DiagnosisClient.tsx`. It is client-side flow glue, not a server pipeline — the server routes stay thin.

### Knowledge base — `src/lib/tcm-knowledge.ts` + `src/data/tcm-knowledge.json`

The 48k-line JSON is a **generated build artifact** — do not hand-edit it. `scripts/build-tcm-knowledge.mjs` compiles it from CSV/JSON sources in a **sibling `合理用药` repo** (`../../合理用药/…`, overridable via `RXAI_DATA_ROOT` / `RXAI_RELEASE_ROOT`); without those sources the rebuild can't run. It carries dose limits, 十八反十九畏 incompatibilities, special-population rules, decoction methods, herb-risk categories, patent-medicine & western-interaction rules, and HIS alias/spec mappings. The local knowledge layer is evidence/context support and legacy parsing only; post-prescription safety authority is the Lingxi unified audit path in `src/lib/rxaudit.ts`, and unavailable audit must fail closed to doctor/pharmacist review.

### Auth — `src/proxy.ts` + `src/lib/cdss-auth.ts`

`proxy()` gates `/`, `/diagnosis`, `/api/:path*`. Auth is on when `CDSS_REQUIRE_API_AUTH=true`, in production, or whenever `CDSS_API_TOKEN` is set. API callers send `x-cdss-api-token` or `Authorization: Bearer <token>`; browsers get an httpOnly cookie `tcm_cdss_ui_access` = `SHA-256("tcm-cdss-ui:"+token)` from `/api/auth/access`. If you add API routes, keep them under the matcher and never introduce an unauthenticated bypass.

## Conventions & gotchas

- **Imports:** `@/*` → `src/*` (tsconfig paths). Match the existing thin-route / logic-in-`lib` split; keep routes validating + streaming only.
- **Everything is fail-closed and evidence-bound.** Don't add model calls that emit dose-level prescriptions, guideline/DOI citations, or risk verdicts without a deterministic rule or KB entry behind them.
- **`NEXT_PUBLIC_BASE_PATH`** lets the app mount under a sub-path; it's threaded through `next.config.ts`, `cdss-auth.ts` and `proxy.ts` — respect it when building URLs/redirects.
- **Build/deploy:** `output:"standalone"` (`next.config.ts`); `Dockerfile` + `docker-compose.yml` build the standalone image and pass the env below. `.env*` is gitignored.
- New request bodies go through `readJsonBodyWithLimit` / `readCaseStateRequest` (`src/lib/http-guard.ts`, `diagnosis-request.ts`) for size caps and 413/400 handling — reuse them.

## Environment variables

Set in `.env.local` (see `.env.example`). Primary model: `AI_TEXT_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` (default target = DeepSeek V4 Pro). Optional adapters: `GLM_API_KEY` (tongue vision), `EVIMED_API_KEY` / `EVIMED_EVIDENCE_API_KEY` / `EVIMED_GUIDE_API_KEY` (evidence). Auth: `CDSS_API_TOKEN`, `CDSS_REQUIRE_API_AUTH` (default `true`), `CDSS_TRUST_PROXY_HEADERS` (only when behind a trusted proxy, for login rate-limit IP keying).
