# Experience-First Clinical Reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make M01–M05 deliver useful, continuous clinical guidance with split modification fields, fewer repeated model calls, better case-specific context and visible doctor advisories instead of clinical-content 4xx responses.

**Architecture:** Keep the current deterministic M01–M05 workflow and signed canonical reasoning. Introduce one delivery-advisory projection that converts post-signature clinical concerns into structured, visible advice; use field-owned context packets for generation/review; improve retrieval and model-call reuse without adding autonomous tool loops. Authentication and malformed-request errors remain transport errors because no usable clinical artifact exists.

**Tech Stack:** Next.js 16 Route Handlers, TypeScript 5, Zod 4, OpenAI-compatible Qwen APIs, local governed JSON/BM25F knowledge, NDJSON streaming, Node/Jiti regression scripts.

---

### Task 1: Keep signed M04 results usable through HIS

**Files:**
- Create: `src/lib/clinical-delivery-advisory.ts`
- Modify: `src/lib/his-prescription-validation.ts`
- Modify: `src/app/api/diagnosis/his-scheme/route.ts`
- Modify: `src/lib/his-scheme.ts`
- Test: `scripts/test-reasoning-contract-signature.mjs`
- Test: `scripts/test-his-structured-projection.mjs`

- [ ] **Step 1: Write failing behavior tests**

Add a signed M04 fixture whose HIS recheck produces `unsupported_high_impact_*`. Assert HTTP 200, preserved diagnosis/prescription, `reviewRequired=true`, and a structured warning with candidate/herb/reason. Keep malformed candidate/index tests at 4xx.

- [ ] **Step 2: Verify RED**

Run `npm run test:reasoning-signature`. Expected: the signed clinical-advisory fixture currently returns 422.

- [ ] **Step 3: Add the delivery advisory type**

Implement a pure projection:

```ts
export type ClinicalDeliveryAdvisory = Readonly<{
  code: string;
  candidateIndex?: number;
  herbIndex?: number;
  herbName?: string;
  message: string;
  suggestedAction: string;
}>;

export function clinicalDeliveryAdvisoryFromIssue(
  issue: string,
  candidate?: PrescriptionCandidate,
): ClinicalDeliveryAdvisory;
```

It maps internal codes to doctor-facing text and extracts indexed herb identity from the canonical candidate. It never changes herbs or doses.

- [ ] **Step 4: Return usable validation with advisories**

Change the success result to `{ok:true,prescribed,candidateIndex,advisories}`. Signature, request shape and candidate existence remain prerequisites. Clinical issue codes become advisories for a valid signed M04 or attested workbench revision.

- [ ] **Step 5: Project advisories into HIS**

Pass advisories into `buildHisAiSchemePayload`; merge them into `riskTips`, `warningProfile`, and `reviewRequired` while preserving `prescriptions`.

- [ ] **Step 6: Verify GREEN**

Run `npm run test:reasoning-signature`, `npm run test:his-structured-projection`, `npm run test:prescription-permission`, and `npm run test:m04-safety-contract`.

- [ ] **Step 7: Commit**

Commit tests and implementation as `fix: keep clinical advisories visible through HIS`.

### Task 2: Align prompt text with field ownership and case relevance

**Files:**
- Create: `src/lib/m03-prompt-sections.ts`
- Modify: `src/lib/diagnosis-prompts.ts`
- Modify: `src/lib/m03-parallel-merge.ts`
- Modify: `src/lib/m03-diagnostic-review.ts`
- Modify: `src/lib/model-response-format.ts`
- Test: `scripts/test-m03-server-owned-fields.mjs`
- Test: `scripts/test-review-adjudication-packet.mjs`

- [ ] **Step 1: Write failing prompt ownership tests**

Assert that half prompts do not request `schemaVersion`, `stage`, `formula`, or other server-owned fields removed from their provider schema. Assert that unrelated disease-specific review sections are absent for a simple cough fixture.

- [ ] **Step 2: Verify RED**

Run the two test scripts; the current half suffix requests removed fields and the review prompt includes unrelated disease families.

- [ ] **Step 3: Centralize field ownership**

