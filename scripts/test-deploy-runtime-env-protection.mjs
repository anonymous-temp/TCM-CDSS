// 生产部署脚本的承重检查（2026-09-25 起钉 scripts/deploy/，原钉已删除的 scripts/deploy-prod.sh）。
//
// 旧 deploy-prod.sh 把 compose 项目名写死成 tcm-cdss-prod，而线上自 2026-09-11 起是 green 容器原地替换；
// 照它部署会「看起来成功、实际没上线」。现行脚本原在 ~/runlogs/ 仓库外，落库时逐项迁移了保护：
// 受保护 runtime env 同步前后比对、compose 空环境解析、Token 三方一致 + 基线 0600/属主、按个数回收镜像、
// 预编译产物与待部署版本逐项核对。本套件分三层钉：源码顺序/形状、真实 rsync/env/python 行为、
// 以及用假 ssh/rsync 驱动真实部署脚本走到每一道拒绝关（没有任何网络访问）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const deployDir = fileURLToPath(new URL("./deploy/", import.meta.url));
const deployScript = path.join(deployDir, "deploy-green-inplace-prebuilt.sh");
const prebuildScript = path.join(deployDir, "prebuild-local.sh");
const commonScript = path.join(deployDir, "common.sh");
const deriveScript = path.join(deployDir, "derive-runtime-dockerfile.sh");
const deploySource = readFileSync(deployScript, "utf8");
const prebuildSource = readFileSync(prebuildScript, "utf8");
const commonSource = readFileSync(commonScript, "utf8");
// 只看代码行：头注释会引用旧项目名、旧做法来解释为什么不这么做。
const deployCode = deploySource.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const refute = (source, pattern, message) => assert.ok(!pattern.test(source), `${message} (matched ${pattern})`);
const repoDockerfile = fileURLToPath(new URL("../Dockerfile", import.meta.url));
let checks = 0;
const check = (fn) => { fn(); checks += 1; };

assert.equal(existsSync(fileURLToPath(new URL("./deploy-prod.sh", import.meta.url))), false,
  "stale deploy-prod.sh (hard-coded -p tcm-cdss-prod) must not come back: following it deploys a container nginx never routes to");

// ── 1. 源码顺序与形状 ─────────────────────────────────────────────────────────────────────
const at = (needle) => {
  const index = deploySource.indexOf(needle);
  assert.ok(index >= 0, `deploy script must contain: ${needle}`);
  return index;
};
const preflightAt = at("ENV_DIGEST_BEFORE=");
const syncAt = at('rsync -az --delete -e "$SSH" "${CDSS_DEPLOY_SYNC_PATHS[@]}"');
const postflightAt = at("ENV_DIGEST_AFTER=");
const expectedTokenAt = at("EXPECTED_TOKEN_HASH=");
const runningBeforeAt = at("RUNNING_TOKEN_HASH_BEFORE=");
const tokenBaselineAt = at("TOKEN_BASELINE_HASH=");
const packageAt = at('echo "=== 运行层打包');
const cutoverAt = at('echo "=== 原地替换');
const actualTokenAt = at("RUNNING_TOKEN_HASH_AFTER=");

check(() => assert.ok(preflightAt < syncAt, "runtime env must be present and fingerprinted before source sync"));
check(() => assert.ok(postflightAt > syncAt && postflightAt < packageAt && postflightAt < cutoverAt,
  "runtime env must be rechecked after sync and before image packaging/cutover"));
check(() => assert.match(deploySource,
  /RUNTIME_ENV="\$\{DEPLOY_RUNTIME_ENV:-\/home\/ubuntu\/tcm-cdss\/\.env\.prod\.runtime\}"/,
  "runtime env must live at a stable deployment-owned path outside synchronized releases"));
check(() => assert.match(deploySource, /COMPOSE_ARGS="[^"\n]*--env-file '\$RUNTIME_ENV'/,
  "compose must consume the deployment-owned env path rather than a release-local copy"));
check(() => assert.match(deploySource, /CLEAN_COMPOSE_ENV="env -i PATH=/,
  "compose interpolation must run with an empty inherited environment"));
