FROM node:24-alpine AS deps
WORKDIR /app
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
COPY package.json package-lock.json ./
RUN npm ci --registry="${NPM_CONFIG_REGISTRY}"

FROM node:24-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_BASE_PATH="/tcm-cdss"
ARG NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE="true"
ARG NEXT_DEPLOYMENT_ID
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
ENV NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE=$NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE
ENV NEXT_DEPLOYMENT_ID=$NEXT_DEPLOYMENT_ID
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ARG NEXT_PUBLIC_BASE_PATH="/tcm-cdss"
ARG NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE="true"
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
ENV NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE=$NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE
RUN printf "%s" "$NEXT_PUBLIC_BASE_PATH" > /app/.next-build-base-path
RUN printf "%s" "$NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE" > /app/.next-build-persistence-flag

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["sh", "-c", "BUILD_BASE_PATH=$(cat /app/.next-build-base-path); BUILD_PERSISTENCE=$(cat /app/.next-build-persistence-flag); if [ \"${NEXT_PUBLIC_BASE_PATH:-}\" != \"$BUILD_BASE_PATH\" ]; then echo 'NEXT_PUBLIC_BASE_PATH changed after build; rebuild the image for basePath changes.' >&2; exit 1; fi; if [ \"${NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE:-}\" != \"$BUILD_PERSISTENCE\" ]; then echo 'NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE changed after build; rebuild the image for persistence changes.' >&2; exit 1; fi; exec node server.js"]
