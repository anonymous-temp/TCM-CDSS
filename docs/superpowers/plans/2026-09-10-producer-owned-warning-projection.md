# Producer-Owned Warning Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking. Preserve other workers' files and do not operate the production server from an implementation task.

**Goal:** Stop ordinary follow-up and lifestyle advice from becoming a current-prescription L4 verdict, consistently in HIS, the browser, downloaded reports and newly saved/restored workspaces.

**Architecture:** Producers retain separate display text and current-risk text before joining them. The server owns provenance verification and risk classification; the browser consumes a small report-bound display receipt, never a permission grant. Persisted receipts reuse the existing HMAC key and existing encrypted workspace payload; snapshot encryption never signs caller-provided conclusions, and HIS always recomputes rather than trusting a receipt.

**Tech Stack:** Existing Next.js 16.3.3 / React 19 / TypeScript / Zod 4, Node crypto, browser Web Crypto, current jiti/node:test harness. No new dependency, key, endpoint, model call, clinical blocking condition or confirmation dialog.

---

## Evidence and boundaries

Base application commit: `594f124a6c4de2805a7d512fcc2fef359c83ea82`.

The isolated candidate's nine fixed HIS scenarios produced ten HTTP calls including identity verification and two failed assertions in **one** scenario. Its effective audit was `MANUAL_REVIEW/MEDIUM`, non-degraded, with `warnings=[]`. The only L4 reason was M05 lifestyle advice containing “严禁过度劳累”. The model-authored `lifestyle` field is written under `## 生活管理`, then the joined risk assessment is scanned as if every sentence were a present medication finding.

Evidence remains in `artifacts/tencent-release-20260910-his-alignment/594f124a-release/candidate-his-projection-golden/`. Do not alter those observations or the old golden results.

Actual `BLOCK`, effective `CRITICAL`, selected HIGH herb pairs, independent T1/related codes, current-patient risk text and unknown/extra/legacy text remain effective. Do not add an “overwork” phrase exception, ignore all of “随访管理方案/注意事项”, or use a model/client `reference` flag as server authority. `actualRiskIndicators`, current audit findings and the broader precautions are not automatically advice.

The previous shared provenance import added 5,675,596 bytes to the largest browser chunk; its gzip size rose from 6,378,818 to 7,398,447 bytes. Remove that new full-catalog dependency by moving local provenance verification to the server. Do not refactor the unrelated pre-existing 39 MB bundle in this change.

## File ownership

- Pure display: create `src/lib/medicine-rendering.ts`; update the imports in `diagnosis-visible-summary.ts`.
- Server provenance: move local catalog verification into `src/lib/medicine-reference-projection.server.ts`; create `src/lib/clinical-warning-projection.server.ts`.
- Producer fragments: create `src/lib/warning-text-projection.ts`; update `diagnosis-safety.ts` and M04 narrative render helpers without changing displayed text.
- Shared state/binding: create `src/lib/followup-display-state.ts`, `src/lib/warning-display-binding.ts`, `src/lib/warning-display-observation.ts`, and `src/lib/warning-display-storage.ts`. Extract existing pure persistence/restoration functions into a focused pure module if required to avoid a server import of browser storage code.
- Receipt authentication: create `src/lib/warning-display-receipt.server.ts` using the existing signing key.
- Boundaries: update `assess/route.ts`, `post-prescription-risk/route.ts`, `his-scheme/route.ts`, `snapshot/route.ts`, `his-scheme.ts`, `diagnosis-stream-protocol.ts`, `diagnosis-engine.ts` and `DiagnosisClient.tsx` only at the relevant producer/consumer points.
- Tests: extend `test-his-projection-alignment.mjs`, the existing stream/snapshot/restore/export tests and `regress-tcm-cdss.mjs`; add focused binding/receipt/transport tests and register them in the existing deterministic family.

## Task 1: Reproduce the complete advice-domain defect

- [x] Add offline assertions using the real `buildDeterministicRiskFollowupPayload` and existing complete HIS fixtures. Do not mock the classification function.

```js
const authored = {
  reviewFocus: "复评乏力与活动耐量，严禁过早判定疗效。",
  efficacyCriteria: "与首诊记录比较，不把自然波动当成治愈。",
  lifestyle: "规律作息，严禁过度劳累。",
  dimensions: ["精力", "食欲", "大便"],
  monitoringIndicators: ["活动耐量", "神疲变化", "实际用药"],
  timeline: [],
};
const state = benign();
const followup = buildDeterministicRiskFollowupPayload(state, authored);
assert.match(followup.markdown, /严禁过度劳累/);
const result = buildHisAiSchemePayload(
  { ...state, riskAssessment: followup.markdown },
  undefined,
  [],
  scope(state),
  { riskAssessment: followup },
);
assert.notEqual(result.warningProfile.level, "L4");
assert.equal(result.prescriptions.herbal[0].adoptable, true);
```

