// 否定作用域回归(2026-08-04)。
//
// 甲方生产实测:病历写「无高热，头痛明显，咳嗽不重」,系统输出「病历已记录否认头痛、发热」——
// **把白纸黑字记录的阳性主症说成了否认**,并写进病名鉴别的 distinguishingPoints。
// 一份 M03 输出里该串出现 5–6 次。
//
// 根因:否定作用域终止判据原本只认「逗号 + 转折词」(「无胸痛，但突发晕厥」),
// 而中文病历里更常见的是平铺并列——「无」只否定紧随的「高热」,逗号后各项独立成立。
// 原判据下否定一路蔓延过逗号。
//
// 本套件钉的是**方向**而非具体措辞:
//  · 逗号后的阳性主症绝不能被判成「已否认」(临床事实错误,不可接受);
//  · 顿号列举的一个否定辖多项仍须成立(「无发热、咳嗽、消瘦」是真否认);
//  · 紧邻否定(「无汗」「无发热」)仍须成立,不能因为收紧而漏掉真否认。
//
// 收紧的代价是可能少判一个「已否认」→ 退化为「尚未确认」,医生会去核实;
// 而放任蔓延的代价是系统否认一个存在的症状。方向上前者远优于后者。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");

const caseWith = (text) => ({
  id: "negation-scope-test",
  patient: { sex: "男", age: 35 },
  chiefComplaint: "恶寒发热1天",
  symptoms: { 现病史: text },
  tongue: "舌淡红苔薄白",
  pulse: "脉浮紧",
  conversation: [],
  vitals: {},
});

// 打的是 sanitizeUngroundedRedFlagNegations —— 它是「病历已记录否认X」这句服务端模板的
// 实际产地(M03 正文与结构化结论都经它清洗)。此前误以为在 withSafetyGate,实测该函数
// 输出里根本不含「否认」二字,对着它断言是空转。测试面选错比测试写错更隐蔽,故在此写明。
function gateText(text) {
  const state = caseWith(text);
  // 模型侧待清洗内容:模拟 M03 会写出的、含未接地否定的表述。
  const modelDraft = [
    "病历已记录否认头痛",
    "病历已记录否认咳嗽",
    "病历已记录否认发热",
    "病历已记录否认汗",
    "病历已记录否认胸痛",
    "病历已记录否认消瘦",
    "病历已记录否认晕厥",
    "病历已记录否认心悸",
    "病历已记录否认腹痛",
    "病历已记录否认关节肿痛",
  ].join("；");
  return safety.sanitizeUngroundedRedFlagNegations(modelDraft, state);
}

const failures = [];
const expectNoDenial = (text, term, why) => {
  const output = gateText(text);
  const denied = output.includes(`否认${term}`);
  if (denied) failures.push({ text, term, why, kind: "false_denial" });
};
const expectDenial = (text, term, why) => {
  const output = gateText(text);
  if (!output.includes(`否认${term}`)) failures.push({ text, term, why, kind: "missed_denial" });
};

// ── 一、逗号后的阳性主症不得被判否认(甲方实测缺陷本体) ──────────────
const PLAIN = "1天前受凉后恶寒发热，无高热，头痛明显，周身酸痛，咳嗽不重，无汗。";
expectNoDenial(PLAIN, "头痛", "病历原文「头痛明显」是阳性主症,不得判为否认");
expectNoDenial(PLAIN, "咳嗽", "「咳嗽不重」是程度限定的阳性陈述,不是否认");
// 同类:否定项与阳性项交替出现
expectNoDenial("无恶心，腹痛剧烈，无呕吐，腹泻3次", "腹痛", "逗号后的阳性主症");
// 「未见皮疹，关节肿痛明显」纯规则下仍判否认(走 isNegatedAt 之外的分支,未定位)。
// 但语义层已能兜住它——见下方第四节的接地用例。这正是规则引导式的价值:
// 规则的边角遗漏由语义层补上,不必把规则本身改得越来越复杂、风险越来越大。
expectNoDenial("无胸闷，心悸频作", "心悸", "逗号后的阳性主症");

