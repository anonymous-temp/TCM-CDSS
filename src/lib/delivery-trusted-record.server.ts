import "server-only";
import { createHash } from "node:crypto";
import policy from "../data/delivery-facts-policy.source.json";
import { isFollowupSkipMessage } from "./followup-conversation";
import { asRecord, pointerToken, stableDeliveryJson } from "./delivery-text";

export type TrustedRecordSource = {
  sourcePath: string; text: string; role: "current" | "history" | "demographics" | "answer" | "mixed";
  /** Keep the whole original field; semantic time/polarity are judged against this context. */
  context: string; questionContext?: string;
};
export type TrustedRecordIndex = { version: string; recordHash: string; sources: TrustedRecordSource[]; hpiPaths: string[]; ageYears?: number };
export const deliveryHash = (value: unknown) => createHash("sha256").update(stableDeliveryJson(value)).digest("hex");
/** Whitelist input partitions. Never index output, assistant questions, gold, safety decisions or citations as patient evidence. */
export function buildTrustedRecordIndex(input: unknown): TrustedRecordIndex {
  const state = asRecord(input);
  const sources: TrustedRecordSource[] = [];
  const hpiPaths: string[] = [];
  const add = (value: unknown, path: string, role: TrustedRecordSource["role"], hpi = false, questionContext?: string) => {
    const visit = (entry: unknown, at: string) => {
      if (typeof entry === "string" || typeof entry === "number") {
        const raw = String(entry);
        if (!raw.trim()) return;
        sources.push({ sourcePath: at, text: raw, role, context: raw, ...(questionContext ? { questionContext } : {}) });
        if (hpi) hpiPaths.push(at);
      } else if (Array.isArray(entry)) entry.forEach((item, index) => visit(item, `${at}/${index}`));
      else if (entry && typeof entry === "object") for (const [key, item] of Object.entries(entry)) {
        if (!policy.machineKeys.includes(key) && !policy.machineTrees.includes(key)) visit(item, `${at}/${pointerToken(key)}`);
      }
    };
    visit(value, path);
  };
  const patient = asRecord(state.patient);
  for (const key of ["sex", "age"]) add(patient[key], `/patient/${key}`, "demographics");
  for (const key of ["chiefComplaint", "tongue", "pulse", "faceNote", "tongueImageDesc"]) add(state[key], `/${key}`, "current");
  for (const key of ["pastHistory", "medicationHistory", "allergyHistory"]) add(state[key], `/${key}`, "history");
  for (const [key, value] of Object.entries(asRecord(state.symptoms))) {
    if (policy.machineTrees.includes(key) || policy.machineKeys.includes(key)) continue;
    add(value, `/symptoms/${pointerToken(key)}`, policy.historyKeys.includes(key) ? "history" : "current", policy.hpiKeys.includes(key));
  }
  for (const [key, value] of Object.entries(asRecord(state.vitals))) add(value, `/vitals/${pointerToken(key)}`, "current");
  const hisRecord = asRecord(state.hisRecord);
  add(hisRecord.rawText, "/hisRecord/rawText", "mixed");
  const fields = asRecord(hisRecord.fields);
  for (const key of policy.hisKeys) add(fields[key], `/hisRecord/fields/${pointerToken(key)}`, policy.historyKeys.includes(key) ? "history" : "current", policy.hpiKeys.includes(key));
  const messages = Array.isArray(state.conversation) ? state.conversation.map(asRecord) : [];
  messages.forEach((message, index) => {
    if (message.role !== "user" || typeof message.content !== "string" || isFollowupSkipMessage(message.content)) return;
    const previous = messages[index - 1];
    add(message.content, `/conversation/${index}/content`, "answer", false,
      previous?.role === "assistant" && typeof previous.content === "string" ? previous.content : undefined);
  });
  const version = policy.version;
  return { version, sources, hpiPaths, recordHash: deliveryHash({ version, sources }), ...(typeof patient.age === "number" ? { ageYears: patient.age } : {}) };
}
export type RecordEvidence = { sourcePath: string; start: number; end: number; quote: string };
export function validRecordEvidence(evidence: RecordEvidence, index: TrustedRecordIndex): boolean {
  const source = index.sources.find((entry) => entry.sourcePath === evidence.sourcePath);
  return Boolean(source && Number.isInteger(evidence.start) && Number.isInteger(evidence.end) && evidence.start >= 0 && evidence.end > evidence.start && evidence.end <= source.text.length && source.text.slice(evidence.start, evidence.end) === evidence.quote);
}
