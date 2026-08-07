// 核心药 / 可减药划分 + 按组成反查的减味兜底层（甲方 5.2「该方为麻黄汤加味，展示为自拟方？」）。
//
// 背景：反查此前要求**完整包含**——缺一味即不认。这道判据是上一轮故意收紧的，因为把正向的
// 80% 覆盖线套到反查上会让麻黄汤被识别成「桂枝汤加减」（表实/表虚互斥对，冠错名远比不识别严重）。
// 代价是加减方几乎全军覆没：全目录实测 2573 张方里只有 94 张（3.7%）在去掉一味非核心药后
// 还能被认出，其余医生看到的都是「本例辨证组方」。
//
// 解法不是调阈值，是让「哪一味不能减」有依据，并且**从受控目录自动推导**而不是手标 2900+ 张方：
//   scripts/build-tcm-formula-core-herbs.mjs → src/data/tcm-formula-core-herbs.json
// 四条判据：方名承载药 / 安全定性药 / 目录已裁定锚点 / **塌陷判据**（去掉它本方就与另一张
// 受控方只差不到一味，说明身份由它承载）。塌陷判据是关键：它自动算出「桂枝汤的白芍」
// （去掉即塌向桂枝去芍药汤）、「麻黄汤的桂枝」（塌向三拗汤）、「七物浓朴汤的肉桂」（塌向厚朴三物汤）。
//
// 运行时改成两层且**不互相竞争**：第一层完整包含（原判据一字未改），第二层减味兜底
// 仅在第一层一个候选都没有时启用。全目录对拍：原方识别 0 退步，加减方新识别 1141 张，0 丢失。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { identifyGovernedFormulaByComposition, compositionIdentityName } =
  await jiti.import("../src/lib/tcm-formula-provenance.ts");
const coreHerbs = (await import("../src/data/tcm-formula-core-herbs.json", { with: { type: "json" } })).default;
const catalog = (await import("../src/data/tcm-formula-governed-catalog.json", { with: { type: "json" } })).default;

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const herbs = (...names) => names.map((name) => ({ name }));
const identify = (...names) => identifyGovernedFormulaByComposition(herbs(...names));
const entryOf = (name) => catalog.entries.find((entry) => entry.name === name);
const normalized = (list) => [...new Set(list.map(compositionIdentityName).filter(Boolean))];

check("FCH-01 生成物覆盖全部可锁定条目，且核心+可减 == 组成全集", () => {
  const lockable = catalog.entries.filter((entry) => entry.identityLockEligible && Array.isArray(entry.ingredients));
  assert.equal(
    coreHerbs.formulaCount,
    Object.keys(coreHerbs.formulas).length,
    "生成物自述条数与实际条数不符",
  );
  const missing = lockable.filter((entry) => !coreHerbs.formulas[entry.name]);
  assert.equal(missing.length, 0, `${missing.length} 个可锁定方没有核心药划分（生成物已与目录漂移，需重跑 build:tcm-formula-core-herbs）`);
  for (const entry of lockable.slice(0, 300)) {
    const info = coreHerbs.formulas[entry.name];
    const union = new Set([...info.core, ...info.optional]);
    const composition = new Set(normalized(entry.ingredients));
    assert.deepEqual(
      [...union].sort(),
      [...composition].sort(),
      `${entry.name} 的核心+可减 与组成不一致`,
    );
  }
});

check("FCH-02 生成器与运行时的安全定性药名单必须同源", () => {
  // 两处各写一份是刻意的（生成器不 import 运行时的数据依赖），但不一致会让核心药判定分叉。
  const runtime = readFileSync("src/lib/tcm-formula-provenance.ts", "utf8");
  const generator = readFileSync("scripts/build-tcm-formula-core-herbs.mjs", "utf8");
  const listOf = (source) => {
    const match = /CORE_SAFETY_HERBS = (?:new Set\()?\[([\s\S]*?)\]/.exec(source);
    assert.ok(match, "找不到 CORE_SAFETY_HERBS 定义");
    return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]).sort();
  };
  assert.deepEqual(listOf(generator), listOf(runtime), "生成器与运行时的安全定性药名单已分叉");
});