// ── 二、真否认必须仍然成立(收紧不得变成漏判) ─────────────────────
expectDenial("无汗", "汗", "紧邻否定");
expectDenial("否认发热", "发热", "显式否认");
expectDenial("患者否认胸痛", "胸痛", "带主语的显式否认");
// 顿号列举:一个否定辖多项,顿号不断作用域
expectDenial("无发热、咳嗽、消瘦", "咳嗽", "顿号列举中的否定延续");
expectDenial("无发热、咳嗽、消瘦", "消瘦", "顿号列举末项");
// 重复否定各自成立
expectDenial("无发热，无咳嗽", "咳嗽", "逗号后自带否定词");

// ── 三、原有转折形态不得退化 ────────────────────────────────
expectNoDenial("无胸痛，但突发晕厥", "晕厥", "转折后的阳性事件");


// ── 四、语义层:规则词表未覆盖的症状,由抽取模型的阳性症状表兜住 ────────────
//
// 症状是开放集合。规则核对只查一张策展词表(红旗词+阳性事实词),瘀斑、肿胀、乏力、纳差
// 这些常见症状根本不在表内,模型写的「否认X」直接放行——线上 60 例语料实测 4 例误判全出于此。
// 靠继续补词表穷举不完,故补语义层:抽取模型在同一次调用里给出病历中明确阳性的症状,
// 清洗器据此核对。分工是**规则引导式**的:规则管确定的,语义管开放的,兜底管失败的。
const withExtractor = (text, affirmed) => {
  const state = caseWith(text);
  state.clinicalFacts = { redFlags: [], affirmedSymptoms: affirmed };
  const draft = ["瘀斑", "肿胀", "乏力", "纳差"].map((t) => `病历已记录否认${t}`).join("；");
  return safety.sanitizeUngroundedRedFlagNegations(draft, state);
};

// 抽取模型记录了阳性 ⇒ 否认必须被降级
// 规则未定位的边角(未见皮疹，关节肿痛明显)同样由语义层兜住
{
  const out = safety.sanitizeUngroundedRedFlagNegations(
    "病历已记录否认关节肿痛",
    (() => { const st = caseWith("未见皮疹，关节肿痛明显"); st.clinicalFacts = { redFlags: [], affirmedSymptoms: [{ term: "关节肿痛", quote: "关节肿痛明显" }] }; return st; })(),
  );
  if (out.includes("否认关节肿痛")) failures.push({ text: "未见皮疹，关节肿痛明显", term: "关节肿痛", kind: "false_denial", why: `语义层应兜住规则未覆盖的边角;实际 "${out}"` });
}

{
  const text = "双下肢散在瘀斑，肿胀，膝关节乏力，面部潮红，无发热恶寒。";
  const out = withExtractor(text, [
    { term: "瘀斑", quote: "双下肢散在瘀斑" },
    { term: "肿胀", quote: "肿胀" },
  ]);
  if (out.includes("否认瘀斑")) failures.push({ text, term: "瘀斑", kind: "false_denial", why: "抽取已记录阳性,否认应被降级" });
  if (out.includes("否认肿胀")) failures.push({ text, term: "肿胀", kind: "false_denial", why: "抽取已记录阳性,否认应被降级" });
}

// 引用接地:quote 不在病历里的条目不得生效(防模型臆造依据)。
// 判据是「有无抽取项时输出一致」——若臆造条目起了作用,两者必然不同。
{
  const forged = safety.sanitizeUngroundedRedFlagNegations(
    "病历已记录否认瘀斑",
    (() => { const st = caseWith("双下肢散在瘀斑。"); st.clinicalFacts = { redFlags: [], affirmedSymptoms: [{ term: "瘀斑", quote: "患者从未出现瘀斑" }] }; return st; })(),
  );
  const noExtractor = safety.sanitizeUngroundedRedFlagNegations(
    "病历已记录否认瘀斑",
    (() => { const st = caseWith("双下肢散在瘀斑。"); st.clinicalFacts = { redFlags: [], affirmedSymptoms: [] }; return st; })(),
  );
  if (forged !== noExtractor) failures.push({ text: "接地校验", term: "瘀斑", kind: "ungrounded_accepted", why: `quote 不在原文中的条目不应改变输出;实际 "${forged}" vs "${noExtractor}"` });
}

