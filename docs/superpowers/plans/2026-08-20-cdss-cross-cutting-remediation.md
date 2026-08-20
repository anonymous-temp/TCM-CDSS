# CDSS Cross-Cutting Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified model-provider, clinical-safety, tenant-isolation, clinician-presentation, medication-label, and M05 outlet defects without changing the three behaviors that were disproved.

**Architecture:** Keep deterministic safety and evidence ownership in `src/lib`, keep routes thin, and make every customer-visible outlet consume one shared projection. Introduce backward-compatible provider and snapshot adapters at the boundary rather than branching clinical logic. Each defect class receives a RED test, a minimal GREEN implementation, and an isolated commit before the full release gate.

**Tech Stack:** Next.js 16 App Router/Proxy, React 19, TypeScript 5 strict, Node 24, zod 4, OpenAI-compatible SDK, local JSON governance data, Node/Jiti deterministic test scripts.

---

## File map

- `src/lib/text-model.ts`: provider/model/endpoint compatibility and request tuning defaults.
- `src/lib/diagnosis-api.ts`: clinical-review identity, streaming prefix, and generic module-draft behavior.
- `src/lib/tcm-diagnostic-citations.ts`: server-owned TCM citation projection.
- `src/lib/diagnosis-safety.ts`, `src/lib/clinical-facts.ts`: vital-sign thresholds and additive semantic facts.
- `src/lib/customer-context.ts`, `src/lib/cdss-auth.ts`, `src/proxy.ts`: customer binding and rate-limit identity.
- `src/app/api/diagnosis/snapshot/route.ts`, `src/lib/encrypted-snapshot.ts`: versioned tenant AAD and legacy migration.
- `src/lib/medicine-candidate-planner.server.ts`, `src/lib/patient-relevant-medication-risk.ts`, `src/lib/medication-label-usage.ts`: inventory, warning, and label projections.
- `src/lib/tcm-treatment-clinician-view.ts`, `src/app/diagnosis/DiagnosisClient.tsx`, `src/lib/diagnosis-visible-summary.ts`: clinician treatment cards.
- `src/lib/m05-followup-authoring.server.ts` and three M05-consuming routes: shared patient-level authoring.
- `.env.example`, `docker-compose.yml`, `package.json`, `docs/部署运行手册-20260713.md`: migration and deployment contract.

### Task 1: Make both Qwen provider topologies merge-safe

**Files:**
- Modify: `scripts/test-text-model-request-tuning.mjs`
- Modify: `scripts/test-m03-diagnostic-review.mjs`
- Modify: `src/lib/text-model.ts`
- Modify: `src/lib/diagnosis-api.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing provider and thinking-default tests**

Add assertions equivalent to:

```js
process.env.AI_TEXT_PROVIDER = "openai-compatible";
process.env.OPENAI_API_KEY = "qwen-compatible-test-key";
process.env.OPENAI_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
process.env.OPENAI_MODEL = "qwen3.8-max";
assert.equal(getPrimaryTextModelConfig().configured, true);
assert.deepEqual(textModelRequestTuning("qwen3.8-max", {}), { enable_thinking: false });
assert.deepEqual(textModelRequestTuning("deepseek-v4-flash", {}), { thinking: { type: "disabled" } });
```

Add a review-candidate assertion that a Bailian reviewer is independent only when its endpoint or model differs from the actual generator.

- [ ] **Step 2: Run RED**

Run: `npm run test:text-model-tuning && npm run test:m03-clinical-review`

Expected: the OpenAI-compatible Qwen configuration reports `vendor_policy`, undefined thinking tuning returns `{}`, or the same-model reviewer is incorrectly independent.

- [ ] **Step 3: Commit the RED tests**

```bash
git add scripts/test-text-model-request-tuning.mjs scripts/test-m03-diagnostic-review.mjs
git commit -m "test: expose Qwen topology and thinking default conflict"
```

- [ ] **Step 4: Implement model/endpoint family validation**

In `getOpenAICompatibleConfig`, derive the model family and require the matching approved host:

```ts
const qwen = isQwenModel(resolvedModel);
const vendorAllowed = qwen
  ? endpointHostAllowed(resolvedBaseUrl, ["dashscope.aliyuncs.com"])
  : isDeepseekModel(resolvedModel) && endpointHostAllowed(resolvedBaseUrl, ["api.deepseek.com"]);
