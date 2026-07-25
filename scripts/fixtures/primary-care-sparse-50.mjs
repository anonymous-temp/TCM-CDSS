import { RED_FLAG_CATEGORY_VOCABULARY } from "../lib/primary-care-sparse-50-contracts.mjs";

export const PRIMARY_CARE_FIXTURE_METADATA = Object.freeze({
  suite: "primary-care-sparse-50",
  fictional: true,
  prohibitsRealPhi: true,
  notice: "全部病例、人物与处方变异均为虚构测试数据，禁止复制或改写真实患者 PHI。",
});

const TCM_DISEASE_BY_ID = {
  D01: /痞满/, D02: /泄泻/, D03: /便秘/, D04: /吐酸|反酸/,
  R01: /咳嗽/, R02: /鼻鼽/, R03: /哮病|喘证/, R04: /咳嗽|肺胀/,
  P01: /膝痹|痹证/, P02: /腰痛|筋伤/, P03: /肩痹|痹证/, P04: /项痹|颈痹/,
  N01: /头痛/, N02: /头痛/, N03: /眩晕/, N04: /中风后遗|偏瘫/, N05: /颤证/,
  S01: /不寐/, S02: /郁证/, S03: /虚劳/,
  M01: /消渴/, M02: /眩晕|头痛/, M03: /心悸/,
  G01: /痛经/, G02: /月经后期|月经失调/, G03: /绝经前后诸证/, G04: /带下病/, G05: /产后虚劳/,
  K01: /湿疮/, K02: /瘾疹/, K03: /粉刺/, K04: /白疕/,
  U01: /癃闭/, U02: /淋证/, U03: /阳痿/,
  C01: /咳嗽/, C02: /厌食|积滞/, C03: /泄泻/,
  E01: /耳鸣/, E02: /喉痹/, E03: /口疮/, E04: /白涩症|目涩/,
  A01: /痔病/, A02: /肛裂/, O01: /虚劳/,
  RF01: /血证|便血/, RF02: /胸痹|真心痛/, RF03: /中风/, RF04: /喘脱|喘证/, RF05: /肠痈|腹痛/,
};

const PRIMARY_SYNDROME_BY_ID = {
  D01: /脾虚|脾胃虚弱|胃失和降|气滞/, D02: /脾虚|湿盛|湿困|寒湿|湿热/, D03: /肠燥|津亏|气虚/, D04: /胃气上逆|肝胃不和/,
  R01: /风邪恋肺|风燥|肺失宣降/, R02: /肺气虚|肺脾气虚|卫表不固/, R03: /痰饮伏肺|肺失宣降|肺气虚/, R04: /痰湿阻肺|肺气虚/,
  P01: /肝肾不足|瘀阻/, P02: /气滞血瘀|瘀阻/, P03: /寒湿|气血瘀滞/, P04: /经筋不舒|气血不畅/,
  N01: /肝阳|风痰|瘀阻|肝火/, N02: /肝郁|气滞|经筋不舒/, N03: /痰湿|清阳不升|风痰/, N04: /气虚血瘀|络阻/, N05: /肝风|肝肾不足|痰瘀/,
  S01: /心神不宁|肝郁|心火|心脾两虚/, S02: /肝郁|心神不宁|脾虚/, S03: /气虚|脾虚|气血不足/,
  M01: /气阴两虚|阴虚燥热|络脉瘀阻/, M02: /肝阳上亢|肝火/, M03: /心神不宁|气血不足|肝郁/,
  G01: /血瘀|寒凝血瘀|气滞血瘀/, G02: /痰湿|肾虚|肝郁/, G03: /肾阴虚|阴阳失调|肝郁/, G04: /湿热下注|脾虚湿盛/, G05: /气血不足|气虚自汗/,
  K01: /湿热蕴肤|血虚风燥/, K02: /风热|风寒|血虚风燥/, K03: /肺经风热|胃肠湿热|痰瘀/, K04: /血热|血燥|血瘀/,
  U01: /肾气虚|膀胱气化不利/, U02: /湿热下注|热淋/, U03: /肾虚|肝郁|瘀阻/,
  C01: /肺失宣降|风寒|风热|痰湿/, C02: /脾胃虚弱|食积/, C03: /湿困脾胃|寒湿|湿热/,
  E01: /肾虚|肝火|痰火|瘀阻/, E02: /风热|肺胃热盛/, E03: /心火|胃火|阴虚火旺/, E04: /肝肾阴虚|津亏/,
  A01: /肠燥|湿热下注|气虚下陷/, A02: /肠燥津亏|血热/, O01: /脾肾亏虚|气血不足/,
  RF01: /出血|气随血脱/, RF02: /心脉痹阻|心阳不振/, RF03: /风痰阻络|瘀阻脑络/, RF04: /肺气欲脱|喘脱/, RF05: /湿热瘀结|热毒壅盛/,
};

function locationExpectation(id, domain) {
  if (/妇科/.test(domain)) return /胞宫|冲任|肝|脾|肾/;
  if (/皮肤/.test(domain)) return /皮肤|肌表|肺|脾|血分/;
  if (/骨伤/.test(domain)) return /经筋|经络|腰|膝|肩|颈|肝|肾/;
  if (/呼吸|鼻炎|咽痛/.test(domain)) return /肺|鼻|咽喉|卫表/;
  if (/神经/.test(domain)) return /脑|头|肝|肾|经络/;
  if (/泌尿|男科/.test(domain)) return /肾|膀胱|肝/;
  if (/消化|肛肠/.test(domain)) return /脾|胃|肠|大肠|肛门/;
  if (/耳鸣|眼科|口腔/.test(domain)) return /耳|目|口|心|肝|肾|胃/;
  if (/心血管/.test(domain)) return /心|肝|脉|络/;
  if (/睡眠|情志/.test(domain)) return /心|肝|脾/;
  if (/儿科/.test(domain)) return /肺|脾|胃|肠/;
  if (/急腹症/.test(domain)) return /肠|腑/;
  if (/胸痛/.test(domain)) return /心|脉/;
  if (/卒中/.test(domain)) return /脑|经络/;
  if (/低氧/.test(domain)) return /肺|心/;
  if (/消化道出血/.test(domain)) return /胃|肠|脾/;
  return /脾|肾|气血|经络/;
}

