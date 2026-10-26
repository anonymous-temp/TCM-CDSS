import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { CaseState } from "./diagnosis-types";
import { stageResultReuseEnabled } from "./stage-result-coalescing.server";

/**
 * 同一份病历的语义事实只抽一次（2026-10-26 甲方测评「相同病历输出一致性」「红旗预警前后不同一」）。
 *
 * 辨证、开方的结果早已按病历内容留存 30 天（stage-result-coalescing.server.ts），但红旗检查接口不在其内，
 * 而它读的语义事实只在进程内缓存 5 分钟（空结果 150 秒）。同一份病历隔半小时再测，事实层重新抽样：
 * 本机逐字回放甲方 10/26 的红旗请求，「月经先期」4 次里 1–2 次判「宜先由西医专科尽快评估」，其余判门诊可处理；
 * 辨证、开方却是复用的第一次结果——同一次就诊里两步各说各的。
 *
 * 做法：事实抽取成功（已签名、覆盖完整）后按「租户 + 病历文本指纹 + 抽取版本 + 代码版本 + 模型」加密落盘；
 * 进程内缓存未命中时先读这里，读到就按本次时间重新签名后使用。与阶段结果复用同一开关（生产默认开，
 * CDSS_STAGE_RESULT_REUSE=false 一起关）、同一目录（CDSS_STAGE_RESULT_STORE_PATH 下的 clinical-facts/）、
 * 同一保留期（CDSS_STAGE_RESULT_PERSIST_DAYS，缺省 30 天）。病历改一个字指纹就变，照常重新抽取；
 * 换版本或换模型同样不回放。抽取失败的结果一律不写。
 */
const PERSIST_CONTEXT = "tcm-cdss-clinical-facts-store-v1";

function storeDir(): string | undefined {
  const dir = process.env.CDSS_STAGE_RESULT_STORE_PATH?.trim();
  return dir ? join(dir, "clinical-facts") : undefined;
}

function storeKey(): Buffer | undefined {
  const secret = process.env.CASE_SNAPSHOT_ENCRYPTION_KEY || "";
  if (secret.length < 16) return undefined;
  return createHmac("sha256", createHash("sha256").update(secret).digest()).update(PERSIST_CONTEXT).digest();
}

function retentionMs(): number {
  const days = Number(process.env.CDSS_STAGE_RESULT_PERSIST_DAYS);
  return (Number.isFinite(days) && days > 0 && days <= 365 ? days : 30) * 86_400_000;
}

export function clinicalFactsStoreEnabled(): boolean {
  return stageResultReuseEnabled() && Boolean(storeDir()) && Boolean(storeKey());
}

/** 留存键：缓存键（租户 + 病历文本指纹）之外再绑定抽取版本、代码版本与模型。 */
export function clinicalFactsStoreKey(cacheKey: string, identity: readonly string[]): string {
  return createHash("sha256")
    .update([process.env.CDSS_BUILD_SOURCE_DIGEST || "", ...identity, cacheKey].join("\n"))
    .digest("hex");
}

function storePath(dir: string, key: string): string {
  return join(dir, key.slice(0, 2), `${key}.bin`);
}

export async function readPersistedClinicalFacts(key: string): Promise<NonNullable<CaseState["clinicalFacts"]> | undefined> {
  const dir = storeDir();
  const secret = storeKey();
  if (!dir || !secret || !stageResultReuseEnabled()) return undefined;
  try {
    const path = storePath(dir, key);
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > retentionMs()) return undefined;
    const raw = await readFile(path);
    const decipher = createDecipheriv("aes-256-gcm", secret, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`clinical-facts|${key}`, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    const facts = JSON.parse(gunzipSync(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])).toString("utf8")) as unknown;
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) return undefined;
    const value = facts as NonNullable<CaseState["clinicalFacts"]>;
    return value.semanticStatus === "checked" && Array.isArray(value.redFlags) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writePersistedClinicalFacts(key: string, facts: CaseState["clinicalFacts"]): Promise<void> {
  const dir = storeDir();
  const secret = storeKey();
  if (!dir || !secret || !stageResultReuseEnabled()) return;
  if (!facts?.attestation || facts.semanticStatus !== "checked" || facts.sourceCoverage !== "full") return;
  try {
    const path = storePath(dir, key);
    await mkdir(join(dir, key.slice(0, 2)), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(Buffer.from(`clinical-facts|${key}`, "utf8"));
    const unsigned: Record<string, unknown> = { ...facts };
    delete unsigned.attestation;
    delete unsigned.resultSource;
    const data = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(unsigned), "utf8"))), cipher.final()]);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    console.warn("[tcm-cdss:telemetry] clinical_facts_persist", { ok: false, reason: error instanceof Error ? error.name : "unknown" });
  }
}