Use the real projected HIS result to assert that this source advice does not create L4, that the advice remains visible and that the otherwise usable herbal item stays usable. Add the same sentence outside its producer-owned domain as a negative control. Add real `BLOCK/CRITICAL`, selected incompatible pairs and independent T1 controls.

- [x] Run the focused target and record the intended RED failure before application edits; commit the failing tests.

```sh
npm run test:his-projection-alignment
git add scripts/test-his-projection-alignment.mjs
git commit -m "test: reproduce follow-up advice becoming a medication verdict"
```

## Task 2: Preserve provenance before text is flattened

- [x] Implement a small producer-only composition primitive.

```ts
export type AdviceText = Readonly<{ kind: "advice"; text: string }>;
export type WarningTextProjection = Readonly<{
  markdown: string;
  currentRiskMarkdown: string;
}>;
export type OwnedCaseWarningProjection = Readonly<{
  prescription?: WarningTextProjection;
  riskAssessment?: WarningTextProjection;
}>;

export function adviceText(text: string): AdviceText {
  return { kind: "advice", text };
}

export function joinWarningText(
  parts: readonly (string | AdviceText)[],
): WarningTextProjection {
  return {
    markdown: parts.map((part) => typeof part === "string" ? part : part.text).join("\n"),
    currentRiskMarkdown: parts.map((part) => typeof part === "string" ? part : "").join("\n"),
  };
}
```

These objects come from application code, not model JSON or request fields. In the existing M05 array, wrap future planning/authoring entries at construction time: first review plan, reviewFocus, efficacyCriteria, future disposition plan, six-dimension follow-up questions and lifestyle. Preserve `actualRiskIndicators`, actual audit findings, missing/vital facts and broader precautions as current text. Do not classify by the adjective that happens to appear in a value.

Integration refinement (2026-09-10): the already formatted safety grade, summary and doctor-action sentences are presentation, not independent risk evidence. For example, “当前无确定性强提示” must not promote an actual MEDIUM audit to L3 merely because it includes “强提示”. Keep their displayed bytes and existing summary generation, but carry the current producer's effective audit result, highest risk and availability as explicit internal classifier inputs instead of re-reading those formatted sentences. Actual HIGH/BLOCK/CRITICAL still applies with audit presentation disabled. This does not authorize removing an existing structured revision BLOCK/CRITICAL: a matching display hash proves freshness, not that a newer audit supersedes an attested prior revision. Keep that independent floor; same-scope audit supersession is outside this change.

- [x] Return the existing Markdown and timeline unchanged, plus the internal `currentRiskMarkdown`. Apply the same final sanitization pipeline to display and projected text, with producer section context preserved. The wire text must remain byte-equivalent for fixed fixtures.
- [x] Split `medicineCandidateRow/Table` into the pure rendering module. Keep catalog lookup and canonical label clause verification server-only. Extend server M04 projection to exact signed diet/lifestyle/emotion renderings in their own producer domain; preserve additional copies, changed values, nested/current-risk text and unknown sections.
- [x] Keep `deriveCaseWarningProfile` as a pure classifier with explicit text inputs supplied by the server adapter. Never let it auto-consume a request's observation, profile or claimed projection. Browser fallback remains conservative and does not import the local medicine catalog.
- [x] Have HIS supply only internally produced final risk text after normal signature/current-candidate validation. Its existing independent T1 and adoption checks remain in force. A mismatched internal projection falls back conservatively without deleting the clinical report or inventing a new HTTP rejection.
- [x] Re-run the focused and neighboring suites, and commit GREEN.

## Task 3: Share final display and restoration reducers

- [x] Move the existing `replaceRiskAssessmentFollowup` and its extraction dependencies from `DiagnosisClient.tsx` into the pure shared module without changing their behavior. Define `applyCompletedM05DisplayResult(previous, result, resolvedCustomerId): CaseState` with the exact existing order: parse audit marker, strip it, merge final risk text, install timeline/auditAdvisory, clear completed-run fields, set `phase=done`, and apply the existing safety normalization.
- [x] Use that reducer on server and browser. Compute a receipt only after all final sanitization, timeline stripping and marker/state changes. Apply the same merge to the producer's current-risk representation; do not accidentally retain an old advice section when its current-risk representation is empty. The request binding comes from the normalized original submitted case before route-only semantic-facts enrichment. The final display material must be reproducible from that submitted state and the actual wire result; do not hash server-only fields that the browser never receives. Fresh owned facts and audit findings still participate in the server-computed profile.
- [x] Extract the existing storage sanitizer, `reconcileRestoredCaseState` and `recoverInterruptedRun` into a server-safe pure restoration boundary. Do not move localStorage/network operations into a server import, re-enable `saveCase/loadCase`, or change existing privacy, TTL, interrupted-run and unsaved-workbench rules.