```

In `textModelRequestTuning`, use `const thinkingEnabled = options.thinkingEnabled ?? false` and always emit the model-family-specific disabled field. In `preferredClinicalReviewModelConfig`, compute independence by endpoint and model identity instead of provider branch. Report the first preferred candidate in public topology status rather than `some()` fallback aggregation.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm run test:text-model-tuning && npm run test:m03-clinical-review && npm run test:health-public-view && npm run typecheck`

```bash
git add src/lib/text-model.ts src/lib/diagnosis-api.ts .env.example
git commit -m "fix: unify Qwen provider and review topology semantics"
```

### Task 2: Make TCM diagnostic citations server-owned at every stage

**Files:**
- Modify: `scripts/test-tcm-diagnostic-citations.mjs`
- Modify: `src/lib/tcm-diagnostic-citations.ts`

- [ ] **Step 1: Add a RED adversarial citation test**

Construct an extension disease payload containing `MODEL-FAKE-001` and a fabricated citation that includes the disease name. Assert `applyGovernedTcmDiagnosticCitations` returns an empty extension reference list. Separately assert `buildEvidenceOutputTransform` can still bind a real governed scope record.

- [ ] **Step 2: Run RED and commit the test**

Run: `npm run test:tcm-diagnostic-citations`

```bash
git add scripts/test-tcm-diagnostic-citations.mjs
git commit -m "test: reject model-authored TCM disease citations"
```

- [ ] **Step 3: Remove model-reference reuse from the early projection**

For non-standard disease names, set `overview.tcmDiseaseReferences = []`. Keep extension citation selection only in `resolveGovernedTcmDiseaseReferences`, where evidence IDs and citation text are resolved from the server evidence scope.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm run test:tcm-diagnostic-citations && npm run test:diagnosis-citation-presentation && npm run test:his-structured-projection`

```bash
git add src/lib/tcm-diagnostic-citations.ts
git commit -m "fix: make TCM diagnostic citations server-owned"
```

### Task 3: Restore clinically relevant warning atoms and inventory semantics

**Files:**
- Modify: `scripts/test-patient-relevant-medication-risk.mjs`
- Modify: `scripts/test-customer-medicine-candidates.mjs`
- Modify: `src/lib/patient-relevant-medication-risk.ts`
- Modify: `src/lib/medicine-candidate-planner.server.ts`

- [ ] **Step 1: Add RED warning-order variants**

Assert a 78-year-old retains these outputs:

```js
assert.equal(visible("孕妇及肝肾功能不全者禁用"), "肝肾功能不全者禁用");
assert.equal(
  visible("孕妇、儿童及年老体弱者应在医师指导下服用"),
  "儿童及年老体弱者应在医师指导下服用",
);
assert.equal(visible("孕妇禁用"), "");
```

- [ ] **Step 2: Add RED empty-inventory tests**

For a customer with no inventory file, assert governed local medicine candidates remain available. For a customer with a loaded inventory that excludes the candidate, assert it is filtered.

- [ ] **Step 3: Run RED and commit tests**

Run: `npm run test:patient-relevant-medication-risk && npm run test:customer-medicine-candidates`

```bash
git add scripts/test-patient-relevant-medication-risk.mjs scripts/test-customer-medicine-candidates.mjs
git commit -m "test: expose warning atom and empty inventory losses"
```

- [ ] **Step 4: Implement atom-preserving warning cleanup**

Remove the `startsWithAny(...REPRODUCTIVE_FORMS)` whole-clause drop. Scrub reproductive list members, then drop only action-only remnants matching `^(?:慎用|禁用|忌服|应在医师指导下使用)[。]?$`.

- [ ] **Step 5: Make inventory filtering conditional on `inventoryLoaded`**

Use:

```ts
const inCustomerInventory = (name: string, kind: "patent" | "western") =>
  !medicineAvailability?.inventoryLoaded || medicineAvailability.statusOf(name, kind) === "in_stock";
```

Apply it to both local and western candidates.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm run test:patient-relevant-medication-risk && npm run test:customer-medicine-candidates && npm run test:multitenant-drug-inventory`

