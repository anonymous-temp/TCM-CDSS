#!/bin/sh
# 从仓库 Dockerfile 截取 runner 段，把三处 `COPY --from=builder` 换成「从打包上下文拷贝」，
# 得到只做运行层打包的 Dockerfile（主机不编译，见 deploy-green-inplace-prebuilt.sh）。
# 部署时在主机上对**刚同步的** Dockerfile 运行；闸门 test:deploy-runtime-env-protection 对仓库
# Dockerfile 运行同一个脚本——runner 段一改，闸门先红，而不是部署到一半才失败。
# 用法：derive-runtime-dockerfile.sh <Dockerfile> > Dockerfile.prebuilt
set -eu
src="${1:?Dockerfile path}"
out="$(sed -n '/^FROM node:24-alpine AS runner/,$p' "$src" \
  | sed -e 's#^COPY --from=builder /app/public ./public#COPY public ./public#' \
        -e 's#^COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./#COPY --chown=nextjs:nodejs standalone ./#' \
        -e 's#^COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static#COPY --chown=nextjs:nodejs static ./.next/static#')"
[ -n "$out" ] || { echo "!! Dockerfile 里找不到 runner 段（FROM node:24-alpine AS runner）" >&2; exit 1; }
if printf '%s\n' "$out" | grep -q 'from=builder'; then
  echo "!! runner 段仍有未改写的 COPY --from=builder；预编译打包无法提供它" >&2; exit 1
fi
[ "$(printf '%s\n' "$out" | grep -c '^COPY')" -eq 3 ] || { echo "!! runner 段 COPY 行数不是 3，改写规则需同步更新" >&2; exit 1; }
printf '%s\n' "$out"
