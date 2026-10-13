/**
 * 服务端自己发起的预先计算请求的标记（2026-10-13，追问跳过零等待）。
 *
 * 追问发出时，服务端按「不回答」把辨证、开方先算出来（no-answer-precompute.server.ts），做法是经本机回环
 * 调自己的 diagnose / prescribe 接口——走的是与调用方完全相同的路由、鉴权、租户绑定与结果复用指纹。
 * 这些请求要与调用方的请求区分开两件事：不计入调用方的模型调用限流（否则每个病例多占两次额度），
 * 不写入临床请求留存（否则留存里每个病例多出两条不是调用方发的请求）。
 *
 * 标记值由服务端密钥派生，调用方即使知道接口令牌也造不出来；它不放宽鉴权——回环请求照样带着调用方的令牌。
 * 只用 WebCrypto，proxy 与路由两侧都能算。
 */
export const INTERNAL_PRECOMPUTE_HEADER = "x-cdss-internal-precompute";

let cachedToken: Promise<string> | undefined;

export function internalPrecomputeToken(): Promise<string> {
  if (!cachedToken) {
    const secret = process.env.REASONING_CONTRACT_SIGNING_KEY || "";
    cachedToken = secret.length < 16
      ? Promise.resolve("")
      : crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tcm-cdss-internal-precompute:${secret}`))
          .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
  }
  return cachedToken;
}

export async function isInternalPrecomputeRequest(headers: Headers): Promise<boolean> {
  const supplied = headers.get(INTERNAL_PRECOMPUTE_HEADER) || "";
  if (supplied.length !== 64) return false;
  const expected = await internalPrecomputeToken();
  if (!expected || expected.length !== supplied.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return diff === 0;
}
