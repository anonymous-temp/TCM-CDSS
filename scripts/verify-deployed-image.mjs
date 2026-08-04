// 部署后镜像一致性验证(2026-08-04)。
//
// 用途:证明**线上正在跑的镜像**就是本地测过的这份源码。甲方评测第 10 条指出
// 「本地回归全绿但线上行为相反」时,我们没有任何手段区分这两种情况:
//   (a) 代码没修对        —— 该继续改源码
//   (b) 代码修对了但没上线 —— 改源码毫无意义,该查部署链路
// 分不清这两者,就会出现「改了又改还是老样子」。本脚本把它变成一个可判定的问题。
//
// 用法:
//   BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=xxx node scripts/verify-deployed-image.mjs
// 退出码 0 = 线上镜像与本地源码一致;非 0 = 不一致或无法证明(两者都必须当作部署失败)。
import { execFileSync } from "node:child_process";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";

function localDigest() {
  return execFileSync("node", ["scripts/build-source-digest.mjs", "--quiet"], { encoding: "utf8" }).trim();
}

function localCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const response = await fetch(`${BASE_URL}/api/diagnosis/health`, {
  headers: TOKEN ? { "x-cdss-api-token": TOKEN } : {},
});
if (!response.ok && response.status !== 503) {
  console.error(JSON.stringify({ ok: false, reason: "health_unreachable", status: response.status }));
  process.exit(2);
}
const health = await response.json();
const remote = health.build || {};
const local = { commit: localCommit(), digest: localDigest() };

// 「unknown」必须判失败而不是跳过:构建没把溯源打进去,与镜像不一致是同一种后果——
// 都意味着我们无法证明线上跑的是测过的代码。静默放过等于把元缺陷留在原地。
const provenanceMissing = remote.commit === "unknown" || remote.sourceDigest === "unknown" || !remote.commit;
const commitMatches = remote.commit === local.commit;
const digestMatches = remote.sourceDigest === local.digest;
const ok = !provenanceMissing && commitMatches && digestMatches;

const result = {
  ok,
  reason: ok ? "image_matches_tested_source"
    : provenanceMissing ? "image_has_no_build_provenance"
    : !commitMatches ? "commit_mismatch"
    : "source_digest_mismatch",
  local,
  remote: { commit: remote.commit, sourceDigest: remote.sourceDigest, builtAt: remote.builtAt },
  releaseId: health.releaseId,
  strictReady: health.strictReady,
};
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
