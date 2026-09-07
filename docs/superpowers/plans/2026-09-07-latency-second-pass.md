# Latency Second Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Each code task requires RED/GREEN and spec then quality review. Do not create extra runtime blocking conditions.

**Goal:** Implement and measure the five approved latency levers while preserving usable advisory outputs and API compatibility.

**Architecture:** Keep M01–M05, canonical signed results and provider boundaries. Reduce provider work at prompt/schema/compilation boundaries, settle deterministic transformations before review, reuse stable work, and emit clearly non-final draft modules. Measurements are passive and experiments do not silently alter production models.

**Tech Stack:** Next.js16, TypeScript, Zod4, OpenAI-compatible Qwen, NDJSON, Node/Jiti scripts.

**Implementation status 2026-09-07:** Tasks 1–5 implemented and independently reviewed. Task1 canonical-equivalence fixture preserved clinical output while wire JSON reduced14.90%; Task2 stub1generation/2reviews→1review with identical final clinical hash; Task3 actual8-call cache experiment confirmed creation/hits, but did not establish uniform net latency/quality benefit, so default remains implicit. Task4 stable query-priority/cancellation7checks pass. Task5 actual provider root-candidate streaming and late-frame tests pass; real browser and integrated candidate testing remain in Task6. Historical baseline observer incorrectly called status-only modules useful; preserved original artifact and reran corrected observer rather than relabeling its times as clinical delivery.

## Task 1 — M04 concise single-source explanations

Status: implemented and reviewed; post-live compact repair compatibility audit found additional consumers to align before final release.

Files: `src/lib/model-response-format.ts`, `src/lib/m04-proposal-compiler.ts`, `src/lib/diagnosis-prompts.ts`, focused `scripts/test-m04-*.mjs`.

- [ ] Add provider-schema and compiled-output tests: ignored `therapyMatch` is not requested, compiled therapyMatch equals the M03 lock, original herb function and decision fields survive, legacy full proposals still parse.
- [ ] Run the targeted test and commit RED.
- [ ] Remove only demonstrated server-owned fields from provider schema; keep permissive legacy parsing. Use existing projections rather than new generated prose. Prompt requires one concise individual explanation without repeating facts in multiple fields.

```ts
assert.equal(providerCandidate.properties.therapyMatch, undefined);
assert.equal(compiled.formula.candidates[0].therapyMatch, getM03TherapyLock(prior).candidateMatch);
assert.equal(compiled.formula.candidates[0].herbs[0].function, suppliedFunction);
```

- [ ] GREEN: `test:model-structured-output`, `test:m04-proposal-compiler`, `test:stage-contract`, related rendering tests; typecheck. Commit minimal implementation.

## Task 2 — M03 review settled clinical state

Status: implemented and reviewed. Server-loopback replay confirms no `finalization_changed` re-review. Its two remaining calls per case were initial review plus dispute adjudication, not duplicate finalization work.

Files: `src/lib/diagnosis-api.ts`, `src/lib/m03-diagnostic-review.ts`, existing signature/review tests.

- [ ] Capture a real existing deterministic finalization transform that currently triggers another review. Add a test asserting a single review for unchanged clinical decisions, and a contrasting real clinical change that remains distinguishable.
- [ ] Commit observed RED. Move reusable existing deterministic finalization before initial review; avoid a second copy of the transform. Keep final emission/signatures identical and preserve actual review decisions.

```ts
assert.equal(reviewCallsForPresentationOnlyChange, 1);
assert.notEqual(clinicalHash(beforeClinicalEdit), clinicalHash(afterClinicalEdit));
```

- [ ] Record review trigger phase and changed field paths without patient text. Run `test:m03-clinical-review`, `test:reasoning-signature`, `test:review-adjudication-packet`, `test:stage-contract`, `test:stream-safety`; commit GREEN.

## Task 3 — Stable prefix and explicit-cache experiment

Status: implemented, reviewed and eight actual calls completed. Explicit cache works, but uniform latency benefit is unproven; production default remains implicit.

Files: new `src/lib/model-prompt-cache.ts`, `src/lib/m03-diagnostic-review.ts`, `src/lib/diagnosis-api.ts`, `src/lib/openai-compatible-response.ts`, `src/lib/cdss-model-task-telemetry.ts`, `.env.example`, compose only if forwarding is needed.

- [ ] RED tests: different patient states share the same static leading block; opt-in emits `cache_control` only on supported provider public prefix; opt-out bytes unchanged; dynamic clinical text remains after prefix; creation/reasoning Token fields parsed without turning missing values into zero.

```ts
assert.equal(buildMessages(staticRules, firstCase)[0].content, buildMessages(staticRules, secondCase)[0].content);
assert.equal(snapshot({ usage: {} }).cacheCreationTokens, undefined);
```

