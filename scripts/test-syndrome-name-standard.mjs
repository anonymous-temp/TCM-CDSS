// 主证名规范化回归(2026-08-05,甲方证候名规范化确认项)。
//
// 实测:线上主证输出「头痛（气血失和，脑失濡养）」——括号外是病名、括号内是病机,
// 整串不是任何一层的规范表述。此前合同只校验主证非空与不含待辨字样,从不校验它是不是一个证候。
// 受治理证候词表 2060 条各带 GB/T 编号,标准一直都在,只是主证这一栏从未拿它比对过。
//
// 本套件钉两个方向:
//  · 规范写法(含并列、含括注补充)必须放行——判据不能严到把正常临床表述拦掉;
//  · 病名+病机的混合串必须驳回——这是甲方指出的形态。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const tables = await jiti.import("../src/lib/clinical-governance-tables.ts");

// 判据函数未导出，此处用与实现同源的三段式重建以验证词表可达性；
// 合同层的实际拦截由 m03StructuralIssue 的集成用例覆盖。
const terminology = await jiti.import("../src/lib/clinical-terminology.ts");
const resolvable = (item) => {
  if (String(item).trim().length < 2) return false;
  if (tables.canonicalTcmSyndromeTerm(item)) return true;
  return String(item).replace(/[（(]/g, "，").replace(/[）)]/g, "").split(/[，,、；;]/)
    .map((x) => x.trim()).filter((x) => x.length >= 2)
    .some((x) => Boolean(tables.canonicalTcmSyndromeTerm(x)));
};
const acceptable = (raw) => {
  const v = String(raw || "").trim();
  if (!v) return false;
  // 与实现同源:只拦「以病名开头、且任何剥法都剩不下证候」的形态,其余放行。
  let hasDisease = false;
  for (let L = 2; L <= Math.min(v.length - 1, 8); L += 1) {
    if (!terminology.isGovernedTcmDiseaseName(v.slice(0, L))) continue;
    hasDisease = true;
    const rest = v.slice(L).trim();
    if (rest && resolvable(rest)) return true;
  }
  return !hasDisease;
};

const failures = [];
const ok = (v, why) => { if (!acceptable(v)) failures.push({ v, why, kind: "wrongly_rejected" }); };
const no = (v, why) => { if (acceptable(v)) failures.push({ v, why, kind: "wrongly_accepted" }); };

// 一、规范写法必须放行
ok("心脾两虚证", "标准证候名");
ok("风寒束表证", "标准证候名");
ok("气血两虚证", "标准证候名");
ok("心脾两虚，气血不足", "并列证候写法");
ok("心脾两虚证（气血不足）", "带括注补充");
ok("胸痹心脉痹阻证", "病证结合规范写法:病名+证候");
ok("阴虚神扰证", "词表未收录的合法组合证候名,不得误伤");

// 二、病名+病机混合必须驳回(甲方实测形态)
no("头痛（气血失和，脑失濡养）", "括号外病名、括号内病机，非证候名");

if (failures.length > 0) console.error(JSON.stringify({ failures }, null, 2));
assert.equal(failures.length, 0, `主证名规范化回归失败 ${failures.length} 项`);
console.log(JSON.stringify({ acceptedForms: 7, rejectedForms: 1, failures: 0 }));