```bash
git add src/lib/patient-relevant-medication-risk.ts src/lib/medicine-candidate-planner.server.ts
git commit -m "fix: preserve warning atoms and unknown-inventory candidates"
```

### Task 4: Close vital-sign gaps and preserve affirmed symptoms

**Files:**
- Modify: `scripts/test-safety-mutation-matrix.mjs`
- Modify: `scripts/test-redflag-expression-coverage.mjs`
- Modify: `scripts/test-clinical-facts.mjs`
- Modify: `src/lib/diagnosis-safety.ts`
- Modify: `src/lib/clinical-facts.ts`

- [ ] **Step 1: Add RED vital tests**

Add cases for pregnant and non-pregnant `185/118`, `120/80 then 185/118`, and `R=8`. Require an obstetric/general critical red flag and require the later high BP to win.

- [ ] **Step 2: Add RED affirmed-symptom review test**

Return an initial grounded `affirmedSymptoms=[{term:"瘀斑",quote:"双下肢散在瘀斑"}]`; make the reviewer omit `affirmedSymptoms`; assert the checked result retains it.

- [ ] **Step 3: Run RED and commit tests**

Run: `npm run test:safety-mutations && npm run test:redflag-expression-coverage && npm run test:clinical-facts`

```bash
git add scripts/test-safety-mutation-matrix.mjs scripts/test-redflag-expression-coverage.mjs scripts/test-clinical-facts.mjs
git commit -m "test: expose critical vital and affirmed symptom gaps"
```

- [ ] **Step 4: Implement thresholds and monotonic fact merge**

Set the general high-BP critical threshold to `>=180 || >=120`, the respiratory threshold to `<=8`, and let obstetric `>=160/110` fire regardless of the general threshold while deduplicating final messages. Merge grounded initial and reviewed affirmed symptoms by normalized `term + quote` in every reviewed return path.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm run test:safety-mutations && npm run test:redflag-expression-coverage && npm run test:clinical-facts && npm run test:prescription-permission`

```bash
git add src/lib/diagnosis-safety.ts src/lib/clinical-facts.ts
git commit -m "fix: close critical vital gaps and retain affirmed symptoms"
```

### Task 5: Replace provisional clinical drafts with safe module status frames

**Files:**
- Modify: `scripts/test-stream-modules.mjs`
- Modify: `scripts/test-stream-module-frames.mjs`
- Modify: `src/lib/diagnosis-stream-module-drafts.ts`
- Modify: `src/lib/diagnosis-api.ts`
- Modify: `src/app/api/diagnosis/diagnose/route.ts`

- [ ] **Step 1: Write RED streaming tests**

Assert module frames contain only the watermark and fixed module status, never diagnosis, syndrome, pathogenesis, therapy, dose, route, or course. Assert a safety banner is enqueued before the first module/progress frame when the gate has a red flag.

- [ ] **Step 2: Run RED and commit tests**

Run: `npm run test:stream-modules && npm run test:stream-module-frames`

```bash
git add scripts/test-stream-modules.mjs scripts/test-stream-module-frames.mjs
git commit -m "test: forbid provisional clinical conclusions in M03 frames"
```

- [ ] **Step 3: Emit generic module status content**

Keep the existing module identifiers and completion scanner, but render fixed content such as `西医判断已生成，正在校验` instead of values from the provider JSON.

- [ ] **Step 4: Add the initial deterministic banner channel**

Add `initialVisiblePrefix?: string` to stream options. The diagnose route computes the same `buildSafetyAdvisoryBanner` once, passes it as the initial prefix, and final output projection reuses it. The stream enqueues it before the first progress message.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm run test:stream-modules && npm run test:stream-module-frames && npm run test:stream-safety && npm run typecheck`

```bash
git add src/lib/diagnosis-stream-module-drafts.ts src/lib/diagnosis-api.ts src/app/api/diagnosis/diagnose/route.ts
git commit -m "fix: make M03 progress non-clinical and red-flag first"
```

### Task 6: Enforce tenant identity and per-customer model budgets

