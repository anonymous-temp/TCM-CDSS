// 辩病受控词表完整性与解析行为测试。
// ① 词表完整性:1,249 条(GB/T 15657-2021 编码条目 1,239 + 教材级扩展 10),代码唯一、
//   正名唯一、别名无跨方碰撞、53 条临时诊断用术语带标记、来源标记齐全。
// ② 解析行为(自然语言链路):标准名/别名/「病」字开合/口语扩展/未命中标记,
//   原 9 条手工规则的全部输入输出必须仍然成立;现代医案真实病名串抽样解析。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lexicon = JSON.parse(readFileSync(new URL("../src/data/tcm-disease-lexicon.json", import.meta.url)));
const { resolveTcmDiseaseName, canonicalTcmDiseaseName } = await import("../src/lib/clinical-terminology.ts");

// ① 完整性
assert.equal(lexicon.schemaVersion, "tcm-disease-lexicon-v1");
const entries = lexicon.entries;
assert.equal(entries.length, 1267, "条目总数 1,267(GB 1,239 + 教材扩展 28)");
assert.equal(new Set(entries.map((e) => e.code)).size, entries.length, "代码唯一");
assert.equal(new Set(entries.map((e) => e.canonical)).size, entries.length, "正名唯一");
assert.equal(entries.filter((e) => e.temporary).length, 53, "53 条临时诊断用术语");
assert.equal(entries.filter((e) => e.category === "临床扩展").length, 28, "28 条教材级扩展正名");
const gbEntries = entries.filter((e) => e.category !== "临床扩展");
assert.equal(gbEntries.length, 1239, "GB/T 15657 编码条目 1,239");
assert.ok(gbEntries.every((e) => e.sourceRefs.includes("SRC-GBT-15657-2021")), "来源标记齐全");
// 别名不得同时是两个正名的别名(撞名歧义)
const aliasOwner = new Map();
for (const e of entries) {
  for (const a of e.aliases) {
    const key = a.normalize("NFKC").replace(/\s+/g, "");
    if (aliasOwner.has(key) && aliasOwner.get(key) !== e.canonical) {
      assert.fail(`别名跨方碰撞:${a} → ${aliasOwner.get(key)} / ${e.canonical}`);
    }
    aliasOwner.set(key, e.canonical);
  }
}

// ② 解析行为
const R = (v) => resolveTcmDiseaseName(v);
// 标准正名
assert.equal(R("感冒")?.canonical, "感冒");
assert.equal(R("感冒")?.status, "standard");
// 标准别名
assert.equal(R("时邪感冒")?.canonical, "时行感冒");
assert.equal(R("时邪感冒")?.status, "standard_alias");
assert.equal(R("瘟疫")?.canonical, "疫病");
assert.equal(R("胃脘痛")?.canonical, "胃痛");
assert.equal(R("胃脘痛")?.temporary, true, "胃痛系临时诊断用术语,须透出标记");
assert.equal(R("中风")?.canonical, "中风病");
// 「病」字开合
assert.equal(R("不寐")?.canonical, "不寐病");
assert.equal(R("泄泻")?.canonical, "泄泻病");
assert.equal(R("咳嗽")?.canonical, "咳嗽病", "咳嗽(临时术语)归到正式病名咳嗽病,同失眠→不寐病一例");
// 临床扩展别名(原 9 条手工规则语义保留,但归到标准正形)
assert.equal(R("失眠")?.canonical, "不寐病");
assert.equal(R("失眠症")?.canonical, "不寐病");
assert.equal(R("头晕")?.canonical, "眩晕");
assert.equal(R("心慌")?.canonical, "心悸");
assert.equal(R("腹泻")?.canonical, "泄泻病");
assert.equal(R("拉肚子")?.canonical, "泄泻病");
// 临床扩展正名(GB 未收的教材级病名)
assert.equal(R("月经不调")?.canonical, "月经不调");
assert.equal(R("月经不调")?.status, "extension");
assert.equal(R("积聚")?.status, "extension");
assert.equal(R("血证")?.status, "extension");
// 教材级别名
assert.equal(R("湿疹")?.canonical, "湿疮");
assert.equal(R("荨麻疹")?.canonical, "瘾疹");
assert.equal(R("银屑病")?.canonical, "白疕");
assert.equal(R("带状疱疹")?.canonical, "蛇串疮");
assert.equal(R("斑秃")?.canonical, "油风");
assert.equal(R("面瘫")?.canonical, "口僻");
assert.equal(R("先兆流产")?.canonical, "胎动不安");
assert.equal(R("鼻窦炎")?.canonical, "鼻渊");
assert.equal(R("霍乱")?.canonical, "疫霍乱");
assert.equal(R("痞满")?.canonical, "胃痞病");
// 未命中:原样放行并标记 unverified(提示词允许的症状层工作病名不得被拦)
const uv = R("浑身不得劲综合征|综合症");
assert.equal(uv?.status, "unverified");
// 临时术语前缀命中:复合症状串取首症状,标 temporary(症状层语义,与提示词「症状层工作病名」一致)
for (const w of ["发热原因待查", "发热待查", "发热查因"]) {
  const rw = R(w);
  assert.equal(rw?.canonical, "发热", `${w} 应归到临时术语发热`);
  assert.equal(rw?.temporary, true);
}
assert.equal(R("无名热")?.status, "unverified", "无名热非病名,须留空");
const fh = R("烦躁和遗尿");
assert.equal(fh?.canonical, "烦躁");
assert.equal(fh?.temporary, true);
assert.equal(uv?.canonical, "浑身不得劲综合征|综合症");
// 临时术语标记透出
assert.equal(R("发热")?.temporary ?? R("高热")?.temporary, true);
// canonicalTcmDiseaseName 兼容语义:未命中走原样;正名命中走正形
const ctx = (tcmDiseaseName, primarySyndrome = "") => ({ overview: { tcmDiseaseName, primarySyndrome }, westernDiagnosis: { primary: { name: "" } } });
assert.equal(canonicalTcmDiseaseName("失眠", ctx("失眠")), "不寐病");
assert.equal(canonicalTcmDiseaseName("不寐", ctx("不寐")), "不寐病");
assert.equal(canonicalTcmDiseaseName("夜间翻来覆去", ctx("夜间翻来覆去")), "夜间翻来覆去");
// 兼容回退:病名字段为空但证型字段里混了病名
assert.equal(canonicalTcmDiseaseName("", ctx("", "不寐（心脾两虚证）")), "不寐病");

