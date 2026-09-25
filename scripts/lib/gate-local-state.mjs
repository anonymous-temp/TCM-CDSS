/**
 * 确定性闸门的「本机状态」隔离策略：哪些套件会读本机 artifacts/ 归档、src 运行态缺省落盘在哪。
 * 由 scripts/run-deterministic-regression.mjs 在开跑前自检并使用；与 ./local-artifacts.mjs 配套。
 *
 * 两类本机状态，处理方式不同：
 *
 * 1. **artifacts/ 评测归档**（gitignore，按机器不同）。少数套件「本机有归档就一并扫描」，于是同一提交
 *    在 fresh clone 绿、在留有归档的机器上红（2026-08-15 实测带着红上线过）。它们经 hasLocalArtifact
 *    读归档，CDSS_IGNORE_LOCAL_ARTIFACTS=1 可模拟干净克隆。以前 verify:release 为此把全部 ~210 个套件
 *    fresh 态再跑一遍（每遍约 3.7 分钟），但开关只对下表这几个套件起作用，其余套件两态逐字节同路径。
 *    现在：全链常态一次 + 下表套件 fresh 态一次。**新套件若读 artifacts/ 却不在表里，闸门开头即失败**
 *    （auditArtifactReaders 静态扫描套件及其本地依赖/子进程脚本的代码行）。
 *
 * 2. **src 运行态文件**（术语缓存、库存、客户注册表、租户审计），缺省落在 cwd/artifacts/runtime/。
 *    fresh 开关管不到它们：主工作区留有术语缓存与库存文件，每跑一次闸门还会往 tenant-audit.ndjson
 *    追加（工作树里实测 228KB）。闸门给每个套件一个全新临时目录并把对应环境变量指过去，
 *    本机留存的运行态既漏不进结果、套件之间也不串。src 里新增一个 artifacts/ 缺省路径而不登记，同样开头即失败。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 行为随 CDSS_IGNORE_LOCAL_ARTIFACTS 变化的套件（npm 脚本名 → 原因）。
 * verify:release 只对这些套件额外跑 fresh 态。
 */
export const ARTIFACT_SENSITIVE_SUITES = Object.freeze({
  "test:clinical-four-binding": "本机若有 artifacts/customer-cases-* 五份旧产出则一并判（2026-08-15 本机红、干净克隆绿的那一条）",
  "test:visible-output-hygiene": "本机若有 artifacts/ 则把全部归档阶段正文重放一遍投影链",
  "test:delivery-doc-freshness": "本机若有 artifacts/feishu 飞书导入版则核对与源文档同步",
  "test:modern-case-corpus": "本机若有 artifacts/medical-records-extract 抽取产物则核对夹具可复现",
});

/**
 * 读 artifacts/ 但两态行为相同的套件：读的是**已提交进 Git** 的归档文件（fresh clone 里同样存在），
 * 不经 hasLocalArtifact。只允许读这里逐条列出的路径。
 */
export const FRESH_INVARIANT_ARTIFACT_READERS = Object.freeze({
  "test:robustness-cases": ["artifacts/web-cases-batch3.json"], // 经 build-robustness-case-corpus.mjs --check
});

/**
 * src 里以 cwd/artifacts/runtime/ 为缺省落盘位置的运行态（文件 → 覆盖用环境变量与临时目录内的文件名）。
 */
export const RUNTIME_STATE_PATHS = Object.freeze({
  "src/lib/controlled-semantic-normalization.server.ts": { env: "CONTROLLED_TERMINOLOGY_CACHE_PATH", name: "controlled-terminology-cache.json" },
  "src/lib/drug-inventory.server.ts": { env: "CDSS_DRUG_INVENTORY_PATH", name: "drug-inventory" },
  "src/lib/customer-registry.server.ts": { env: "CDSS_CUSTOMER_REGISTRY_PATH", name: "customer-registry.json" },
  "src/lib/tenant-audit.server.ts": { env: "CDSS_TENANT_AUDIT_PATH", name: "tenant-audit.ndjson" },
});

/** 某个套件专用的运行态环境变量（目录由调用方保证每个套件唯一；不必预先存在，各模块自行 mkdir -p）。 */
export function runtimeStateEnv(directory) {
  return Object.fromEntries(Object.values(RUNTIME_STATE_PATHS).map(({ env, name }) => [env, path.join(directory, name)]));
}

// ── 静态扫描 ───────────────────────────────────────────────────────────────────────────────

const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const ARTIFACT_PATH = /(?:^|\/)artifacts(?:\/|$)/;

/** 代码行（去掉整行注释）里的字符串字面量中，形如 artifacts/… 的路径。 */
function artifactLiterals(source) {
  const found = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trimStart();
    if (inBlock) { if (trimmed.includes("*/")) inBlock = false; continue; }
    if (trimmed.startsWith("/*")) { if (!trimmed.includes("*/")) inBlock = true; continue; }
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;
    for (const match of line.matchAll(STRING_LITERAL)) {
      const text = match[2];
      if (!ARTIFACT_PATH.test(text)) continue;
      const at = text.search(ARTIFACT_PATH);
      // 只取路径部分：「artifacts/x.json#no=…」「artifacts/x.json: 说明」这类是来源标注，路径是冒号/井号之前那段。
      found.push(text.slice(at + (text[at] === "/" ? 1 : 0)).match(/^[\w./${}-]+/)[0]);
    }
  }
  return found;
}

/**
 * 套件文件的本地依赖闭包：静态/动态 import 的 ./….mjs，以及**同一行**里作为子进程启动的脚本
 * （spawn/exec/fork/process.execPath 行上的 "scripts/….mjs" 或 "./….mjs"）。只当文本读取的脚本
 * （readFileSync 做源码断言）不算——它们不执行，读不到归档。已知盲区：先存进变量、隔行再 spawn 的脚本。
 */