check(() => {
  const composeCalls = deploySource.match(/docker compose \$COMPOSE_ARGS[^\n]*/g) || [];
  assert.equal(composeCalls.length, 2, "exactly two compose invocations (config + up)");
  for (const line of deploySource.split("\n").filter((l) => l.includes("docker compose $COMPOSE_ARGS"))) {
    assert.ok(line.includes("$CLEAN_COMPOSE_ENV $COMPOSE_ENV docker compose"), `compose must run under env -i: ${line.trim()}`);
  }
});
check(() => assert.ok(expectedTokenAt > postflightAt && expectedTokenAt < cutoverAt && actualTokenAt > cutoverAt,
  "the effective token must be compared to the live container before and after cutover"));
check(() => assert.ok(runningBeforeAt > postflightAt && runningBeforeAt < cutoverAt,
  "the running container's token must be read before it is replaced"));
check(() => assert.ok(tokenBaselineAt > expectedTokenAt && tokenBaselineAt < packageAt,
  "an independent protected token baseline must be checked before packaging and cutover"));
check(() => assert.match(deploySource, /"\$EXPECTED_TOKEN_HASH" != "\$RUNNING_TOKEN_HASH_BEFORE"/,
  "deployment must refuse a token change before replacing the running container"));
check(() => assert.match(deploySource, /"\$TOKEN_BASELINE_HASH" != "\$EXPECTED_TOKEN_HASH"/,
  "every deployment must compare the stable runtime token to the independent baseline"));
check(() => {
  const inspects = deploySource.match(/docker inspect --format '\{\{json \.Config\.Env\}\}' '\$CONTAINER'/g) || [];
  assert.equal(inspects.length, 2, "token invariance must read immutable container config (before and after cutover)");
  refute(deployCode, /docker exec[^\n]*CDSS_API_TOKEN/,
    "token invariance must not require the old or new container process to be running");
});
check(() => assert.match(deploySource,
  /TOKEN_BASELINE_PATH="\$\{DEPLOY_TOKEN_BASELINE_PATH:-\/home\/ubuntu\/tcm-cdss\/\.cdss-api-token\.sha256\}"/,
  "token baseline must live outside synchronized release directories"));
check(() => {
  assert.match(deploySource, /stat -c %a '\$TOKEN_BASELINE_PATH'/, "every deployment must verify baseline permissions");
  assert.match(deploySource, /stat -c %u '\$TOKEN_BASELINE_PATH'/, "every deployment must verify baseline ownership");
});
check(() => {
  // 原地替换总有旧容器与既有基线：缺基线一律拒绝，脚本里不存在任何写基线的路径。
  assert.match(deploySource, /if \[ -z "\$TOKEN_BASELINE_HASH" \]; then\n\s+echo "!![^\n]*"[^\n]*exit 1/,
    "a missing token baseline must fail closed");
  refute(deployCode, /ALLOW_TOKEN_BASELINE_BOOTSTRAP|>\s*'\$TOKEN_BASELINE_PATH|mv [^\n]*TOKEN_BASELINE_PATH/,
    "the in-place deploy must never create or rewrite the token baseline");
});
check(() => {
  // 线上拓扑参数化，且不得回到旧的写死项目名。
  refute(deployCode, /tcm-cdss-prod/, "compose project/container must not be hard-coded to the stale tcm-cdss-prod");
  assert.match(deploySource, /COMPOSE_ARGS="-p '\$PROJECT' [^"\n]*-f '\$NEW_DIR\/\$OVERRIDE_REL'"/,
    "compose must target the parameterized green project and the release-ops override");
  for (const required of ["IMAGE_TAG", "PREBUILT_DIR", "DEPLOY_REMOTE_DIR", "DEPLOY_OVERRIDE_REL"]) {
    assert.match(deploySource, new RegExp(`\\$\\{${required}:\\?`), `${required} must be required (stale defaults were measured failures)`);
  }
});
check(() => {
  const preSsh = deploySource.slice(0, preflightAt);
  assert.match(preSsh, /\.prebuilt-meta/, "prebuilt meta must be verified before any remote step");
  assert.match(preSsh, /"\$META_COMMIT" != "\$COMMIT" \] \|\| \[ "\$META_DIGEST" != "\$DIGEST"/,
    "prebuilt meta must match both commit and source digest");
});
check(() => {
  assert.match(deploySource, /docker build[\s\S]*?\| tail -4"\n\$SSH "\$USER@\$HOST" "docker image inspect 'tcm-cdss:\$TAG' >\/dev\/null" \|\| \{/,
    "remote build output is truncated, so image existence must be re-verified independently");
  assert.match(deploySource, /\[ "\$RUNNING" = "tcm-cdss:\$TAG" \] \|\|/, "only the running image equal to the tag counts as deployed");
});
check(() => {
  assert.match(deploySource, /sort -k2 -r \| head -n \$KEEP_IMAGES/, "image pruning must be count-based, not time-based");
  assert.match(deploySource, /reference='tcm-cdss:\*'/, "only tcm-cdss images may be pruned on the shared host");
  assert.match(deploySource, /\[ "\$\{AVAIL_GB:-0\}" -ge "\$MIN_FREE_GB" \]/, "disk floor must be enforced before packaging");
});

