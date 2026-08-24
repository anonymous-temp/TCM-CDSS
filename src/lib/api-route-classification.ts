/**
 * Complete API surface classification. Any new route must be deliberately assigned before release.
 * Paths are repository-relative so the deterministic test can compare them with the filesystem.
 */
export const GLOBAL_API_ROUTES = [
  "src/app/api/auth/access/route.ts",
  "src/app/api/diagnosis/health/route.ts",
  "src/app/api/model-health/route.ts",
  "src/app/api/tcm-knowledge/drug-catalog/route.ts",
  "src/app/api/tcm-knowledge/herb-function/route.ts",
  "src/app/api/tcm-knowledge/search/route.ts",
] as const;

export const CUSTOMER_BOUND_API_ROUTES = [
  "src/app/api/customers/register/route.ts",
  "src/app/api/drug-inventory/route.ts",
  "src/app/api/diagnosis/assess/route.ts",
  "src/app/api/diagnosis/collect/route.ts",
  "src/app/api/diagnosis/diagnose/route.ts",
  "src/app/api/diagnosis/emergency-clearance/route.ts",
  "src/app/api/diagnosis/his-scheme/route.ts",
  "src/app/api/diagnosis/post-prescription-risk/route.ts",
  "src/app/api/diagnosis/prescribe/route.ts",
  "src/app/api/diagnosis/question/interpret/route.ts",
  "src/app/api/diagnosis/question/route.ts",
  "src/app/api/diagnosis/red-flags/route.ts",
  "src/app/api/diagnosis/snapshot/route.ts",
  "src/app/api/diagnosis/terminology/confirm/route.ts",
  "src/app/api/tenant-audit/route.ts",
] as const;