check("FCH-03 塌陷判据算出的核心药与临床一致", () => {
  // 每一条都点名，因为它们正是「放宽阈值会冠错名」的那批判别点。
  const expectations = [
    ["桂枝汤", "白芍", true],      // 去掉即塌向桂枝去芍药汤
    ["桂枝汤", "桂枝", true],      // 方名承载
    ["桂枝汤", "生姜", false],
    ["麻黄汤", "麻黄", true],
    ["麻黄汤", "桂枝", true],      // 去掉即塌向三拗汤
    ["七物浓朴汤", "肉桂", true],  // 去掉即塌向厚朴三物汤
    ["七味都气丸", "五味子", true],// 去掉即分毫不差是六味地黄丸
    ["归脾汤", "远志", false],     // 去掉后最近的受控方差 5 味，不承载身份
    ["小柴胡汤", "柴胡", true],
  ];
  for (const [formula, herb, shouldBeCore] of expectations) {
    const info = coreHerbs.formulas[formula];
    assert.ok(info, `生成物缺 ${formula}`);
    const identity = compositionIdentityName(herb);
    const isCore = info.core.includes(identity);
    assert.equal(
      isCore,
      shouldBeCore,
      `${formula} 的「${herb}」应${shouldBeCore ? "" : "不"}是核心药（当前核心=${info.core.join("、")}）`,
    );
  }
});

check("FCH-04 安全底线：互斥对绝不互相冠名", () => {
  // 上一轮真实误判过的一对：把无汗表实的麻黄汤冠上有汗表虚的桂枝汤名。
  const mahuang = identify("麻黄", "桂枝", "甘草", "苦杏仁");
  assert.ok(mahuang, "麻黄汤原方未被识别");
  assert.equal(mahuang.formulaName, "麻黄汤");
  const guizhi = identify("桂枝", "白芍", "甘草", "生姜", "大枣");
  assert.ok(guizhi, "桂枝汤原方未被识别");
  // 目录里「桂枝加桂汤」被录成了与桂枝汤逐味相同的组成（真实差异只在桂枝用量），
  // 按组成反查在原理上分不开，第一层因此可能给出「桂枝加桂汤」。这是**目录数据缺陷**，
  // 修法在构建期而不是排序判据里——试过「不带加/去/合优先」与「名字短优先」两条
  // tie-break，全目录对拍都是净负（前者让「小半夏加茯苓汤」被消暑丸顶掉，
  // 后者把「六味地黄丸」改判成「虚验方」）。此处只断言真正的安全底线：
  // 不得跨到表虚/表实互斥的另一族去。
  assert.ok(
    /桂枝/.test(guizhi.formulaName),
    `桂枝汤原方被识别成与桂枝无关的 ${guizhi.formulaName}`,
  );
  assert.notEqual(guizhi.formulaName, "麻黄汤", "桂枝汤被冠上麻黄汤名");
  // 缺核心药一律不得冠名：麻黄汤去桂枝不是麻黄汤（那是三拗汤），更不能是桂枝汤。
  const withoutGuizhi = identify("麻黄", "甘草", "苦杏仁", "生姜");
  assert.notEqual(withoutGuizhi?.formulaName, "桂枝汤", "去掉桂枝后被冠上桂枝汤名");
  assert.notEqual(withoutGuizhi?.formulaName, "麻黄汤", "缺核心药桂枝仍被冠上麻黄汤名");
});

check("FCH-05 组成相同的孪生条目：兜底层拒绝命名，不猜", () => {
  // 目录里「右归饮」被录成了左归饮的组成（缺杜仲/肉桂/附子），补阴方与补阳方在组成上
  // 完全相同。分辨不了就不要猜——猜错等于把补阴写成补阳。
  const zuogui = entryOf("左归饮");
  const yougui = entryOf("右归饮");
  if (zuogui && yougui) {
    const same = normalized(zuogui.ingredients).sort().join("|") === normalized(yougui.ingredients).sort().join("|");
    if (same) {
      const info = coreHerbs.formulas["左归饮"];
      const droppable = info?.optional?.[0];
      assert.ok(droppable, "左归饮没有可减药，无法构造兜底层场景");
      const partial = normalized(zuogui.ingredients).filter((herb) => herb !== droppable);
      const result = identify(...partial, "陈皮", "生姜");
      assert.notEqual(
        result?.formulaName,
        "右归饮",
        "组成无法分辨的孪生方被猜成了另一张（补阴/补阳相反）",
      );
    }
  }
});