Export a single `M03_PROVIDER_FIELD_OWNERSHIP` description used by schema trimming, half suffix construction and merge.

- [ ] **Step 4: Select case-specific review sections**

Build review prompt sections from deterministic case signals. Always include grounding, polarity, main-complaint and TCM reasoning basics; include cardiopulmonary, thunderclap, arthritis or constipation sections only when the case matches.

- [ ] **Step 5: Replace “one issue only” with one compact review decision**

Extend the review contract with an optional bounded `findings` array while retaining `issueCode` compatibility. The reviewer reports up to three related clinical findings in one response; the coordinator applies one deterministic projection or one targeted revision request.

- [ ] **Step 6: Verify and commit**

Run `test:m03-server-owned-fields`, `test:m03-clinical-review`, `test:review-adjudication-packet`, `test:model-structured-output`, `test:stage-contract`. Commit `perf: make M03 prompts field-owned and case-specific`.

### Task 3: Build compact context packets and parallel retrieval

**Files:**
- Create: `src/lib/clinical-context-packet.ts`
- Modify: `src/app/api/diagnosis/diagnose/route.ts`
- Modify: `src/lib/cdss-evidence-context.ts`
- Modify: `src/lib/evimed-guide.ts`
- Modify: `src/lib/tcm-formula-indications.ts`
- Test: `scripts/test-orchestration-token-budget.mjs`
- Test: `scripts/test-prompt-evidence-budget.mjs`
- Test: `scripts/test-evimed-normalization.mjs`

- [ ] **Step 1: Write packet and retrieval tests**

Assert shared facts preserve chief complaint, temporal/polarity/subject markers and four examinations. Assert western/tcm packets exclude fields owned only by the other half. Mock a slow long evidence query and a fast governed main-problem query; the useful result must not wait for the slow query.

- [ ] **Step 2: Implement context packets**

Add:

```ts
export type M03ContextPackets = Readonly<{
  shared: string;
  western: string;
  tcm: string;
}>;

export function buildM03ContextPackets(state: CaseState): M03ContextPackets;
```

Compose half prompts from stable rules + shared facts + owned context + relevant evidence.

- [ ] **Step 3: Retrieve main problem first**

Run governed problem queries and long case query concurrently. Prefer relevant main-problem hits; retain long-query hits as supplemental evidence and deduplicate by evidence ID/fingerprint.

- [ ] **Step 4: Improve evidence slices**

Render title, applicable condition, matched patient fact, concise excerpt, source/version and differentiator. Do not inject internal governance history.

- [ ] **Step 5: Verify and commit**

Run prompt-budget, evidence, formula retrieval, grounding, polarity and M03 integration suites. Commit `perf: build compact M03 context and concurrent evidence retrieval`.

### Task 4: Reuse completed work across follow-up and edits

**Files:**
- Create: `src/lib/case-change-set.ts`
- Modify: `src/lib/clinical-facts-runtime.ts`
- Modify: `src/lib/m02-answer-interpreter.server.ts`
- Modify: `src/lib/m05-followup-authoring.server.ts`
- Modify: `src/lib/prescription-revision.ts`
- Test: `scripts/test-clinical-facts.mjs`
- Test: `scripts/test-m02-answer-interpreter.mjs`
- Test: `scripts/test-followup-timeline-authoring.mjs`
- Test: `scripts/test-clinical-grounding.mjs`

- [ ] **Step 1: Write reuse tests**

Assert an M02 answer changes only authorized fields; unchanged signed facts/evidence reuse the prior result; a one-herb edit preserves diagnosis and unrelated candidate content; concurrent M05 consumers share one model call.

- [ ] **Step 2: Implement a deterministic change set**

Return changed clinical field IDs, signature-affecting changes and prescription-only changes. Use the same output to choose cache reuse and UI invalidation.

- [ ] **Step 3: Enrich M05 with selected patient context**

Include grounded current symptom course, relevant lifestyle context and prior response only when present. Keep the prompt compact and reuse the existing cache/in-flight maps.

- [ ] **Step 4: Verify and commit**

Run facts, M02, follow-up, grounding, signature and prescription revision suites. Commit `perf: reuse unchanged clinical work across follow-up and edits`.