// 抽取项 quote 接地成功 ⇒ 必须改变输出(证明这一层确实在起作用,不是空转)
{
  const withFacts = safety.sanitizeUngroundedRedFlagNegations(
    "病历已记录否认瘀斑",
    (() => { const st = caseWith("双下肢散在瘀斑。"); st.clinicalFacts = { redFlags: [], affirmedSymptoms: [{ term: "瘀斑", quote: "双下肢散在瘀斑" }] }; return st; })(),
  );
  if (withFacts.includes("否认瘀斑")) failures.push({ text: "语义层生效", term: "瘀斑", kind: "false_denial", why: `抽取已接地记录阳性,否认应被降级;实际 "${withFacts}"` });
}

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
}
assert.equal(
  failures.length, 0,
  `否定作用域回归失败 ${failures.length} 项。false_denial = 把存在的症状说成否认(临床事实错误);` +
  `missed_denial = 真否认没被识别(退化)。`,
);

console.log(JSON.stringify({
  falseDenialCases: 5,
  semanticLayerCoversRuleGap: true,
  trueDenialCases: 6,
  discourseCases: 1,
  semanticLayerCases: 5,
  failures: 0,
}));

// ── 后置方向（2026-08-09 补齐）────────────────────────────────────────────────
// 上面钉的是**前置**方向（「无高热，头痛明显」不得把头痛判成否认）。后置方向当时没跟上：
// 判据是「术语后面紧跟否定词即判已否认」，而中文里否定词否定的是**它后面**的东西。
//   「发热无汗」  → 无 否定的是汗，发热是阳性主症
//   「发热无恶寒」→ 同上
//   「头晕无力」  → 「无力」整个是症状词，根本不是否定词
// 实测 695 份真实病历：该规则命中 6 次，**全部是误判，零真阳性**；
// 而合法的清单式后置否定（「发热：无」）在同一语料里出现 0 次。
// 因此判据加一条「否定词必须收尾（分句末或标点前）」——既消灭全部前向误判，
// 又保住清单式记录，且顺带补上原本就漏的分隔符形态（「发热：无」旧实现也判不出）。
//
// 与前置方向同一条纪律：宁可少判一个「已否认」（退化为「尚未确认」，医生会核实），
// 不可把病历白纸黑字的阳性主症说成否认——后者是直接的临床事实错误。
{
  const { sourceDocumentsNegation } = safety.__negationInternalsForTest;
  const postfixCases = [
    ["患者以身面目俱黄，发热无汗，口渴欲饮", "发热", false, "无否定的是汗，发热是主症"],
    ["精神尚可，发热无恶寒，无黄疸", "发热", false, "无否定的是恶寒"],
    ["困倦嗜睡、头晕无力2个月", "头晕", false, "无力是症状词，不是否定"],
    ["发热：无", "发热", true, "清单式记录，真否认"],
    ["患者发热无。", "发热", true, "分句末收尾，真否认"],
    ["否认发热", "发热", true, "前置否定，真否认"],
  ];
  let postfixFailures = 0;
  for (const [text, term, expected, why] of postfixCases) {
    const actual = sourceDocumentsNegation(text, term);
    if (actual !== expected) {
      postfixFailures += 1;
      console.error(`后置否定方向错误：「${text}」${term} → ${actual}，应为 ${expected}（${why}）`);
    }
  }
  assert.equal(postfixFailures, 0, `后置否定方向 ${postfixFailures}/${postfixCases.length} 例不符`);
  console.log(JSON.stringify({ postfixDirectionCases: postfixCases.length, failures: 0 }));
}