**Files:**
- Modify: `scripts/test-customer-context.mjs`
- Modify: `scripts/test-proxy-model-rate-limit.mjs`
- Modify: `src/lib/customer-context.ts`
- Modify: `src/proxy.ts`

- [ ] **Step 1: Add RED tenant-conflict and rate tests**

Create a signed customer-A cookie plus customer-B header and require 409. Exhaust customer A's token-authenticated model budget and require customer B's first request to remain below the limit.

- [ ] **Step 2: Run RED and commit tests**

Run: `npm run test:customer-context && npm run test:model-rate-limit`

```bash
git add scripts/test-customer-context.mjs scripts/test-proxy-model-rate-limit.mjs
git commit -m "test: expose tenant override and shared model bucket"
```

- [ ] **Step 3: Reject conflicting identity sources and use the scoped key**

Resolve header and cookie independently. If both valid and unequal, return `customer_context_mismatch`; otherwise use the available source. Replace proxy-local token/session keys with `getCdssAuthenticatedRateLimitKey(req)`.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm run test:customer-context && npm run test:customer-auth-binding && npm run test:model-rate-limit && npm run typecheck`

```bash
git add src/lib/customer-context.ts src/proxy.ts
git commit -m "fix: bind browser tenants and scope model rate limits"
```

### Task 7: Version snapshot AAD and provide customer migration controls

**Files:**
- Modify: `scripts/test-snapshot-auth-binding.mjs`
- Modify: `scripts/test-customer-context.mjs`
- Modify: `scripts/migrate-drug-inventory-to-customer.mjs`
- Modify: `src/lib/encrypted-snapshot.ts`
- Modify: `src/app/api/diagnosis/snapshot/route.ts`
- Modify: `src/lib/customer-context.ts`
- Modify: `src/app/api/diagnosis/health/route.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `docs/部署运行手册-20260713.md`

- [ ] **Step 1: Add RED legacy/v2 snapshot tests**

Construct both a pre-tenant v1 envelope and current tenant-bound data. Require both to decrypt for the original customer, require new encryption to emit v2, and require v2 to fail for another customer without legacy fallback.

- [ ] **Step 2: Add RED default-customer and CLI tests**

Assert missing header/cookie uses a valid `CDSS_DEFAULT_CUSTOMER_ID`, invalid defaults remain 400, and the migration script accepts `--source --root --customer-id` without overwriting an existing target.

- [ ] **Step 3: Run RED and commit tests**

Run: `npm run test:snapshot-auth-binding && npm run test:customer-context && npm run test:inventory-customer-migration`

```bash
git add scripts/test-snapshot-auth-binding.mjs scripts/test-customer-context.mjs scripts/test-inventory-customer-migration.mjs
git commit -m "test: expose snapshot and customer migration breaks"
```

- [ ] **Step 4: Implement v2 envelopes and legacy decrypt**

Accept v1/v2 in `isEncryptedSnapshotEnvelope`. Encrypt only v2. Decrypt v2 only with tenant AAD; decrypt v1 with tenant AAD first, then the pre-tenant auth-scope AAD. Return `legacyEnvelope: true` after legacy recovery so subsequent browser persistence rewrites v2.

- [ ] **Step 5: Implement and document the transition path**

