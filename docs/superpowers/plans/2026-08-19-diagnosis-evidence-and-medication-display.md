# Diagnosis Evidence and Medication Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make M03 visibly return evidence-backed TCM disease and syndrome results, standardize Western primary/differential citations, and replace medication-candidate placeholder copy with source-bound label usage fields.

**Architecture:** Add one shared citation contract and one deterministic projection layer that binds governed references before signing. Keep clinical reasoning separate from citation rendering. Parse medication label usage into optional structured fields and render only fields actually present.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5 strict, zod 4, Node `jiti` deterministic tests.

---

### Task 1: Pin the citation and medication-usage contracts

**Files:**
- Modify: `src/lib/diagnosis-types.ts`
- Modify: `scripts/run-deterministic-regression.mjs`
- Create: `scripts/test-diagnostic-citation-contract.mjs`

- [ ] **Step 1: Write the failing contract test**

```js
const reasoning = normalizeReasoningV2(fixture);
assert.equal(reasoning.overview.tcmDiseaseReferences[0].sourceType, "standard");
assert.equal(reasoning.overview.tcmSyndromeReferences[0].sourceType, "standard");
assert.equal(reasoning.westernDiagnosis.differentials[0].guidelineReferences[0].evidenceId, "EVID-GUIDE-001");
assert.equal(reasoning.formula.patentAndWestern[0].administrationTiming, "饭前或空腹时服");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `jiti scripts/test-diagnostic-citation-contract.mjs`

Expected: FAIL because the new fields are absent from the zod-normalized contract.

- [ ] **Step 3: Add the shared schemas and types**

```ts
export type ClinicalCitation = {
  evidenceId: string;
  citation: string;
  url?: string;
  doi?: string;
  pmid?: string;
  sourceType: "standard" | "guideline" | "consensus" | "literature";
};

const ClinicalCitationSchema = z.object({
  evidenceId: z.string().min(3).max(80),
  citation: z.string().min(3).max(600),
  url: z.string().url().max(600).optional(),
  doi: z.string().max(120).optional(),
  pmid: z.string().max(32).optional(),
  sourceType: z.enum(["standard", "guideline", "consensus", "literature"]),
});
```

Add `overview.tcmDiseaseReferences`, `overview.tcmSyndromeReferences`, `westernDiagnosis.differentials[].guidelineReferences`, and `patentAndWestern[].administrationTiming` as optional, isolated arrays/fields.

- [ ] **Step 4: Run the test and typecheck**

Run: `jiti scripts/test-diagnostic-citation-contract.mjs && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Register and commit**

```bash
git add src/lib/diagnosis-types.ts scripts/test-diagnostic-citation-contract.mjs scripts/run-deterministic-regression.mjs
git commit -m "test: define governed diagnostic citation contract"
```

### Task 2: Attach governed TCM disease and syndrome standards

**Files:**
- Create: `src/lib/tcm-diagnostic-citations.ts`
- Modify: `src/lib/diagnosis-api.ts`
- Create: `scripts/test-tcm-diagnostic-citations.mjs`

- [ ] **Step 1: Write RED tests for standard and extension terms**

```js
assert.deepEqual(tcmDiseaseStandardCitations("吐酸").map(x => x.evidenceId), ["STD-GBT-15657-2021"]);
assert.deepEqual(tcmSyndromeStandardCitations("脾胃虚弱证").map(x => x.evidenceId), ["STD-GBT-16751-2-2021"]);
assert.deepEqual(tcmSyndromeStandardCitations("项目扩展证候"), []);
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-tcm-diagnostic-citations.mjs`

Expected: FAIL because the citation resolver does not exist.

- [ ] **Step 3: Implement deterministic resolvers**

```ts
export function tcmDiseaseStandardCitations(value: unknown): ClinicalCitation[] {
  const resolved = resolveTcmDiseaseName(value);
  if (!resolved || !["standard", "standard_alias"].includes(resolved.status)) return [];
  return [{
    evidenceId: "STD-GBT-15657-2021",
    citation: "国家市场监督管理总局, 国家标准化管理委员会. 中医病证分类与代码: GB/T 15657-2021[S]. 2021.",
    sourceType: "standard",
  }];
}
```

