import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored third-party review tool is not part of this product's lint contract.
    "open-code-review-main/**",
    // Generated regression evidence and cached governance sources are disposable outputs, not
    // application code. Keep ESLint aligned with tsconfig and gitignore so a test run cannot
    // silently expand the release lint surface to downloaded third-party repositories.
    "artifacts/**",
    "deeptest/**",
    "test-results/**",
    // 一次性复现脚本（tmp-probe/、根目录 probe-*.mjs）与上面三者同类：调查产出，不是应用源码。
    // 它们此前既不在 lint ignore、也不在 gitignore 里，于是残留的排查脚本会让
    // `npm run verify:release` 的 lint 关卡直接失败——发布闸门被一堆草稿卡住。
    "tmp-probe/**",
    "probe-*.mjs",
    "tmp-probe-*.mjs",
  ]),
]);

export default eslintConfig;
