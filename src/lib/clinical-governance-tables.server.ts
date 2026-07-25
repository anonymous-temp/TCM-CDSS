import "server-only";

import governanceManifestJson from "../data/clinical-governance-table-manifest.json" with { type: "json" };
import governanceSourceRegistryJson from "../data/clinical-governance-source-registry.json" with { type: "json" };
import formulaCatalogJson from "../data/tcm-formula-governed-catalog.json" with { type: "json" };
import herbIdentityCatalogJson from "../data/tcm-herb-identity-catalog.json" with { type: "json" };
import { CLINICAL_GOVERNANCE_TABLES } from "./clinical-governance-tables";

/**
 * Server-only aggregate. T8/T9 are deliberately excluded from the isomorphic module because
 * their multi-megabyte indexes must never be pulled into the browser bundle by convenience imports.
 */
export const ALL_CLINICAL_GOVERNANCE_TABLES = {
  ...CLINICAL_GOVERNANCE_TABLES,
  formula: formulaCatalogJson,
  herbIdentity: herbIdentityCatalogJson,
} as const;

export const CLINICAL_GOVERNANCE_MANIFEST = governanceManifestJson;
export const CLINICAL_GOVERNANCE_SOURCE_REGISTRY = governanceSourceRegistryJson;
