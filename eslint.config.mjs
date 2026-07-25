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
  ]),
]);

export default eslintConfig;
