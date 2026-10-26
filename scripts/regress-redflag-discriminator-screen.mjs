// 指南红旗判别项读病历小任务的实测（真实模型，按次计费；不进确定性闸门）。
// 用法：CDSS_ENV_FILE=<env> RUNS=3 node scripts/regress-redflag-discriminator-screen.mjs [setFilter]
// 输出每个概念的检出率（期望读出的）与误读率（对照组不得读出的），两家模型并集与各家单独都报。
import fs from "node:fs";
import { createJiti } from "jiti";
if (process.env.CDSS_ENV_FILE) {
  for (const line of fs.readFileSync(process.env.CDSS_ENV_FILE, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && !(line.slice(0, at) in process.env)) process.env[line.slice(0, at)] = line.slice(at + 1);
  }
}
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const screen = await jiti.import("../src/lib/redflag-discriminator-screen.server.ts");
const fixture = JSON.parse(fs.readFileSync("scripts/fixtures/redflag-discriminator-screen-set.json", "utf8"));
const RUNS = Number(process.env.RUNS || 3);
const filter = process.argv[2];
const results = [];
for (const [setName, cases] of Object.entries(fixture.sets)) {
  if (filter && setName !== filter) continue;
  for (const item of cases) {
    for (let run = 0; run < RUNS; run += 1) {
      // 每次换一个无关前缀，避开小任务缓存（缓存键是请求内容）。
      const record = `${item.record}\n记录序号：${run}-${Date.now() % 100000}`;
      const result = await screen.runRedflagDiscriminatorScreen(record, { ageMonths: item.ageMonths });
      const present = new Set((result?.present || []).map((entry) => entry.conceptId));
      // 只核对这一次清单里真的问到的概念（闸门口径收回的行不再问，见源表 gatePolicy）。
      const asked = new Set(screen.buildRedflagDiscriminatorRequest(record, { ageMonths: item.ageMonths })?.concepts || []);
      results.push({ set: setName, id: item.id, run, status: result?.status, present: [...present],
        missed: (item.present || []).filter((concept) => asked.has(concept) && !present.has(concept)),
        falsePositive: (item.absent || []).filter((concept) => present.has(concept)),
        expected: (item.present || []).filter((concept) => asked.has(concept)).length });
    }
  }
}
const summary = {};
for (const row of results) {
  const key = row.set;
  summary[key] ||= { runs: 0, unavailable: 0, expected: 0, missed: 0, controlsChecked: 0, falsePositive: 0 };
  const entry = summary[key];
  entry.runs += 1;
  if (row.status !== "checked") entry.unavailable += 1;
  const item = fixture.sets[row.set].find((candidate) => candidate.id === row.id);
  entry.expected += row.expected;
  entry.missed += row.missed.length;
  entry.controlsChecked += (item.absent || []).length;
  entry.falsePositive += row.falsePositive.length;
}
fs.mkdirSync("artifacts/redflag-screen", { recursive: true });
fs.writeFileSync(`artifacts/redflag-screen/result-${Date.now()}.json`, JSON.stringify({ results, summary }, null, 1));
console.log(JSON.stringify({ summary, misses: results.filter((row) => row.missed.length || row.falsePositive.length).map((row) => ({ id: row.id, run: row.run, missed: row.missed, falsePositive: row.falsePositive })) }, null, 1));