Implement the syndrome equivalent through `resolveNationalStandardTcmSyndromeTerm`. Add `applyGovernedTcmDiagnosticCitations(content)` to rewrite only the sentinel object before M03 signature attachment.

- [ ] **Step 4: Wire the transform before signing and rerun**

Run: `jiti scripts/test-tcm-diagnostic-citations.mjs && npm run test:reasoning-signature`

Expected: PASS; citation arrays survive normalization and signature verification.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tcm-diagnostic-citations.ts src/lib/diagnosis-api.ts scripts/test-tcm-diagnostic-citations.mjs
git commit -m "feat: attach governed TCM disease and syndrome citations"
```

### Task 3: Bind standard references to Western differentials

**Files:**
- Modify: `src/lib/cdss-evidence-context.ts`
- Modify: `src/lib/diagnostic-reference-catalog.ts`
- Create: `scripts/test-western-differential-citations.mjs`

- [ ] **Step 1: Write RED tests for reference-only output**

```js
const result = resolveDifferentialReferences(payload, scope, caseState);
assert.equal(result[0].guidelineReferences[0].citation.includes("supports"), false);
assert.equal(result[0].guidelineReferences[0].citation.includes("支持"), false);
assert.match(result[0].guidelineReferences[0].citation, /\b20\d{2}\b/);
assert.ok(result[0].guidelineReferences[0].url?.startsWith("https://"));
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-western-differential-citations.mjs`

Expected: FAIL because differentials do not carry reference arrays.

- [ ] **Step 3: Extend governed reference resolution**

Use each differential name as an additional diagnostic anchor. Resolve only evidence IDs present in the current `EvidenceScope`, assign up to two references per differential, and preserve `reason/distinguishingPoints/nextCheck` outside the citation object.

```ts
differential.guidelineReferences = governedReferencesForAnchors(
  [differential.name], scope, caseState, 2,
);
```

Format `citation` without `appliesTo` or explanatory suffixes.

- [ ] **Step 4: Run evidence and outlet tests**

Run: `jiti scripts/test-western-differential-citations.mjs && npm run test:guideline-reference-outlets && npm run test:evimed-normalization`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cdss-evidence-context.ts src/lib/diagnostic-reference-catalog.ts scripts/test-western-differential-citations.mjs
git commit -m "feat: bind governed citations to Western differentials"
```

### Task 4: Render three diagnoses and separate citations from reasoning

**Files:**
- Modify: `src/lib/clinical-output-authority.ts`
- Modify: `src/app/diagnosis/DiagnosisClient.tsx`
- Modify: `src/lib/diagnosis-visible-summary.ts`
- Modify: `src/lib/his-scheme.ts`
- Create: `scripts/test-diagnosis-citation-presentation.mjs`

- [ ] **Step 1: Write RED presentation tests**

```js
assert.match(clientSource, /辨病：/);
assert.match(clientSource, /辨证：/);
assert.match(clientSource, /tcmDiseaseReferences/);
assert.match(clientSource, /tcmSyndromeReferences/);
assert.doesNotMatch(citationRendererSource, /appliesTo/);
assert.doesNotMatch(citationRendererSource, /reason.*citation|distinguishingPoints.*citation/);
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-diagnosis-citation-presentation.mjs`

Expected: FAIL because disease display is disabled and citation groups do not exist.

- [ ] **Step 3: Implement the shared citation renderer**

Set `TCM_DISEASE_NAME_VISIBLE_TO_CLINICIAN=true`. Render the diagnosis card in this fixed order:

```tsx
<DiagnosisResult label="西医诊断" value={westernName} coding={coding} />
<DiagnosisResult label="辨病" value={tcmDiseaseName} citations={tcmDiseaseReferences} />
<DiagnosisResult label="辨证" value={primarySyndrome} citations={tcmSyndromeReferences} />
```

Render Western differential citations under each differential card. Keep rationale text in `辨病要点`, `辨证要点`, and `鉴别要点` blocks; never concatenate it into citation chips.

- [ ] **Step 4: Verify all four output surfaces**

