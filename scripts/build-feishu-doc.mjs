// 接口文档 → 飞书云文档可导入格式(2026-08-04)。
//
// 飞书云文档支持导入 Markdown,但它的解析器与 GitHub Flavored Markdown 有几处实测差异,
// 直接把仓库里的 .md 拖进去会掉内容。本脚本按类处理,而不是逐处手改——手改的版本
// 下次文档更新又要重来一遍。
//
// 处理的五类(判据来自实测扫描,见下方每条注释):
//  1. 代码块外的裸 HTML 注释 —— 飞书会**整行吞掉**。而本文档里的 <!-- DIAGNOSIS_JSON_START -->
//     恰恰是给集成方看的**协议标记**,吞掉等于删掉关键契约说明。转成行内代码保留可见性。
//  2. 代码块外的裸尖括号标签 —— 同上会被当 HTML 吞掉,如 <关键词>、<token>。转行内代码。
//  3. 四级以上标题 —— 飞书导入最多识别到三级,四级会退化成正文,层级信息丢失。
//     降级为加粗段首,保留视觉层次。
//  4. 超长表格行 —— 飞书表格列宽固定,超长单元格会挤成一坨不可读。拆分说明文字到表下。
//  5. 文件头补一段导入说明与版本信息,方便甲方知道拿到的是哪一版。
//
// 用法: node scripts/build-feishu-doc.mjs
// 产出: artifacts/feishu/中医CDSS-对外接口文档.md(可直接拖入飞书云文档导入)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SOURCE = "docs/中医CDSS-对外接口文档-20260803.md";
const OUT_DIR = "artifacts/feishu";
const OUT_FILE = path.join(OUT_DIR, "中医CDSS-对外接口文档.md");

const raw = fs.readFileSync(SOURCE, "utf8");
const lines = raw.split("\n");

const stats = { htmlComment: 0, angleTag: 0, deepHeading: 0, longTableRow: 0 };
const out = [];
let inFence = false;

for (const line of lines) {
  if (line.trim().startsWith("```")) {
    inFence = !inFence;
    out.push(line);
    continue;
  }
  if (inFence) {
    // 代码块内一律原样保留:那里的尖括号与注释是**协议内容本身**,任何改写都是失真。
    out.push(line);
    continue;
  }

  let text = line;

  // 1. 裸 HTML 注释 → 行内代码(飞书会整行吞掉 HTML 注释)。
  // 源文档里部分注释**已经**被反引号包着,再包一层会变成 ``…`` 双反引号,飞书渲染成乱码。
  // 因此先按反引号切段,只处理段外的裸注释。
  if (text.includes("<!--")) {
    const parts = text.split(/(`[^`]*`)/);
    const next = parts
      .map((seg) => (seg.startsWith("`") ? seg : seg.replace(/<!--\s*(.*?)\s*-->/g, (_m, inner) => `\`<!-- ${inner} -->\``)))
      .join("");
    if (next !== text) stats.htmlComment += 1;
    text = next;
  }

  // 2. 裸尖括号标签 → 行内代码(已在反引号内的不动)
  if (/<[a-zA-Z/][^>]*>/.test(text)) {
    const segments = text.split(/(`[^`]*`)/);
    text = segments
      .map((segment) => (segment.startsWith("`")
        ? segment
        : segment.replace(/<([a-zA-Z/][^>]*)>/g, "`<$1>`")))
      .join("");
    stats.angleTag += 1;
  }

  // 3. 四级以上标题 → 加粗段首(飞书导入只识别到三级)
  const deep = text.match(/^(#{4,})\s+(.*)$/);
  if (deep) {
    text = `**${deep[2]}**`;
    stats.deepHeading += 1;
  }

  out.push(text);
}

// 4. 超长表格行:统计并提示(不自动拆——拆错会破坏表义,交由人工按提示处理)
const longRows = out
  .map((line, index) => ({ line, index }))
  .filter((row) => row.line.startsWith("|") && row.line.length > 300);
stats.longTableRow = longRows.length;

// 5. 文件头:导入说明 + 版本锚点
const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

const header = [
  "> **导入说明**：本文件为飞书云文档导入版。飞书中新建文档 → 右上角「···」→「导入」→ 选择本 .md 文件。",
  ">",
  `> 源文档：\`${SOURCE}\`　·　源码版本：\`${commit}\`　·　本文件由 \`scripts/build-feishu-doc.mjs\` 生成，请勿直接编辑。`,
  ">",
  "> 与源文档的差异仅为**飞书兼容性处理**（HTML 注释与尖括号标签转为行内代码、四级标题转为加粗），技术内容完全一致。",
  "",
  "---",
  "",
].join("\n");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, header + out.join("\n"));

console.log(JSON.stringify({
  written: OUT_FILE,
  sourceLines: lines.length,
  outputLines: out.length + 8,
  converted: stats,
  longTableRowsNeedingReview: longRows.map((row) => row.index + 1),
}, null, 2));
