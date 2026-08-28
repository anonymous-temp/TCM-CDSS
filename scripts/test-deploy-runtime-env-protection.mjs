import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const expectedTokenAt = deploySource.indexOf("EXPECTED_TOKEN_HASH=");
const deployAt = deploySource.indexOf('echo "=== deploy ==="');
const actualTokenAt = deploySource.indexOf("RUNNING_TOKEN_HASH_AFTER=");
const tokenBaselineAt = deploySource.indexOf("TOKEN_BASELINE_HASH=");

assert.ok(preflightAt >= 0 && preflightAt < syncAt,
  "runtime env must be present and fingerprinted before source sync");
assert.ok(syncAt >= 0 && postflightAt > syncAt && buildAt > postflightAt,
  "runtime env must be rechecked after sync and before image build");
assert.match(deploySource,
  /RUNTIME_ENV="\$\{DEPLOY_RUNTIME_ENV:-\/home\/ubuntu\/tcm-cdss\/\.env\.prod\.runtime\}"/,
  "runtime env must live at a stable deployment-owned path outside synchronized releases");
assert.match(deploySource, /--env-file '\$RUNTIME_ENV'/,
  "compose must consume the deployment-owned env path rather than a release-local copy");
assert.match(deploySource, /CLEAN_COMPOSE_ENV="env -i PATH=/,
  "compose interpolation must run with an empty inherited environment");
assert.ok(expectedTokenAt > postflightAt && expectedTokenAt < deployAt && actualTokenAt > deployAt,
  "the effective token must be compared to the live container before and after cutover");
assert.ok(tokenBaselineAt > expectedTokenAt && tokenBaselineAt < deployAt,
  "an independent protected token baseline must be checked before cutover");
assert.match(deploySource, /EXPECTED_TOKEN_HASH.*RUNNING_TOKEN_HASH_BEFORE/s,
  "deployment must refuse a token change before replacing the running container");
assert.match(deploySource, /docker inspect --format '\{\{json \.Config\.Env\}\}' tcm-cdss-prod-tcm-cdss-1/,
  "token invariance must read immutable container config so a stopped container remains recoverable");
assert.doesNotMatch(deploySource, /docker exec tcm-cdss-prod-tcm-cdss-1[^\n]*CDSS_API_TOKEN/,
  "token invariance must not require the old or new container process to be running");
assert.match(deploySource,
  /TOKEN_BASELINE_PATH="\$\{DEPLOY_TOKEN_BASELINE_PATH:-\/home\/ubuntu\/tcm-cdss\/\.cdss-api-token\.sha256\}"/,
  "token baseline must live outside synchronized release directories");
assert.match(deploySource,
  /\[ -z "\$RUNNING_TOKEN_HASH_BEFORE" \] && \[ "\$ALLOW_TOKEN_BASELINE_BOOTSTRAP" != "true" \]/,
  "missing old container and missing baseline must fail closed unless first deployment is explicit");
assert.match(deploySource, /umask 077; tmp='\$TOKEN_BASELINE_PATH\.tmp'/,
  "baseline bootstrap must use a private atomic file outside the release tree");
assert.ok(deploySource.includes(String.raw`chmod 600 \"\$tmp\"; mv`),
  "baseline bootstrap must explicitly tighten a pre-existing temp file before atomic replacement");
assert.match(deploySource, /stat -c %a '\$TOKEN_BASELINE_PATH'/,
  "every deployment must verify baseline permissions rather than trusting umask history");
assert.match(deploySource, /stat -c %u '\$TOKEN_BASELINE_PATH'/,
  "every deployment must verify that the baseline remains owned by the deployment user");
assert.match(deploySource, /TOKEN_BASELINE_HASH" != "\$EXPECTED_TOKEN_HASH/,
  "every deployment must compare the stable runtime token to the independent baseline");

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

const cleanEnvironment = execFileSync("env", [
  "-i",
  `PATH=${process.env.PATH || "/usr/bin:/bin"}`,
  "sh",
  "-c",
  'printf %s "${CDSS_API_TOKEN-}"',
], {
  env: { ...process.env, CDSS_API_TOKEN: "shell-override-must-not-survive" },
  encoding: "utf8",
});
assert.equal(cleanEnvironment, "", "env -i must remove an inherited token before compose interpolation");

const syntheticStoppedConfig = JSON.stringify([
  "NODE_ENV=production",
  "CDSS_API_TOKEN=stable-runtime-token",
  "CDSS_RELEASE_ID=old-release",
]);
const inspectedHash = execFileSync("python3", [
  "-c",
  'import hashlib,json,sys; values=json.load(sys.stdin); value=next((item.split("=",1)[1] for item in values if item.startswith("CDSS_API_TOKEN=")), None); value is not None or sys.exit(1); print(hashlib.sha256(value.encode()).hexdigest())',
], { input: syntheticStoppedConfig, encoding: "utf8" }).trim();
assert.equal(inspectedHash, createHash("sha256").update("stable-runtime-token").digest("hex"),
  "stopped-container config must yield the same token hash without docker exec");

console.log(JSON.stringify({ suite: "deploy-runtime-env-protection", checks: 22, failures: 0 }));