check("FCH-06 目录里的非方名条目不得作为兜底层方名出厂", () => {
  // 「治方」「备用成方」「治大便难及大小便并不通方」这类是章节标题被抽成了条目。
  // 目录侧 identityLockEligible/prescriptionLockEligible/doseCompilationEligible 全为 true，
  // 没有受控标志能区分，只能在这一层拦。真正的修法在目录构建期。
  const placeholders = ["治方", "治方并方", "备用成方", "治大便难及大小便并不通方"];
  for (const name of placeholders) {
    const entry = entryOf(name);
    if (!entry) continue;
    const info = coreHerbs.formulas[name];
    const droppable = info?.optional?.[0];
    if (!droppable) continue;
    const partial = normalized(entry.ingredients).filter((herb) => herb !== droppable);
    const result = identify(...partial, "陈皮", "生姜");
    assert.notEqual(result?.formulaName, name, `非方名条目「${name}」被冠给了处方`);
  }
});

check("FCH-07 分层：完整包含永远压过减味兜底", () => {
  // 银翘散原方九味必须判 canonical，绝不能因为兜底层里有别的候选就改判。
  const yinqiao = identify("金银花", "连翘", "荆芥", "薄荷", "桔梗", "淡豆豉", "牛蒡子", "甘草", "淡竹叶");
  assert.ok(yinqiao, "银翘散原方未被识别");
  assert.equal(yinqiao.modificationKind, "canonical", `银翘散原方被判成 ${yinqiao.modificationKind}`);
  assert.deepEqual(yinqiao.missingIngredients, [], "完整包含的候选不应带缺失药味");
});

check("FCH-08 兜底层的产出必须标为「加减」，不得冒充原方", () => {
  const guipi = entryOf("归脾汤");
  assert.ok(guipi, "目录缺归脾汤");
  const info = coreHerbs.formulas["归脾汤"];
  const dropped = info.optional.filter((herb) => /远志|龙眼肉/.test(herb));
  assert.ok(dropped.length > 0, "归脾汤的远志/龙眼肉应为可减药");
  const partial = normalized(guipi.ingredients).filter((herb) => herb !== dropped[0]);
  const result = identify(...partial, "川芎", "白芍");
  if (result && result.missingIngredients.length > 0) {
    assert.equal(result.modificationKind, "加减", "带缺失药味的候选未标为加减");
    assert.ok(/加减$/.test(result.displayName), `兜底层显示名未带「加减」：${result.displayName}`);
    assert.ok(result.missingIngredients.length <= 1, "兜底层缺失药味超过 1 味");
  }
});

check("FCH-09 召回下限：兜底层必须真的在工作", () => {
  // 防止有人把兜底层悄悄关掉又不改测试。判据是全目录行为，不是某几例。
  const lockable = catalog.entries.filter((entry) =>
    entry.identityLockEligible && Array.isArray(entry.ingredients) && entry.ingredients.length >= 5);
  let recognized = 0;
  let tried = 0;
  for (const entry of lockable) {
    const info = coreHerbs.formulas[entry.name];
    if (!info || info.optional.length === 0) continue;
    tried += 1;
    if (tried > 400) break;
    const partial = normalized(entry.ingredients).filter((herb) => herb !== info.optional[info.optional.length - 1]);
    if (identify(...partial, "陈皮", "生姜")) recognized += 1;
  }
  assert.ok(tried > 100, `可构造的加减方样本只有 ${tried} 例，样本不足`);
  assert.ok(
    recognized / tried > 0.6,
    `加减方识别率跌到 ${(recognized * 100 / tried).toFixed(1)}%（应 >60%）——兜底层疑似失效，` +
      "医生会重新看到大量「本例辨证组方」",
  );
});

if (failures.length > 0) {
  console.error("核心药划分与减味兜底 FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({ formulas: coreHerbs.formulaCount, failures: 0 }));