Run: `jiti scripts/test-diagnosis-citation-presentation.mjs && npm run test:diagnosis-display && npm run test:his-structured-projection && npm run test:visible-output-hygiene`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/clinical-output-authority.ts src/app/diagnosis/DiagnosisClient.tsx src/lib/diagnosis-visible-summary.ts src/lib/his-scheme.ts scripts/test-diagnosis-citation-presentation.mjs
git commit -m "feat: show evidence-backed TCM disease and syndrome results"
```

### Task 5: Parse and show label-bound medication usage

**Files:**
- Create: `src/lib/medication-label-usage.ts`
- Modify: `src/lib/medicine-candidate-planner.server.ts`
- Modify: `src/lib/diagnosis-prompts.ts`
- Modify: `src/app/diagnosis/DiagnosisClient.tsx`
- Modify: `src/lib/diagnosis-visible-summary.ts`
- Create: `scripts/test-medication-label-usage.mjs`

- [ ] **Step 1: Write RED parsing tests with real catalog strings**

```js
assert.deepEqual(parseMedicationLabelUsage("口服，一次3～5克，一日2～3次，饭前或空腹时服。"), {
  route: "口服",
  singleDose: "一次3～5克",
  frequency: "一日2～3次",
  administrationTiming: "饭前或空腹时服",
});
assert.equal(parseMedicationLabelUsage("口服，每日2次").course, undefined);
```

- [ ] **Step 2: Run RED**

Run: `jiti scripts/test-medication-label-usage.mjs`

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement bounded parsing and evidence binding**

Parse only route, single-dose, frequency, administration timing, and explicit course phrases from the same label entry. `localCandidateToProposal` must call the parser on `candidate.usage`; `externalCandidateToProposal` must use structured fields returned by the evidence adapter and must not infer missing values.

- [ ] **Step 4: Remove placeholder display copy**

Update the React and Markdown renderers to omit absent fields. Delete visible output paths containing `本候选不形成疗程医嘱`, `按说明书`, `遵医嘱`, or `待确认`.

- [ ] **Step 5: Run GREEN tests**

Run: `jiti scripts/test-medication-label-usage.mjs && npm run test:local-patent-medicines && npm run test:presentation-contract && npm run test:api-doc-field-parity`

Expected: PASS; 养脾散 exposes route, dose, frequency, timing and no course row.

- [ ] **Step 6: Commit**

```bash
git add src/lib/medication-label-usage.ts src/lib/medicine-candidate-planner.server.ts src/lib/diagnosis-prompts.ts src/app/diagnosis/DiagnosisClient.tsx src/lib/diagnosis-visible-summary.ts scripts/test-medication-label-usage.mjs
git commit -m "fix: render medication label usage instead of course placeholders"
```

### Task 6: Update the external contract and run release verification

**Files:**
- Modify: `docs/中医CDSS-对外接口文档.md`
- Modify: `scripts/test-api-doc-field-parity.mjs`
- Modify: `scripts/e2e-reflux-treatment-evidence.mjs`

- [ ] **Step 1: Document the new M03/M04 fields**

Add `ClinicalCitation`, TCM reference arrays, Western differential references, and `administrationTiming`. State that absent medication course is omitted.

- [ ] **Step 2: Extend the reflux browser/API acceptance assertions**

```js
check("中医辨病与辨证均显示", /辨病.*吐酸/s.test(reportText) && /辨证.*脾胃虚弱/s.test(reportText));
check("中西医引用为标准格式", !/支持.*患者|本例.*支持/.test(referenceText));
check("说明书用法已展示且无占位", /一次3～5克/.test(reportText) && !/本候选不形成疗程医嘱/.test(reportText));
```

- [ ] **Step 3: Run the focused suite**

Run: `npm run test:client-feedback-20260817 && npm run test:customer-review-20260810 && npm run test:guideline-reference-outlets && npm run test:icd10-coding`

Expected: PASS.

- [ ] **Step 4: Run the release gate**

Run: `npm run verify:release`

Expected: typecheck, lint, 155+ deterministic suites twice, and production build all pass.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/中医CDSS-对外接口文档.md scripts/test-api-doc-field-parity.mjs scripts/e2e-reflux-treatment-evidence.mjs
git commit -m "docs: publish evidence and label-usage contract"
```