// ── 2. 白名单只写一处，且不含运行时密钥 ──────────────────────────────────────────────────────
const syncPaths = execFileSync("bash", ["-c", `source '${commonScript}'; printf '%s\\n' "\${CDSS_DEPLOY_SYNC_PATHS[@]}"`], { encoding: "utf8" })
  .trim().split("\n");
check(() => {
  assert.ok(syncPaths.includes("src") && syncPaths.includes("docker-compose.yml") && syncPaths.includes(".env.example"));
  assert.equal(syncPaths.some((entry) => /\.env\.prod|^\.env$|runtime/.test(entry)), false,
    "runtime secrets must never become a source-synchronized path");
  assert.equal(new Set(syncPaths).size, syncPaths.length, "sync whitelist has no duplicates");
});
check(() => {
  for (const [name, source] of [["deploy", deploySource], ["prebuild", prebuildSource]]) {
    assert.ok(source.includes('"${CDSS_DEPLOY_SYNC_PATHS[@]}"'), `${name} must use the shared whitelist from common.sh`);
    refute(source, /\bsrc package\.json package-lock\.json\b/, `${name} must not carry its own copy of the whitelist`);
  }
});
check(() => {
  // 预编译的 basePath / 持久化开关必须等于运行层镜像写进 .next-build-* 的 Dockerfile ARG 缺省值。
  const runner = readFileSync(repoDockerfile, "utf8").split(/^FROM node:24-alpine AS runner$/m)[1] || "";
  for (const name of ["NEXT_PUBLIC_BASE_PATH", "NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE"]) {
    const argDefault = runner.match(new RegExp(`^ARG ${name}="([^"]*)"$`, "m"))?.[1];
    assert.ok(argDefault, `Dockerfile runner stage declares ${name}`);
    const assigned = prebuildSource.match(new RegExp(`^[^#\\n]*\\b${name}=(\\S+)`, "m"))?.[1];
    assert.equal(assigned, argDefault,
      `prebuild ${name} must equal the runner ARG default "${argDefault}" (container refuses to start otherwise)`);
  }
  refute(prebuildSource, /^[^#\n]*NEXT_DEPLOYMENT_ID=/m, "prebuild must not set NEXT_DEPLOYMENT_ID (changes static asset URLs)");
});

// ── 3. 运行层 Dockerfile 派生：对仓库 Dockerfile 跑同一个脚本 ──────────────────────────────────
check(() => {
  const derived = execFileSync("sh", [deriveScript, repoDockerfile], { encoding: "utf8" });
  assert.doesNotMatch(derived, /from=builder/);
  assert.deepEqual(derived.split("\n").filter((line) => line.startsWith("COPY")), [
    "COPY public ./public",
    "COPY --chown=nextjs:nodejs standalone ./",
    "COPY --chown=nextjs:nodejs static ./.next/static",
  ]);
  assert.match(derived, /^FROM node:24-alpine AS runner$/m);
});
const work = mkdtempSync(path.join(tmpdir(), "tcm-cdss-deploy-guard-"));
check(() => {
  // 旧版远端用 `! grep -q from=builder` 做守卫——set -e 不会因取反命令失败而退出，那道守卫从未生效。
  const original = readFileSync(repoDockerfile, "utf8");
  assert.ok(original.includes("COPY --from=builder /app/public ./public\n"));
  const drifted = path.join(work, "Dockerfile.drifted");
  // 同样 3 行 COPY，但有一行改了形状、改写规则套不上：只有 from=builder 守卫拦得住。
  writeFileSync(drifted, original.replace("COPY --from=builder /app/public ./public\n", "COPY --from=builder --chown=nextjs:nodejs /app/public ./public\n"));
  const unrewritten = spawnSync("sh", [deriveScript, drifted], { encoding: "utf8" });
  assert.notEqual(unrewritten.status, 0, "an unrewritten COPY --from=builder must fail the derivation");
  assert.match(unrewritten.stderr, /from=builder/);
  // 新增一行上下文里没有的 COPY：只有行数守卫拦得住。
  const extra = path.join(work, "Dockerfile.extra");
  writeFileSync(extra, original.replace("USER nextjs\n", "COPY scripts/entrypoint.sh ./entrypoint.sh\nUSER nextjs\n"));
  const extraCopy = spawnSync("sh", [deriveScript, extra], { encoding: "utf8" });
  assert.notEqual(extraCopy.status, 0, "a new runner COPY the prebuilt context cannot provide must fail the derivation");
  assert.match(extraCopy.stderr, /COPY 行数/);
});

// ── 4. 真实 rsync / env -i / python 行为 ───────────────────────────────────────────────────
check(() => {
  // 部署用的「多源 + --delete」形态：源码侧陈旧文件照删，发布目录外的 runtime env 不可达。
  const source = path.join(work, "source");
  const destination = path.join(work, "destination");
  const runtimeEnv = path.join(work, ".env.prod.runtime");
  mkdirSync(path.join(source, "src"), { recursive: true });
  mkdirSync(path.join(destination, "src"), { recursive: true });
  writeFileSync(path.join(source, "src", "app.ts"), "export const ok = true;\n");
  writeFileSync(path.join(source, "package.json"), "{}\n");
  writeFileSync(runtimeEnv, "CDSS_API_TOKEN=synthetic-test-only\n");
  writeFileSync(path.join(destination, "src", "obsolete.ts"), "stale\n");
  writeFileSync(path.join(destination, "docker-compose.yml.pre-abc1234"), "rollback copy\n");
  execFileSync("rsync", ["-az", "--delete", path.join(source, "src"), path.join(source, "package.json"), `${destination}/`]);
  assert.equal(readFileSync(runtimeEnv, "utf8"), "CDSS_API_TOKEN=synthetic-test-only\n",
    "source sync must preserve the runtime env byte-for-byte");
  assert.equal(existsSync(path.join(destination, "src", "obsolete.ts")), false,
    "source-owned obsolete files should still be removed by --delete");
  assert.equal(existsSync(path.join(destination, "docker-compose.yml.pre-abc1234")), true,
    "top-level rollback compose backups survive the multi-source --delete");
});
check(() => {
  const cleanEnvironment = execFileSync("env", ["-i", `PATH=${process.env.PATH || "/usr/bin:/bin"}`, "sh", "-c", 'printf %s "${CDSS_API_TOKEN-}"'], {
    env: { ...process.env, CDSS_API_TOKEN: "shell-override-must-not-survive" },
    encoding: "utf8",
  });
  assert.equal(cleanEnvironment, "", "env -i must remove an inherited token before compose interpolation");
});
const sharedPy = (name) => execFileSync("bash", ["-c", `source '${commonScript}'; printf %s "$${name}"`], { encoding: "utf8" });
check(() => {
  // 部署脚本实际嵌进远端的 python 片段（取自 common.sh），不是本测试另写一份。
  for (const name of ["CDSS_DEPLOY_TOKEN_FROM_ENV_PY", "CDSS_DEPLOY_TOKEN_FROM_COMPOSE_PY"]) {
    assert.doesNotMatch(sharedPy(name), /'/, `${name} is embedded in single quotes remotely and must not contain one`);
  }
  const expected = createHash("sha256").update("stable-runtime-token").digest("hex");
  const fromStoppedConfig = execFileSync("python3", ["-c", sharedPy("CDSS_DEPLOY_TOKEN_FROM_ENV_PY")], {
    input: JSON.stringify(["NODE_ENV=production", "CDSS_API_TOKEN=stable-runtime-token", "CDSS_RELEASE_ID=old-release"]),
    encoding: "utf8",
  }).trim();
  assert.equal(fromStoppedConfig, expected, "stopped-container config must yield the token hash without docker exec");
  const fromCompose = execFileSync("python3", ["-c", sharedPy("CDSS_DEPLOY_TOKEN_FROM_COMPOSE_PY")], {
    input: JSON.stringify({ services: { "tcm-cdss": { environment: { CDSS_API_TOKEN: "stable-runtime-token" } } } }),
    encoding: "utf8",
  }).trim();
  assert.equal(fromCompose, expected, "compose-resolved token must hash identically");
  const missing = spawnSync("python3", ["-c", sharedPy("CDSS_DEPLOY_TOKEN_FROM_ENV_PY")], { input: JSON.stringify(["NODE_ENV=production"]) });
  assert.notEqual(missing.status, 0, "a container without CDSS_API_TOKEN must not yield a hash");
});

// ── 5. 用假 ssh/rsync 驱动真实部署脚本走到每一道拒绝关 ──────────────────────────────────────
const bin = path.join(work, "bin");
mkdirSync(bin);
const sshLog = path.join(work, "ssh.log");
// 假 ssh：记录远端命令（最后一个参数），按命令形状回放 FAKE_* 取值；第二次读 env 摘要回放 FAKE_ENV_DIGEST_AFTER。
writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env bash
cmd="\${!#}"
printf '%s\\n----\\n' "$cmd" >> "$FAKE_LOG"
case "$cmd" in
  *"sha256sum"*)
    if [ -f "$FAKE_LOG.env-read" ]; then printf '%s\\n' "\${FAKE_ENV_DIGEST_AFTER:-$FAKE_ENV_DIGEST}"; else touch "$FAKE_LOG.env-read"; printf '%s\\n' "$FAKE_ENV_DIGEST"; fi ;;
  *"config --format json"*) printf '%s\\n' "$FAKE_EXPECTED" ;;
  *"stat -c %a"*) printf '%s' "$FAKE_BASELINE" ;;
  *".Config.Env"*) printf '%s\\n' "$FAKE_RUNNING" ;;
