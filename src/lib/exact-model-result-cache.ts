import { createHmac, randomBytes } from "node:crypto";

/** Process-local, bounded and non-persistent. Keys cannot be dictionary-matched to patient text. */
export class ExactModelResultCache<T> {
  private readonly secret = randomBytes(32);
  private readonly entries = new Map<string, { expiresAt: number; value: T }>();

  constructor(private readonly ttlMs = 60_000, private readonly maxEntries = 128) {}

  key(parts: unknown): string {
    return createHmac("sha256", this.secret).update(JSON.stringify(parts)).digest("hex");
  }

  get(key: string): T | undefined {
    this.prune();
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry.value) : undefined;
  }

  set(key: string, value: T): void {
    this.prune();
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value: structuredClone(value) });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}