### Task 5: Make progress and doctor-facing advice actionable

**Files:**
- Create: `src/lib/doctor-facing-stage-status.ts`
- Modify: `src/lib/stage-progress.ts`
- Modify: `src/app/diagnosis/DiagnosisClient.tsx`
- Modify: `src/lib/diagnosis-visible-summary.ts`
- Modify: `src/lib/his-scheme.ts`
- Test: `scripts/test-stage-progress-phase.mjs`
- Test: `scripts/test-doctor-facing-vocabulary.mjs`
- Test: `scripts/test-diagnosis-display-consistency.mjs`

- [ ] **Step 1: Write presentation tests**

Assert internal issue codes never appear in doctor output, completed sections remain visible while supplemental work runs, and modification rows render separate action/herb cells.

- [ ] **Step 2: Add one status vocabulary**

Map orchestration events to `正在整理病例重点`, `正在形成辨病辨证建议`, `正在核对处方要点`, `正在补充参考资料`, and `建议已生成，可继续编辑`. Attach actionable advice to affected sections.

- [ ] **Step 3: Preserve partial useful content**

Keep completed canonical modules in UI state when a supplemental request times out or is cancelled. Mark only that section as incomplete.

- [ ] **Step 4: Verify and commit**

Run progress, vocabulary, display, stream and UI typecheck suites. Commit `feat: present progressive clinical results and actionable advice`.

### Task 6: Make model/tool use measurable and economical

**Files:**
- Modify: `src/lib/text-model.ts`
- Modify: `src/lib/cdss-model-task-telemetry.ts`
- Modify: `src/lib/controlled-semantic-normalization.server.ts`
- Create: `src/lib/model-request-context.ts`
- Create: `scripts/regress-model-routing-ab.mjs`
- Create: `scripts/regress-evidence-tool-mode.mjs`
- Test: `scripts/test-model-task-telemetry.mjs`
- Test: `scripts/test-text-model-request-tuning.mjs`

- [ ] **Step 1: Write physical-attempt tests**

Use a local 503 server. Assert each physical HTTP attempt is visible or configure SDK retries to zero and count the application retry. Assert missing usage is reported as unavailable rather than zero-cost.

- [ ] **Step 2: Unify retry ownership**

Set `maxRetries: 0` on shared clients; application retry policies remain bounded by their current request budgets. Tag health/synthetic calls separately from business calls.

- [ ] **Step 3: Add A/B harnesses**

Compare M03 Flash/Plus, M04 Plus/Max, thinking settings, current injected retrieval and optional Function Calling. Record first useful content, final duration, prompt/output/cache tokens, model calls, structured completeness and clinician scoring fields. The harness does not change production defaults.

- [ ] **Step 4: Verify and commit**

Run telemetry, tuning, upstream, orchestration and deterministic suites. Commit `perf: make model attempts and routing experiments measurable`.

### Task 7: Complete experience-focused production verification and documentation

**Files:**
- Modify: `scripts/regress-prod-smoke.mjs`
- Create: `scripts/regress-experience-journey.mjs`
- Modify: `docs/中医CDSS-对外接口文档.md`
- Modify: `docs/架构与完整推理链路审查-TODO-20260907.md`

- [ ] **Step 1: Add the full journey**

Exercise M01, optional M02, M03, M04, post-prescription audit, M05, HIS and a doctor edit. Assert that clinical concerns remain visible with the usable result and split modification fields survive all outputs.

- [ ] **Step 2: Run class-level case matrices**

Run customer cases, public clinical corpus and counterexamples. Report first useful content, total latency, revisions, advisories, doctor-edit continuity and model cost. Results inform rollout; the harness does not introduce a new clinical-content blocker.

- [ ] **Step 3: Update docs and checklist**

Mark completed UX items with commit/test evidence. Document `warnings/reviewRequired`, split modification fields, optional model/tool modes and the difference between service availability and retrieval no-hit.

- [ ] **Step 4: Final verification**

Run `npm run verify:release`, experience journey, customer live tests and production smoke. Build an immutable image, verify commit/source digest, deploy, and rerun the experience journey on production while preserving the existing customer API token.