function natureExpectation(pattern) {
  const source = pattern?.source || "";
  const terms = ["气虚", "血虚", "阴虚", "阳虚", "气血不足", "痰", "湿", "热", "寒", "火", "瘀", "气滞", "风", "津亏", "虚", "实"];
  const present = terms.filter((term) => source.includes(term));
  return new RegExp(present.length ? present.join("|") : "虚|实|寒|热|痰|湿|瘀|气滞");
}

function answerFacts(answer, questionAxes) {
  const parts = String(answer || "").split(/[；;。\n]+/).map((item) => item.trim()).filter(Boolean);
  return questionAxes.map((axis, axisIndex) => ({
    axis,
    axisIndex,
    facts: parts.filter((part) => {
      const semanticPart = part
        .replace(/怀孕|有孕/g, "妊娠")
        .replace(/喘不上气|憋得慌/g, "呼吸困难")
        .replace(/大便发黑|黑色大便/g, "黑便");
      axis.lastIndex = 0;
      return axis.test(part) || axis.test(semanticPart);
    }),
  }));
}

function categoryOracle(required = [], allowed = []) {
  const requiredSet = new Set(required);
  const allowedSet = new Set(allowed);
  return Object.freeze({
    required: Object.freeze([...requiredSet]),
    allowed: Object.freeze([...allowedSet]),
    forbidden: Object.freeze(RED_FLAG_CATEGORY_VOCABULARY.filter((category) => !requiredSet.has(category) && !allowedSet.has(category))),
  });
}

const caseOf = (id, domain, age, sex, chief, initial, answer, expected) => {
  const redFlagStage = expected.redFlagStage || (expected.redFlag ? "initial" : "none");
  const redFlagOracle = expected.redFlagOracle || categoryOracle();
  // Compatibility-only display fields for the older report consumer. The executable regression
  // derives dose behavior from production derivePrescriptionPermission, never from these values.
  const nonDoseIds = new Set(["G04", "G05", "U02", "C01", "C02", "C03"]);
  const doseGate = expected.doseGate || (redFlagStage !== "none" || expected.doseExpected === false || nonDoseIds.has(id) ? "non_dose" : "allow");
  const syndrome = expected.syndrome || PRIMARY_SYNDROME_BY_ID[id] || expected.tcm;
  return {
    id,
    fictional: true,
    domain,
    age,
    sex,
    chief,
    initial,
    answer,
    ...expected,
    redFlagStage,
    redFlagOracle,
    expectedRedFlagCategories: [...redFlagOracle.required],
    diagnosisExpected: redFlagStage === "none",
    doseGate,
    doseExpected: doseGate === "allow",
    doseGateReason: expected.doseGateReason || (doseGate === "allow" ? "case_context_complete" : redFlagStage !== "none" ? "red_flag" : nonDoseIds.has(id) ? "special_population_or_pregnancy_unknown" : "case_specific_boundary"),
    m02AnswerFacts: answerFacts(answer, expected.questionAxes || []),
    canonical: {
      // These are compatible examples, not an exact-answer allowlist. Sparse cases may support a
      // different conservative symptom-level working diagnosis when it remains fact-grounded.
      westernPrimaryCompatible: [expected.western],
      westernPrimaryForbidden: expected.westernPrimaryForbidden || [],
      westernDifferentialAllowed: expected.westernDifferentialAllowed || [],
      tcmDiseaseAllowed: [expected.tcmDisease || TCM_DISEASE_BY_ID[id]],
      tcmDiseaseForbidden: expected.tcmDiseaseForbidden || [/待定|未知|不详/],
      primarySyndromeAllowed: [syndrome],
      primarySyndromeForbidden: expected.primarySyndromeForbidden || [/待定|未知|不详|信息不足/],
    },
    pathogenesisExpectations: {
      locationsAllowed: [expected.location || locationExpectation(id, domain)],
      locationsForbidden: expected.locationsForbidden || [/待定|未知|不详/],
      naturesAllowed: [expected.nature || natureExpectation(syndrome)],
      naturesForbidden: expected.naturesForbidden || [/待定|未知|不详/],
      mechanismsAllowed: [expected.mechanism || syndrome],
      mechanismsForbidden: expected.mechanismsForbidden || [/待定|未知|信息不足/],
      therapiesAllowed: [expected.therapy],
      therapiesForbidden: expected.therapiesForbidden || [/待定|观察即可|无需处理/],
      nodePairs: [{ mechanism: expected.mechanism || syndrome, therapy: expected.therapy }],
    },
  };
};

/**
 * Fifty fictional primary-care cases. Initial records deliberately remain sparse and colloquial;
 * `answer` simulates the single focused M02 round and still leaves nonessential fields unknown.
 */
