import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { formulaSyndromeConflicts, formulaSyndromeConflictNotice } =
  await jiti.import("../src/lib/formula-syndrome-consistency.ts");

let cases = 0, failures = 0;
const check = (name, fn) => { cases += 1; try { fn(); } catch (e) { failures += 1; console.error("FAIL", name, e?.message); } };

// FSC-01 方向对立必须检出(甲方考题集裁决第1条建议:证名与所选方自相矛盾此前无任何一层校验)
check("寒热对立:大寒方 × 虚寒证", () => {
  const c = formulaSyndromeConflicts(["白虎汤"], "脾胃虚寒证");
  assert.equal(c.length, 1);
  assert.equal(c[0].axis, "thermal");
  assert.equal(c[0].syndromeSide, "cold");
  assert.equal(c[0].formulaSide, "heat");
});
check("寒热对立:温中方 × 实热证", () => {
  const c = formulaSyndromeConflicts(["理中丸"], "胃热炽盛证");
  assert.equal(c.length, 1);
  assert.equal(c[0].axis, "thermal");
});

// FSC-02 只拦方向对立,不拦「不同」——一方治多证是中医常态,全拦会大面积误伤
check("方证相符不得报冲突", () => {
  assert.deepEqual(formulaSyndromeConflicts(["归脾汤"], "心脾两虚证"), []);
  assert.deepEqual(formulaSyndromeConflicts(["麻黄汤"], "风寒束表证"), []);
});

// FSC-03 数据缺口必须弃权,绝不因标注缺失驳回(目录 20% 无证候标注、80% 无病位病性)
check("方剂无轴数据时弃权", () => {
  assert.deepEqual(formulaSyndromeConflicts(["茵陈术附汤"], "脾虚湿蕴证"), [],
    "无 natureTags/locationTags 的方必须弃权而不是乱判");
  assert.deepEqual(formulaSyndromeConflicts(["不存在的方名XYZ"], "心脾两虚证"), []);
  assert.deepEqual(formulaSyndromeConflicts(["白虎汤"], ""), []);
  assert.deepEqual(formulaSyndromeConflicts([], "脾胃虚寒证"), []);
});

// FSC-04 呈现文案必须说明「不代表一定错误」——异病同治/反治法均可成立,这是提示不是裁决
check("医生可见文案的边界表述", () => {
  const notice = formulaSyndromeConflictNotice(formulaSyndromeConflicts(["白虎汤"], "脾胃虚寒证"));
  assert.ok(notice);
  assert.match(notice, /不代表一定错误/);
  assert.match(notice, /反治法|异病同治/);
  assert.match(notice, /白虎汤/);
  assert.equal(formulaSyndromeConflictNotice([]), undefined);
});

console.log(JSON.stringify({ cases, failures }));
if (failures > 0) process.exit(1);
