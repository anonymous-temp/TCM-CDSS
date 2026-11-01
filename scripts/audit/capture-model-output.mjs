// 截获每次模型调用的完整输出（不存提示词），按病历指纹归到病例。--import 预加载。
import fs from "node:fs";
const dir = process.env.TRACE_DIR; fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const cases = JSON.parse(fs.readFileSync(process.env.TRACE_CASES, "utf8")).map((c) => ({ key: c.key, fp: String(c.caseState?.symptoms?.["现病史"] || c.caseState?.chiefComplaint || "").slice(0, 22) }));
const real = globalThis.fetch; let n = 0;
function assemble(text) {
  if (!text.includes("data:")) { try { const j = JSON.parse(text); const m = j.choices?.[0]?.message; return m?.content || JSON.stringify(m?.tool_calls || "") ; } catch { return text.slice(0, 20000); } }
  let out = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue; const p = line.slice(5).trim(); if (p === "[DONE]") continue;
    try { const d = JSON.parse(p).choices?.[0]?.delta; if (d?.content) out += d.content; const t = d?.tool_calls?.[0]?.function?.arguments; if (t) out += t; } catch {}
  }
  return out;
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url || String(input);
  if (!/chat\/completions/.test(url) || !init?.body) return real(input, init);
  const id = `${process.pid}-${String(++n).padStart(5, "0")}`;
  let body = {}; try { body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)); } catch {}
  const all = JSON.stringify(body.messages || "");
  const hit = cases.find((c) => c.fp.length >= 6 && all.includes(c.fp));
  const sys = String(body.messages?.[0]?.content || "").slice(0, 160);
  const t0 = Date.now();
  const res = await real(input, init);
  res.clone().text().then((t) => fs.writeFileSync(`${dir}/${id}.json`, JSON.stringify({ key: hit?.key || null, t: t0, ms: Date.now() - t0, model: body.model, schema: body.response_format?.json_schema?.name || body.tools?.[0]?.function?.name || null, sys, content: assemble(t) }), { mode: 0o600 })).catch(() => {});
  return res;
};
