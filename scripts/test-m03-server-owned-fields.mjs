/**
 * P2：M03 生成合同瘦身 + 服务端确定性补全。
 *
 * 立项依据（2026-08-29 token 审计，逐字段复证过六个消费方：可见投影 / 安全门 / 签名链 /
 * HIS / M04 输入 / 复核输入）：M03 合同里有一批字段模型写完就被服务端覆盖或直接丢弃。
 * 中医半实测每例输出约 2345 token，按实测 ~51 tok/s 解码，这批字段是纯粹的墙钟成本。
 *
 * 本套件钉住三件事：
 *  1. **校验合同一字未动**——签名载荷、HIS、页面投影的形状不能因为生成侧瘦身而变；
 *  2. 生成侧 schema 确实不再要求这些字段，且死 $defs 被裁掉；
 *  3. 服务端补全「只补不改 / 幂等 / 不产生临床结论」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { applyServerOwnedM03Fields } from "../src/lib/m03-server-owned-fields.ts";
import { responseFormatForTask } from "../src/lib/model-response-format.ts";
import { ReasoningV2Schema } from "../src/lib/diagnosis-types.ts";
import { SAFETY_DEFERENCE_TEXT } from "../src/lib/cdss-vocab.ts";

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (obj) => `前置正文\n${START}\n${JSON.stringify(obj)}\n${END}\n后置正文`;
const unwrap = (content) => JSON.parse(content.split(START)[1].split(END)[0]);

// 模型在瘦身后会输出的形状：没有 schemaVersion/stage/formula/nonPharma/summary/evidence
const modelOutput = () => ({
  overview: {
    tcmDiseaseName: "不寐", primarySyndrome: "心脾两虚证",
    overallPathogenesis: "心脾两虚，心神失养", overallTherapy: "补益心脾",
  },
  westernDiagnosis: { primary: { name: "失眠障碍", status: "考虑", supportingFacts: ["入睡困难3月"] } },
  pathogenesis: {
    locationDifferentiation: { items: ["心", "脾"], resolution: "bounded" },
    natureDifferentiation: { items: ["气虚"], resolution: "bounded" },
    chain: [
      { nodeId: "P1", patientFact: "入睡困难3月", syndromeEvidence: "夜寐不安", pathogenesis: "心神失养", therapyDirection: "养心安神" },
      { nodeId: "P2", patientFact: "纳差乏力", syndromeEvidence: "食少倦怠", pathogenesis: "脾气亏虚", therapyDirection: "健脾益气" },
    ],
  },
  therapy: {
    overallPrinciple: "补益心脾", overallMethod: "养心安神健脾",
    subTherapies: [{ therapy: "养心安神", targetPathogenesis: "心神失养", priority: "主要" }],
  },
  lineageAdaptation: { applicabilityReason: "本例证候与该流派偏好一致", influencedDecisions: [] },
});

// ── 1. 校验合同一字未动 ────────────────────────────────────────────────────
check("校验用 ReasoningV2Schema 仍然认识全部被瘦身的字段", () => {
  const shape = z.toJSONSchema(ReasoningV2Schema, { unrepresentable: "any", reused: "ref" });
  const top = Object.keys(shape.properties || {});
  for (const key of ["schemaVersion", "stage", "formula", "nonPharma"]) {
    assert.ok(top.includes(key), `校验合同丢了 ${key}——签名载荷与 HIS 出口的形状会跟着变`);
  }
  assert.ok("summary" in (shape.properties.pathogenesis.properties || {}), "校验合同丢了 pathogenesis.summary");
  assert.ok("evidence" in (shape.properties.overview.properties || {}), "校验合同丢了 overview.evidence");
});

// ── 2. 生成侧 schema 确实瘦了 ──────────────────────────────────────────────
const generationSchema = (task) => responseFormatForTask("qwen3.8-flash", task).json_schema.schema;
check("生成侧不再要求服务端自有的顶层字段", () => {
  for (const task of ["m03_full", "m03_tcm"]) {
    const top = Object.keys(generationSchema(task).properties || {});
    for (const key of ["schemaVersion", "stage", "formula", "nonPharma"]) {
      assert.ok(!top.includes(key), `${task} 仍在要求模型输出 ${key}`);
    }
  }
});
check("生成侧不再要求 pathogenesis.summary 与各处 evidence", () => {
  const schema = generationSchema("m03_tcm");
  const properties = schema.properties;
  assert.ok(!("summary" in properties.pathogenesis.properties), "仍在要求 summary");
  assert.ok(!("evidence" in properties.overview.properties), "overview 仍在要求 evidence");
  assert.ok(!("evidence" in properties.pathogenesis.properties.locationDifferentiation.properties), "病位仍在要求 evidence");
  assert.ok(!("evidence" in properties.pathogenesis.properties.natureDifferentiation.properties), "病性仍在要求 evidence");
  const defs = Object.values(schema.$defs || {});
  const chainNode = defs.find((d) => d.properties && "nodeId" in d.properties && "patientFact" in d.properties);
  assert.ok(chainNode, "找不到病机节点定义，断言会空转");
  assert.ok(!("evidence" in chainNode.properties), "病机节点仍在要求 evidence");
  const subTherapy = defs.find((d) => d.properties && "therapy" in d.properties && "priority" in d.properties);
  assert.ok(subTherapy, "找不到子治法定义，断言会空转");
  assert.ok(!("evidence" in subTherapy.properties), "子治法仍在要求 evidence");
});
check("西医半也不再要求服务端自有字段", () => {
  const top = Object.keys(generationSchema("m03_western").properties || {});
  assert.deepEqual(top.sort(), ["management", "westernDiagnosis"]);
});
check("lineageAdaptation 的常量子字段已从生成侧移除（否则与提示词直接冲突）", () => {
  const lineage = generationSchema("m03_tcm").properties.lineageAdaptation;
  const variants = lineage.anyOf || [lineage];
  for (const variant of variants) {
    if (!variant.properties) continue;
    for (const key of ["schemaVersion", "lineageCode", "label", "applicable", "unaffectedBySafety", "safetyDeference"]) {
      assert.ok(!(key in variant.properties), `lineageAdaptation 仍在要求模型抄回 ${key}`);
    }
    assert.ok("applicabilityReason" in variant.properties, "applicabilityReason 是模型真正要判断的内容，不得一并裁掉");
  }
});
check("不可达 $defs 已裁剪（两个半区各带一份、每个修复轮再带一份）", () => {
  for (const task of ["m03_tcm", "m03_western"]) {
    const schema = generationSchema(task);
    const defs = schema.$defs || {};
    const reachable = new Set();
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      for (const [key, value] of Object.entries(node)) {
        if (key === "$defs") continue;
        if (key === "$ref" && typeof value === "string") {
          const name = value.split("/").pop();
          if (name && defs[name] && !reachable.has(name)) { reachable.add(name); visit(defs[name]); }
          continue;
        }
        visit(value);
      }
    };
    visit({ properties: schema.properties, required: schema.required });
    assert.equal(Object.keys(defs).length, reachable.size,
      `${task} 仍带着 ${Object.keys(defs).length - reachable.size} 个不可达定义`);
  }
});
check("裁剪后的 m03_tcm schema 显著变小（防止有人把整份 $defs 又带回来）", () => {
  const size = JSON.stringify(generationSchema("m03_tcm")).length;
  assert.ok(size < 16_000, `m03_tcm schema ${size} 字符，超过阈值——不可达定义可能又被带回来了`);
});

// ── 3. 服务端补全的三条不变量 ─────────────────────────────────────────────
const filled = () => unwrap(applyServerOwnedM03Fields(wrap(modelOutput())));
check("常量字段被补齐", () => {
  const out = filled();
  assert.equal(out.schemaVersion, "tcm-cdss-reasoning-v2");
  assert.equal(out.stage, "diagnose");
  assert.equal(out.formula, null);
  assert.equal(out.nonPharma, null);
});
check("各处 evidence 被补齐，且与旧模板逐字一致（下游读数不变）", () => {
  const out = filled();
  assert.deepEqual(out.overview.evidence, { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" });
  assert.deepEqual(out.westernDiagnosis.primary.evidence, { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" });
  assert.deepEqual(out.pathogenesis.locationDifferentiation.evidence, { evidenceLevel: "model_inference", source: "本例四诊与病史推断", confidence: "中" });
  assert.deepEqual(out.pathogenesis.natureDifferentiation.evidence, { evidenceLevel: "model_inference", source: "本例四诊与病史推断", confidence: "中" });
  for (const node of out.pathogenesis.chain) {
    assert.deepEqual(node.evidence, { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" });
  }
  for (const sub of out.therapy.subTherapies) {
    assert.deepEqual(sub.evidence, { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" });
  }
});
check("lineageAdaptation 常量由服务端写定，模型判断项原样保留", () => {
  const out = unwrap(applyServerOwnedM03Fields(wrap(modelOutput()), "unrestricted"));
  assert.equal(out.lineageAdaptation.lineageCode, "unrestricted");
  assert.equal(out.lineageAdaptation.applicable, "partial");
  assert.equal(out.lineageAdaptation.safetyDeference, SAFETY_DEFERENCE_TEXT);
  assert.deepEqual(out.lineageAdaptation.unaffectedBySafety, ["红旗排查", "剂量安全", "配伍禁忌", "特殊人群", "相互作用"]);
  assert.equal(out.lineageAdaptation.applicabilityReason, "本例证候与该流派偏好一致", "模型判断项不得被覆盖");
});

check("只补不改：模型给出的真实外部证据必须原样保留", () => {
  const withRealEvidence = modelOutput();
  const real = { evidenceLevel: "guideline", source: "《中国失眠障碍诊断和治疗指南》", confidence: "高" };
  withRealEvidence.overview.evidence = { ...real };
  withRealEvidence.pathogenesis.chain[0].evidence = { ...real };
  const out = unwrap(applyServerOwnedM03Fields(wrap(withRealEvidence)));
  assert.deepEqual(out.overview.evidence, real, "模型引到的真实证据被服务端默认值覆盖了");
  assert.deepEqual(out.pathogenesis.chain[0].evidence, real);
  // 同批里没给的那条仍应补默认值
  assert.equal(out.pathogenesis.chain[1].evidence.evidenceLevel, "model_inference");
});
check("幂等：重复应用是不动点", () => {
  const once = applyServerOwnedM03Fields(wrap(modelOutput()));
  assert.equal(applyServerOwnedM03Fields(once), once);
});
check("不产生临床结论：补全只动服务端自有字段", () => {
  const before = modelOutput();
  const after = filled();
  assert.equal(after.overview.primarySyndrome, before.overview.primarySyndrome);
  assert.equal(after.overview.overallPathogenesis, before.overview.overallPathogenesis);
  assert.equal(after.pathogenesis.chain.length, before.pathogenesis.chain.length);
  assert.equal(after.pathogenesis.chain[0].pathogenesis, before.pathogenesis.chain[0].pathogenesis);
  assert.equal(after.pathogenesis.locationDifferentiation.items.join(), "心,脾");
  // summary 不由本函数产生——它是 normalizeM03PathogenesisSummaryProjection 的唯一职责，
  // 而权威内核缺失时那个函数刻意不合成（test:stage-contract 钉着这条安全规则）。
  assert.equal(after.pathogenesis.summary, undefined, "补全层不得越权合成病机归纳");
});
check("非 M03 载荷原样返回", () => {
  const m04 = { schemaVersion: "tcm-cdss-m04-proposal-v1", stage: "prescribe", candidate: { name: "归脾汤" } };
  const content = wrap(m04);
  assert.equal(applyServerOwnedM03Fields(content), content, "M04 载荷不得被 M03 补全层改写");
});
check("无 sentinel 或 JSON 非法时原样返回，不抢结构化修复层的活", () => {
  assert.equal(applyServerOwnedM03Fields("没有 sentinel 的纯文本"), "没有 sentinel 的纯文本");
  const broken = `${START}\n{不是合法JSON\n${END}`;
  assert.equal(applyServerOwnedM03Fields(broken), broken);
});

// ── 4. 提示词与合同一致 ───────────────────────────────────────────────────
const prompts = fs.readFileSync(path.join(process.cwd(), "src/lib/diagnosis-prompts.ts"), "utf8");
check("提示词明确告知哪些字段由服务端生成", () => {
  assert.ok(
    prompts.includes("以下字段由服务端确定性生成或覆盖，**不要输出**"),
    "缺少这句，模型会继续输出被裁掉的字段——严格 schema 下会被解码器直接拒",
  );
});
check("提示词示例里不再出现被裁掉的字段", () => {
  const start = prompts.indexOf('## V2结构化临床数据（唯一输出）');
  const end = prompts.indexOf("// ─── M01", start);
  assert.ok(start > 0 && end > start, "切片越界，断言会空转");
  const block = prompts.slice(start, end);
  assert.ok(block.includes('"overview": {'), "切到的不是 M03 合同块");
  assert.ok(!block.includes('"summary": "病机归纳段落"'), "示例里仍在教模型写 summary");
  assert.ok(!block.includes('"evidenceLevel":"model_inference"'), "示例里仍在教模型填 model_inference");
  assert.ok(!block.includes('"nonPharma": null'), "示例里仍有 nonPharma");
});

console.log(JSON.stringify({ checks, failures: 0 }));
