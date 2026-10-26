// 指南红旗判别项（src/data/redflag-discriminators.source.json）→ 闸门用的精简运行时表 src/data/redflag-discriminators.json。
// 源表带逐字引文与中文定义（155KB），只给服务端读病历的小任务写提示词；安全层会进页面打包，只读这份精简表。
// 用法：node scripts/build-redflag-discriminators.mjs [--check]
import fs from "node:fs";
const SOURCE = "src/data/redflag-discriminators.source.json";
const OUTPUT = "src/data/redflag-discriminators.json";
const source = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
const policy = source.gatePolicy.bySource;
const SOURCE_LABELS = {
  "nice-ng143": "NICE NG143 五岁以下发热红绿灯表",
  "nice-ng254": "NICE NG254 十六岁以下疑似脓毒症",
  "nice-ng253": "NICE NG253 十六岁及以上疑似脓毒症",
  "nice-ng255": "NICE NG255 妊娠期疑似脓毒症",
  "mts-vaidyanathan-2012": "曼彻斯特分诊通用判别项",
  "mts-seiger-2014": "曼彻斯特分诊通用判别项",
};
const rows = source.discriminators.map((row) => {
  const enabled = row.verified !== false && row.enabledByDefault !== false;
  const action = enabled ? (policy[row.sourceId]?.[row.level]?.[row.kind] || "none") : "none";
  const population = Object.fromEntries(Object.entries(row.population || {}).filter(([key]) => key !== "setting"));
  return {
    id: row.id,
    sourceId: row.sourceId,
    level: row.level,
    kind: row.kind,
    conceptId: row.conceptId,
    labelZh: row.labelZh,
    population,
    ...(row.numeric ? { numeric: row.numeric } : {}),
    action,
  };
}).filter((row) => row.action !== "none");
const output = {
  generatedFrom: SOURCE,
  version: source.version,
  sourceLabels: SOURCE_LABELS,
  contextConceptIds: source.contextConcepts.map((item) => item.conceptId),
  rows,
};
const text = `${JSON.stringify(output)}\n`;
if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
  if (current !== text) { console.error(`${OUTPUT} 与源表不同步，请运行 node scripts/build-redflag-discriminators.mjs`); process.exit(1); }
  console.log(JSON.stringify({ ok: true, rows: rows.length }));
} else {
  fs.writeFileSync(OUTPUT, text);
  console.log(JSON.stringify({ written: OUTPUT, rows: rows.length, bytes: text.length }));
}