esac
exit 0
`);
writeFileSync(path.join(bin, "rsync"), `#!/usr/bin/env bash\nprintf 'RSYNC %s\\n----\\n' "$*" >> "$FAKE_LOG"\n`);
chmodSync(path.join(bin, "ssh"), 0o755);
chmodSync(path.join(bin, "rsync"), 0o755);
// 最小源码树：部署脚本在 DEPLOY_SRC 里取 HEAD 与源摘要（摘要脚本换成固定输出，避免扫 481MB 语料）。
const fakeSrc = path.join(work, "src-tree");
mkdirSync(path.join(fakeSrc, "scripts"), { recursive: true });
writeFileSync(path.join(fakeSrc, "scripts", "build-source-digest.mjs"), 'console.log(JSON.stringify({ digest: "synthetic-digest" }));\n');
const git = (...args) => execFileSync("git", ["-C", fakeSrc, ...args], { encoding: "utf8" }).trim();
git("init", "-q");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "synthetic");
const head = git("rev-parse", "HEAD");
const prebuilt = path.join(work, "prebuilt");
for (const part of [".next/standalone", ".next/static", "public"]) mkdirSync(path.join(prebuilt, part), { recursive: true });
const key = path.join(work, "synthetic-key");
writeFileSync(key, "not a real key\n");

