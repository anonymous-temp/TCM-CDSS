// 交付副本必须与源文档同步（2026-08-12 甲方对接人复核时暴露）。
//
// 事故经过：接口文档 docs/中医CDSS-对外接口文档.md 已按新字段改好，
// 但**甲方读的是飞书导入版** artifacts/feishu/中医CDSS-对外接口文档.md——
// 那是 scripts/build-feishu-doc.mjs 的产物，我改完源文档没重跑生成器，
// 于是甲方连续两轮复核看到的都是旧字段 timelineItems[].indication，
// 而我这边"文件明明改了"。这与今天早些时候治理表指纹分叉是同一类：**改了源没重跑生成器**。
//
// 判据不是"字段对不对"（那只覆盖这一次的字段），而是**产物是不是源文档的当前产物**：
// 重跑一次生成器，与仓库里的产物逐字节比对。任何文档改动没同步到交付副本都会红。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hasLocalArtifact } from "./lib/local-artifacts.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const ARTIFACT = join(repo, "artifacts/feishu/中医CDSS-对外接口文档.md");

const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { failures.push({ name, message: error?.message || String(error) }); }
};

// 生成器往文件头盖了一枚 `源码版本：<git HEAD 短哈希>` 的溯源戳。它与文档内容无关，
// 却会随**任何**提交改变——本套件第一版拿它一起比对，结果是「每提交一次就红一次」。
// 一道在与被保护对象无关的原因上常态化报红的闸门，只会被绕过或删掉，比没有还糟。
// 因此比对前把这一戳归一化：判据回到「技术内容是不是源文档的当前产物」。
const normalizeVersionStamp = (text) => text.replace(/源码版本：`[^`]*`/g, "源码版本：`<stamp>`");

let generatedArtifact = "";
check("飞书导入版可由 fresh clone 重建，已有产物必须与源文档同步", () => {
  const hadArtifact = hasLocalArtifact(ARTIFACT);
  const before = hadArtifact ? readFileSync(ARTIFACT, "utf8") : "";
  // artifacts/ 按设计不入 Git，fresh clone 上不应因为本机交付产物不存在而失败。
  // 无论是否已有产物都跑生成器；若已有产物，仍逐字节校验其内容新鲜度。
  try {
    execFileSync("node", ["scripts/build-feishu-doc.mjs"], { cwd: repo, stdio: "pipe" });
    const after = readFileSync(ARTIFACT, "utf8");
    generatedArtifact = after;
    if (hadArtifact) {
      assert.equal(
        normalizeVersionStamp(after),
        normalizeVersionStamp(before),
        "飞书导入版与源文档不同步——改了 docs/中医CDSS-对外接口文档.md 后请重跑 node scripts/build-feishu-doc.mjs",
      );
    }
  } finally {
    if (hadArtifact) writeFileSync(ARTIFACT, before);
    else if (existsSync(ARTIFACT)) unlinkSync(ARTIFACT);
  }
});

// 归一化只能免掉溯源戳这一处，不能顺手把正文也免掉——否则闸门就空了。
check("归一化不得掩盖正文差异（本套件的自检）", () => {
  const sample = "源码版本：`abc1234`\n| timelineItems[].indicators | 观察项 |";
  assert.equal(
    normalizeVersionStamp(sample),
    "源码版本：`<stamp>`\n| timelineItems[].indicators | 观察项 |",
    "归一化越界：除溯源戳外的任何字符都不得被改写",
  );
});

// 这一次的具体字段另钉一条：甲方逐字核对的就是它。
check("交付副本里不得再有 timelineItems[].indication 的字段定义", () => {
  const artifact = generatedArtifact;
  assert.ok(artifact, "未获取飞书导入版生成结果");
  const offending = artifact.split("\n")
    .map((line, index) => ({ line, no: index + 1 }))
    .filter((row) => /timelineItems\[\]\.indication(?!s)/.test(row.line))
    // 变更历史那一行是**故意**提到旧字段名的：它就是在告诉集成方那个字段从未存在。
    .filter((row) => !/勘误|从未存在|V2\.0 \|/.test(row.line));
  assert.deepEqual(
    offending.map((row) => `第${row.no}行`),
    [],
    `交付副本仍在把 indication 当字段定义：${offending.map((row) => row.line.trim().slice(0, 80)).join(" / ")}`,
  );
  for (const field of ["timelineItems[].indicators", "timelineItems[].triggers"]) {
    assert.ok(artifact.includes(field), `交付副本缺字段定义 ${field}`);
  }
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "delivery-doc-freshness", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "delivery-doc-freshness", checks: 3, failures: 0 }));
