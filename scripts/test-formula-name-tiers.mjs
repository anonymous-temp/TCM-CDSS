// 方名三档处置回归(2026-08-05)。
//
// 组成与受治理基准的关系有三种,此前只处置了两端:
//   一、完全吻合        ⇒ 保留原方名
//   二、核心保留、有增减 ⇒ **应记为「X 加减」**(此前缺失,被与第三档同等作废)
//   三、核心已不成立    ⇒ 才剥离为自拟方
//
// 线上实测(风热犯表证):模型给出 金银花 连翘 薄荷 荆芥 桔梗 牛蒡子 淡竹叶 芦根 甘草
// ——标准银翘散加减(略淡豆豉、加芦根,均临床常规),药味全部通过剂量与配伍校验,
// 但因方名写作「银翘散」而非「银翘散加减」走严格分支(recall 8/9=0.89 < 0.999)⇒ 方名整体作废。
// 医生看到「本例辨证组方」,不知道这是银翘散。线上 60 例语料自拟方占 74%,主因在此。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const prov = await jiti.import("../src/lib/tcm-formula-provenance.ts");

const herb = (name) => ({ name, dose: "10g" });
const failures = [];
const check = (label, ok, detail) => { if (!ok) failures.push({ label, detail }); };

// 银翘散受治理基准:金银花 连翘 荆芥 薄荷 桔梗 淡豆豉 炒牛蒡子 甘草 淡竹叶
const EXACT = ["金银花","连翘","荆芥","薄荷","桔梗","淡豆豉","炒牛蒡子","甘草","淡竹叶"];
// 线上真实产出:略淡豆豉、加芦根、牛蒡子未标炮制
const MODIFIED = ["金银花","连翘","薄荷","荆芥","桔梗","炒牛蒡子","淡竹叶","芦根","甘草"];
// 核心已不成立:仅保留两味,其余全换
const BROKEN = ["金银花","连翘","附子","干姜","肉桂","白术","茯苓"];

// 每次调用都用新构造的药味数组:复用同一数组对象会在多次校验间携带状态,
// 实测因此出现 matchedIngredientCount=0 的假失败。
const verifyAs = (names, explicitlyModified) =>
  prov.verifyFormulaCompilationComponents(["银翘散"], names.map(herb), false, explicitlyModified);

// 第一档:完全吻合,严格标准下即成立
check("第一档 完全吻合(严格)", verifyAs(EXACT, false).every((x) => x.verified),
  JSON.stringify(verifyAs(EXACT, false).map((x) => x.verified)));

// 第二档:严格标准不成立,但按加减标准成立 —— 这正是「X 加减」应当被记名的情形
const strictOnModified = verifyAs(MODIFIED, false).every((x) => x.verified);
const modifiedOnModified = verifyAs(MODIFIED, true).every((x) => x.verified);
check("第二档 严格标准应不成立", !strictOnModified, "严格标准下不应通过,否则第二档无意义");
check("第二档 加减标准应成立", modifiedOnModified,
  JSON.stringify(verifyAs(MODIFIED, true).map((x) => ({ v: x.verified, ov: x.matchedIngredientCount, total: x.totalIngredientCount }))));

// 第三档:核心已不成立,两种标准都不通过
check("第三档 严格标准不成立", !verifyAs(BROKEN, false).every((x) => x.verified), "");
check("第三档 加减标准也不成立", !verifyAs(BROKEN, true).every((x) => x.verified),
  "核心已不成立时不得靠「加减」蒙混保留方名");

if (failures.length > 0) console.error(JSON.stringify({ failures }, null, 2));
assert.equal(failures.length, 0, `方名三档回归失败 ${failures.length} 项`);
console.log(JSON.stringify({ tiers: 3, checks: 5, failures: 0 }));
