import { m03TcmTwoPassPolicy } from "./m03-tcm-policy";
import { deliveryGatePolicy } from "./delivery-gate-policy";
import { M03_TCM_NARRATIVE_PROVIDER_SCHEMA } from "./m03-tcm-narrative";
import criteria from "../data/tcm-diagnostics-syndrome-criteria.json";
import lineage from "../data/tcm-lineage-card-evidence.source.json";
import { m03TcmHash, M03_TCM_CONCLUSION_PROVIDER_SCHEMA } from "./m03-tcm-conclusion";
import factsPolicy from "../data/delivery-facts-policy.source.json";
import nature from "../data/tcm-nature-lexicon.json";
import locations from "../data/tcm-location-lexicon.json";
import textbook from "../data/tcm-textbook-syndrome-formula-table.json";
const governedData = m03TcmHash({ factsPolicy, nature, locations, textbook, criteria, lineage, schemas: [M03_TCM_CONCLUSION_PROVIDER_SCHEMA, M03_TCM_NARRATIVE_PROVIDER_SCHEMA] });
export function r1064GenerationIdentity(env: Record<string, string | undefined> = process.env): string {
  return JSON.stringify({ version: "r1064-wire-v1", twoPass: m03TcmTwoPassPolicy(env), delivery: deliveryGatePolicy(env), governedData,
    checks: Object.fromEntries(["CDSS_M03_SECONDARY_GROUP_CHECK", "CDSS_M03_SECONDARY_BROAD_TRIGGER", "CDSS_HISTORY_STATED_DISEASE"]
      .map(key => [key, env[key] !== "false"])) });
}
