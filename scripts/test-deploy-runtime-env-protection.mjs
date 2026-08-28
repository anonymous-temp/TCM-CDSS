import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const deploySource = readFileSync(new URL("./deploy-prod.sh", import.meta.url), "utf8");
const preflightAt = deploySource.indexOf("ENV_DIGEST_BEFORE=");
const syncAt = deploySource.indexOf("rsync -az --delete");
const postflightAt = deploySource.indexOf("ENV_DIGEST_AFTER=");
const buildAt = deploySource.indexOf('echo "=== build ==="');

assert.ok(preflightAt >= 0 && preflightAt < syncAt,
  "runtime env must be present and fingerprinted before source sync");
assert.ok(syncAt >= 0 && postflightAt > syncAt && buildAt > postflightAt,
  "runtime env must be rechecked after sync and before image build");
assert.match(deploySource,
  /RUNTIME_ENV="\$\{DEPLOY_RUNTIME_ENV:-\/home\/ubuntu\/tcm-cdss\/\.env\.prod\.runtime\}"/,
  "runtime env must live at a stable deployment-owned path outside synchronized releases");
assert.match(deploySource, /--env-file '\$RUNTIME_ENV'/,
  "compose must consume the deployment-owned env path rather than a release-local copy");

const syncPathsBlock = deploySource.match(/SYNC_PATHS=\(([\s\S]*?)\n\)/)?.[1] || "";
assert.doesNotMatch(syncPathsBlock, /\.env\.prod\.runtime/,
  "runtime secrets must never become a source-synchronized path");

// Behavior-level parity for the exact multi-source + --delete shape used by deploy-prod.sh.
// Source cleanup remains effective, while a runtime env outside the synchronized release is unreachable.
const root = mkdtempSync(path.join(tmpdir(), "tcm-cdss-deploy-env-"));
const source = path.join(root, "source");
const destination = path.join(root, "destination");
const runtimeEnv = path.join(root, ".env.prod.runtime");
mkdirSync(path.join(source, "src"), { recursive: true });
mkdirSync(path.join(destination, "src"), { recursive: true });
writeFileSync(path.join(source, "src", "app.ts"), "export const ok = true;\n");
writeFileSync(path.join(source, "package.json"), "{}\n");
writeFileSync(runtimeEnv, "CDSS_API_TOKEN=synthetic-test-only\n");
writeFileSync(path.join(destination, "src", "obsolete.ts"), "stale\n");

execFileSync("rsync", [
  "-az",
  "--delete",
  path.join(source, "src"),
  path.join(source, "package.json"),
  `${destination}/`,
]);

assert.equal(
  readFileSync(runtimeEnv, "utf8"),
  "CDSS_API_TOKEN=synthetic-test-only\n",
  "source sync must preserve the runtime env byte-for-byte",
);
assert.equal(existsSync(path.join(destination, "src", "obsolete.ts")), false,
  "source-owned obsolete files should still be removed by --delete");

console.log(JSON.stringify({ suite: "deploy-runtime-env-protection", checks: 6, failures: 0 }));
