// 药名身份不可判定（单字残片）必须 fail-closed。
//
// 立这道闸的直接原因是一个**自我授权的闭环**：剂量豁免表
// （src/data/tcm-herb-dose-clinician-policy.source.json）是按「哪些药名卡住了方剂」
// 自动汇总出来的，于是 40 个古籍抽取残片被收成了合法的「由医师确定用量」成分——
// 其中「用」「汤」「身」「坯」「绢」根本不是药。豁免表反过来让含残片的方通过剂量门禁：
// 实测 33 张方可编译剂量，另有 4 个残片被直接解析成真药并配上数值区间
// （豉→淡豆豉、草→甘草、本→藁本、芎→川芎）。
//
// 构建脚本的注释当时**已经写明**「单字残缺继续整方阻断——把它们印成『用量由医师确定』
// 比不给更糟」，代码却从没实现过这一条。注释和代码是两个面，这是本项目反复出现的形状。
//
// 因此本套件同时钉住三件事：
//   ① 运行时三条入口（身份解析 / 剂量豁免 / 存在性）都认这条规则；
//   ② 生成目录里不存在「含残片且可编译剂量」的方；
//   ③ **构建期 python 判据与运行时 TS 判据在同一批 token 上结论逐个相同**——
//      只钉一侧，另一侧迟早漂走。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isIdentityIndeterminateHerbName, resolveGovernedTcmHerbIdentity } =
  await jiti.import("../src/lib/tcm-herb-identity.ts");
const { isClinicianDoseHerb, isKnownTcmHerbName } = await jiti.import("../src/lib/tcm-knowledge.ts");

const catalog = JSON.parse(readFileSync("src/data/tcm-formula-governed-catalog.json", "utf8"));

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

/** 目录里实测出现过的 45 个残片，全部来自真实构建产物，不是手写样例。 */
const OBSERVED_FRAGMENTS = [...new Set(
  catalog.entries.flatMap((entry) => entry.corruptIngredientNames || []),
)].sort();

/** 正常饮片名：这条规则不得误伤它们，尤其是那 4 个曾被残片错误命中的目标药。 */
const LEGITIMATE_HERBS = [
  "甘草", "淡豆豉", "藁本", "川芎", "黄芪", "黄芩", "黄连", "大黄",
  "肉桂", "桂枝", "芒硝", "生地黄", "姜半夏", "荆芥穗", "广藿香", "朱砂",
];

check("HNI-01 目录里确实存在残片（样本非空，否则本套件是空转）", () => {
  assert.ok(OBSERVED_FRAGMENTS.length >= 40, `只找到 ${OBSERVED_FRAGMENTS.length} 个残片，样本疑似丢失`);
});

check("HNI-02 每个残片都被判为身份不可判定", () => {
  const missed = OBSERVED_FRAGMENTS.filter((token) => !isIdentityIndeterminateHerbName(token));
  assert.deepEqual(missed, [], `以下残片没被识别出来：${missed.join("、")}`);
});

check("HNI-03 正常饮片名不得误伤", () => {
  const hurt = LEGITIMATE_HERBS.filter((name) => isIdentityIndeterminateHerbName(name));
  assert.deepEqual(hurt, [], `以下正常药名被误判为残片：${hurt.join("、")}`);
});

check("HNI-04 身份解析：残片一律歧义，绝不落到某味真药上", () => {
  const leaked = [];
  for (const token of OBSERVED_FRAGMENTS) {
    const resolution = resolveGovernedTcmHerbIdentity(token);
    if (resolution.canonicalName) leaked.push(`${token} → ${resolution.canonicalName}`);
    if (resolution.status !== "ambiguous") leaked.push(`${token} status=${resolution.status}`);
  }
  assert.deepEqual(leaked, [], `残片被静默解析成了具体药味：\n  ${leaked.join("\n  ")}`);
});

check("HNI-05 剂量豁免：残片拿不到「由医师确定用量」豁免", () => {
  const exempt = OBSERVED_FRAGMENTS.filter((token) => isClinicianDoseHerb(token));
  assert.deepEqual(exempt, [], `以下残片仍在享受剂量豁免（会被当成一味药标注下发）：${exempt.join("、")}`);
});

