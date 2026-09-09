# Tencent release execution

**Goal:** Deploy the verified continuity fixes to the configured Tencent server, run real API checks, and push the exact released source to the user's GitHub repository without changing the customer Token.

## Confirmed targets

- Server: ubuntu@82.156.128.153; current production container tcm-cdss-prod-tcm-cdss-1, loopback port3016, basePath /tcm-cdss.
- GitHub: anonymous-temp/TCM-CDSS, main=ef000456; authenticated GitHub API reports push/admin access.
- Starting candidate: 2b468270 on codex/20260909-delivery-continuity, clean; prior202 normal+202 fresh/typecheck/lint/build passed.
- 3ec22b4 is absent from local and GitHub; never claim it was merged. The known HIS permission contradiction will be independently fixed from reproduced behavior before cutover, consistent with the user's earlier remediation request.

## Implementation / verification sequence

- [ ] Push the existing reviewed branch as a remote checkpoint; main stays unchanged until release checks pass.
- [ ] HIS bounded fix: one predicate around existing rejectionTier for code+relatedCodes; T1 and an existing L4/non-executable disposition must not coexist with candidateStatus=valid or adoptable=true. Keep payload/clinical text and workflowPermission=continue; T2 quality notes do not gain new restrictions. Add executed RED then GREEN, first-request/historical-PASS/fresh-audit/collapsed-code counterexamples and benign controls; independently review.
- [ ] Migrate only the golden assertions that require old blanket422/no-payload behavior. Assert the replacement business contract: useful report and accurate warnings, explicit fields, T1 adoption state consistency and no fabricated auditPASS. Do not skip cases, delete failures or relax unrelated clinical assertions.
- [ ] Build immutable image in an isolated resource-limited Linux/amd64 builder; keep current production running. No global prune, no unrelated container changes, retain rollback image and production volume.
- [ ] Start a separate loopback candidate project with separate runtime volume, protected existing environment, same authenticationToken/provider settings, same build/runtime basePath. Verify Token equality without exposing value/hash. No production limit changes.
- [ ] Run candidate authenticated strict health, exact source/commit check, model probe, golden baseline and targetedM03/M04/HIS smoke. Distinguish legacy contract, infrastructure and real failures; persist evidence.
- [ ] Fast-forward main only after checking current remote tip; push branch and main without force. Verify remoteSHA.
- [ ] Switch production to the tested image using the existing production project/volume and stable runtime environment. Verify publicTLS, authenticatedstrictReady, image/source/commit alignment, Token invariance, model configuration and focused live smoke. Roll back if new release fails these checks.
- [ ] Remove only this task's candidate/build resources after checking them, preserving artifacts and productionrollback. Report remaining clinical issues honestly; this release is not proof that everyhistorical customer requirement is closed.

## Resource decision

Server currently has approximately5GB availableRAM and24GB disk, swap full. Builds must be contained and cannot assume6GB free just because npm's heap ceiling is6GB. Use a dedicated capped builder or a separate build environment; do not stop unrelated services to make space.