const token = "a".repeat(64);
function runDeploy(overrides = {}, { meta = { COMMIT: head, DIGEST: "synthetic-digest" } } = {}) {
  writeFileSync(sshLog, "");
  rmSync(`${sshLog}.env-read`, { force: true });
  writeFileSync(path.join(prebuilt, ".prebuilt-meta"), `COMMIT=${meta.COMMIT}\nDIGEST=${meta.DIGEST}\nSTAMP=2026-09-25T00:00:00Z\n`);
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: work, FAKE_LOG: sshLog,
    IMAGE_TAG: "synthetic-tag", PREBUILT_DIR: prebuilt, DEPLOY_REMOTE_DIR: "/srv/release", DEPLOY_OVERRIDE_REL: "release-ops/override.yml",
    DEPLOY_SRC: fakeSrc, DEPLOY_KEY: key, DEPLOY_HOST: "deploy.invalid",
    FAKE_ENV_DIGEST: "env-digest", FAKE_EXPECTED: token, FAKE_RUNNING: token, FAKE_BASELINE: token,
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const result = spawnSync("bash", [deployScript], { env, encoding: "utf8", timeout: 60_000 });
  return { ...result, remote: readFileSync(sshLog, "utf8") };
}
const cutoverReached = (run) => /compose[^\n]* up -d/.test(run.remote);
const packagingReached = (run) => /docker build -f|docker create/.test(run.remote);

