# DeepSeek V4.1 Flash implementation plan

> **For agentic workers:** Use subagent-driven-development with bounded ownership and independent SPEC then QUALITY review. The user already approved the all-model switch including tongue vision.

**Goal:** Make the existing image path use the same verified DeepSeek model as all text phases without altering clinical prompts or workflow.

**Architecture:** A small provider selector supplies URL/key/model/tuning to both the existing vision stream and health probe. Default GLM remains compatible; explicit primary selects only the verified DeepSeek vision model. Medication extraction reuses existing common tuning.

**Tech Stack:** Existing TypeScript, OpenAI-compatible fetch, jiti/node:test, Next.js 16 route wrappers unchanged.

## Task 1: Vision selection and transport parity

Files: create `src/lib/tongue-vision-model.ts`; modify only relevant vision sections of `src/lib/diagnosis-api.ts`; extend `scripts/test-upstream-guards.mjs` or create focused `scripts/test-tongue-vision-provider.mjs`; wire focused tests into the existing upstream test family in `package.json`.

- [ ] Read the installed Next.js route handler guide before changing request-facing code.
- [ ] Add executed RED tests: `TONGUE_VISION_PROVIDER=primary`, configured `deepseek-flash`, no GLM key must select approved DeepSeek URL/key/model; stream and health must send that same identity and preserve content/END. A secret/config mismatch must not silently fall back to GLM.
- [ ] Cover default GLM behavior, explicit off, unsupported model/provider, missing key, malformed/empty stream, cancellation and returned public label/model without key leakage. A synthetic 64×64 existing probe image contains no patient data.
- [ ] Run `node --test scripts/test-tongue-vision-provider.mjs` (or the extended upstream suite), record intended RED, commit only those tests.
- [ ] Implement the pure selection contract `getTongueVisionModelConfig()` with `provider`, `providerLabel`, `model`, `apiKey`, `endpoint`, `enabled`, `configured`, `disabledReason` and request tuning. `primary` consumes `getPrimaryTextModelConfig()` rather than an arbitrary new URL/key variable; retain existing TLS/vendor validation and require `deepseek-flash` for native vision.
- [ ] Feed the chosen config into `callGlmStream`, `isTongueVisionConfigured`, `probeTongueVisionModel`, and `getDiagnosisProviderStatus`. Preserve medical prompt, NDJSON/cancellation/budgets, and default GLM behavior. Probe success requires actual usable final content, not merely a choices array.
- [ ] Run the same tests GREEN and neighboring stream/probe tests before the implementation commit.

## Task 2: Complete non-thinking request settings

Files: `src/lib/medication-event-extractor.ts` and its existing regression suite.

- [ ] Intercept the actual SDK request with synthetic input and prove current extraction omits the explicit non-thinking setting.
- [ ] Add the existing helper call `...textModelRequestTuning(primary.model, { reasoningEffort: "low", thinkingEnabled: false })` to that request and its shared repair path; do not add a new model call or change extraction semantics.
- [ ] Confirm DeepSeek `thinking.type=disabled`, Qwen `enable_thinking=false`, existing retry/schema failures unchanged, and no extraction when external audit is explicitly skipped.

## Task 3: Configuration and verification

Files: `.env.example`, `docker-compose.yml`, existing test registration. Add only `TONGUE_VISION_PROVIDER` with default `glm`; actual trial overrides to `primary`. Do not overwrite real secrets or silently change existing production model defaults.

- [ ] Document `primary` native vision support, same-model review wording and unchanged clinical boundaries.
- [ ] Run `npm run typecheck`, `npm run lint`, corresponding vision/medication/explicit-audit-off/stream tests and both full deterministic modes.
- [ ] Independent SPEC and QUALITY review the exact change, then freeze a commit and build the immutable candidate. Root owns all server deployment, runtime settings, live evaluation and GitHub push.
