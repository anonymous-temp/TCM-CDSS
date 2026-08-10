/**
 * 红旗表达覆盖：中文构词式表达、中医术语变体、否定作用域跨逗号污染。
 *
 * 【这批缺陷的共同形状】红旗判据按「完整词」穷举，而中文不是这么构词的：
 *   · 程度词插在部位与症状之间 —— 词表有「上腹痛」「右下腹痛」，
 *     「上腹剧痛」「右下腹剧痛」「脘腹剧烈疼痛」「少腹急痛」全部失配；
 *   · 同一临床概念的中医写法是另一套词 —— 认得「口角歪斜」不认得「口眼歪斜」，
 *     认得「肢体无力」不认得「半身不遂」。这是个**中医** CDSS，这批词才是医生实际会写的；
 *   · 同一判据两处各写各的 —— 安全层自写 /孕\d+(?:周|月)/，
 *     而 clinical-state 里早有覆盖「孕妇/孕晚期/有身孕」且带否定排除的受治理谓词。
 *
 * 全部为 2026-08-09 实测复现后修复，逐条钉住：
 *   · BP 170/112 + 剧烈头痛，主诉写「孕32周」有重度子痫前期红旗、写「孕妇」**零红旗**；
 *   · 「突发右下腹剧痛」「脘腹剧烈疼痛」「少腹急痛，停经40天」**零红旗**
 *     （阑尾炎、异位妊娠的典型主诉）；
 *   · 「今晨突发口眼歪斜／半身不遂／不省人事／意识模糊」**零红旗**；
 *   · 「否认糖尿病，胸痛今日新发」**零红旗**，删掉那句无关的既往史否认后就正常——
 *     一句与胸痛毫不相干的否认跨过逗号把今日新发的胸痛吃掉了。
 *
 * 反向同等重要：本套件同时钉住「否认列举仍是否认」「轻症慢病不得升级」
 * 「非妊娠语境不得触发产科红旗」——放宽识别绝不能变成制造误报。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true, interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { evaluateSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { assessPregnancyState } = await jiti.import("../src/lib/clinical-state.ts");

let checks = 0;
const failures = [];
const ok = (label, condition) => { checks += 1; if (!condition) failures.push(label); };

const caseOf = (chiefComplaint, over = {}) => ({
  patient: { sex: "女", age: 40 }, chiefComplaint, symptoms: {}, tongue: "", pulse: "", faceNote: "",
  conversation: [], vitals: {}, history: {}, ...over,
});
const redFlagsOf = (chiefComplaint, over) => evaluateSafetyGate(caseOf(chiefComplaint, over))?.redFlags || [];
const hasFlag = (chiefComplaint, over) => redFlagsOf(chiefComplaint, over).length > 0;
const hasFlagMatching = (chiefComplaint, needle, over) =>
  redFlagsOf(chiefComplaint, over).some((flag) => String(flag).includes(needle));

// ── ① 产科语境：判据收敛到受治理谓词，不再自写正则 ──────────────────────────
const SEVERE_BP = { vitals: { bloodPressure: "170/112" } };
for (const text of ["孕妇，剧烈头痛，视物模糊", "孕晚期，剧烈头痛", "早孕，剧烈头痛", "有身孕，剧烈头痛",
  "孕32周，剧烈头痛", "妊娠期，剧烈头痛", "产后10天，剧烈头痛", "临产，剧烈头痛"]) {
  ok(`产科重度高血压红旗：${text}`, hasFlagMatching(text, "妊娠/产褥期血压", SEVERE_BP));
}
// 反向：非妊娠语境不得被这条规则误伤。170/112 未达通用危急阈值(180/120)，本就不该出红旗。
for (const text of ["不孕症3年，头痛", "备孕中，头痛", "否认妊娠，头痛", "既往孕2产1，头痛", "孕前咨询，头痛"]) {
  ok(`非妊娠语境不得触发产科红旗：${text}`, !hasFlagMatching(text, "妊娠/产褥期血压", SEVERE_BP));
}
// 谓词本身的边界（安全层现在直接依赖它，它错了安全层就跟着错）。
for (const [text, expected] of [["早孕", "positive"], ["宫内早孕", "positive"], ["孕妇", "positive"],
  ["早孕试验阴性", "unknown"], ["早孕反应明显", "unknown"], ["不孕症3年", "unknown"], ["备孕中", "unknown"],
  ["否认妊娠", "negative"], ["既往孕2产1", "historical"]]) {
  ok(`妊娠谓词 ${text} → ${expected}`, assessPregnancyState(text).status === expected);
}

// ── ② 急腹症：部位 × 程度 × 痛 的构词式表达 ────────────────────────────────
for (const text of ["突发上腹剧痛，大汗", "突发右下腹剧痛", "脘腹剧烈疼痛，拒按", "少腹急痛，停经40天",
  "突发左下腹绞痛", "全腹剧痛，板状腹", "突发腹痛，大汗", "突发上腹痛，大汗"]) {
  ok(`急腹症红旗：${text}`, hasFlag(text));
}
// 反向：轻症/慢病/查体阴性不得升级为急腹症。
for (const text of ["腹部隐痛3月，餐后明显", "胃脘胀满不适2周", "慢性腹胀，间断发作数年",
  "查体：腹软，无压痛反跳痛", "否认腹痛、腹胀、恶心"]) {
  ok(`不得误报急腹症：${text}`, !hasFlag(text));
}

// ── ③ 局灶神经缺损的中医术语 ────────────────────────────────────────────────
for (const text of ["今晨突发口眼歪斜", "今晨突发半身不遂", "今晨突发不省人事", "今晨突发意识模糊",
  "今晨突发神志模糊", "今晨突发肢体活动不利", "今晨突发言语謇涩", "今晨突发意识不清", "今晨突发口角歪斜"]) {
  ok(`神经急症红旗：${text}`, hasFlag(text));
}
ok("否认列举中的中医术语不得误报", !hasFlag("否认口眼歪斜、半身不遂"));
// 词表与正则必须同源：加词只改数组、正则没跟上会让新词静默半失效。
{
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(path.join(repoRoot, "src/lib/diagnosis-safety.ts"), "utf8"));
  ok("FOCAL_NEUROLOGIC_PATTERN 由数组派生而非手抄第二份",
    /const FOCAL_NEUROLOGIC_PATTERN = new RegExp\(\s*`\(\?:\$\{FOCAL_NEUROLOGIC_TERMS/.test(source));
}

// ── ④ 否定作用域不得跨逗号吃掉阳性症状 ──────────────────────────────────────
for (const text of ["否认糖尿病，胸痛今日新发", "否认糖尿病，今日新发胸痛",
  "否认糖尿病，登楼时诱发胸痛，今日新发", "既往体健，否认高血压糖尿病史。今晨活动后突发胸痛20分钟，伴大汗",
  "否认糖尿病史。今晨突发左侧肢体无力"]) {
  ok(`无关否认不得吃掉阳性红旗：${text}`, hasFlag(text));
}
// 反向：紧凑否认列举必须仍然是否认。这是本项目显式测试的误报类别，放宽识别绝不能碰它。
for (const text of ["否认胸痛，胸闷，气促", "既往体健，否认胸痛胸闷", "否认胸痛，未出现气促"]) {
  ok(`否认列举仍是否认：${text}`, !hasFlag(text));
}

if (failures.length > 0) {
  console.error("[test:redflag-expression-coverage] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(`[test:redflag-expression-coverage] OK — ${checks} 项断言全过`);