check("HNI-06 存在性：残片不算「知识库已收录」", () => {
  const known = OBSERVED_FRAGMENTS.filter((token) => isKnownTcmHerbName(token));
  assert.deepEqual(known, [], `以下残片被判为已收录饮片：${known.join("、")}`);
});

check("HNI-07 生成目录：不存在「含残片且可编译剂量」的方", () => {
  const offenders = catalog.entries
    .filter((entry) => (entry.corruptIngredientNames || []).length > 0 && entry.doseCompilationEligible)
    .map((entry) => `${entry.name}（残片 ${entry.corruptIngredientNames.join("、")}）`);
  assert.deepEqual(offenders, [], `以下方组成含身份不明的药味，却仍可自动编译数值剂量：\n  ${offenders.join("\n  ")}`);
});

check("HNI-08 生成目录：残片方必须给出「回源修抽取」这条独立阻断理由", () => {
  const missing = catalog.entries
    .filter((entry) => (entry.corruptIngredientNames || []).length > 0)
    .filter((entry) => !(entry.doseBlockingReasons || []).includes("ingredient_name_corrupt_requires_source_repair"))
    .map((entry) => entry.name);
  assert.deepEqual(missing, [], `以下残片方缺独立阻断理由，下游会给出错误的转人工提示：\n  ${missing.join("、")}`);
});

check("HNI-09 生成目录：没有任何单字药味被链接到规范名", () => {
  const linked = [];
  for (const entry of catalog.entries) {
    for (const link of entry.ingredientLinks || []) {
      if (isIdentityIndeterminateHerbName(link.rawName) && link.canonicalName) {
        linked.push(`${entry.name}：${link.rawName} → ${link.canonicalName}`);
      }
    }
  }
  assert.deepEqual(linked, [], `构建期把残片猜成了具体药味：\n  ${linked.join("\n  ")}`);
});

check("HNI-10 构建期 python 判据与运行时 TS 判据逐个同集", () => {
  // 只钉一侧没有意义：目录是 python 生成的、运行时是 TS 判的，两边漂开就会出现
  // 「目录说不可编译、运行时说可以」这类分叉。这里直接跑 python 侧判据比对。
  const probes = [...OBSERVED_FRAGMENTS, ...LEGITIMATE_HERBS, "", " ", "A", "1", "生", "去核", "朱砂粉"];
  const script = [
    "import json, sys",
    "sys.path.insert(0, 'scripts')",
    "import importlib.util",
    "spec = importlib.util.spec_from_file_location('bt', 'scripts/build-tcm-governance-tables.py')",
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "probes = json.loads(sys.argv[1])",
    "print(json.dumps([mod.is_identity_indeterminate_herb_name(p) for p in probes]))",
  ].join("\n");
  let pythonVerdicts;
  try {
    const out = execFileSync("python3", ["-c", script, JSON.stringify(probes)], { encoding: "utf8" });
    pythonVerdicts = JSON.parse(out.trim().split("\n").pop());
  } catch (error) {
    // 构建脚本 import 期会读数据文件；跑不起来时**不静默跳过**——静默跳过正是本项目
    // 反复栽跟头的地方（监控脚本吞掉报错，失败看起来和正常一模一样）。
    throw new Error(`无法执行构建期判据做同集比对：${String(error.message).slice(0, 400)}`);
  }
  const diverged = probes
    .map((probe, index) => ({ probe, ts: isIdentityIndeterminateHerbName(probe), py: pythonVerdicts[index] }))
    .filter((row) => row.ts !== row.py)
    .map((row) => `${JSON.stringify(row.probe)}: TS=${row.ts} python=${row.py}`);
  assert.deepEqual(diverged, [], `构建期与运行时对同一个药名结论不同：\n  ${diverged.join("\n  ")}`);
});

if (failures.length > 0) {
  console.error("药名身份 fail-closed FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({
  suite: "herb-name-identity",
  fragments: OBSERVED_FRAGMENTS.length,
  corruptFormulas: catalog.entries.filter((e) => (e.corruptIngredientNames || []).length > 0).length,
  failures: 0,
}));