```ts
export function restoreWarningDisplayCase(
  value: unknown,
  runningPhase?: Phase,
): CaseState | undefined {
  const normalized = normalizeCaseStateInput(value);
  if (!normalized) return undefined;
  return recoverInterruptedRun(
    reconcileRestoredCaseState(
      withSafetyGate(sanitizeCaseStateForBrowserPersistence(normalized)),
    ),
    runningPhase,
  );
}
```

All four functions in this expression are the existing implementations, extracted and re-exported rather than reimplemented with different rules.

## Task 4: Bind small observations, not copies of clinical data

- [x] Define the receipt and finite schemas. Reject malformed version/digest/profile combinations, oversized reasons and duplicate/conflicting transport observations. Invalid metadata is omitted; it must not discard a readable report.

```ts
export type WarningDisplayView = {
  materialHash: `sha256:${string}`;
  profile: ClinicalWarningProfile;
};
export type WarningDisplayReceipt = {
  version: "tcm-warning-display-receipt-v1";
  projectionVersion: "warning-projection-v1";
  producer: "assess" | "post-prescription-risk";
  clientId: string;
  customerId: string;
  caseId: string;
  encounterId: string;
  requestHash: `sha256:${string}`;
  live: WarningDisplayView;
  stored: WarningDisplayView;
  mac: `hmac-sha256:${string}`;
};
```

- [x] Implement stable JSON with deterministic code-unit key ordering, array order retained, undefined object fields omitted and no clinical text rewriting. Do not use locale-dependent ordering or recursively remove every field named `signature`/`updatedAt`.

```ts
export function stableWarningJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonical(record[key])]));
  };
  return JSON.stringify(canonical(value));
}

export async function warningDisplayHash(material: string): Promise<`sha256:${string}`> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
```

`warningDisplayMaterial` uses the shared normalized clinical state and authorized customer. It retains clinical inputs, full M03/M04 content/signatures, selected candidate, revision, risk/audit state and final reports/timeline. Only explicitly non-material top-level save timestamps, export acknowledgement and `previousResult` are excluded. Test ordinary normalization/copying as well as every material edit.

- [x] Sign only producer-computed live and stored views, using the existing 32-character signing-key policy and a new message namespace, not a new key.

```ts
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { stableWarningJson } from "./warning-display-binding";
import type { WarningDisplayReceipt } from "./warning-display-binding";

const DOMAIN = "tcm-cdss-warning-display-receipt-v1\0";
function receiptMac(unsigned: Omit<WarningDisplayReceipt, "mac">): string | undefined {
  const key = process.env.REASONING_CONTRACT_SIGNING_KEY?.trim() || "";
  if (key.length < 32) return undefined;
  return `hmac-sha256:${createHmac("sha256", key)
    .update(DOMAIN).update(stableWarningJson(unsigned)).digest("hex")}`;
}
```

Verification strictly parses first, compares authorized client/customer/case/encounter, recalculates the MAC and uses equal-length `timingSafeEqual`. The stored view is calculated from the actual sanitized/restored state, not by copying the live hash/profile. Preserve typed provenance through that view transformation; mismatching or additional text stays current. Missing keys/invalid receipts only omit the observation. The use of `timingSafeEqual` belongs in the verifier, not in the signing function shown above.

## Task 5: Wire current display and existing encrypted restoration

- [x] Add a distinct outer NDJSON metadata frame before END, and an optional top-level post-risk JSON field. Never derive it from content, sentinel text or a model object.

```ts
type WarningProfileFrame = {
  type: "warning_profile";
  observation: WarningDisplayReceipt;
};
```

Only the designated consumers enable collection. Content-embedded lookalikes, duplicates, metadata after END, truncated/error/cancelled streams do not install an observation. Report content is still delivered normally.

- [x] In the current-generation M05/workbench completion path, compute request/display hashes asynchronously with Web Crypto. After awaiting, recheck request epoch, active case/customer, cancellation and the exact current material key. Install the observation and corresponding completed state together. Use synchronous material-key equality on each render to invalidate stale cached data immediately; do not rely only on object identity or an asynchronous effect.
- [x] Make the badge, `ResultPanel`, `handleDownloadReport` and `confirmReportExport` share one resolver. Merge only independent structural danger floors such as current selected pairs and revision BLOCK/CRITICAL; do not merge the whole old prose scanner back into a matched observation. Recheck state/epoch after async export work so a prior confirmation does not export a different patient's report.
- [x] Keep receipts out of live CaseState, model input and HIS authority. Persist only a currently matching receipt in the existing workspace object using a storage-only reserved field. Do not revive per-case plaintext persistence.