Validate `CDSS_DEFAULT_CUSTOMER_ID` through `parseCustomerId`, expose a non-secret health flag, add `migrate:drug-inventory-customer`, and document the exact command and rollback behavior.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm run test:snapshot-auth-binding && npm run test:customer-context && npm run test:inventory-customer-migration && npm run test:health-public-view`

```bash
git add src/lib/encrypted-snapshot.ts src/app/api/diagnosis/snapshot/route.ts src/lib/customer-context.ts src/app/api/diagnosis/health/route.ts scripts/migrate-drug-inventory-to-customer.mjs package.json .env.example docker-compose.yml docs/部署运行手册-20260713.md
git commit -m "fix: migrate tenant snapshots and legacy customer callers"
```

### Task 8: Restore actionable treatment cards and clinical precautions

**Files:**
- Modify: `scripts/test-tcm-treatment-clinician-view.mjs`
- Modify: `scripts/test-visible-output-hygiene.mjs`
- Modify: `src/lib/tcm-treatment-clinician-view.ts`
- Modify: `src/app/diagnosis/DiagnosisClient.tsx`
- Modify: `src/lib/diagnosis-visible-summary.ts`

- [ ] **Step 1: Add RED real-template tests**

Use the real catalog schedules `每日1次，每次30分钟`, `隔日1次，每次约30分钟`, `咳嗽点按每日1次`, `每周2次`, and `身体活动每日累计不少于30分钟`. Require the corresponding cards to remain visible.

- [ ] **Step 2: Add RED precaution projection tests**

Require `requiredChecks=["感觉障碍","糖尿病足","皮损和烫伤风险"]` and a trained-operator requirement to appear in the clinician DTO, UI source, and Markdown projection, while `政府发布方案`, `现场医师确认`, source IDs, and protocol status remain absent.

- [ ] **Step 3: Run RED and commit tests**

Run: `npm run test:tcm-treatment-clinician-view && npm run test:visible-output-hygiene`

```bash
git add scripts/test-tcm-treatment-clinician-view.mjs scripts/test-visible-output-hygiene.mjs
git commit -m "test: expose hidden treatment plans and precautions"
```

- [ ] **Step 4: Broaden actionable schedules and add safe fields**

Accept quantitative frequency or daily cumulative duration; remove the moxibustion `周` special case. Add `precautions?: string[]` and `operatorRequirement?: string` to the clinician DTO, populated from cleaned `requiredChecks`, `techniqueBoundary`, and operator text after removing workflow/governance clauses.

- [ ] **Step 5: Render the shared fields in UI and Markdown**

Show compact `注意事项` and `实施要求` rows from the shared DTO. Do not render raw backend fields directly.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm run test:tcm-treatment-clinician-view && npm run test:tcm-treatments && npm run test:visible-output-hygiene && npm run test:presentation-contract`

```bash
git add src/lib/tcm-treatment-clinician-view.ts src/app/diagnosis/DiagnosisClient.tsx src/lib/diagnosis-visible-summary.ts
git commit -m "fix: restore actionable TCM treatment cards and precautions"
```

### Task 9: Parse non-oral label regimens from the same source row

**Files:**
- Modify: `scripts/test-medication-label-usage.mjs`
- Modify: `src/lib/medication-label-usage.ts`

- [ ] **Step 1: Add RED route/regimen tests**

Add exact cases for 丁桂儿脐贴, external ointment, eye/nasal drops, inhalation, sublingual, suppository/enema, 冲服, and 烊化兑服. Require every returned field to be a substring or concatenation of adjacent source fragments.

- [ ] **Step 2: Run RED and commit the test**

Run: `npm run test:medication-label-usage`

```bash
git add scripts/test-medication-label-usage.mjs
git commit -m "test: expose non-oral medication label parsing gaps"
```

- [ ] **Step 3: Implement source-bound route and interval parsing**

Recognize the governed route prefixes, join an adjacent application-site fragment for external products, and recognize `24小时换药一次`/`每N小时一次` as frequency. Keep unknown fields absent.

- [ ] **Step 4: Run GREEN, measure corpus improvement, and commit**

Run: `npm run test:medication-label-usage && npm run test:local-patent-medicines`

Run the corpus counter and record route-missing counts before/after in the commit message body.

```bash
git add src/lib/medication-label-usage.ts
git commit -m "fix: parse non-oral medication label regimens"
```

### Task 10: Make M05 patient-level authoring common to all three outlets

**Files:**
- Modify: `scripts/test-llm-adjudication-boundaries.mjs`
- Modify: `scripts/test-his-structured-projection.mjs`
- Modify: `src/lib/m05-followup-authoring.server.ts`
- Modify: `src/app/api/diagnosis/assess/route.ts`
- Modify: `src/app/api/diagnosis/post-prescription-risk/route.ts`
- Modify: `src/app/api/diagnosis/his-scheme/route.ts`

- [ ] **Step 1: Add RED three-outlet source and behavior tests**

Assert all three routes call one exported helper, deterministic risk verdicts remain outside the authored payload, and a mocked patient-level result reaches the HIS `followup` item instead of the fixed template.

- [ ] **Step 2: Run RED and commit tests**

Run: `npm run test:llm-adjudication-boundaries && npm run test:his-structured-projection`

