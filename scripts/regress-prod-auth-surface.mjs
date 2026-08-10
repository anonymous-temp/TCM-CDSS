/**
 * 生产鉴权面实证。
 *
 * 为什么单独一个脚本：`regress:tcm-cdss` 里有 21 条鉴权断言，而它们在 `npm run dev` 上
 * **必然全部失败**——dev 进程按 isCdssAuthRequired 的口径没有开启鉴权，无令牌请求本来就返回 200。
 * 于是这 21 条在本地只能是噪音，真正有意义的运行环境只有 NODE_ENV=production 的部署。
 *
 * 本探针不触发任何模型调用，因此不占用 CDSS_MODEL_RATE_LIMIT_PER_10_MIN 配额。
 *
 * 用法：
 *   BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=<prod-token> node scripts/regress-prod-auth-surface.mjs
 *
 * 注意两个限流桶会**把你自己锁掉 10 分钟**（登录桶 8 次失败、API 令牌桶 20 次失败各一个）。
 * 想连跑或与其他探针串跑时加 SKIP_BRUTEFORCE=1 跳过这两段；单跑时不加，
 * 429 出现本身就是「限流生效」的证据。
 */
// 生产鉴权面实证：dev 服务器上鉴权未启用，21 条鉴权断言在本地必然失败，
// 只有 NODE_ENV=production 的部署上才有意义。本探针**不触发任何模型调用**，
// 因此不占用 CDSS_MODEL_RATE_LIMIT_PER_10_MIN 的配额。
const BASE = (process.env.BASE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const failures = []; let checks = 0;
const ok = (name, cond, detail) => { checks += 1; if (!cond) failures.push({ name, detail }); };
const get = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, text: await res.text().catch(() => "") };
};

for (const [label, path] of [["health", "/api/diagnosis/health"], ["snapshot", "/api/diagnosis/snapshot"],
  ["knowledge", "/api/tcm-knowledge/search?q=%E9%BB%84%E8%8A%AA"], ["future-route", "/api/does-not-exist-yet"]]) {
  const r = await get(path);
  ok(`${label} API 无令牌必须 401（且未来路由先鉴权再 404）`, r.status === 401, `status=${r.status}`);
}
{
  const r = await get("/diagnosis");
  ok("诊断页无令牌必须跳登录", [302, 303, 307, 308].includes(r.status) && /\/login/.test(r.headers.get("location") || ""),
    `status=${r.status} location=${r.headers.get("location")}`);
}
{
  const wrong = await fetch(`${BASE}/api/auth/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "wrong-token-xyz" }) });
  ok("登录接口拒绝错误令牌", wrong.status === 401, `status=${wrong.status}`);
  const good = await fetch(`${BASE}/api/auth/access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  const cookie = good.headers.get("set-cookie") || "";
  ok("登录接口下发 UI 凭证 cookie", good.status === 200 && /tcm_cdss_ui_access=/.test(cookie), `status=${good.status} cookie=${cookie.slice(0, 60)}`);
  ok("cookie 为 HttpOnly", /HttpOnly/i.test(cookie), cookie.slice(0, 160));
  ok("cookie 为 SameSite=Lax", /SameSite=Lax/i.test(cookie), cookie.slice(0, 160));
  ok("cookie 有有限 Max-Age", /Max-Age=\d+/i.test(cookie), cookie.slice(0, 160));
  ok("cookie path 限定在应用子路径", /Path=\/tcm-cdss/i.test(cookie), cookie.slice(0, 160));
  ok("HTTPS 下 cookie 带 Secure", /Secure/i.test(cookie), cookie.slice(0, 160));
}
if (process.env.SKIP_BRUTEFORCE !== "1") {
  // 轮换伪造 IP 不得绕过登录限流
  let last = null;
  for (let i = 0; i < 12; i += 1) {
    last = await fetch(`${BASE}/api/auth/access`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${i}`, "cf-connecting-ip": `198.51.100.${i}` },
      body: JSON.stringify({ token: `wrong-${i}` }) });
  }
  ok("轮换 x-forwarded-for / cf-connecting-ip 不得绕过登录限流", last.status === 429, `status=${last.status}`);
}
{
  const r = await get("/api/diagnosis/health", { headers: { "x-cdss-api-token": TOKEN } });
  ok("正确令牌照常放行", r.status === 200, `status=${r.status}`);
}
for (const [label, headers] of [["sec-fetch-site", { "sec-fetch-site": "same-origin" }],
  ["origin", { origin: BASE }], ["referer", { referer: `${BASE}/diagnosis` }]]) {
  const r = await get("/api/diagnosis/health", { headers });
  ok(`${label} 单独不得绕过 API 令牌鉴权`, r.status === 401, `status=${r.status}`);
}
if (process.env.SKIP_BRUTEFORCE !== "1") {
  let locked = null;
  for (let i = 0; i < 20; i += 1) {
    locked = await get("/api/diagnosis/health", { headers: { "x-cdss-api-token": `wrong-api-token-${i}`, "x-real-ip": "198.51.100.99" } });
  }
  ok("API 令牌爆破被限流", locked.status === 429 && Boolean(locked.headers.get("retry-after")),
    `status=${locked.status} retryAfter=${locked.headers.get("retry-after")}`);
}
console.log(JSON.stringify({ suite: "prod-auth", baseUrl: BASE, checks, failures: failures.length }, null, 2));
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
