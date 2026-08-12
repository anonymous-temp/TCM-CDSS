// 内部口径词不得出现在医生看得到的文案里（甲方 2026-08-12）。
//
// 甲方原话：「页面仍显示『剂量来源：受治理知识库边界校验』…你要求知识库不对用户展示，
// 这句话也应删除或改为『剂量已完成规则校验』」。
//
// 上一轮只改了甲方点名的那一句是不够的：全仓扫下来有 7 处会渲染给医生看的串带着
// 知识库 / 受治理 / 闭集 / 受控 这类内部口径词，分布在三个出口，而且各写各的——
// 服务端 Markdown 有一道净化器在改写这类词，但它归一到的目标恰恰还是「中药知识库」；
// 医生页面上那几处是写死的字符串，从来不经过那道净化器。
//
// 判据落在**源码的字符串字面量**上，而不是某一次输出的抽样：注释先剥掉（注释里必须
// 能自由讨论内部机制，那正是本仓库的记录方式），剩下的引号内文本一个都不许带这些词。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 顶层 await import：与其余套件同一写法，交给 jiti 解析 TS 与无扩展名的相对导入。
const policy = await import("../src/lib/result-display-policy.ts");

const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { failures.push({ name, message: error?.message || String(error) }); }
};

// 判据的范围本身错过一次（2026-08-12 部署后线上实测）：上一版只列了 4 个「我认为是出口」的
// 文件，于是 m04-proposal-compiler 写进 verificationReasons 的
// 「受治理剂量边界 2-10g 已用于生成后校验」照样印到了医生面前，闸门全绿。
// 判据改成**扫全部应用源码**，再显式豁免「这份字符串是喂给模型的提示词，不是给人看的」。
// 豁免必须逐个文件写清理由——新文件默认被扫到，红了就得有人做一次分类，
// 而不是像上一版那样默认漏掉。
const SCAN_ROOTS = ["src/lib", "src/app"];

/**
 * 提示词专用模块：这些文件里的中文串是发给模型的指令与上下文，医生看不到。
 * 内部口径词在这里是**必要的**——它正是在告诉模型「这条数据的治理边界是什么」。
 */
const PROMPT_ONLY_FILES = new Set([
  "src/lib/diagnosis-prompts.ts",                        // M01–M05 提示词本体
  "src/lib/structured-clinical-repair.ts",               // 修复轮指导语
  "src/lib/m04-clinical-review.ts",                      // 复核提示词
  "src/lib/controlled-semantic-normalization.server.ts", // 术语归一提示词
  "src/lib/drug-inventory.server.ts",                    // 院内库存提示词上下文
  "src/lib/tcm-clinical-decision-cards.ts",              // 决策卡片提示词上下文
  "src/lib/diagnosis-api.ts",                            // 结构化合同提示词
  "src/lib/cdss-evidence-context.ts",                    // 证据上下文提示词
  "src/lib/syndrome-hypothesis-rerank.server.ts",        // 证候候选重排提示词
  // 内部口径词**检测器**：它必须含有这些词才能把它们从可见正文里找出来。
  "src/lib/m03-therapy-lock.ts",
]);

// 内部口径词。这些是我们自己的实现语汇，医生不需要、也不该在结论里读到。
const INTERNAL_VOCABULARY = /知识库|受治理|闭集|受控词表|\bKB\b/;

/**
 * 剥掉注释后取出所有字符串字面量。
 *
 * 不做完整 TS 解析——判据只需要「引号里的中文文案」，而正则替换里的中文
 * （净化器的 /…/ 模式）不在引号内，天然不会被扫到。
 */
function stringLiteralsOf(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
  const literals = [];
  const patterns = [/"((?:[^"\\\n]|\\.)*)"/g, /'((?:[^'\\\n]|\\.)*)'/g, /`((?:[^`\\]|\\.)*)`/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(withoutComments))) literals.push(match[1]);
  }
  return literals;
}

function sourceFilesUnder(rootRelative) {
  const root = fileURLToPath(new URL(`../${rootRelative}`, import.meta.url));
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

check("① 医生可见文案里不得出现内部口径词", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const offenders = [];
  for (const absolute of SCAN_ROOTS.flatMap(sourceFilesUnder)) {
    const relative = absolute.slice(repoRoot.length).replace(/\\/g, "/");
    if (PROMPT_ONLY_FILES.has(relative)) continue;
    const source = readFileSync(absolute, "utf8");
    for (const literal of stringLiteralsOf(source)) {
      // 只看含中文的文案串：import 路径、CSS 类名、枚举值不是给医生读的。
      if (!/[一-鿿]/.test(literal)) continue;
      if (INTERNAL_VOCABULARY.test(literal)) offenders.push(`${relative}：「${literal.slice(0, 60)}」`);
    }
  }
  assert.deepEqual(offenders, [], `以下文案会渲染给医生，但带着内部口径词：\n  ${offenders.join("\n  ")}`);
});

check("② doseSource 的可见中文名只有一处定义，且是甲方给定的措辞", () => {
  assert.equal(policy.doseSourceLabelForDisplay("governed_boundary"), "剂量已完成规则校验");
  assert.equal(policy.doseSourceLabelForDisplay("classical_source"), "经典来源原方量");
  // 认不出的取值一律落到最保守的那一档，绝不假装剂量有来源。
  assert.equal(policy.doseSourceLabelForDisplay("none"), "未形成可执行来源");
  assert.equal(policy.doseSourceLabelForDisplay(""), "未形成可执行来源");
  assert.equal(policy.doseSourceLabelForDisplay(undefined), "未形成可执行来源");
  assert.equal(policy.doseSourceLabelForDisplay("something_new"), "未形成可执行来源");

  // 页面不得再自己写一份映射——那正是这次的成因。
  const client = readFileSync(fileURLToPath(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url)), "utf8");
  assert.ok(
    /doseSourceLabelForDisplay\(/.test(client),
    "医生页面必须调用统一投影 doseSourceLabelForDisplay，不得内联三元映射",
  );
  assert.ok(
    !/doseSource\s*===\s*"governed_boundary"\s*\?/.test(client),
    "医生页面又内联了一份 doseSource → 中文名的映射",
  );
});

check("③ 机器取值不得被改动：doseSource 枚举是 HIS 出参契约", () => {
  const his = readFileSync(fileURLToPath(new URL("../src/lib/his-scheme.ts", import.meta.url)), "utf8");
  for (const value of ["governed_boundary", "classical_source"]) {
    assert.ok(his.includes(`"${value}"`), `HIS 出参丢了机器取值 ${value}——改可见文案不得改枚举`);
  }
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "doctor-facing-vocabulary", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "doctor-facing-vocabulary", checks: 3, failures: 0 }));
