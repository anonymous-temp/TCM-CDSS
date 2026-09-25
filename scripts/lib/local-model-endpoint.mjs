/**
 * 本地假模型服务的「物理调用」判定。
 *
 * 【为什么需要它】几条套件用 `createServer().listen(0, "127.0.0.1")` 起假上游，再数请求次数来钉
 * 重试预算（SDK 重试 2 次 / 应用层自管重试 0 次 / 断连恢复恰好 1 次）。它们原先把**每一个到达的
 * HTTP 请求**都算成一次模型调用。
 *
 * 2026-09-25 实测：本机的 IDE 宿主进程（`t3 serve`，会话预览功能）会对新出现的 localhost 监听端口
 * 发一次 `GET /`（user-agent `node`），通常落在 listen 之后 ~250ms。于是凡是监听超过这个时长的
 * 夹具（SDK 退避 ~450ms 的 socket 用例、在夹具里现 import 模块的术语探针用例）约 17% 的运行会多数
 * 一次：`3 !== 2` / `2 !== 1`。用 `ss -tnp` 按来源端口反查到的属主就是 t3 进程——不是 keep-alive、
 * 不是 SDK 多重试、也不是计数竞态。
 *
 * 所以计数口径收窄到「被测代码实际会发的那种请求」：POST …/chat/completions。其它请求一律 404
 * 且不计数、不推进夹具状态（例如「第 1 次调用断连」不能被探测请求吃掉）。这不放松断言：
 * 被测代码若改打别的路径，会拿到 404 并且计数对不上，照样红。
 */
export function isModelAttempt(req) {
  if (req.method !== "POST") return false;
  const { pathname } = new URL(req.url || "/", "http://127.0.0.1");
  return pathname.endsWith("/chat/completions");
}

/** 非模型请求（如宿主端口探测）：排空请求体、回 404、不计数。返回 true 表示已处理。 */
export async function answerNonModelRequest(req, res) {
  if (isModelAttempt(req)) return false;
  for await (const chunk of req) void chunk;
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not a model endpoint");
  return true;
}
