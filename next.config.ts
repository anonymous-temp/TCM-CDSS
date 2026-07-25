import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  // 纯评测语料不进镜像。它们放在 src/data 只是为了和其他治理产物同目录，运行时零消费者
  // （`grep -rn tcm-modern-case-eval-corpus src` 无命中；封套自身也写着 evaluationOnly:true、
  // runtimeRetrievalAllowed:false），但 Next 的文件追踪按目录把 src/data 整个纳入每条诊断路由的
  // 产物清单，于是 38.5MB 的现代医案语料 + 医案回放语料 + 已被 T15 全表扫取代的旧紧凑索引
  // 全都随镜像发布。排除它们不影响任何运行时行为——若哪天真要在运行时读，
  // 会立刻 ENOENT 而不是静默降级，这比多带 40MB 更安全。
  outputFileTracingExcludes: {
    "**": [
      "src/data/tcm-modern-case-eval-corpus.json",
      "src/data/tcm-classic-case-eval-corpus.json",
      "src/data/tcm-classic-formula-evidence.json",
    ],
  },
  deploymentId: process.env.NEXT_DEPLOYMENT_ID || process.env.CDSS_RELEASE_ID,
  ...(process.env.NEXT_PUBLIC_BASE_PATH
    ? { basePath: process.env.NEXT_PUBLIC_BASE_PATH }
    : {}),
  turbopack: {
    root: projectRoot,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