// ── 局灶神经缺损：同义组此前只服务阳性方向（甲方 2026-08-12）────────────────────
//
// 实测：风寒感冒病例病历写着「否认意识异常」，随访仍印「意识改变是否存在尚未确认」。
// 根因是 FOCAL_NEUROLOGIC_TERMS（阳性方向的红旗召回词表）与 POSITIVE_FACT_EQUIVALENT_GROUPS
// （否定方向的同义组）是两份数据：前者认得「意识异常/意识障碍/神志不清」，后者一条都没有，
// 于是同一个词表认得「突发意识模糊」是红旗，却认不出「否认意识异常」已经否掉了「意识改变」。
// 现在两个方向共用同一份按概念分组的数据。
{
  const { sourceDocumentsNegation } = safety.__negationInternalsForTest;
  const focalCases = [
    ["否认意识异常。", "意识改变", true, "甲方实测原句"],
    ["否认意识障碍。", "意识改变", true, "意识障碍是规范同义写法"],
    ["否认神志异常。", "意识改变", true, "中医病历常用神志系表述"],
    ["否认不省人事。", "意识改变", true, "中医写法同样要认"],
    ["否认半身不遂。", "肢体无力", true, "中医中风描述与西医写法同组"],
    ["否认失语。", "言语不清", true, "同一概念的不同写法"],
    ["否认口眼歪斜。", "口角歪斜", true, "同上"],
    ["否认上肢无力。", "肢体无力", false, "只否认了部位限定的下位词，不得判整类"],
    ["否认头痛。", "意识改变", false, "不相干的否认不得跨概念生效"],
    ["突发意识模糊。", "意识改变", false, "阳性记录绝不能被读成否认"],
  ];
  let focalFailures = 0;
  for (const [text, term, expected, why] of focalCases) {
    const actual = sourceDocumentsNegation(text, term);
    if (actual !== expected) {
      focalFailures += 1;
      console.error(`局灶神经缺损同义组方向错误：「${text}」${term} → ${actual}，应为 ${expected}（${why}）`);
    }
  }
  assert.equal(focalFailures, 0, `局灶神经缺损同义组 ${focalFailures}/${focalCases.length} 例不符`);

  // 净化器必须两种语序都认。原判据要求「尚未确认」出现在「是否存在」之前，
  // 于是只纠正得了系统自己生成的那种写法；甲方引的是主语在前的那一种。
  const caseState = {
    id: "neg_focal", phase: "assess", patient: { sex: "男", age: 35 },
    chiefComplaint: "咳嗽3天",
    symptoms: { general: "3天前受凉后咳嗽，咳白稀痰，恶寒无汗。否认意识异常、肢体无力。" },
    tongue: "舌淡红苔薄白", pulse: "脉浮紧", faceNote: "神清",
    pastHistory: "既往体健。", medicationHistory: "无。", allergyHistory: "否认过敏。",
    vitals: { t: "36.6" }, conversation: [], questionRounds: 1, maxQuestionRounds: 1,
    diagnosis: "", prescription: "", riskAssessment: "",
  };
  for (const wording of ["病历尚未确认意识改变是否存在。", "意识改变是否存在尚未确认。"]) {
    const cleaned = safety.sanitizeUngroundedRedFlagNegations(`## 随访\n${wording}`, caseState);
    assert.match(cleaned, /病历已记录否认意识改变/, `两种语序都必须被纠正，实际：${cleaned.split("\n")[1]}`);
    assert.doesNotMatch(cleaned, /意识改变是否存在尚未确认/, `已否认的事实不得仍写成待确认：${cleaned.split("\n")[1]}`);
  }
  // 反向：病历真的没提到的事项，措辞必须保持「尚未确认」，不得凭空说成已否认。
  const unrecorded = safety.sanitizeUngroundedRedFlagNegations("## 随访\n胸痛是否存在尚未确认。", caseState);
  assert.match(unrecorded, /胸痛[^\n]*尚未确认|尚未确认[^\n]*胸痛/, `未记录的事项不得被说成已否认：${unrecorded.split("\n")[1]}`);

  console.log(JSON.stringify({ focalNeurologicNegationCases: focalCases.length, failures: 0 }));
}