```bash
git add scripts/test-llm-adjudication-boundaries.mjs scripts/test-his-structured-projection.mjs
git commit -m "test: expose template M05 content in HIS"
```

- [ ] **Step 3: Export and consume one authoring helper**

Export `authorFollowupForCase(state, diagnoseReasoning, selectedCandidate, signal)` from the M05 authoring module. Replace duplicated route code, and call it in both audit-success and audit-unavailable branches of HIS before `buildDeterministicRiskFollowup`.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm run test:llm-adjudication-boundaries && npm run test:his-structured-projection && npm run test:primary-care-m05-live && npm run typecheck`

```bash
git add src/lib/m05-followup-authoring.server.ts src/app/api/diagnosis/assess/route.ts src/app/api/diagnosis/post-prescription-risk/route.ts src/app/api/diagnosis/his-scheme/route.ts
git commit -m "fix: share patient-level M05 content across outlets"
```

### Task 11: Pin the three disproved behaviors

**Files:**
- Modify: `scripts/test-tcm-diagnostic-citations.mjs`
- Modify: `scripts/test-safety-mutation-matrix.mjs`
- Modify: `scripts/test-client-feedback-20260817.mjs`

- [ ] **Step 1: Add no-production-change regressions**

Pin: final evidence scope removes fabricated TCM references; a later abnormal BP wins over an earlier normal BP; comma-separated pathogenesis and therapy text survives fact sanitization inside the sentinel.

- [ ] **Step 2: Run and commit**

Run: `npm run test:tcm-diagnostic-citations && npm run test:safety-mutations && npm run test:client-feedback-20260817`

```bash
git add scripts/test-tcm-diagnostic-citations.mjs scripts/test-safety-mutation-matrix.mjs scripts/test-client-feedback-20260817.mjs
git commit -m "test: pin disproved audit claims"
```

### Task 12: Full verification, deployment, and handoff

**Files:**
- Update generated hashes only through: `scripts/build-clinical-governance-static-tables.mjs`
- Update client evidence report after live proof: `artifacts/comprehensive-review-20260819/build_comprehensive_client_report.py`

- [ ] **Step 1: Regenerate governed fingerprints**

Run: `npm run build:clinical-governance-static-tables && npm run test:clinical-governance-tables`

- [ ] **Step 2: Run the complete release gate**

Run, in order:

```bash
npm run typecheck
npm run lint
npm run test:deterministic
npm run test:deterministic:fresh
npm run build
npm audit --omit=dev --audit-level=high
```

Expected: zero failures, successful production build, zero high/critical production vulnerabilities.

- [ ] **Step 3: Run targeted local/live regressions**

Verify the exact adversarial fixtures introduced above plus the 78-year-old reflux case, `public-082`, `modern-01191`, `modern-12965`, `modern-09432`, and `modern-17304`. Do not resume the remaining 77-case batch unless the user requests it.

- [ ] **Step 4: Build and deploy without compiling on the shared server**

Build standalone locally with immutable commit/digest metadata, rsync the prebuilt runtime context, assemble a runner-only image under a new tag, retain the previous image, and switch Compose with `--no-build`.

- [ ] **Step 5: Verify production and rollback readiness**

Verify image tag, commit, digest, non-root user, container health, strict health, real model probe, fixed customer-token authentication without printing the token, customer isolation, legacy snapshot recovery, RxAudit availability, and targeted cases. Roll back to the previous immutable image on any failed readiness check.

- [ ] **Step 6: Update evidence report and push**

Regenerate the DOCX with original feedback screenshots, point-to-point replies, final screenshots, code/test evidence, and transparent disclosure of the intentionally stopped full regression. Render and visually inspect every page, commit source/report-builder changes, and push `codex/pharmacopoeia-case-regression` only after production proof passes.

## Plan self-review

- Every verified defect in the approved design maps to exactly one implementation task.
- The three disproved claims receive tests only and no production behavior change.
- Model, customer, and snapshot compatibility changes remain fail-closed for unknown providers, invalid customer IDs, and v2 cross-tenant decrypt attempts.
- No task introduces or prints a credential; deployment inherits the protected runtime token.
- The stopped full 77-case run is not silently represented as completed.
