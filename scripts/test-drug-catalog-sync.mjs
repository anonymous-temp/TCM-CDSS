// 药品目录同步接口（甲方 2026-08-05 核对件「药品同步接口：缺少此接口」🟡中）。
//
// 这是 9 条「接口缺失」里唯一**四环全缺**的一条：契约、生成、对外可见、测试都没有。
// 其余八条都是「数据已生成、投影没投出去」。
//
// 本套件同时钉住两件事：
//  1) 接口存在且分页/版本语义正确——没有任何既有测试枚举过路由清单，接口即使实现也无闸门保护；
//  2) **不得替医生做身份裁定**：歧义别名（499 条，如「一包针」→ 千年健/石韦）必须原样标为歧义，
//     待复核状态（AUTO_PARSED_NEEDS_REVIEW / P1-需补表/复核）必须原样保留。
//     压平成单一正名或布尔，等于把待复核条目伪装成已确认条目。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const catalog = await jiti.import("../src/lib/drug-catalog.ts");
const route = await jiti.import("../src/app/api/tcm-knowledge/drug-catalog/route.ts");

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .catch((error) => { failures.push(`${name}: ${error.message}`); });
}

const BASE = "http://localhost:3000/api/tcm-knowledge/drug-catalog";
const get = (qs = "") => route.GET(new Request(`${BASE}${qs}`));

await check("CAT-01 路由存在且不带 type 时返回目录概览", async () => {
  const res = await get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.catalogVersion, "缺目录版本");
  assert.equal(body.types.length, 4, "四类目录必须全部登记");
  for (const entry of body.types) {
    assert.ok(entry.total > 0, `${entry.type} 条目数为 0，数据源未接通`);
  }
});

await check("CAT-02 目录版本随三份受治理资产组合，且稳定", async () => {
  const first = catalog.drugCatalogVersion();
  const second = catalog.drugCatalogVersion();
  assert.equal(first, second, "同一构建两次调用版本不一致，HIS 会被迫每次全量重拉");
  assert.match(first, /^kb:.+\|identity:.+\|patent:.+$/, `版本格式不符：${first}`);
});

await check("CAT-03 四类目录均可分页拉取，游标推进正确", async () => {
  for (const type of catalog.DRUG_CATALOG_TYPES) {
    const res = await get(`?type=${type}&limit=5`);
    assert.equal(res.status, 200, `${type} 拉取失败`);
    const body = await res.json();
    assert.equal(body.type, type);
    assert.ok(body.items.length > 0 && body.items.length <= 5, `${type} 分页条数异常：${body.items.length}`);
    assert.equal(body.cursor, 0);
    if (body.total > 5) {
      assert.equal(body.nextCursor, body.items.length, `${type} nextCursor 未推进`);
      const next = await (await get(`?type=${type}&limit=5&cursor=${body.nextCursor}`)).json();
      assert.notDeepEqual(next.items, body.items, `${type} 第二页与第一页相同，游标未生效`);
    } else {
      assert.equal(body.nextCursor, null);
    }
  }
});

await check("CAT-04 limit 越界被钳制，不得让单次请求拉爆整库", async () => {
  const body = await (await get("?type=patent&limit=99999")).json();
  assert.ok(body.items.length <= catalog.DRUG_CATALOG_MAX_LIMIT,
    `limit 未钳制，返回 ${body.items.length} 条`);
  const negative = await (await get("?type=patent&limit=-5&cursor=-3")).json();
  assert.equal(negative.cursor, 0, "负游标必须归零");
  assert.ok(negative.items.length >= 1, "负 limit 必须回落到合法值");
});

await check("CAT-05 未知 type 明确拒绝，不静默回空", async () => {
  const res = await get("?type=不存在的类型");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "unsupported_catalog_type");
  assert.ok(Array.isArray(body.supported) && body.supported.length === 4);
});

await check("CAT-06 since 命中目录版本时回 304，未命中正常返回", async () => {
  const version = catalog.drugCatalogVersion();
  const hit = await get(`?type=herb&since=${encodeURIComponent(version)}`);
  assert.equal(hit.status, 304, "目录未变时应回 304，避免整轮无谓拉取");
  assert.equal(hit.headers.get("x-cdss-catalog-version"), version);
  const miss = await get("?type=herb&since=stale-version");
  assert.equal(miss.status, 200);
});

// —— 以下两条是本套件的临床要害：不得替医生做身份裁定 ——

await check("CAT-07 歧义别名必须标为歧义，绝不自动择一", async () => {
  let checked = 0;
  for (let cursor = 0; cursor < 700; cursor += 500) {
    const body = await (await get(`?type=herb&limit=500&cursor=${cursor}`)).json();
    for (const item of body.items) {
      assert.ok(Array.isArray(item.aliases), `${item.name} 缺 aliases`);
      assert.ok(Array.isArray(item.ambiguousAliases), `${item.name} 缺 ambiguousAliases`);
      for (const ambiguous of item.ambiguousAliases) {
        assert.ok(!item.aliases.includes(ambiguous),
          `${item.name}：歧义别名「${ambiguous}」同时出现在确定别名里，等于替医生择一`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, "未覆盖到任何歧义别名，样本无效");
});

await check("CAT-08 待复核状态原样保留，不得压平成已确认", async () => {
  const mappings = await (await get("?type=his_mapping&limit=500")).json();
  const statuses = new Set(mappings.items.map((item) => item.status).filter(Boolean));
  assert.ok(statuses.size > 0, "HIS 映射未带 status");
  const specs = await (await get("?type=spec_conversion&limit=500")).json();
  const conversionStatuses = new Set(specs.items.map((item) => item.conversionStatus).filter(Boolean));
  assert.ok(conversionStatuses.size > 0, "规格换算未带 conversionStatus");
  const hasReviewMarker = [...statuses, ...conversionStatuses]
    .some((value) => /NEEDS_REVIEW|复核|待/.test(String(value)));
  assert.ok(hasReviewMarker,
    `待复核标记全部消失，待复核条目会被当成已确认：${JSON.stringify([...statuses, ...conversionStatuses].slice(0, 8))}`);
});

await check("CAT-09 剂量边界如实分档：来源冲突不给数值", async () => {
  const body = await (await get("?type=herb&limit=500")).json();
  for (const item of body.items) {
    assert.ok(["governed", "not_governed", "source_conflict_requires_pharmacist_review"]
      .includes(item.doseLimitStatus), `${item.name} 剂量状态非法：${item.doseLimitStatus}`);
    if (item.doseLimitStatus !== "governed") {
      assert.equal(item.doseLimit, null,
        `${item.name} 非受治理剂量却给出了数值区间，HIS 会当成唯一合法区间`);
    }
  }
});

await check("CAT-10 入站对接入口随每页下发，避免集成方以为只有出站", async () => {
  const summary = await (await get()).json();
  const page = await (await get("?type=herb&limit=1")).json();
  assert.equal(summary.inboundSyncEndpoint, "POST /api/drug-inventory");
  assert.equal(page.inboundSyncEndpoint, "POST /api/drug-inventory",
    "每页都要带入站入口——集成方可能只看分页出参");
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "drug-catalog-sync", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "drug-catalog-sync", checks: 10, failures: 0 }));