- [ ] Add typed helper using explicit known template boundary, not natural-language stripping. Opt-in `CDSS_EXPLICIT_PROMPT_CACHE=true`, default preserves current implicit mode pending comparison. Never add a cache warm-up API call. Fix review prefix ordering without changing clinical text.
- [ ] Run tuning/usage/cache tests and typecheck, commit GREEN. Real cold/warm provider replay compares same model+prompt+schema; log billed creation and hit counts and elapsed time, no secrets.

## Task 4 — Prioritized evidence without waiting on unused work

Status: implemented, reviewed and seven controlled concurrency/cancellation checks passed.

Files: `src/lib/evimed-guide.ts`, `scripts/test-evidence-query-concurrency.mjs`, small helper only if needed.

- [ ] RED test uses unresolved long query and immediately successful primary query; useful context must resolve before long query releases. Also assert ordered fallback, all-no-hit, failure recovery and unchanged evidence IDs/source pairing.

```ts
const context = await Promise.race([run, failAfterDeadline]);
assert.match(context, /主诉咳嗽指南/);
assert.equal(longQueryFinished, false);
```

- [ ] Start queries together but consume primary results by stable priority; await long fallback only when needed. Late unused results do not replace an emitted clinical decision or poison a future cache. Handle rejections/cancellation without unhandled promises or abandoning client cancellation.
- [ ] Run evidence and source-binding tests; commit GREEN.

## Task 5 — M04 progressive candidate and genuine first-useful timing

Status: implemented and reviewed; server-loopback clinical drafts and browser read-only drafts observed. Full browser delivery remains unverified. An independently reproduced pending-cancel cleanup defect was fixed in `573c19c1`, with twelve regression scenarios and independent review; this does not prove the cause of the earlier SSH/browser stall.

Files: `src/lib/diagnosis-stream-protocol.ts`, relevant partial-JSON helper, `src/lib/diagnosis-api.ts`, `src/lib/diagnosis-engine.ts`, `src/app/diagnosis/DiagnosisClient.tsx`, `scripts/regress-experience-journey.mjs`.

- [ ] RED tests: candidate before trailing nonPharma yields draft frame; incomplete herb rows do not appear as complete objects; final stream still emits END and canonical signature; late draft cannot overwrite final or physician edits; heartbeats do not count as usable content.

```ts
assert.equal(draft.status, "draft");
assert.ok(firstUsefulMs < durationMs);
assert.equal(heartbeatOnly.firstUsefulMs, null);
```

- [ ] Extend existing module-draft mechanism rather than new transport. Display read-only “候选建议，补充中” in M04 while preserving final editor state. Passive measurement uses streamed chunks instead of response.text().
- [ ] Test protocol/display/client cancellation and browser UI; commit GREEN.

## Task 6 — Paired live experiments and release

Status at candidate rebuild: in progress, NOT yet released. `adeaca13` passed `verify:release` (200 suites in each of two modes, typecheck, lint and build). Server-loopback journey completed two of three cases; reflux M04 ended without a signed prescription. Same-input full model comparison also failed reflux in both arms. Follow-up fixes through `345665e9` address compact repair compatibility, nonblocking transport cleanup, and bounded readable reference-dose advice with accurate metadata and HIS reference-only handling; code and healthcare reviews have no remaining findings. Preserve the earlier failures. Final rebuilt-image and live results are recorded separately in `artifacts/latency-second-pass/implementation-and-live-results.md`. Three cases are not a clinical-equivalence or P95 claim.

Files: `scripts/regress-experience-journey.mjs`, `scripts/regress-model-routing-ab.mjs` or a focused new full-stage experiment script, test output `artifacts/latency-second-pass/`, API docs and this checklist.

- [ ] Extend replay to emit first content, first useful module, stage durations, structured presence and provider statistics; all failed attempts remain in report. No raw token/signatures in output.
- [ ] Perform same synthetic cases against baseline/candidate, controlled M03 Flash/Plus and M04 Plus/Flash or Max comparisons with matching inputs/schema. Do not claim a micro-question comparison proves clinical equivalence.
- [ ] Execute cold/warm explicit-versus-implicit comparison and prioritized retrieval timing test. For frontend use browser synthetic session and confirm partial output is not overwritten by late frames.
- [ ] Run `npm run verify:release`, customer regressions selected from existing corpus, end-to-end doctor-edit probe. Build immutable Linux image once integrated; compare digest, push and deploy without changing customer token. Rerun final production cases and record remaining limitations accurately.
- [ ] Mark every task with evidence, distinguish implemented code, actual tests, experimental setting retained or rejected, and clinician-quality uncertainty. No generic “all done” based only on HTTP200.
