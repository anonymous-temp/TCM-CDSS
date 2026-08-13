// 部署后镜像一致性验证(2026-08-04) + 主模型活性验证(2026-08-13)。
//
// 用途:证明**线上正在跑的镜像**就是本地测过的这份源码。甲方评测第 10 条指出
// 「本地回归全绿但线上行为相反」时,我们没有任何手段区分这两种情况:
//   (a) 代码没修对        —— 该继续改源码
//   (b) 代码修对了但没上线 —— 改源码毫无意义,该查部署链路
// 分不清这两者,就会出现「改了又改还是老样子」。本脚本把它变成一个可判定的问题。
//
// 2026-08-13 追加第三种必须区分的情况:
//   (c) 代码对、也上线了,但上游模型账户已死 —— 2026-08-13 凌晨 DeepSeek 余额耗尽(402),
//       身份验证照样全绿,瘫痪持续约 8 小时才被撞见。身份一致证明不了上游活着,
//       所以本脚本在身份验证之后**强制打一次真实模型调用**(model-health?check=1)。
//
// 用法:
//   BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=xxx node scripts/verify-deployed-image.mjs
// 退出码 0 = 镜像一致**且**主模型真实调用成功;非 0 = 任一不成立或无法证明(都当作部署失败)。
// 只验身份不打模型(例如上游明知在维护窗口): SKIP_MODEL_LIVE_CHECK=1。
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
const identityOk = !provenanceMissing && commitMatches && digestMatches;

// 身份一致后仍要证明上游活着(2026-08-13 402 事故)。model-health?check=1 会发一次
// 真实 completion 请求并校验最终内容流契约;它自带限流(6 次/10 分钟),部署验证单发一次。
// 「无法证明」(网络失败/限流/非 JSON)一律按失败处理,与镜像验证同一条纪律。
async function modelLiveCheck() {
  if (process.env.SKIP_MODEL_LIVE_CHECK === "1") return { skipped: true, ok: true };
  try {
    const res = await fetch(`${BASE_URL}/api/model-health?check=1`, {
      headers: TOKEN ? { "x-cdss-api-token": TOKEN } : {},
    });
    const body = await res.json().catch(() => null);
    const live = body?.liveCheck;
    if (!live || typeof live.ok !== "boolean") {
      return { ok: false, reason: res.status === 429 ? "model_health_rate_limited" : "model_health_unverifiable", status: res.status };
    }
    return {
      ok: live.ok,
      reason: live.ok ? "primary_model_live" : "primary_model_unreachable_or_unfunded",
      provider: live.provider,
      model: live.model,
      ...(live.ok ? {} : { error: live.error || "" }),
    };
  } catch (error) {
    return { ok: false, reason: "model_health_unverifiable", error: String(error?.message || error) };
  }
}

const modelLive = identityOk ? await modelLiveCheck() : { ok: false, reason: "skipped_identity_failed" };
const ok = identityOk && modelLive.ok;

const result = {
  ok,
  reason: !identityOk
    ? (provenanceMissing ? "image_has_no_build_provenance"
      : !commitMatches ? "commit_mismatch"
      : "source_digest_mismatch")
    : !modelLive.ok ? modelLive.reason
    : "image_matches_tested_source_and_model_live",
  local,
  remote: { commit: remote.commit, sourceDigest: remote.sourceDigest, builtAt: remote.builtAt },
  releaseId: health.releaseId,
  strictReady: health.strictReady,
  modelLive,
};
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
