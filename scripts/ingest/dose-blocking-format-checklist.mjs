// 剂量阻断药名 勾选清单产出(中医师裁定文案)。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DIR = resolve(ROOT, "artifacts/dose-blocking-adjudication");
const out = JSON.parse(readFileSync(resolve(DIR, "adjudicated.json"), "utf-8"));

const adopt = out.filter((o) => o.decision === "adopt");
const adjust = out.filter((o) => o.decision === "adjust");
const blank = out.filter((o) => o.decision === "blank");
const excipient = out.filter((o) => o.riskClass === "excipient");
const toxic = out.filter((o) => o.riskClass === "toxic");
const homonym = out.filter((o) => o.riskClass === "homonym");

const md = [];
md.push("# 剂量阻断药名 中医师裁定勾选清单（300 个）");
md.push("");
md.push(`共 300 个：**勾 ${adopt.length}、调整 ${adjust.length}、不勾 ${blank.length}**（其中赋形类勾而持阻 ${excipient.length}、毒性制品持阻 ${toxic.length}、同名异物持阻 ${homonym.length}）。`);
md.push("");
md.push("裁定纪律：药味身份是替换语义——证型判错是检索层选错方，药味判错是开出去另一味药。默认答案是不勾；同名异物一律不勾（白附子禹白附/关白附式合并即事故）；毒性药及其制品不配自动剂量；赋形/外用载体身份可归一但剂量语义不属饮片煎服。");
md.push("");
md.push("已按裁定经 T9 身份表通道入库 286 条（钩选与调整项），另 2 条赋形类仅身份归一、保持剂量阻断。");
md.push("");
for (const o of out) {
  md.push(`### ${o.idx}. ${o.name}`);
  md.push(`*阻断 ${o.blockedCount} 首方的剂量编制*`);
  for (const f of o.formulas.slice(0, 4)) md.push(`> ${f}`);
  const mark = o.decision === "blank" ? " " : "x";
  const finalName = o.standardName || o.proposal;
  md.push(`- [${mark}] 判定为 **${finalName}**　\`${o.dose}\`　(中医师裁定${o.decision === "adjust" ? "·调整" : o.decision === "blank" ? "·不勾" : ""}${o.riskClass !== "none" ? `·${o.riskClass}` : ""})`);
  md.push(`  <sub>中医师裁定依据：${o.evidence}</sub>`);
  md.push("");
}
writeFileSync(resolve(DIR, "中医师裁定勾选清单.md"), md.join("\n") + "\n");
console.log(JSON.stringify({ written: "中医师裁定勾选清单.md", adopt: adopt.length, adjust: adjust.length, blank: blank.length }));
