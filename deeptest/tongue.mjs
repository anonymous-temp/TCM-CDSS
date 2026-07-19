// deeptest/tongue.mjs
// 舌象视觉测试：下载真实舌照→base64→调用 collect(GLM vision)→评估舌诊抽取质量。
// 图片来源：Wikimedia Commons (CC 协议)，非真实患者 PHI。
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = resolve(__dirname, "out", "tongue");
mkdirSync(OUT, { recursive: true });

// (label, url, 预期中医舌象特征)
const IMAGES = [
  ["candidiasis_white_coating", "https://upload.wikimedia.org/wikipedia/commons/a/a0/Human_tongue_infected_with_oral_candidiasis.jpg", "白苔/厚苔（鹅口疮→中医多见白腐苔，主湿浊/痰湿）"],
];

async function toDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (url.match(/\.(jpe?g|png|webp)$/i) || [, "jpg"])[1].toLowerCase().replace("jpg", "jpeg");
  return { dataUrl: `data:image/${ext};base64,${buf.toString("base64")}`, bytes: buf.length };
}

async function callCollect(userInput, tongueDataUrl) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/diagnosis/collect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userInput, tongueImage: tongueDataUrl, tongueImageConsent: true }),
  });
  let raw = "";
  if (res.ok) {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i+1); if (!line) continue;
        try { const o = JSON.parse(line); if (typeof o.content === "string" && o.content !== "[END]") raw += o.content; if (o.error) raw += `\n[ERR:${o.error}]`; } catch {} } }
  } else {
    raw = `HTTP ${res.status}: ${await res.text().catch(()=>"")}`;
  }
  // extract tongueDx sentinel
  let tongueDx = null;
  const s = raw.indexOf("<!-- DIAGNOSIS_JSON_START -->"), e = raw.indexOf("<!-- DIAGNOSIS_JSON_END -->");
  if (s >= 0 && e >= 0) { const sl = raw.slice(s, e); const lb = sl.indexOf("{"), rb = sl.lastIndexOf("}");
    try { const j = JSON.parse(sl.slice(lb, rb+1)); tongueDx = j.tongueDx || null; } catch (err) { tongueDx = { __parseError: String(err) }; } }
  return { ok: res.ok, ms: Date.now() - t0, raw, tongueDx };
}

for (const [label, url, expect] of IMAGES) {
  console.log(`\n=== ${label} ===\n期望: ${expect}\nURL: ${url}`);
  let data;
  try { data = await toDataUrl(url); console.log(`下载 ${data.bytes} bytes`); }
  catch (e) { console.log("下载失败:", e.message); continue; }
  writeFileSync(resolve(OUT, `${label}.dataurl.txt`), data.dataUrl.slice(0, 200) + `...(${data.dataUrl.length} chars)`);
  // 用一段与舌象无关的极简主诉，避免文本干扰舌象抽取
  const r = await callCollect("患者，女，40岁，近期乏力纳差，想请医生看看舌象。", data.dataUrl);
  console.log(`collect ${r.ok?"ok":"FAIL"} (${r.ms}ms)`);
  writeFileSync(resolve(OUT, `${label}.raw.md`), r.raw);
  writeFileSync(resolve(OUT, `${label}.tongueDx.json`), JSON.stringify(r.tongueDx, null, 2));
  if (r.tongueDx) {
    console.log("tongueDx 摘要:");
    console.log("  quality:", JSON.stringify(r.tongueDx.quality));
    console.log("  tongueBody:", JSON.stringify(r.tongueDx.tongueBody));
    console.log("  coating:", JSON.stringify(r.tongueDx.coating));
    console.log("  evidenceLevel:", r.tongueDx.clinicalEvidenceLevel);
    console.log("  summaryText:", r.tongueDx.summaryText);
  } else {
    console.log("无 tongueDx（raw 前300字）:", r.raw.slice(0, 300));
  }
}