export const PRIMARY_CARE_SPARSE_50 = [
  caseOf("D01", "消化-餐后胀", 43, "男", "这两个月一吃完饭肚子上边就胀，老打嗝", "没吐过血，别的说不清。", "饭后半小时最明显，吃一点就饱，大便偏稀；没有黑便、消瘦和吞咽困难。平时没固定吃药，没发现药物过敏。舌淡胖有齿痕。", {
    questionAxes: [/进食|饭后|早饱/, /黑便|呕血|消瘦|吞咽/], western: /功能性消化不良|慢性胃炎|(?:餐后|进食后)?上腹(?:部)?胀满(?:伴嗳气)?(?:（原因待查）)?/, tcm: /痞满|胃脘|脾胃|胃失和降/, therapy: /健脾|和胃|理气|消痞/,
  }),
  caseOf("D02", "消化-腹泻", 37, "女", "最近吃点东西就想跑厕所，稀稀的有半个月", "一天大概三四次。", "没有发热、血便和夜里拉醒，喝水尿量还行；出差回来后开始，家里没人同样发病。月经正常，确认未孕。舌淡苔白腻。", {
    questionAxes: [/次数|性状|血便|脓血/, /发热|夜间|饮水|尿量|脱水|旅行/], western: /^腹泻(?:待查|症)?(?:（[^）]{0,30}）)?$|急性腹泻|持续性腹泻|迁延性腹泻|急性胃肠炎|感染性腹泻/, westernPrimaryForbidden: [/肠易激|IBS|功能性腹泻/], tcm: /泄泻|脾虚|湿盛|湿困/, therapy: /健脾|化湿|止泻|和中/,
  }),
  caseOf("D03", "消化-便秘", 56, "女", "大便老解不出来，四五天一次，肚子还胀", "最近三个月越来越明显。", "便干成颗粒，排便费劲；没有便血、黑便、呕吐和明显消瘦。平时喝水少，活动也少。未孕，没固定吃泻药。舌偏红少津。", {
    questionAxes: [/便血|黑便|呕吐|消瘦|排气/, /饮水|活动|药物|病程/], western: /功能性便秘|慢性便秘/, tcm: /便秘|肠燥|津亏|气虚/, therapy: /润肠|通便|益气|养阴/,
  }),
  caseOf("D04", "消化-反流", 34, "男", "晚上躺下老反酸，嗓子也有点烧", "断断续续一个多月。", "吃辣和夜宵后加重，偶尔嗳气；没有吞咽卡住、呕血、黑便或体重下降。没长期吃药。舌红苔薄黄。", {
    questionAxes: [/进食|夜间|平卧|反流|吃辣|夜宵/, /吞咽|呕血|黑便|体重/], western: /胃食管反流|反流性食管炎/, tcm: /反酸|吐酸|胃气上逆|肝胃不和/, therapy: /和胃|降逆|疏肝|制酸/,
  }),

  caseOf("R01", "呼吸-感冒后咳", 32, "女", "感冒好了还一直干咳，嗓子痒", "差不多三周，晚上明显。", "没有发热、喘不上气和咳血，痰很少；没吃普利类降压药。未孕。舌偏红苔薄白。", {
    questionAxes: [/发热|气促|喘|咯血/, /夜间|痰|过敏|用药/], western: /感染后咳嗽|亚急性咳嗽/, tcm: /咳嗽|风邪恋肺|风燥|肺失宣降/, therapy: /宣肺|止咳|疏风|润燥/,
  }),
  caseOf("R02", "耳鼻喉-过敏性鼻炎", 28, "女", "早晨起来喷嚏一串串，清鼻涕不停", "换季和打扫屋子时更厉害。", "鼻子眼睛都痒，没有发热、脸痛和黄脓鼻涕，也不喘。以前说是尘螨过敏，没药物过敏，未孕。舌淡苔薄白。", {
    questionAxes: [/发热|面痛|脓涕/, /过敏|灰尘|季节|喘/], western: /过敏性鼻炎|变应性鼻炎/, tcm: /鼻鼽|肺气|卫表|肺脾气虚/, therapy: /宣肺|通窍|益气|固表/,
  }),
  caseOf("R03", "呼吸-反复喘鸣", 41, "男", "一跑快了就胸口呼呼响，晚上有时憋醒", "最近一个月犯了三回。", "跑步和夜间容易发作，旧吸入药通常十来分钟能缓解；目前说话走路正常，没有胸痛、发热和咯血。小时候有过敏性鼻炎，没做过肺功能。舌淡苔白。", {
    questionAxes: [/呼吸困难|说话|发绀|夜间|晚上|憋醒/, /吸入药|过敏|发作频率|肺功能/], western: /支气管哮喘|咳嗽变异性哮喘|气道高反应|运动诱发.{0,6}(?:气短|喘)|反复喘鸣/, tcm: /哮病|喘证|痰饮伏肺|肺失宣降|肺气虚/, therapy: /宣肺|平喘|化痰|补肺益气|益气补肺/,
  }),
  caseOf("R04", "呼吸-慢性咳痰", 64, "男", "抽烟好多年，早上老咳一口白痰", "这半年比以前多一点，走两层楼会喘。", "没有发热、咯血、胸痛和静息气短；每天一包烟，没做过肺功能。舌暗苔白腻。", {
    questionAxes: [/咯血|发热|气促|胸痛/, /吸烟|肺功能|痰色|活动耐量/], western: /慢性支气管炎|慢性阻塞性肺疾病|COPD/, tcm: /咳嗽|肺胀|痰湿阻肺|肺气虚/, therapy: /化痰|宣肺|益气|止咳/,
  }),

  caseOf("P01", "骨伤-膝痛", 59, "女", "右膝盖上下楼疼，坐久站起来也疼", "有大半年了。", "晨起僵不到半小时，没有摔伤、红肿发热和卡住；偶尔吃一粒塞来昔布，胃不太好。舌暗苔薄白。", {
    questionAxes: [/外伤|红肿|晨僵|锁膝/, /负重|用药|胃|肾/], western: /膝骨关节炎|膝关节退行性/, tcm: /膝痹|痹证|肝肾不足|瘀阻/, therapy: /通络|止痛|祛湿|补益肝肾/,
  }),
  caseOf("P02", "骨伤-腰痛", 48, "男", "搬东西后腰酸痛，弯腰更难受", "十来天了。", "疼痛不往腿上窜，没有发热、夜里痛醒、腿无力麻木和大小便异常。贴过膏药，药名不清楚。舌暗。", {
    questionAxes: [/外伤|发热|夜间|大小便|无力/, /放射|麻木|活动|体位/], western: /急性腰扭伤|非特异性腰痛|腰肌劳损/, tcm: /腰痛|筋伤|气滞血瘀|瘀阻/, therapy: /舒筋|活血|通络|止痛/,
  }),
  caseOf("P03", "骨伤-肩痛", 52, "女", "右肩膀抬不高，梳头穿衣都费劲", "慢慢加重有四个月。", "夜里压着会疼，没有摔伤、发热和手臂麻木无力。血糖以前偏高，具体不记得。舌淡暗。", {
    questionAxes: [/外伤|发热|无力|麻木/, /活动范围|夜间|夜里|糖尿病|血糖/], western: /肩周炎|冻结肩|肩袖损伤/, tcm: /肩痹|痹证|寒湿|气血瘀滞/, therapy: /舒筋|通络|祛风散寒|止痛/,
  }),
  caseOf("P04", "骨伤-颈项痛", 39, "男", "低头看手机多，脖子僵，后脑勺也紧", "反复两个月。", "休息和热敷会轻些，没有手麻手无力、走路不稳、发热和外伤。没固定吃药。舌淡红。", {
    questionAxes: [/手麻|无力|走路|外伤|发热/, /姿势|活动|缓解|休息|热敷/], western: /颈椎病|颈肩肌筋膜疼痛|颈部劳损/, tcm: /项痹|颈痹|经筋|气血不畅/, therapy: /舒筋|通络|活血|止痛/,
  }),

  caseOf("N01", "神经-偏头痛", 33, "女", "右边脑袋一跳一跳地疼，见光就烦", "每个月两三回。", "一次半天左右，会恶心，睡一觉能缓；不是突然最痛，没有发热、手脚无力和说话不清。未孕。舌红脉弦。", {
    questionAxes: [/突然|最剧烈|无力|言语|发热/, /频率|持续|恶心|畏光|月经/], western: /偏头痛/, tcm: /头痛|肝阳|风痰|瘀阻|肝火/, therapy: /平肝|息风|通络|止痛/,
  }),
  caseOf("N02", "神经-紧张性头痛", 29, "男", "下午脑袋像戴了个紧箍，脖子也酸", "加班多的时候就来。", "两边都胀紧，不恶心也不怕光；没有突然爆发、发热、肢体无力。睡一晚会好些。舌淡红。", {
    questionAxes: [/突然|发热|无力|言语/, /压力|颈项|恶心|畏光|频率/], western: /紧张型头痛|紧张性头痛/, tcm: /头痛|肝郁|气滞|经筋不舒/, therapy: /疏肝|理气|舒筋|止痛/,
  }),
  caseOf("N03", "神经-体位性眩晕", 61, "女", "一翻身屋子就转，躺着不动又好点", "每次几十秒，三天了。", "没有耳聋、说话不清、复视、手脚无力或走不了路；血压药叫氨氯地平。舌淡苔白。", {
    questionAxes: [/言语|复视|无力|行走|头痛/, /体位|持续|耳鸣|听力|耳聋/], western: /良性阵发性位置性眩晕|耳石症|BPPV/, tcm: /眩晕|痰湿|清阳不升|风痰/, therapy: /化痰|息风|健脾|定眩|益气|养血|升清/,
  }),
  caseOf("N04", "神经-卒中康复", 68, "男", "脑梗以后右手右脚不灵活，想调理康复", "出院四个月了，现在能拄拐走。", "近来没有新发嘴歪、说话不清、单侧无力加重和意识变化。每天吃阿司匹林和阿托伐他汀，剂量不记得。舌暗有瘀点。", {
    questionAxes: [/新发|加重|言语|意识|嘴歪/, /吞咽|跌倒|康复|用药|阿司匹林|阿托伐他汀/], western: /脑梗死后|卒中后|脑卒中恢复期/, tcm: /中风后遗|偏瘫|气虚血瘀|络阻/, therapy: /益气|活血|通络|康复/,
  }),
  caseOf("N05", "神经-震颤", 65, "男", "右手闲着时会抖，写字越来越小", "快一年了。", "动作比以前慢，闻味道也差些；没有突然无力、说话不清和意识改变。没吃过抗帕金森药。舌淡暗。", {
    questionAxes: [/动作迟缓|动作.*慢|僵硬|步态|跌倒/, /突然|无力|用药|家族/], western: /帕金森病|帕金森综合征|震颤待查/, tcm: /颤证|肝风|肝肾不足|痰瘀/, therapy: /息风|化痰|补益肝肾|通络/,
  }),

  caseOf("S01", "睡眠-失眠", 45, "女", "躺床上脑子停不下来，得一两个小时才睡着", "有两个多月，第二天没精神。", "每周大概五晚，容易心慌但没胸痛晕倒；不打鼾，也没人说呼吸会停。未孕，没吃安眠药。舌尖偏红。", {
    questionAxes: [/频率|白天|打鼾|呼吸暂停/, /情绪|心悸|心慌|用药|安眠药/], western: /失眠障碍|慢性失眠/, tcm: /不寐|心神不宁|肝郁|心火|心脾/, therapy: /安神|疏肝|清心|养心/,
  }),
  caseOf("S02", "情志-焦虑", 38, "女", "这阵子总觉得心里悬着，坐不住，老往坏处想", "工作忙了三个月。", "常伴肩颈紧和胃口差，偶尔心跳快；没有胸痛晕厥，也没有伤害自己或别人的想法。未孕。舌淡红脉弦。", {
    questionAxes: [/自伤|他伤|伤害自己|伤害别人|睡眠|功能/, /心悸|胸痛|甲状腺|咖啡因/], western: /焦虑状态|广泛性焦虑|焦虑障碍/, tcm: /郁证|肝郁|心神不宁|脾虚/, therapy: /疏肝|解郁|安神|健脾/,
  }),
  caseOf("S03", "全科-乏力", 51, "男", "最近总没劲，干点活就累", "大概一个月，别的没太注意。", "没有发热、胸痛、气短、黑便和明显消瘦；睡得一般，饭量稍差。去年体检血糖偏高。舌淡。", {
    questionAxes: [/发热|胸痛|气短|黑便|体重/, /睡眠|食欲|血糖|贫血|甲状腺/], western: /乏力待查|疲劳状态|代谢异常待查/, tcm: /虚劳|气虚|脾虚|气血不足/, therapy: /益气|健脾|养血/,
  }),

  caseOf("M01", "代谢-糖尿病控制差", 60, "男", "口渴得厉害，晚上也老起来尿，脚底还麻", "糖尿病好多年，最近三个月明显。", "上次糖化8点多，具体单子没带；没有低血糖昏倒和足部破溃。吃二甲双胍早晚各一片，剂量不清。舌暗红少津。", {
    questionAxes: [/血糖|糖化|低血糖|足部/, /饮水|尿量|体重|用药|二甲双胍/], western: /2型糖尿病|糖尿病周围神经病变/, tcm: /消渴|气阴两虚|阴虚燥热|络脉瘀阻/, therapy: /益气养阴|清热生津|活血通络/,
  }),
  caseOf("M02", "心血管-血压波动", 57, "女", "最近量血压老是高，后脑勺发紧", "家里量过一百六十多，没天天记。", "没有胸痛、气短、视物模糊、肢体无力和说话不清。每天早上吃缬沙坦一片，毫克数不清。未孕。舌红脉弦。", {
    questionAxes: [/血压数值|胸痛|视物|无力|言语/, /用药|漏服|头痛|睡眠|缬沙坦/], western: /高血压|血压控制不佳/, tcm: /眩晕|头痛|肝阳上亢|肝火/, therapy: /平肝潜阳|清肝|息风/,
  }),
  caseOf("M03", "心血管-心悸", 36, "女", "心口突然扑通扑通，几分钟自己就好了", "一周两三次，最近熬夜多。", "没有胸痛、晕厥和活动后气短；咖啡喝得多，甲状腺没查过。未孕，没长期用药。舌淡红。", {
    questionAxes: [/胸痛|晕厥|气短|持续/, /咖啡|甲状腺|频率|心率/], western: /心悸待查|心律失常待查|早搏/, tcm: /心悸|心神不宁|气血不足|肝郁/, therapy: /养心|安神|益气|疏肝/,
  }),

  caseOf("G01", "妇科-痛经", 27, "女", "来月经第一天肚子疼得蜷着，热水袋捂着好点", "这样有一年多。", "经血暗、有小血块，量不算特别多；没有晕倒、发热和异味分泌物。确认没怀孕，也没备孕。舌暗有瘀点。", {
    questionAxes: [/妊娠|经量|血块/, /晕厥|发热|分泌物|剧痛/], western: /原发性痛经|痛经|周期性经期腹痛/, tcm: /痛经|血瘀|寒凝血瘀|气滞血瘀/, syndrome: /血瘀|寒凝血瘀|气滞血瘀/, mechanism: /血瘀|瘀阻|寒凝|气滞/, nature: /瘀|气滞|寒/, therapy: /温经|散寒|行气|活血(?:化瘀)?|通络|止痛/,
  }),
  caseOf("G02", "妇科-月经不规则", 31, "女", "月经老往后拖，有时候两个月才来", "这半年胖了不少，脸上也长痘。", "最近一次月经是六周前，早孕试纸阴性；没有大量出血、腹部剧痛和乳头溢液。暂时不备孕。舌淡红苔腻。", {
    questionAxes: [/末次月经|最近一次月经|妊娠|体重|痤疮|雄激素/, /乳溢|大量出血|腹痛|妇科急症/], western: /多囊卵巢综合征|月经(?:不规则|稀发)|稀发月经/, tcm: /月经后期|月经失调|痰湿|肾虚|肝郁/, therapy: /化痰|调经|补肾|疏肝/,
  }),
  caseOf("G03", "妇科-围绝经期", 49, "女", "一阵阵发热出汗，晚上更明显，脾气也急", "月经这半年忽早忽晚。", "没有发热咳嗽和明显消瘦；近两月没来月经，验孕阴性。没有乳腺或妇科肿瘤史。舌红少苔。", {
    questionAxes: [/月经|妊娠|出血/, /发热|消瘦|甲状腺|睡眠/], western: /围绝经期综合征|更年期综合征/, tcm: /绝经前后诸证|肾阴虚|阴阳失调|肝郁/, therapy: /滋阴|补肾|调和阴阳|疏肝/,
  }),
  caseOf("G04", "妇科-带下", 35, "女", "白带突然多了，还有点痒", "四五天了。", "白带偏黄、有异味，没有发热、下腹剧痛和异常出血；有固定伴侣，是否怀孕还没测。没自己用药。舌红苔黄腻。", {
    questionAxes: [/妊娠|发热|腹痛|出血/, /颜色|气味|性交|用药/], western: /阴道炎|宫颈炎|阴道分泌物异常/, tcm: /带下病|湿热下注|脾虚湿盛/, therapy: /清热利湿|止带|健脾化湿/,
  }),
  caseOf("G05", "妇科-哺乳期疲乏", 30, "女", "生完孩子两个月，总觉得累，还容易出汗", "现在母乳喂养，晚上睡得碎。", "没有发热、胸痛、气短和大量出血，食欲一般；产后血红蛋白没复查。明确正在哺乳。舌淡。", {
    questionAxes: [/出血|发热|气短|心悸/, /睡眠|哺乳|贫血|甲状腺/], western: /产后疲劳|贫血待查|甲状腺功能异常待查/, tcm: /产后虚劳|气血不足|气虚自汗/, therapy: /益气|养血|固表/, doseExpected: false,
  }),

  caseOf("K01", "皮肤-湿疹", 26, "女", "胳膊弯和腿弯老起红疹，痒得抓破", "反复半年，洗热水澡后更痒。", "皮肤干，有时少量渗水；没有发热、流脓、嘴唇肿和喘。用过保湿霜，未孕。舌红苔微腻。", {
    questionAxes: [/面唇|呼吸|发热|化脓/, /分布|渗液|渗水|接触|药物|保湿霜/], western: /特应性皮炎|湿疹|接触性皮炎/, tcm: /湿疮|湿热蕴肤|血虚风燥/, therapy: /祛湿|止痒|养血|润燥/,
  }),
  caseOf("K02", "皮肤-荨麻疹", 40, "男", "身上一片片风疙瘩，起来快消得也快", "三天了，晚上更明显。", "没有嘴唇舌头肿、喘憋和头晕；最近换了洗衣液，没吃新药。以前海鲜后也起过。舌红苔薄。", {
    questionAxes: [/面唇舌|喘|头晕/, /新药|食物|接触|持续/], western: /急性荨麻疹|荨麻疹/, tcm: /瘾疹|风热|风寒|血虚风燥/, therapy: /祛风|止痒|清热|养血/,
  }),
  caseOf("K03", "皮肤-痤疮", 22, "女", "下巴和额头老长红痘，有的摸着疼", "半年了，熬夜和来月经前更多。", "没有发热和大片化脓，月经大致规律，未孕；自己用过水杨酸。大便有点干。舌红苔黄。", {
    questionAxes: [/月经|妊娠|药物/, /化脓|瘢痕|饮食|大便/], western: /寻常痤疮|痤疮/, tcm: /粉刺|肺经风热|胃肠湿热|痰瘀/, therapy: /清热|化湿|散结|凉血/,
  }),
  caseOf("K04", "皮肤-银屑病", 45, "男", "胳膊腿上厚厚的红斑掉白皮，冬天更重", "七八年了，最近又多了。", "没有发热、关节肿痛和全身红皮；外用药膏名字不记得。没有肝病史。舌暗红。", {
    questionAxes: [/关节|发热|全身|药物/, /分布|诱因|感染|肝病/], western: /银屑病|寻常型银屑病/, tcm: /白疕|血热|血燥|血瘀/, therapy: /凉血|活血|养血|润燥/,
  }),

  caseOf("U01", "泌尿-前列腺症状", 66, "男", "晚上起来尿三四趟，尿线也越来越细", "有大半年了。", "还能尿出来，没有发热、腰痛、血尿和膀胱胀痛；吃氨氯地平，没吃前列腺药。舌淡脉沉。", {
    questionAxes: [/尿潴留|血尿|发热|腰痛/, /夜尿|尿线|用药|病程|氨氯地平|前列腺药/], western: /良性前列腺增生|下尿路症状/, tcm: /癃闭|肾气虚|膀胱气化不利/, therapy: /温肾|益气|通利|化瘀/,
  }),
  caseOf("U02", "泌尿-尿路感染", 42, "女", "小便刺痛还老想去厕所", "两天了。", "没有发热寒战、腰痛、血尿和呕吐；是否怀孕还没测，没自己吃抗生素。舌红苔黄。", {
    questionAxes: [/发热|寒战|腰痛|呕吐|血尿/, /妊娠|抗生素|病程/], western: /急性膀胱炎|尿路感染/, tcm: /淋证|湿热下注|热淋/, therapy: /清热利湿|通淋/,
  }),
  caseOf("U03", "男科-勃起功能下降", 52, "男", "最近硬不起来，勉强起来也容易软", "有四五个月，心里挺着急。", "晨勃也少，性欲一般；有高血压，吃药名字不记得。没有胸痛和活动气短。舌淡暗。", {
    questionAxes: [/晨勃|性欲|心理|病程/, /心血管|用药|吃药|高血压|糖尿病|激素/], western: /勃起功能障碍|性功能障碍/, tcm: /阳痿|肾虚|肝郁|瘀阻/, therapy: /补肾|疏肝|活血|起痿/,
  }),

  caseOf("C01", "儿科-咳嗽", 5, "男", "孩子咳了三天，吃饭也少了", "家里说不清有没有痰。", "没有呼吸急促、鼻翼扇动、嘴唇发紫和精神萎靡；能喝水，小便量和平时差不多，最高体温37.8℃。体重18kg。舌苔白。", {
    questionAxes: [/呼吸|鼻翼|发绀|精神/, /饮水|尿量|脱水|体温/], western: /上呼吸道感染|急性支气管炎|感染相关咳嗽/, tcm: /咳嗽|肺失宣降|风寒|风热|痰湿/, therapy: /宣肺|止咳|化痰/, doseExpected: false,
  }),
  caseOf("C02", "儿科-食欲差", 7, "女", "孩子最近不爱吃饭，吃几口就说饱", "快一个月了，精神还行。", "没有持续腹痛、呕吐、黑便和明显消瘦；大便两天一次偏干。体重24kg，没吃保健品。舌淡有齿痕。", {
    questionAxes: [/腹痛|呕吐|黑便|体重/, /大便|零食|病程|用药/], western: /食欲不振|功能性消化不良|便秘/, tcm: /厌食|积滞|脾胃虚弱|食积/, therapy: /健脾|和胃|消食|导滞/, doseExpected: false,
  }),
  caseOf("C03", "儿科-腹泻", 3, "男", "孩子一天拉五六次稀水便", "从昨天开始。", "没有血便、高热和反复呕吐；还能喝水，但小便比平时少一点，精神尚可。体重14kg。没吃止泻药。舌苔白腻。", {
    questionAxes: [/血便|高热|呕吐/, /饮水|尿量|精神|体重/], western: /急性腹泻|急性胃肠炎|感染性腹泻/, tcm: /泄泻|湿困脾胃|寒湿|湿热/, therapy: /化湿|和中|止泻|健脾/, doseExpected: false,
  }),

  caseOf("E01", "耳鼻喉-耳鸣", 55, "男", "右耳嗡嗡响，晚上安静时更明显", "两个多月，听力好像也差点。", "不是突然耳聋，没有眩晕、脸歪和肢体无力；高血压药每天吃，名字不清。舌暗。", {
    questionAxes: [/突发耳聋|眩晕|神经症状/, /单侧|听力|耳聋|药物|高血压药|噪声/], western: /耳鸣|感音神经性听力下降待查/, tcm: /耳鸣|肾虚|肝火|痰火|瘀阻/, therapy: /补肾|清肝|化痰|通窍/,
  }),
  caseOf("E02", "耳鼻喉-咽痛", 24, "女", "嗓子疼，吞口水都不舒服", "两天了，有点低烧。", "能喝水，没有呼吸费力、流口水、张口困难和颈部明显肿；最高37.9℃，没吃抗生素，未孕。舌红苔薄黄。", {
    questionAxes: [/呼吸|流涎|张口|颈肿/, /体温|咳嗽|脓点|抗生素/], western: /急性咽炎|上呼吸道感染|扁桃体炎/, tcm: /喉痹|风热|肺胃热盛/, therapy: /疏风清热|利咽|解毒/,
  }),
  caseOf("E03", "口腔-复发口疮", 30, "女", "嘴里老长小溃疡，疼得吃饭不舒服", "这次三天，平时一两个月就来一次。", "每次一两个，一周多能好；没有发热、眼痛、生殖器溃疡和明显消瘦。未孕。舌尖红。", {
    questionAxes: [/数量|持续|发热|体重/, /眼|生殖器|胃肠|月经/], western: /复发性口腔溃疡|阿弗他溃疡/, tcm: /口疮|心火|胃火|阴虚火旺/, therapy: /清心|泻火|养阴|生肌/,
  }),
  caseOf("E04", "眼科-干眼", 44, "女", "眼睛干涩发酸，看电脑久了像有沙子", "半年了，眨眼和休息能好点。", "没有突然视力下降、眼球剧痛和明显畏光；戴隐形眼镜少，未孕。最近睡得偏晚。舌偏红少津。", {
    questionAxes: [/视力下降|剧痛|畏光/, /屏幕|隐形眼镜|口干|药物/], western: /干眼症|视疲劳/, tcm: /白涩症|目涩|肝肾阴虚|津亏/, therapy: /养阴|润燥|养肝明目/,
  }),

  caseOf("A01", "肛肠-痔", 47, "男", "大便后纸上有鲜血，肛门还有个小包", "断断续续一个月。", "血是鲜红的、量不多，没有黑便、头晕和体重下降；大便偏干，没做过肠镜。舌红。", {
    questionAxes: [/黑便|头晕|体重|血量/, /疼痛|脱出|便秘|肠镜/], western: /痔|内痔|混合痔/, tcm: /痔病|肠燥|湿热下注|气虚下陷/, therapy: /清热凉血|润肠|止血|升提/,
  }),
  caseOf("A02", "肛肠-肛裂", 36, "女", "大便太硬，拉的时候肛门像裂开一样疼", "有两周，擦纸会有一点血。", "疼在排便时最明显，便后还疼一会；没有黑便、发热和肛周流脓。未孕。舌偏红。", {
    questionAxes: [/黑便|发热|流脓/, /便后疼|便后.*疼|便秘|血量/], western: /肛裂|便秘/, tcm: /肛裂|肠燥津亏|血热/, therapy: /润肠通便|清热凉血|止痛/,
  }),

  caseOf("O01", "老年-衰弱", 78, "女", "这半年腿脚越来越没劲，走一会就得歇", "饭量也比以前小，人瘦了几斤。", "没有胸痛、气短、黑便和发热，近半年摔过一次但没骨折；平时吃降压药，具体不清。舌淡。", {
    questionAxes: [/胸痛|气短|黑便|发热/, /体重|跌倒|摔|饮食|用药|降压药|日常活动/], western: /老年衰弱|营养不良风险|肌少症/, tcm: /虚劳|脾肾亏虚|气血不足/, therapy: /健脾益气|补肾|养血|调养/,
  }),

  caseOf("RF01", "红旗-消化道出血", 69, "男", "这两天拉出来像柏油一样黑，站起来还晕", "今天更没劲，平时吃阿司匹林。", "血压90/55，脉搏118次/分。", {
    redFlag: true, redFlagOracle: categoryOracle(["gi_bleed"], ["shock", "vital_instability"]), questionAxes: [], western: /消化道出血|失血|循环不稳/, tcm: /血证|便血/, therapy: /急诊|转诊|止血|复苏/,
  }),
  caseOf("RF02", "红旗-胸痛", 58, "男", "胸口突然像石头压着，出一身冷汗", "一个小时前开始，歇着也不缓。", "一周前体检心电图说正常。", {
    redFlag: true, redFlagOracle: categoryOracle(["cardiac"]), questionAxes: [], western: /急性冠脉综合征|心肌梗死|ACS/, tcm: /胸痹|真心痛/, therapy: /急诊|心电图|肌钙蛋白|转运/,
  }),
  caseOf("RF03", "红旗-卒中", 72, "女", "刚才突然说不出话，右边手脚也抬不起来", "大概四十分钟前家里人发现的。", "以前没有这样。", {
    redFlag: true, redFlagOracle: categoryOracle(["neuro"]), questionAxes: [], western: /脑卒中|脑梗死|脑出血/, tcm: /中风/, therapy: /卒中中心|急诊|溶栓|取栓|影像/,
  }),
  caseOf("RF04", "红旗-低氧", 74, "女", "突然喘不上气，嘴唇有点发紫", "半小时前开始。", "血氧88%，呼吸30次/分。", {
    redFlag: true, redFlagOracle: categoryOracle(["respiratory"], ["vital_instability"]), questionAxes: [], western: /急性低氧|肺栓塞|心力衰竭|呼吸衰竭/, tcm: /喘脱|喘证/, therapy: /急诊|氧疗|转运|监护/,
  }),
  caseOf("RF05", "红旗-急腹症", 63, "男", "右下肚子有点疼，走路不太舒服", "今天下午开始，具体表现还没问清。", "疼痛很快加重，已经吐了两次；现在发热38.6℃，按下去松手更疼。", {
    redFlag: true, redFlagStage: "after_m02", redFlagOracle: categoryOracle(["acute_abdomen"]), questionAxes: [/疼痛|加重|压痛|反跳痛/, /发热|呕吐|排便|排气/], western: /阑尾炎|急腹症|腹膜炎/, tcm: /肠痈|腹痛/, therapy: /急诊|外科|影像|手术评估/,
  }),
];

