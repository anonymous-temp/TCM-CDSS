#!/usr/bin/env node
/**
 * 望诊受控词表（面象 / 舌象 / 脉象）生成器。
 *
 * 甲方给的是一份可点选字典：页面上医生点条目，也允许自己敲。这两条路最终都要被后台认出来，
 * 否则会出现最难解释的一类故障——医生在页面上点了「舌体颤动」，后台判定舌象**未记录**，
 * 输出里再把它改写成「舌象待核实」。实测该字典 82 词里后台不认 28 词（舌象 49 词中 27 词不认）。
 *
 * 根因不是漏了几个词，而是**识别词表由手工正则维护，而字典在别处**：字典加一条，
 * 后台就要有人记得去改 clinical-state.ts 的正则。所以这里把字典编译成运行时产物，
 * 让「页面能点的」和「后台能认的」出自同一份数据。
 *
 * 用法：npm run build:tcm-inspection-lexicon
 * 源文件：好医生_中医面象、舌象、脉象_2026-07-28.xlsx（随仓库一起提供，9KB）
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const SOURCE_FILE = process.env.TCM_INSPECTION_LEXICON_SOURCE
  || "好医生_中医面象、舌象、脉象_2026-07-28.xlsx";
const sourcePath = join(projectRoot, SOURCE_FILE);

if (!existsSync(sourcePath)) {
  console.error(`[build:tcm-inspection-lexicon] 源文件不存在：${SOURCE_FILE}`);
  console.error("  用 TCM_INSPECTION_LEXICON_SOURCE 指定其它路径。");
  process.exit(1);
}

// xlsx 解析交给 python（仓库已有多个 python 生成器，openpyxl 是既有依赖），
// 避免为读一张 3 行的表引入新的 node 依赖。
const PARSER = String.raw`
import json, re, sys
import openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb.worksheets[0]
axes = []
for row in ws.iter_rows(values_only=True):
    cells = [str(c).strip() for c in row if c is not None and str(c).strip()]
    if len(cells) < 3:
        continue
    axis, normal, raw = cells[0], cells[1], cells[2]
    # 同一行里可能并排放两组（"苔色：… <空格> 舌下络脉：…"），必须按组名重新切分，
    # 否则后一组会被并进前一组，其组名连同首词一起丢失。
    flat = re.sub(r"[ \t　]+", " ", raw.replace("\n", " ")).strip()
    groups = []
    for match in re.finditer(r"([一-龥]{2,6})：([^：]*?)(?=\s+[一-龥]{2,6}：|$)", flat):
        name = match.group(1).strip()
        items = [x.strip() for x in re.split(r"[、，,\s]+", match.group(2)) if x.strip()]
        if items:
            groups.append({"name": name, "terms": items})
    axes.append({
        "axis": axis,
        "normal": normal.split("：", 1)[1].strip() if "：" in normal else normal.strip(),
        "normalLabel": normal.strip(),
        "groups": groups,
    })
print(json.dumps(axes, ensure_ascii=False))
`;

const parsed = JSON.parse(execFileSync("python3", ["-c", PARSER, sourcePath], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
}));

const AXIS_FIELD = { 面象: "face", 舌象: "tongue", 脉象: "pulse" };
const axes = parsed.map((entry) => {
  const field = AXIS_FIELD[entry.axis];
  if (!field) throw new Error(`未知望诊轴「${entry.axis}」——请先确认它对应 CaseState 的哪个字段`);
  return { ...entry, field };
});

for (const axis of axes) {
  if (axis.groups.length === 0) throw new Error(`${axis.axis} 没有解析出任何分组，源文件格式可能变了`);
  const seen = new Set();
  for (const group of axis.groups) {
    for (const term of group.terms) {
      if (seen.has(term)) throw new Error(`${axis.axis} 出现重复词条「${term}」`);
      seen.add(term);
    }
  }
}

const termCount = axes.reduce((total, axis) =>
  total + axis.groups.reduce((sum, group) => sum + group.terms.length, 0), 0);

const artifact = {
  schemaVersion: "tcm-inspection-lexicon-v1",
  sourceFile: SOURCE_FILE,
  sourceSha256: createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
  axisCount: axes.length,
  termCount,
  // 医生点选的正常项也必须能被后台认作「已记录」，否则「面色正常」「舌淡红苔薄白」
  // 这类最常见的录入会被判成未采集。
  axes,
};

writeFileSync(
  join(projectRoot, "src/data/tcm-inspection-lexicon.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify({
  schemaVersion: artifact.schemaVersion,
  axes: axes.map((axis) => ({
    axis: axis.axis,
    field: axis.field,
    normal: axis.normal,
    groups: axis.groups.map((group) => `${group.name}(${group.terms.length})`),
  })),
  termCount,
}, null, 2));