for (const missing of ["IMAGE_TAG", "PREBUILT_DIR", "DEPLOY_REMOTE_DIR", "DEPLOY_OVERRIDE_REL"]) {
  check(() => {
    const run = runDeploy({ [missing]: undefined });
    assert.notEqual(run.status, 0, `${missing} missing must fail`);
    assert.equal(run.remote, "", `${missing} missing must fail before any remote command`);
  });
}
check(() => {
  const run = runDeploy({}, { meta: { COMMIT: "0".repeat(40), DIGEST: "synthetic-digest" } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /不一致，拒绝部署/);
  assert.equal(run.remote, "", "a prebuilt artifact for another commit must be refused before any remote command");
});
check(() => {
  const run = runDeploy({}, { meta: { COMMIT: head, DIGEST: "stale-digest" } });
  assert.notEqual(run.status, 0);
  assert.equal(run.remote, "", "a prebuilt artifact with another source digest must be refused before any remote command");
});
check(() => {
  const run = runDeploy({ FAKE_ENV_DIGEST: "" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /受保护运行时配置缺失/);
  assert.equal(run.remote.includes("RSYNC"), false, "a missing runtime env must stop before source sync");
});
check(() => {
  const run = runDeploy({ FAKE_ENV_DIGEST_AFTER: "changed-by-sync" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /源码同步改变了受保护运行时配置/);
  assert.ok(run.remote.includes("RSYNC"));
  assert.equal(run.remote.includes("config --format json") || cutoverReached(run), false,
    "a runtime env changed by sync must stop before compose resolution and cutover");
});
check(() => {
  const run = runDeploy({ FAKE_BASELINE: "__INVALID__" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /0600/);
  assert.equal(packagingReached(run) || cutoverReached(run), false, "an unsafe baseline file must stop the deployment");
});
check(() => {
  const run = runDeploy({ FAKE_BASELINE: "" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /基线缺失/);
  assert.equal(packagingReached(run) || cutoverReached(run), false, "a missing baseline must fail closed");
});
check(() => {
  const run = runDeploy({ FAKE_RUNNING: "b".repeat(64) });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /三方不一致/);
  assert.equal(packagingReached(run) || cutoverReached(run), false, "a token that differs from the live container must stop before replacement");
});
check(() => {
  const run = runDeploy({ FAKE_EXPECTED: "" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /三方不一致/);
  assert.equal(packagingReached(run) || cutoverReached(run), false, "an unresolvable compose token must stop the deployment");
});
check(() => {
  // 三方一致时越过 Token 关，被下一道（磁盘下限，假主机报 0G）拦住——证明上面几例拦在 Token 关而非更早。
  const run = runDeploy();
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, /Token 三方一致/);
  assert.match(run.stderr, /磁盘可用/);
  assert.equal(packagingReached(run) || cutoverReached(run), false);
  assert.ok(run.remote.includes("env -i PATH=") && run.remote.includes("--env-file '/home/ubuntu/tcm-cdss/.env.prod.runtime'"),
    "compose resolution must run under env -i with the deployment-owned env file");
  assert.ok(run.remote.includes(`cp -p '/srv/release/docker-compose.yml' '/srv/release/docker-compose.yml.pre-${head.slice(0, 7)}'`),
    "the pre-deploy compose must be backed up (rollback = old image + old compose)");
  assert.ok(run.remote.indexOf("docker-compose.yml.pre-") < run.remote.indexOf("RSYNC"), "the compose backup must precede source sync");
});

console.log(JSON.stringify({ suite: "deploy-runtime-env-protection", checks, failures: 0 }));