```ts
export function withWarningStorageReceipt(
  payload: Record<string, unknown>,
  matchingReceipt?: WarningDisplayReceipt,
): Record<string, unknown> {
  const { __tcmWarningDisplayReceipt: ignored, ...core } = payload;
  void ignored;
  return matchingReceipt ? { ...core, __tcmWarningDisplayReceipt: matchingReceipt } : core;
}
```

- [x] Keep snapshot encryption and AES-GCM v1/v2 compatibility unchanged. Encryption must not sign arbitrary caller metadata. On successful decryption, verify the optional HMAC receipt for only the explicit workspace-v1/case payload shapes and their restored material hash; add an optional **top-level** `verifiedWarningObservation` beside the unchanged payload. Invalid receipts do not make valid ciphertext or clinical data fail restoration. No recursive search for arbitrary profile objects.
- [x] Restore clients install only that verified top-level observation after their final restoration projection and async hash/epoch checks; a receipt inside raw payload is never sufficient. Save-sequence guards must cover both the new hash await and the existing encryption await. Update autosave dependencies so a just-installed receipt is actually included in the next save.

## Task 6: Prove the class and rebuild one final candidate

Implementation checkpoint (2026-09-10): Tasks 1–5 are implemented. The focused warning-display suite now has 24 passing tests, including actual M05/post-risk producers, page save/export callbacks and actual encrypted restoration. HIS projection, RxAudit route/normalization/presentation, snapshot ownership, reasoning signatures, formula restoration, prescription permission, stream and display neighbors pass; typecheck/lint/diff checks pass. Independent full-feature specification and quality reviews, both deterministic modes, bundle measurements and isolated candidate live acceptance remain pending below.

Binding refinement: the clinical reducers and classifiers continue to receive only parsed, tenant-validated state. A server-only binding helper may preserve validated original wire text bytes and narrowly absent HIS/face bookkeeping dates for hashing; it requires equivalence to the authorized parsed shape, rejects non-corresponding arrays, and uses explicit producer-owned final fields even for equal-value writes. Missing/empty bookkeeping dates stay absent through the shared restoration adapter. Supplied nested dates and signed clinical artifacts remain bound. Post-risk JSON uses the optional top-level `warningObservation`; its typed timeline remains separate from Markdown.

- [ ] Add and execute RED/GREEN tests for: advice in each producer slot; exact same current/unknown/nested risk; actual T1/pairs/BLOCK/CRITICAL; UI badge/download parity; content-forged and duplicate metadata; customer mismatch; edits during hashing/export; workspace save races; forged public hashes with wrong MAC; cross-tenant valid MAC; changed restored data; arbitrary snapshot payload/v1/v2 compatibility; legitimate redaction/date truncation; interrupted/unsaved cases; and HIS ignoring even a valid display receipt.
- [ ] Extend fixed HTTP cases with an actual stubbed authoring response in offline route tests, then rerun the same nine real HTTP cases without altering their adoption expectations. A stochastic re-run that happens not to say “严禁” is not the class proof.
- [ ] Run focused, stream, snapshot, signature, HIS and safety neighbors, then typecheck/lint and both deterministic modes. Complete independent specification and code-quality reviews.

```sh
npm run typecheck
npm run lint
npm run test:deterministic
JITI_FS_CACHE=false npm run test:deterministic:fresh
```

- [ ] Verify the client dependency graph no longer imports the new full local-medicine index. Compare the resulting main chunk with the retained e4b and 594 files; report actual raw and gzip bytes, not an invented page-load speedup.
- [ ] Freeze commit/digest, build through the already verified isolated native/AMD64 process, update only versioned one-off deployment constants and test their guards. Do not compile on production or recreate 3016.
- [ ] Run targeted HIS HTTP, full golden, customer cases and M03/M04 smoke on the isolated candidate. Keep M03's measured 66.811-second maximum and earlier uncertainty observations visible until a fresh result or explicit release decision resolves them. Do not set an all-pass attestation for a nonzero raw suite exit.

## Completion and limits

New generated and newly saved/restored workspaces must not reacquire the advice-induced L4. Missing/forged/incompatible old observations fall back conservatively without adding an HTTP block or deleting report content. Existing actual clinical restrictions and snapshot authorization remain unchanged. The public old service remains online throughout preparation; production cutover is a separate verified operation.

Self-review: all current-risk obligations are represented in Tasks 1–2 and 6; browser and restored parity are covered by Tasks 3–5; no additional clinical/provider calls or keys are introduced; raw report text, arbitrary snapshot payload behavior, real fixture expectations and old production continuity are preserved.