if (PRIMARY_CARE_SPARSE_50.length !== 50) {
  throw new Error(`Expected 50 sparse primary-care cases, got ${PRIMARY_CARE_SPARSE_50.length}`);
}

export const PRIMARY_CARE_POLARITY_CONTRASTS = [
  {
    id: "POL-NEG-START",
    fictional: true,
    context: "negative",
    position: "start",
    text: "没有胸痛、冷汗或晕厥，今天只是饭后上腹胀。",
    expected: { category: "cardiac", allowedStatuses: ["negative"], allowAbsent: true, forbidPositive: true },
  },
  {
    id: "POL-HIST-MIDDLE",
    fictional: true,
    context: "historical",
    position: "middle",
    text: "目前走路说话正常；三年前曾短暂口角歪斜，已完成治疗且近期没有新发无力或言语不清。",
    expected: { category: "neuro", allowedStatuses: ["historical", "negative"], allowAbsent: true, forbidPositive: true },
  },
  {
    id: "POL-FAMILY-END",
    fictional: true,
    context: "family_history",
    position: "end",
    text: "本人没有黑便、呕血或站立头晕，父亲以前因消化道出血住过院。",
    expected: { category: "gi_bleed", allowedStatuses: ["negative", "historical"], allowAbsent: true, forbidPositive: true },
  },
  {
    id: "POL-COND-BOTH",
    fictional: true,
    context: "conditional",
    position: "both",
    text: "如果以后突然喘不上气就去急诊；现在血氧正常，没有气促，家属也说若嘴唇发紫会立即呼救。",
    expected: { category: "respiratory", allowedStatuses: ["negative"], allowAbsent: true, forbidPositive: true },
  },
];