function localClosure(root, entryFiles) {
  const seen = new Set();
  const queue = [...entryFiles];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(path.join(root, file))) continue;
    seen.add(file);
    const source = readFileSync(path.join(root, file), "utf8");
    const dir = path.posix.dirname(file);
    const resolve = (ref) => (ref.startsWith("scripts/") ? ref : path.posix.normalize(path.posix.join(dir, ref)));
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'`](\.{1,2}\/[^"'`\s]+\.mjs)["'`]/g)) queue.push(resolve(match[1]));
    for (const line of source.split("\n")) {
      if (!/\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\b|process\.execPath/.test(line)) continue;
      for (const match of line.matchAll(/["'`]((?:scripts\/|\.{1,2}\/)[^"'`\s]+\.mjs)["'`]/g)) queue.push(resolve(match[1]));
    }
  }
  return [...seen];
}

function listFiles(root, dir, pattern) {
  const out = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.posix.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...listFiles(root, rel, pattern));
    else if (pattern.test(name)) out.push(rel);
  }
  return out;
}

/**
 * 返回问题清单（空 = 通过）。
 * @param {string} root 仓库根
 * @param {Record<string,string>} npmScripts package.json 的 scripts
 * @param {string[]} registered 闸门登记的套件
 */
export function auditLocalStateReaders(root, npmScripts, registered) {
  const problems = [];
  const runtimeEnvs = new Set(Object.values(RUNTIME_STATE_PATHS).map(({ env }) => env));
  for (const suite of registered) {
    const command = npmScripts[suite] || "";
    const entries = [...command.matchAll(/scripts\/[^\s"']+\.mjs/g)].map((match) => match[0]);
    const closure = localClosure(root, entries);
    const archiveRefs = new Set();
    let gated = false;
    for (const file of closure) {
      const source = readFileSync(path.join(root, file), "utf8");
      if (file !== "scripts/lib/local-artifacts.mjs" && /\bhasLocalArtifact\s*\(/.test(source)) gated = true;
      for (const literal of artifactLiterals(source)) {
        if (literal.startsWith("artifacts/runtime")) {
          // 运行态缺省路径：必须能被闸门钉住的环境变量覆盖。
          if (![...runtimeEnvs].some((env) => source.includes(env))) {
            problems.push(`${suite}: ${file} 使用运行态缺省路径 ${literal}，但没有经 RUNTIME_STATE_PATHS 里的环境变量覆盖`);
          }
          continue;
        }
        archiveRefs.add(literal);
      }
    }
    if (suite in ARTIFACT_SENSITIVE_SUITES) {
      if (archiveRefs.size === 0) problems.push(`${suite}: 登记为归档敏感，但代码里已不读 artifacts/（请从 ARTIFACT_SENSITIVE_SUITES 移除）`);
      if (!gated) problems.push(`${suite}: 读 artifacts/ 却不经 hasLocalArtifact，CDSS_IGNORE_LOCAL_ARTIFACTS 关不掉它`);
      continue;
    }
    if (suite in FRESH_INVARIANT_ARTIFACT_READERS) {
      const allowed = new Set(FRESH_INVARIANT_ARTIFACT_READERS[suite]);
      const extra = [...archiveRefs].filter((ref) => !allowed.has(ref));
      if (extra.length) problems.push(`${suite}: 读了未声明的归档路径 ${extra.join("、")}（已提交的文件加进 FRESH_INVARIANT_ARTIFACT_READERS；本机归档须经 hasLocalArtifact 并登记 ARTIFACT_SENSITIVE_SUITES）`);
      if (archiveRefs.size === 0) problems.push(`${suite}: 登记为读已提交归档，但代码里已不读 artifacts/（请从 FRESH_INVARIANT_ARTIFACT_READERS 移除）`);
      continue;
    }
    if (archiveRefs.size) {
      problems.push(`${suite}: 读 artifacts/（${[...archiveRefs].join("、")}）却不在 ARTIFACT_SENSITIVE_SUITES / FRESH_INVARIANT_ARTIFACT_READERS 里——fresh clone 与本机结论可能相反`);
    }
  }
  for (const suite of [...Object.keys(ARTIFACT_SENSITIVE_SUITES), ...Object.keys(FRESH_INVARIANT_ARTIFACT_READERS)]) {
    if (!registered.includes(suite)) problems.push(`${suite}: 在本机状态策略表里，却不在闸门登记数组中`);
  }
  // src 运行态缺省路径：每一处都必须登记环境变量，否则闸门钉不住。
  const runtimeFiles = new Set();
  for (const file of listFiles(root, "src", /\.(?:ts|tsx|mts|cts|js|mjs)$/)) {
    const source = readFileSync(path.join(root, file), "utf8");
    if (!artifactLiterals(source).length) continue;
    runtimeFiles.add(file);
    const declared = RUNTIME_STATE_PATHS[file];
    if (!declared) problems.push(`${file}: 有 artifacts/ 缺省落盘路径，但未登记到 RUNTIME_STATE_PATHS（闸门无法把它指到临时目录）`);
    else if (!source.includes(`process.env.${declared.env}`)) problems.push(`${file}: 登记的覆盖变量 ${declared.env} 在文件里找不到`);
  }
  for (const file of Object.keys(RUNTIME_STATE_PATHS)) {
    if (!runtimeFiles.has(file)) problems.push(`${file}: 登记在 RUNTIME_STATE_PATHS，但已没有 artifacts/ 缺省路径（请移除）`);
  }
  return problems;
}