// 现代医案真实中医病名抽样(非西医名):解析率必须 ≥90%
const corpus = JSON.parse(readFileSync(new URL("../src/data/tcm-modern-case-eval-corpus.json", import.meta.url)));
const WESTERN = /炎|综合征|综合症|梗塞|梗死|硬化|哮喘|乙肝|肾炎|肝炎|结石|肌瘤|囊肿|增生|溃疡|糖尿(?!目病)|高血压|冠心病|关节炎|感染|衰竭|肿瘤|癌(?!症)|贫血|过敏|疱疹|湿疣|骨折|脱位|扭伤|劳损|突出|反流|息肉|甲亢|甲减|白血|红斑狼疮|银屑|干燥|帕金森|脑瘫|肾病|脱出|扩张|脂肪|性紫癜|肝病|肺疾病|不全|麻痹|养育|卵巢|多囊|坐骨|血栓|静脉|坏死|阻塞|脑出血|脑溢血|结核|细胞|小板|梗阻|胆石|腺瘤|血管瘤|溃疡性|慢性非|萎缩|反流性|类风湿|强直|白塞|干燥|帕金森|阿尔茨海默|痴呆（|多发性硬化|格林巴利|重症肌无力|运动神经元|脊髓|颅|垂体|甲状腺|肾上腺|糖尿病|高脂血|痛风|肥胖症|代谢|更年|绝育|避孕|妊娠(?!恶阻|糖尿病)|分娩|产褥|流产(?!先)|异位妊娠|葡萄胎|绒癌|不孕(?!$)|宫颈炎|盆腔炎|阴道炎|外阴|宫颈|子宫(?!出血)|附件|输卵|卵巢功能|乳腺(?!痈|癖|核|岩|痨|漏|疬|核)|前列腺增生|泌尿系|尿路|膀胱|肛门|阑尾|胆囊|胰腺|食管|胃部|十二指肠|结肠炎|直肠炎|胃肠炎|消化性溃疡|幽门|病毒性|细菌性|真菌|支原体|衣原体|感染性疾病|传染|流行性|疫苗|接种|过敏性疾病|免疫|自身抗体|结缔组织|红斑|鱼鳞|毛周角化|脂溢|秃发|白发|甲沟|嵌甲|胼胝|鸡眼|疣状|痣|黑素|黑色素|咖啡斑|太田|鲜红斑|毛细血管|静脉曲|动脉硬化|血栓闭塞|雷诺|心肌|心包|先天性|房缺|室缺|动脉导管|法洛|瓣膜|起搏|射频|支架|搭桥|移植|透析|放化疗|术后|恢复期|并发症|后遗症(?!$)/;
const icd = JSON.parse(readFileSync(new URL("../src/data/icd10-diagnosis-index.json", import.meta.url)));
const icdNames = new Set(icd.entries.map((e) => e.name));
const isWesternName = (n) => WESTERN.test(n) || icdNames.has(n); // ICD 命中者归西医层,不计入中医词表应解分母
const tcmNames = new Map();
for (const c of corpus.cases) {
  for (const d of c.diseases || []) {
    const n = String(d || "").trim();
    if (n && !isWesternName(n)) tcmNames.set(n, (tcmNames.get(n) || 0) + 1);
  }
}
const EXPECTED_UNVERIFIED = new Set(["浊证", "胃积", "自拟", "牛皮癣", "肠积", "肾痹", "小儿病理", "漏", "早孕", "1", "肠廦", "小肠绝", "舌病", "语迟", "燥证", "肝风证", "心赫依", "骨浊", "肺岩", "PCOS", "多发性抽搐症", "风湿热", "脑震荡后遗症", "右眼中心性浆液性脉络膜视网膜病变", "湿毒", "饮证", "肾积", "红蝴蝶斑", "节育器副反应", "拘挛", "无名热", "阴阳毒", "自闭症", "风菩雷", "肾岩", "骶1隐裂"]); // 同名异义/歧义/非病名串,留空才是正确裁定
let ok = 0, total = 0, correctlyHeld = 0;
const missed = [];
for (const [n, c] of tcmNames) {
  const r = R(n);
  if (EXPECTED_UNVERIFIED.has(n)) {
    assert.equal(r?.status, "unverified", `${n} 必须按同名异义/歧义留空`);
    correctlyHeld += c;
    continue;
  }
  total += c;
  if (r && r.status !== "unverified") ok += c;
  else missed.push([n, c]);
}
missed.sort((a, b) => b[1] - a[1]);
assert.ok(ok / total >= 0.9, `现代医案中医病名解析率 ${(ok / total * 100).toFixed(1)}% < 90%(未解样例:${missed.slice(0, 10).map((m) => m[0]).join("、")})`);

console.log(JSON.stringify({ entries: entries.length, aliases: lexicon.summary.aliasCount, corpusTcmNameResolution: `${(ok / total * 100).toFixed(1)}%`, correctlyHeld, missedTop: missed.slice(0, 8) }));