const auditHerb = (name, dose) => ({ name, dose });
const auditControl = (id, mutation, overrides) => ({
  id,
  fictional: true,
  controlLayer: "provider",
  mutation,
  patient: { sex: "女", age: 35 },
  chiefComplaint: "虚构审方正控，不代表临床建议",
  diagnosis: "失眠障碍",
  syndrome: "心脾两虚证",
  pastHistory: "否认肝肾功能不全",
  medicationHistory: "否认当前其他用药",
  allergyHistory: "否认药物过敏",
  herbs: [
    auditHerb("黄芪", "15g"),
    auditHerb("白术", "10g"),
    auditHerb("茯苓", "15g"),
    auditHerb("酸枣仁", "15g"),
    auditHerb("甘草", "6g"),
  ],
  ...overrides,
});

/**
 * Independent fictional prescription mutations. Provider controls must produce a traceable
 * LingXi issue. Input-quality controls exercise the CDSS boundary before any provider result is
 * interpreted and must never be represented as provider issues.
 */
export const M05_PRESCRIPTION_MUTATION_CONTROLS = [
  auditControl("M05-PC-01", "overdose", {
    herbs: [auditHerb("黄芪", "15g"), auditHerb("白术", "10g"), auditHerb("茯苓", "15g"), auditHerb("酸枣仁", "15g"), auditHerb("甘草", "60g")],
    expectedIssue: { type: /DOSE_OVER|DOSE/i, text: /剂量|用量|超/, drugs: ["甘草"], minSeverity: "MEDIUM" },
  }),
  auditControl("M05-PC-02", "missing_dose", {
    controlLayer: "input_quality",
    herbs: [auditHerb("黄芪", "15g"), auditHerb("白术", null), auditHerb("茯苓", "15g"), auditHerb("酸枣仁", "15g"), auditHerb("甘草", "6g")],
    expectedInputAdvisory: { code: "missing_dose", drugs: ["白术"] },
  }),
  auditControl("M05-PC-03", "duplicate_drug", {
    herbs: [auditHerb("黄芪", "15g"), auditHerb("白术", "10g"), auditHerb("茯苓", "15g"), auditHerb("酸枣仁", "15g"), auditHerb("酸枣仁", "10g")],
    expectedIssue: { type: /DUPLICATE|REPEAT|重复/i, text: /重复|叠加|同味/, drugs: ["酸枣仁"], minSeverity: "MEDIUM" },
  }),
  auditControl("M05-PC-04", "decoction_method", {
    diagnosis: "失眠障碍",
    syndrome: "心脾两虚证",
    herbs: [auditHerb("大黄", "10g"), auditHerb("芒硝", "6g"), auditHerb("枳实", "10g"), auditHerb("厚朴", "10g")],
    expectedIssue: { type: /TCM_(?:DECOCTION|SPECIAL)|DECOCTION|煎法|煎煮/i, text: /先煎|后下|烊化|煎法|煎煮|冲服/, drugs: ["大黄"], minSeverity: "MEDIUM" },
  }),
  auditControl("M05-PC-05A", "pregnancy_lactation", {
    patient: { sex: "女", age: 29 },
    pastHistory: "当前妊娠12周",
    herbs: [auditHerb("桃仁", "10g"), auditHerb("牛膝", "12g"), auditHerb("当归", "10g"), auditHerb("川芎", "6g")],
    expectedIssue: { type: /PREGN|SPECIAL_POP|CONTRAINDICATION|妊娠/i, text: /妊娠|孕妇|孕期|特殊人群/, drugs: ["桃仁"], minSeverity: "MEDIUM" },
  }),
  auditControl("M05-PC-05B", "pregnancy_lactation", {
    patient: { sex: "女", age: 31 },
    pastHistory: "产后6周，明确正在哺乳",
    herbs: [auditHerb("大黄", "6g"), auditHerb("芒硝", "3g"), auditHerb("枳实", "6g"), auditHerb("厚朴", "6g")],
    expectedIssue: { type: /LACT|SPECIAL_POP|CONTRAINDICATION|哺乳/i, text: /哺乳|乳汁|乳母|特殊人群/, drugs: ["大黄"], minSeverity: "MEDIUM" },
  }),
  auditControl("M05-PC-06", "incompatibility", {
    herbs: [auditHerb("甘草", "6g"), auditHerb("甘遂", "3g"), auditHerb("白术", "10g"), auditHerb("茯苓", "15g")],
    expectedIssue: { type: /INCOMPAT|REPULSION|TCM.*PAIR|十八反|十九畏|配伍/i, text: /十八反|十九畏|配伍|相反|禁忌/, drugs: ["甘草", "甘遂"], minSeverity: "CRITICAL" },
  }),
  auditControl("M05-PC-07", "interaction", {
    patient: { sex: "男", age: 67 },
    diagnosis: "心房颤动",
    syndrome: "气虚血瘀证",
    medicationHistory: "当前规律服用华法林",
    herbs: [auditHerb("丹参", "15g"), auditHerb("黄芪", "15g"), auditHerb("当归", "10g"), auditHerb("川芎", "6g")],
    expectedIssue: { type: /INTERACTION|DRUG.*DRUG|相互作用/i, text: /相互作用|出血|抗凝|华法林/, contextDrug: /华法林/, drugs: ["丹参"], minSeverity: "HIGH" },
  }),
];
