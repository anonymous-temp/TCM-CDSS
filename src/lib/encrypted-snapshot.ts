export type EncryptedSnapshotEnvelope = {
  schemaVersion: "tcm-cdss-encrypted-snapshot-v1" | "tcm-cdss-encrypted-snapshot-v2";
  algorithm: "A256GCM";
  iv: string;
  ciphertext: string;
  authTag: string;
  updatedAt: string;
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CIPHERTEXT_CHARS = 3 * 1024 * 1024;

export function isEncryptedSnapshotEnvelope(value: unknown): value is EncryptedSnapshotEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.schemaVersion === "tcm-cdss-encrypted-snapshot-v1" ||
      record.schemaVersion === "tcm-cdss-encrypted-snapshot-v2") &&
    record.algorithm === "A256GCM" &&
    typeof record.iv === "string" && record.iv.length === 16 && BASE64.test(record.iv) &&
    typeof record.authTag === "string" && record.authTag.length === 24 && BASE64.test(record.authTag) &&
    typeof record.ciphertext === "string" && record.ciphertext.length > 0 && record.ciphertext.length <= MAX_CIPHERTEXT_CHARS && BASE64.test(record.ciphertext) &&
    typeof record.updatedAt === "string" && Number.isFinite(Date.parse(record.updatedAt));
}
