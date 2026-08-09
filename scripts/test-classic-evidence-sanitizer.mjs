/**
 * 古籍证据摘录的**剂量/操作脱敏**：简繁两侧必须同集。
 *
 * 为什么要有这条：古籍语料本身就是繁体的，而脱敏正则原来的单位与操作词字符类全是简体
 * （克|g|钱|两|升|合|铢、后下、针、分钟）。后果不是少抹几个字，而是**带具体剂量的经典条文
 * 原样进 M03/M04 prompt**——直接违反「经典剂量不得成为剂量指导、定量只归药典层」这条铁律。
 *
 * 实测（2026-08-09，逐条扫两个已发布语料，只算 safetyClass==="standard" 即运行期可达）：
 *   修复前 2274 条运行期可达记录带未隔离剂量（如《伤寒论》理中圆方「…乾薑各三兩」）；
 *   修复后 0 条。
 *
 * 本套件钉两层：
 *   ① 字面用例：每个繁体写法都必须被隔离，且其简体同义词行为一致；
 *   ② 结构不变量：正则里凡出现某个简体单位/操作词，其**语料中实际出现过**的繁体写法
 *      也必须在同一个字符类里。这一条是为了防「下次又只补一边」——
 *      本仓库反复出现的正是这种「一个面修了，另一个没修」。
 * 同时用反向用例守住既有的药名碰撞豁免（百合/合欢不得被当成剂量抹掉）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const sourcePath = path.join(repoRoot, "src/lib/tcm-classic-evidence.server.ts");
const source = fs.readFileSync(sourcePath, "utf8");

let checks = 0;
const failures = [];
function ok(label, condition) {
  checks += 1;
  if (!condition) failures.push(label);
}

// ── 从源码里取出这两个字符类，避免测试与实现各写一份正则 ────────────────────
const unitClass = source.match(/\\\\s\*\(\?:([^)]*?)\)`/)?.[1]
  ?? source.match(/\(\?:克\|[^)]*\)/)?.[0];
assert.ok(unitClass, "没能从源码里取到单位字符类——实现结构变了，先更新本测试再改实现");

const operationSegment = source.match(/\|每日[\s\S]*?寸\)\)"/)?.[0];
assert.ok(operationSegment, "没能从源码里取到操作词片段");

// ── ① 简繁同集：语料中实际出现过的繁体写法必须与其简体同义词同时在场 ─────────
// 频次来自对两个语料 safetyClass==="standard" 记录的实测扫描，不是凭空列举。
const REQUIRED_VARIANT_PAIRS = [
  { simplified: "两", traditional: "兩", corpusHits: 2867, where: "unit" },
  { simplified: "钱", traditional: "錢", corpusHits: 5334, where: "unit" },
  { simplified: "铢", traditional: "銖", corpusHits: 64, where: "unit" },
  { simplified: "针", traditional: "針", corpusHits: 469, where: "operation" },
  { simplified: "分钟", traditional: "分鐘", corpusHits: 48, where: "operation" },
  { simplified: "后下", traditional: "後下", corpusHits: 42, where: "operation" },
];

for (const pair of REQUIRED_VARIANT_PAIRS) {
  const scope = pair.where === "unit" ? unitClass : operationSegment;
  ok(`简体在场: ${pair.simplified}`, scope.includes(pair.simplified));
  ok(
    `繁体在场: ${pair.traditional}（语料实测 ${pair.corpusHits} 次；只补一边就是这条要拦的缺陷）`,
    scope.includes(pair.traditional),
  );
}

// ── ② 行为用例：直接跑源码里那条正则 ────────────────────────────────────────
// 用与实现逐字一致的构造方式重建，构造串本身也从源码取，避免测试写死另一份。
const collisions = source.match(/const CLASSIC_RUNTIME_HERB_NAME_COLLISIONS = "([^"]+)"/)?.[1];
assert.ok(collisions, "没能取到药名碰撞白名单");
const bodyMatch = source.match(/new RegExp\(\s*`([\s\S]*?)`\s*\+\s*"([\s\S]*?)",\s*\n\s*"gi",\s*\n\s*\);/);
assert.ok(bodyMatch, "没能取到正则构造串");
const pattern = new RegExp(
  bodyMatch[1].replace("${CLASSIC_RUNTIME_HERB_NAME_COLLISIONS}", collisions).replaceAll("\\\\", "\\") + bodyMatch[2],
  "gi",
);
const isolate = (text) => text.replace(pattern, "[具体剂量或操作已隔离]");

const MUST_ISOLATE = [
  ["繁体两", "於四逆湯方內，加人參一兩，餘依四逆湯方"],
  ["繁体钱", "桂枝三錢，芍藥三錢"],
  ["繁体铢", "附子一銖"],
  ["伤寒论理中圆方原文", "人參、白朮、甘草（炙）、乾薑各三兩"],
  ["简体两（既有行为）", "加人参一两"],
  ["简体钱（既有行为）", "桂枝三钱"],
  ["繁体后下", "大黃後下"],
  ["繁体针刺", "針刺足三里穴"],
  ["繁体分钟", "留針三十分鐘"],
  ["煎法", "水煎服"],
];
for (const [label, text] of MUST_ISOLATE) {
  ok(`必须隔离: ${label} —— ${text}`, isolate(text) !== text);
}

// ── ③ 反向：药名碰撞豁免不得被本次改动破坏 ──────────────────────────────────
const MUST_KEEP = [
  ["百合固金汤", "百合固金汤"],
  ["百合地黄汤", "百合地黄汤主之"],
  ["合欢皮", "合欢皮解郁"],
];
for (const [label, text] of MUST_KEEP) {
  ok(`不得隔离（药名碰撞豁免）: ${label}`, isolate(text) === text);
}

// ── ④ 语料级：运行期可达记录里不得再有未隔离的繁体剂量 ──────────────────────
// 语料是 44MB/347MB 的构建产物，CI 机器上未必都在；缺文件时跳过并明说，不静默通过。
const CORPORA = [
  "src/data/tcm-classic-text-evidence.jsonl",
  "src/data/tcm-classic-text-evidence-tcmoc.jsonl",
];
const TRADITIONAL_DOSE = /(?:\d+(?:\.\d+)?|[〇零一二三四五六七八九十百半]+)\s*(?:兩|錢|銖)/;
const LIMIT = Number(process.env.CLASSIC_SANITIZER_SCAN_LIMIT || 40000);
let scanned = 0;
let leaked = 0;
for (const rel of CORPORA) {
  const file = path.join(repoRoot, rel);
  if (!fs.existsSync(file)) {
    console.log(`[test:classic-evidence-sanitizer] 语料缺失，跳过语料级扫描: ${rel}`);
    continue;
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    if (scanned >= LIMIT) break;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.safetyClass !== "standard") continue;
    const text = String(row.text || "");
    if (!TRADITIONAL_DOSE.test(text)) continue;
    scanned += 1;
    if (TRADITIONAL_DOSE.test(isolate(text))) leaked += 1;
  }
}
if (scanned > 0) {
  ok(`语料级：${scanned} 条含繁体剂量的运行期可达记录，脱敏后残留 ${leaked} 条`, leaked === 0);
  console.log(`[test:classic-evidence-sanitizer] 语料级扫描 ${scanned} 条，残留 ${leaked} 条`);
}

if (failures.length > 0) {
  console.error("[test:classic-evidence-sanitizer] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(`[test:classic-evidence-sanitizer] OK — ${checks} 项断言全过`);
