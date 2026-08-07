// 生成 src/data/tcm-formula-core-herbs.json —— 逐方的「核心药 / 可减药」划分。
//
// 为什么需要它：按组成反查经方时，完整包含（缺一味即不认）让加减方几乎全军覆没
// ——全目录实测 2573 张方里只有 94 张（3.7%）在去掉一味非核心药后仍能被认出，
// 其余医生看到的都是「本例辨证组方」（甲方 5.2「该方为麻黄汤加味，展示为自拟方？」）。
// 但直接放宽阈值是上一轮踩过的坑：把正向 80% 覆盖线套到反查上，麻黄汤被识别成
// 「桂枝汤加减」——表实/表虚互斥对，冠错名比不识别严重得多。
//
// 出路是「哪一味不能减」要有依据，而不是拍一个阈值。本脚本从**受控目录自身**推导，
// 不手工标注 2900+ 张方（那既做不完，也无人复核）。四条判据，全部可复算：
//
//  1) 方名承载药 —— 麻黄汤的麻黄、桂枝汤的桂枝。名字就是它，减掉即名不副实。
//  2) 安全定性药 —— 附子/乌头/半夏/麻黄/细辛/大黄… 决定全方寒热攻补的性质。
//     **必须按 row.ingredients 全量算，不能用扣除毒性味之后的可编译组成**：
//     T8 会把附子这类扣出剂量编译，若据此算核心药，右归饮的附子就不在核心里，
//     左归饮（补阴）会被认成「右归饮加减」（补阳）。
//  3) 目录已人工裁定的 requiredIngredients（有就用，没有不强求）。
//  4) **塌陷判据**：去掉它之后，本方就与另一张受控方只差不到一味——
//     说明这张方的身份主要由它承载。例：
//       七物浓朴汤 = 厚朴 甘草 大黄 枳实 桂心；去掉桂心后 = 厚朴三物汤 + 甘草，
//       只多一味 → 桂心是核心药。少了它就该叫厚朴三物汤，不该叫七物浓朴汤。
//       七味都气丸去五味子 = 六味地黄丸（分毫不差）→ 五味子是核心药。
//     反例（正确地判为可减）：
//       归脾汤去远志后仍有 9 味，最接近的受控方四君子汤只有 4 味，差 5 味 →
//       远志不承载归脾汤的身份，可减。
//
// 判据 4 是 O(方数² × 味数)，因此放在构建期而不是运行时。
// 输入只有 src/data/tcm-formula-governed-catalog.json（仓库内已有，不依赖外部 CSV），
// 所以这个生成物任何人都能原地复算。
import { readFileSync, writeFileSync } from "node:fs";

const CATALOG_PATH = "src/data/tcm-formula-governed-catalog.json";
const OUT_PATH = "src/data/tcm-formula-core-herbs.json";

// 身份归一**直接复用运行时那一个函数**。此前生成器自带一张别名表，与运行时的
// compositionIdentityName 对「黄芩片 vs 黄芩」这类判断分叉，生成的核心药名在运行时对不上，
// 接入后误判反而从 40 例涨到 50 例。核心药是安全判据，两边必须是同一把尺子。
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { compositionIdentityName } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const identityName = (raw) => compositionIdentityName(String(raw || ""));

// 与 src/lib/tcm-formula-provenance.ts 的 CORE_SAFETY_HERBS 同源；不一致由
// test:formula-core-herbs 断言拦住。
const CORE_SAFETY_HERBS = [
  "附子", "乌头", "川乌", "草乌", "半夏", "天南星", "麻黄", "细辛", "大黄", "巴豆", "朱砂", "雄黄", "马钱子",
];

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
const rows = catalog.entries.filter((entry) => entry.identityLockEligible && Array.isArray(entry.ingredients));

// 身份集合：同一张方在目录里可能有多个命名条目（八珍汤/八珍散），组成相同即同一张方，
// 塌陷判据必须跳过它们，否则每一味都会被判成核心。
const compositions = rows.map((row) => {
  const set = new Set(row.ingredients.map(identityName).filter(Boolean));
  return { name: row.name, set, signature: [...set].sort().join("|") };
});

const universe = [...new Set(compositions.flatMap((item) => [...item.set]))].sort();
const bitIndex = new Map(universe.map((herb, index) => [herb, index]));
function toMask(set) {
  let mask = 0n;
  for (const herb of set) mask |= 1n << BigInt(bitIndex.get(herb));
  return mask;
}
for (const item of compositions) {
  item.mask = toMask(item.set);
  item.size = item.set.size;
}
// 按味数分桶：塌陷判据只关心 |T| >= |S| - 2 的方，能砍掉绝大多数比较。
const bySize = new Map();
for (const item of compositions) {
  if (!bySize.has(item.size)) bySize.set(item.size, []);
  bySize.get(item.size).push(item);
}

/** 去掉 herb 后，本方是否与另一张受控方只差不到一味。 */
function collapsesWithout(item, herb) {
  const remaining = item.mask & ~(1n << BigInt(bitIndex.get(herb)));
  const remainingSize = item.size - 1;
  // 只有 |T| ∈ [remainingSize - 1, remainingSize] 且 T ⊆ remaining 才算「塌陷」。
  for (const size of [remainingSize, remainingSize - 1]) {
    if (size < 3) continue;
    for (const other of bySize.get(size) || []) {
      if (other.signature === item.signature) continue;
      if ((other.mask & ~remaining) === 0n) return other.name;
    }
  }
  return "";
}

const safety = new Set(CORE_SAFETY_HERBS.map(identityName));
const out = {};
let coreTotal = 0;
let optionalTotal = 0;
for (const item of compositions) {
  const row = rows.find((entry) => entry.name === item.name);
  const core = new Set();
  const reasons = {};
  for (const raw of row.ingredients) {
    const herb = identityName(raw);
    if (!herb) continue;
    if (herb.length >= 2 && item.name.includes(herb)) { core.add(herb); reasons[herb] = "name_bearing"; continue; }
    if (safety.has(herb)) { core.add(herb); reasons[herb] = "safety_defining"; continue; }
  }
  if (item.size >= 4) {
    for (const herb of item.set) {
      if (core.has(herb)) continue;
      const collapsedInto = collapsesWithout(item, herb);
      if (collapsedInto) { core.add(herb); reasons[herb] = `collapses_into:${collapsedInto}`; }
    }
  }
  const optional = [...item.set].filter((herb) => !core.has(herb)).sort();
  coreTotal += core.size;
  optionalTotal += optional.length;
  out[item.name] = { core: [...core].sort(), optional, reasons };
}

writeFileSync(OUT_PATH, `${JSON.stringify({
  schemaVersion: "tcm-formula-core-herbs-v1",
  generatedFrom: CATALOG_PATH,
  formulaCount: Object.keys(out).length,
  formulas: out,
}, null, 1)}\n`);
console.log(JSON.stringify({
  formulas: Object.keys(out).length,
  coreHerbs: coreTotal,
  optionalHerbs: optionalTotal,
  out: OUT_PATH,
}));
