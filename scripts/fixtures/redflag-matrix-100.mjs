// 100+10 条覆盖矩阵测试用例 - 用于 /api/diagnosis/red-flags 批量回归与 real-100 M03/M04 评测
// 全部为虚构测试数据,不含真实 PHI
// 设计原则:
//   - RF01-RF10: 红旗急症(应触发 allowDosePrescription=false)
//   - NG01-NG10: 阴性对照(同主题+否认词,不应误报)
//   - SP01-SP10: 特殊人群(孕/老/儿/肝肾)
//   - AL01-AL10: 过敏史/用药史冲突
//   - TC01-TC10: 中医专科(脾胃/肝胆/肺/心/肾)
//   - TC11-TC20: 中医专科(妇科/儿科/骨伤/皮科/五官)
//   - BO01-BO10: 边界(空主诉/极简/超长/特殊字符)
//   - MIX01-MIX10: 多病共存/复杂场景
//   - OK01-OK10: 全阴性健康体检
//   - TR01-TR10: 极性陷阱("无X史"等表述)
//   - ES01-ES10: 就诊范围与时态(恢复期残余症状/稳定慢性病明确求治/复诊续药体检咨询/时态矛盾)

export const REDFLAG_MATRIX_100 = [
  // ============ RF: 红旗急症(10 条)============
  { id: "RF01", cat: "cardiac", chief: "突发剧烈胸痛伴大汗1小时", hist: "1小时前胸骨后压榨样剧痛,向左肩放射,大汗、濒死感。", vitals: { bp: "160/100", hr: "110", spo2: "95" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF02", cat: "stroke", chief: "突发左侧肢体无力伴言语不清40分钟", hist: "40分钟前突然左侧胳膊腿不听使唤,说话含糊,口角歪斜。", vitals: { bp: "190/110", hr: "88" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF03", cat: "anaphylaxis", chief: "吃海鲜后全身皮疹伴喉头阻塞感20分钟", hist: "20分钟前吃虾后全身荨麻疹、唇肿、呼吸困难,既往海鲜过敏。", vitals: { bp: "85/50", hr: "120", spo2: "90" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF04", cat: "gi_bleed", chief: "呕血伴黑便3小时", hist: "3小时前呕咖啡样物2次,黑便1次,头晕心悸。既往胃溃疡。", vitals: { bp: "92/60", hr: "110" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF05", cat: "sepsis", chief: "高热寒战伴意识模糊1天", hist: "昨日发热39.5℃寒战,今日昏睡,尿少。", vitals: { t: "39.5", hr: "130", bp: "85/45", rr: "28", spo2: "92" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF06", cat: "acute_abdomen", chief: "突发全腹剧痛2小时", hist: "2小时前突发全腹刀割样痛,板状腹,拒按。", vitals: { bp: "100/65", hr: "100" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF07", cat: "respiratory", chief: "哮喘急性发作,端坐呼吸30分钟", hist: "30分钟前喘息加重,端坐呼吸,说话不能成句。", vitals: { rr: "32", spo2: "88", hr: "125" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF08", cat: "obstetric", chief: "孕32周,大量阴道出血", hist: "孕32周,1小时前无痛性阴道大出血,浸湿2片夜用卫生巾。", vitals: { bp: "95/60", hr: "105" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF09", cat: "shock", chief: "严重腹泻后意识淡漠", hist: "昨日水样便10余次,今日昏睡,四肢冷。", vitals: { bp: "78/40", hr: "135", spo2: "90" }, expect: { redFlag: true, allowDose: false } },
  { id: "RF10", cat: "pediatric_critical", chief: "3月龄婴儿发热38.5伴拒奶嗜睡", hist: "3月龄,昨日发热,今日不吃奶、嗜睡、哭声弱。", vitals: { t: "38.5", hr: "170", rr: "55" }, expect: { redFlag: true, allowDose: false } },

  // ============ NG: 阴性对照(10 条 - 同主题+否认,不应触发)============
  { id: "NG01", chief: "胸部闷痛半年,既往心肌梗死,目前已无症状", hist: "半年前心梗已放支架,目前无症状,近期心电图正常。", vitals: { bp: "120/80", hr: "72" }, expect: { redFlag: false } },
  { id: "NG02", chief: "2年前脑梗,遗留右侧肢体轻微力弱,目前稳定", hist: "2年前缺血性脑卒中,康复后遗留轻微力弱,近期无新发症状。", vitals: { bp: "130/85" }, expect: { redFlag: false } },
  { id: "NG03", chief: "已知海鲜过敏,本次未接触,无症状", hist: "既往海鲜过敏,本次未食,无皮疹、无呼吸困难。", vitals: { bp: "118/75", hr: "70" }, expect: { redFlag: false } },
  { id: "NG04", chief: "既往胃溃疡,目前无出血、大便正常", hist: "3年前胃溃疡已治愈,目前大便正常,无呕血、无黑便。", vitals: { bp: "120/80" }, expect: { redFlag: false } },
  { id: "NG05", chief: "上呼吸道感染,体温37.2℃无寒战", hist: "感冒2天,流涕咽痛,体温最高37.2℃,无寒战、无意识改变。", vitals: { t: "37.2", hr: "80" }, expect: { redFlag: false } },
  { id: "NG06", chief: "慢性胃炎,轻度上腹隐痛", hist: "慢性胃炎5年,轻度上腹隐痛,无板状腹、无拒按。", vitals: { bp: "120/80" }, expect: { redFlag: false } },
  { id: "NG07", chief: "哮喘稳定期,日常无喘息", hist: "哮喘稳定期,规律吸入激素,无急性发作、无夜间憋醒。", vitals: { rr: "16", spo2: "98" }, expect: { redFlag: false, m03: "limited", m04: "non_dose", notes: "稳定期无急性发作且无本次治疗请求:historical 拦截=预期安全行为" } },
  { id: "NG08", chief: "孕32周,常规产检,无腹痛无出血", hist: "孕32周常规产检,胎动正常,无腹痛、无阴道出血。", vitals: { bp: "110/70", hr: "78" }, expect: { redFlag: false } },
  { id: "NG09", chief: "急性胃肠炎恢复期,腹泻已止", hist: "3天前急性胃肠炎,已无症状,今日大便正常,精神可。", vitals: { bp: "118/75" }, expect: { redFlag: false } },
  { id: "NG10", chief: "3岁儿童感冒,体温37.5℃精神活泼", hist: "3岁,感冒1天,流涕轻咳,精神活泼、进食正常。", vitals: { t: "37.5", hr: "100" }, expect: { redFlag: false } },

  // ============ SP: 特殊人群(10 条)============
  { id: "SP01", chief: "孕12周恶心呕吐", hist: "孕12周,恶心呕吐3周,轻度脱水。", vitals: { bp: "105/65" }, expect: { redFlag: false, m03: "full", m04: "non_dose", notes: "妊娠剧吐需关注但不一定红旗;妊娠=非剂量硬边界(产品决策,不得放宽)" } },
  { id: "SP02", chief: "孕28周高血压", hist: "孕28周,血压150/95,轻度下肢水肿,无头痛。", vitals: { bp: "150/95" }, expect: { redFlag: false, m03: "any", m04: "non_dose", notes: "preeclampsia 边界;妊娠期:保守有限或完整 M03 均可(特殊人群保守=设计行为);妊娠=非剂量硬边界" } },
  { id: "SP03", chief: "82岁老人肺部感染", hist: "82岁,发热咳嗽3天,精神差,食纳少。", vitals: { t: "38.0", rr: "22", spo2: "93" }, expect: { redFlag: false, m03: "any", m04: "non_dose", notes: "高龄感染伴精神差及低氧边缘值虽未命中急诊硬阈值，仍不应作为必须生成剂量处方的质量正例" } },
  { id: "SP04", chief: "6月龄婴儿湿疹", hist: "6月龄,面部湿疹反复,无发热、无腹泻。", vitals: { t: "36.8" }, expect: { redFlag: false } },
  { id: "SP05", chief: "慢性肾功能不全,肌酐250", hist: "CKD 3期,肌酐250μmol/L,乏力,无水肿。", vitals: { bp: "140/85" }, expect: { redFlag: false, notes: "用药需调整" } },
  { id: "SP06", chief: "肝硬化代偿期", hist: "肝硬化Child-Pugh A,无腹水、无黄疸。", vitals: { bp: "118/70" }, expect: { redFlag: false } },
  { id: "SP07", chief: "哺乳期急性乳腺炎", hist: "产后3月哺乳期,右乳红肿热痛2天,体温37.8℃。", vitals: { t: "37.8" }, expect: { redFlag: false, m03: "any", m04: "non_dose", notes: "哺乳期急性感染:保守有限或完整 M03 均可;哺乳=非剂量硬边界" } },
  { id: "SP08", chief: "癫痫规律服药中", hist: "癫痫5年,规律服丙戊酸钠,2年无发作。", vitals: { bp: "120/80" }, expect: { redFlag: false } },
  { id: "SP09", chief: "冠心病稳定型心绞痛", hist: "劳力性胸痛2年,规律服药,本次就诊开药。", vitals: { bp: "130/80", hr: "72" }, expect: { redFlag: false } },
  { id: "SP10", chief: "G6PD缺乏症,无急性溶血", hist: "G6PD缺乏,本次体检,无黄疸、无血红蛋白尿。", vitals: { bp: "118/75" }, expect: { redFlag: false } },

  // ============ AL: 过敏史/用药史(10 条)============
  { id: "AL01", chief: "感冒咳嗽", hist: "咳嗽2天。既往青霉素过敏(皮试休克史)。", vitals: { bp: "120/80" }, expect: { redFlag: false, notes: "青霉素过敏史须标注" } },
  { id: "AL02", chief: "慢性荨麻疹", hist: "反复荨麻疹。对海鲜、花粉、阿司匹林过敏。", vitals: {}, expect: { redFlag: false, notes: "过敏史标注" } },
  { id: "AL03", chief: "高血压复诊", hist: "高血压10年。现用厄贝沙坦、氨氯地平、氢氯噻嗪。", vitals: { bp: "145/90" }, expect: { redFlag: false, notes: "用药清单标注" } },
  { id: "AL04", chief: "房颤抗凝中", hist: "房颤3年,华法林抗凝,INR 2.5。", vitals: { bp: "130/80" }, expect: { redFlag: false, notes: "抗凝药须警示" } },
  { id: "AL05", chief: "2型糖尿病", hist: "二甲双胍+格列美脲+西格列汀三联,血糖控制可。", vitals: {}, expect: { redFlag: false, notes: "多药联用" } },
  { id: "AL06", chief: "抑郁症复诊", hist: "服SSRI 2年,症状稳定。", vitals: {}, expect: { redFlag: false, notes: "精神类药物" } },
  { id: "AL07", chief: "甲减", hist: "服左甲状腺素钠50μg/d,TSH正常。", vitals: {}, expect: { redFlag: false, m03: "any", m04: "non_dose", notes: "稳定用药无本次治疗请求:保守非剂量合理" } },
  { id: "AL08", chief: "类风湿关节炎", hist: "甲氨蝶呤+来氟米特+泼尼松5mg。", vitals: {}, expect: { redFlag: false, notes: "免疫抑制+激素" } },
  { id: "AL09", chief: "癫痫孕前咨询", hist: "服丙戊酸钠,准备怀孕咨询。", vitals: {}, expect: { redFlag: false, notes: "胎儿风险" } },
  { id: "AL10", chief: "失眠", hist: "既往安眠药过敏(苯二氮卓类)。", vitals: {}, expect: { redFlag: false, notes: "失眠+安眠药过敏,影响治法" } },

  // ============ TC: 中医专科(20 条)============
  { id: "TC01", chief: "胃脘胀满饭后加重3月", hist: "饭后胃胀,嗳气,大便偏稀。舌淡胖有齿痕苔白腻。", vitals: {}, expect: { redFlag: false, tcm: "痞满/脾胃虚弱" } },
  { id: "TC02", chief: "腹泻腹痛2天", hist: "进食生冷后腹泻日4次,稀水样,轻度腹痛。舌淡苔白腻。", vitals: {}, expect: { redFlag: false, tcm: "泄泻/寒湿" } },
  { id: "TC03", chief: "便秘3月", hist: "大便干结,4-5日一行,排便费力。舌红少津。", vitals: {}, expect: { redFlag: false, tcm: "便秘/肠燥津亏" } },
  { id: "TC04", chief: "反酸烧心1月", hist: "夜间反酸烧心,平卧加重。舌红苔薄黄。", vitals: {}, expect: { redFlag: false, tcm: "吐酸/肝胃不和", m03: "full", m04: "dose", notes: "温清反佐已按受控经典方组成建模：左金丸式黄连+吴茱萸可过合同；脱离经方基准的自拟反佐仍须拒收" } },
  { id: "TC05", chief: "感冒后咳嗽2周", hist: "干咳少痰,咽痒,夜间加重。舌偏红苔薄白。", vitals: {}, expect: { redFlag: false, tcm: "咳嗽/风邪恋肺" } },
  { id: "TC06", chief: "晨起喷嚏清涕3年", hist: "尘螨过敏史,晨起喷嚏连连,清涕。舌淡苔薄白。", vitals: {}, expect: { redFlag: false, tcm: "鼻鼽/肺气虚寒" } },
  { id: "TC07", chief: "运动后喘鸣1月", hist: "跑步后喘鸣,夜间憋醒1次。舌淡苔白。", vitals: { rr: "18", spo2: "97" }, expect: { redFlag: false, tcm: "哮病/痰饮伏肺" } },
  { id: "TC08", chief: "失眠多梦半年", hist: "入睡困难,多梦易醒,心悸。舌淡苔薄白,脉细弱。", vitals: { bp: "120/78" }, expect: { redFlag: false, tcm: "不寐/心肝血虚" } },
  { id: "TC09", chief: "膝痛加重1月", hist: "右膝疼痛,上下楼加重,无红肿。舌暗苔薄白。", vitals: {}, expect: { redFlag: false, tcm: "膝痹/肝肾不足" } },
  { id: "TC10", chief: "头痛反复发作1年", hist: "头痛偏两侧,情绪波动后加重。舌红苔薄黄,脉弦。", vitals: { bp: "125/80" }, expect: { redFlag: false, tcm: "头痛/肝阳上亢" } },
  { id: "TC11", sex: "女", age: 31, chief: "痛经3年", hist: "经期小腹冷痛,得温则减,月经后期。舌暗苔白。", vitals: {}, expect: { redFlag: false, tcm: "痛经/寒凝血瘀" } },
  { id: "TC12", chief: "小儿厌食2月", hist: "5岁,近2月食纳差,无发热、无腹泻。舌淡苔白腻。", vitals: {}, expect: { redFlag: false, tcm: "厌食/脾胃虚弱" } },
  { id: "TC13", chief: "颈肩酸痛反复半年", hist: "久坐后颈肩酸胀,无手麻。舌淡苔薄白。", vitals: {}, expect: { redFlag: false, tcm: "项痹/经筋不舒" } },
  { id: "TC14", chief: "慢性湿疹3年", hist: "四肢屈侧湿疹反复,瘙痒,皮肤增厚。舌红苔薄黄。", vitals: {}, expect: { redFlag: false, tcm: "湿疮/血虚风燥" } },
  { id: "TC15", chief: "耳鸣反复1年", hist: "耳鸣如蝉,夜间明显,腰膝酸软。舌红少苔。", vitals: { bp: "130/85" }, expect: { redFlag: false, tcm: "耳鸣/肾精亏虚" } },
  { id: "TC16", chief: "慢性咽炎", hist: "咽部异物感半年,干燥,无发热。舌红少津。", vitals: {}, expect: { redFlag: false, tcm: "喉痹/肺肾阴虚" } },
  { id: "TC17", chief: "消渴(2型糖尿病)", hist: "口干多饮乏力半年,空腹血糖9mmol/L。舌红少苔。", vitals: {}, expect: { redFlag: false, tcm: "消渴/气阴两虚" } },
  { id: "TC18", chief: "中风后遗左侧肢体无力", hist: "半年前脑梗,遗留左肢力弱,可扶行。舌暗有瘀斑。", vitals: { bp: "135/85" }, expect: { redFlag: false, tcm: "中风后遗/气虚血瘀" } },
  { id: "TC19", chief: "心悸阵作3月", hist: "心悸时发,无胸痛、无晕厥。舌淡苔薄白,脉细弱。", vitals: { bp: "120/80", hr: "76" }, expect: { redFlag: false, tcm: "心悸/气血不足" } },
  { id: "TC20", chief: "腰痛2月", hist: "腰酸软疼痛,劳累加重,无下肢放射痛。舌淡苔薄白。", vitals: {}, expect: { redFlag: false, tcm: "腰痛/肾虚" } },

  // ============ BO: 边界场景(10 条)============
  { id: "BO01", chief: "", hist: "", vitals: {}, expect: { redFlag: false, notes: "完全空病历 - 应不阻断但提示填主诉" } },
  { id: "BO02", chief: "感冒", hist: "", vitals: {}, expect: { redFlag: false, notes: "极简病历 - 仅主诉" } },
  { id: "BO03", chief: "a".repeat(2000), hist: "", vitals: {}, expect: { redFlag: false, notes: "超长主诉 - 不应崩溃" } },
  { id: "BO04", chief: "头痛<script>alert(1)</script>", hist: "", vitals: {}, expect: { redFlag: false, notes: "XSS 注入测试" } },
  { id: "BO05", chief: "胃痛'; DROP TABLE--", hist: "", vitals: {}, expect: { redFlag: false, notes: "SQL 注入测试" } },
  { id: "BO06", chief: "失眠", hist: "患者\n含\r\n各种\t制表符\b退格", vitals: {}, expect: { redFlag: false, notes: "特殊字符" } },
  { id: "BO07", chief: "腹痛", hist: "<>{}[]()&%^$#@!", vitals: {}, expect: { redFlag: false, notes: "符号注入" } },
  { id: "BO08", chief: "皮疹", hist: "🏥💊⚕️中医药 emoji 测试", vitals: {}, expect: { redFlag: false, notes: "emoji" } },
  { id: "BO09", chief: "咳嗽", hist: "英文 english mixed 咳嗽 cough 2 days", vitals: {}, expect: { redFlag: false, notes: "中英混杂" } },
  { id: "BO10", chief: "乏力", hist: "null undefined NaN", vitals: {}, expect: { redFlag: false, notes: "代码字面量" } },

  // ============ MIX: 多病共存(10 条)============
  { id: "MIX01", chief: "高血压糖尿病冠心病胃溃疡多种疾病", hist: "20年高血压、15年糖尿病、5年心绞痛、3年胃溃疡。", vitals: { bp: "150/90" }, expect: { redFlag: false, notes: "多病共存,用药复杂" } },
  { id: "MIX02", chief: "肿瘤化疗后骨髓抑制", hist: "乳腺癌术后化疗第3周期,WBC 2.0。", vitals: {}, expect: { redFlag: false, notes: "免疫抑制" } },
  { id: "MIX03", chief: "慢性肾衰+心衰", hist: "CKD 4期+HF EF35%,双下肢水肿,平路气短。", vitals: { bp: "160/95", rr: "22", spo2: "93" }, expect: { redFlag: false, notes: "多脏器受累" } },
  { id: "MIX04", chief: "乙肝肝硬化肝癌术后", hist: "乙肝30年,肝硬化10年,肝癌切除1年,目前稳定。", vitals: {}, expect: { redFlag: false, m03: "limited", m04: "non_dose", notes: "肝病背景;术后目前稳定且无治疗请求:保守拦截合理" } },
  { id: "MIX05", chief: "房颤+脑梗后+痴呆", hist: "房颤抗凝中,1年前脑梗,轻度认知障碍。", vitals: { bp: "135/85" }, expect: { redFlag: false, m03: "limited", m04: "non_dose", notes: "联合病变;无明确治疗请求:保守拦截合理" } },
  { id: "MIX06", chief: "COPD+肺心病", hist: "COPD 10年,继发肺心病,双下肢轻度水肿。", vitals: { rr: "22", spo2: "92" }, expect: { redFlag: false, notes: "呼吸+循环" } },
  { id: "MIX07", chief: "帕金森+抑郁+便秘", hist: "帕金森5年,抑郁2年,慢性便秘多年。", vitals: {}, expect: { redFlag: false, notes: "老年综合征" } },
  { id: "MIX08", chief: "糖尿病足+周围神经病变", hist: "糖尿病15年,右足溃疡,足部麻木。", vitals: {}, expect: { redFlag: false, notes: "并发症" } },
  { id: "MIX09", chief: "SLE+狼疮性肾炎", hist: "SLE 8年,狼疮性肾炎III型,服激素+免疫抑制。", vitals: {}, expect: { redFlag: false, notes: "自身免疫" } },
  { id: "MIX10", chief: "HIV+TB", hist: "HIV 5年,ART治疗中,合并肺结核治疗3月。", vitals: {}, expect: { redFlag: false, notes: "感染联合" } },

  // ============ OK: 全阴性健康体检(10 条)============
  { id: "OK01", chief: "体检咨询", hist: "无症状,体检正常。", vitals: { bp: "120/80", hr: "72" }, expect: { redFlag: false } },
  { id: "OK02", chief: "疲劳乏力1周", hist: "工作忙后疲劳,无其他症状,睡眠可。", vitals: {}, expect: { redFlag: false, tcm: "虚劳/气血不足" } },
  { id: "OK03", chief: "调理身体", hist: "亚健康状态,无明显不适。", vitals: {}, expect: { redFlag: false } },
  { id: "OK04", chief: "换季养生", hist: "无不适,想调理。", vitals: {}, expect: { redFlag: false } },
  { id: "OK05", chief: "体重正常稳定", hist: "体重稳定,无变化。", vitals: {}, expect: { redFlag: false } },
  { id: "OK06", chief: "睡眠偶尔不佳", hist: "偶有入睡慢,无规律失眠。", vitals: {}, expect: { redFlag: false } },
  { id: "OK07", chief: "食欲正常", hist: "无不适。", vitals: {}, expect: { redFlag: false } },
  { id: "OK08", chief: "大便规律", hist: "大便日1次,正常。", vitals: {}, expect: { redFlag: false } },
  { id: "OK09", chief: "月经规律", hist: "月经规律,无痛经。", vitals: {}, expect: { redFlag: false } },
  { id: "OK10", chief: "情绪平稳", hist: "情绪稳定,无明显压力。", vitals: {}, expect: { redFlag: false } },

  // ============ TR: 极性陷阱(10 条)============
  { id: "TR01", chief: "胸闷", hist: "患者否认胸痛、否认呼吸困难、否认放射痛。", vitals: { bp: "120/80" }, expect: { redFlag: false, notes: "否认陷阱" } },
  { id: "TR02", chief: "头痛", hist: "既往脑梗史,目前已愈,无后遗。", vitals: { bp: "130/85" }, expect: { redFlag: false, notes: "既往史不应硬阻断" } },
  { id: "TR03", chief: "腹痛", hist: "10年前阑尾切除,目前无腹痛。", vitals: {}, expect: { redFlag: false, m03: "limited", m04: "non_dose", notes: "既往手术史;目前无腹痛=无当前治疗目标" } },
  { id: "TR04", chief: "皮疹", hist: "5年前药物过敏,本次未接触,无皮疹急性发作。", vitals: {}, expect: { redFlag: false, m03: "limited", m04: "non_dose", notes: "既往过敏史;本次无急性发作=无当前治疗目标" } },
  { id: "TR05", chief: "失眠", hist: "未服用镇静药,无安眠药依赖。", vitals: {}, expect: { redFlag: false, notes: "未用药史" } },
  { id: "TR06", chief: "咳嗽", hist: "否认咯血、否认发热、否认盗汗。", vitals: {}, expect: { redFlag: false, notes: "三重否认" } },
  { id: "TR07", chief: "心悸", hist: "心电图正常,既往无心脏病。", vitals: { hr: "76" }, expect: { redFlag: false, notes: "客观检查正常" } },
  { id: "TR08", chief: "腹泻", hist: "无血便、无发热、无脱水。", vitals: {}, expect: { redFlag: false, notes: "腹泻但无红旗征" } },
  { id: "TR09", chief: "便秘", hist: "无便血、无体重下降、无呕吐。", vitals: {}, expect: { redFlag: false, notes: "便秘无红旗" } },
  { id: "TR10", chief: "乏力", hist: "无消瘦、无黄疸、无水肿。", vitals: {}, expect: { redFlag: false, notes: "乏力无红旗" } },

  // ============ ES: 就诊范围与时态(10 条 - encounter scope)============
  // ES01-ES02 恢复期仍有残余症状 → 当前存在活动性治疗目标,期望完整 M03 + 剂量链
  // ES03-ES04 慢性稳定疾病但本次明确要求治疗 → historical/stable 拦截块的假阳性守卫
  // ES05/ES06/ES07/ES10 常规复诊/续药/体检/咨询 → scope 驱动,保守定义 any(见文件末尾说明)
  // ES08-ES09 前后时态互相矛盾 → 保守:存在当前主诉,绝不得按 historical/stable 拦截
  { id: "ES01", cat: "es_recovery", chief: "肺炎恢复期,咳嗽少痰乏力1周", hist: "2周前肺炎住院治疗,已退热5天,复查胸片炎症吸收好转;现仍晨起咳嗽、少量白黏痰、乏力纳差,要求中药调理。舌淡红苔薄白,脉细弱。", vitals: { t: "36.8", hr: "78" }, expect: { redFlag: false, m03: "full", m04: "dose", notes: "恢复期残余症状=当前活动性治疗目标,不得按既往/稳定拦截" } },
  { id: "ES02", cat: "es_recovery", chief: "脑梗死恢复期3月,右侧肢体仍麻木", hist: "3月前患脑梗死,经治病情稳定;现遗留右侧肢体麻木、握力稍差,近1月无新发症状,本次要求中药康复治疗。舌暗苔薄白,脉细涩。", vitals: { bp: "135/85" }, expect: { redFlag: false, m03: "full", m04: "dose", notes: "恢复期残余症状,期望完整+剂量" } },
  { id: "ES03", cat: "es_stable_active", chief: "高血压控制稳定,仍头晕,要求中药治疗", hist: "高血压8年,规律服氨氯地平,血压控制在130/80mmHg左右;近2月晨起头晕头胀、项背强,本次明确要求加用中药。舌红苔薄黄,脉弦。", vitals: { bp: "132/82" }, expect: { redFlag: false, m03: "full", m04: "dose", notes: "假阳性守卫:稳定慢性病+明确治疗请求,historical_or_stable_only 不得拦截" } },
  { id: "ES04", cat: "es_stable_active", chief: "糖尿病血糖稳定,仍口干乏力,要求中药干预", hist: "2型糖尿病6年,二甲双胍治疗,空腹血糖6-7mmol/L;近半年口干多饮、疲乏,本次明确要求中药治疗。舌红少津少苔,脉细数。", vitals: {}, expect: { redFlag: false, m03: "full", m04: "dose", notes: "假阳性守卫:稳定+明确求治" } },
  { id: "ES05", cat: "es_followup", chief: "慢性胃炎复诊,要求继服上方", hist: "慢性非萎缩性胃炎3年;2周前就诊服香砂六君子汤14剂,胃胀减轻,今复诊要求续方。舌淡红苔薄白,脉细。", vitals: {}, expect: { redFlag: false, m03: "any", m04: "any", notes: "复诊续药:续方(完整+剂量)与要求补充评估(限定+非剂量)均属可接受 scope 判定,保守观察" } },
  { id: "ES06", cat: "es_followup", chief: "健康体检,无不适", hist: "单位年度体检,自测血压120/76mmHg,既往体健,无不适主诉,咨询中医体质调理。", vitals: { bp: "120/76", hr: "72" }, expect: { redFlag: false, m03: "any", m04: "any", notes: "体检咨询:scope 驱动,保守观察" } },
  { id: "ES07", cat: "es_followup", chief: "偶尔入睡困难,仅咨询是否需要治疗", hist: "近1月偶入睡慢,每周1-2次,白天精神可;明确表示暂不想服药,仅咨询。舌淡红苔薄白。", vitals: {}, expect: { redFlag: false, m03: "any", m04: "any", notes: "明确仅咨询不服药:非剂量合理;若按轻度不寐给出剂量级建议也记录观察" } },
  { id: "ES08", cat: "es_tense_conflict", chief: "头痛1周", hist: "患者诉头痛1周;家属补充其3年前头痛“已治愈”,本人又称头痛2年来反复发作从未完全缓解,前后时态矛盾;以本次1周新发加重为准。舌红苔薄黄,脉弦。", vitals: { bp: "125/80" }, expect: { redFlag: false, m03: "full", m04: "dose", notes: "时态矛盾→保守:存在当前主诉,绝不得按 historical/stable 拦截;矛盾只可影响置信度" } },
  { id: "ES09", cat: "es_tense_conflict", chief: "咳嗽5天", hist: "现病史一处记录“咳嗽5天”,另一处旧病程写“慢性咳嗽3年已愈半年”;本次确有5天新起咳嗽咳痰,时态记载互相矛盾。舌淡红苔薄白。", vitals: {}, expect: { redFlag: false, m03: "full", m04: "dose", notes: "时态矛盾→保守:不得 historical 拦截" } },
  { id: "ES10", cat: "es_followup", chief: "糖尿病常规复诊,无不适", hist: "2型糖尿病10年,规律用药,血糖稳定;本次常规复诊开化验单,无不适,暂未要求调整用药。", vitals: { bp: "128/80" }, expect: { redFlag: false, m03: "any", m04: "any", notes: "无明确治疗请求的常规复诊:非剂量合理,给出调理剂量亦属 scope 判定,保守观察" } },
];

// ============ M03/M04 期望结局标注(regress-real-100-evaluate 消费)============
// expect.m03: "full"     期望完整签名 M03(签名 reasoning-v2 且非签名有限结果)
//             "limited"  期望签名有限结果(primarySyndromeResolution=unresolved 且病机链为空)
//             "any"      scope/边界探针,两种结局均可接受,只记录观察、不计异常
// expect.m04: "dose"     期望真实剂量级候选方药
//             "non_dose" 期望确定性非剂量占位(<!-- CDSS_NON_DOSE_PRESCRIPTION -->)
//             "any"      两种结局均可接受
// 缺省(ordinary active 病例)按 full+dose;以下仅标注非缺省情形,既有用例的临床内容不改动。
// ES 用例已在行内字面标注,不在此重复。
const LIMITED_NON_DOSE_IDS = [
  // RF01-RF10 红旗急症:确定性安全门 fail-closed → 签名有限结果 + 非剂量
  "RF01", "RF02", "RF03", "RF04", "RF05", "RF06", "RF07", "RF08", "RF09", "RF10",
  // NG01/NG02/NG04 仅既往、已缓解或稳定背景就诊:独立语义预检一致后 → 限定 + 非剂量
  "NG01", "NG02", "NG04",
];
const ANY_OUTCOME_IDS = [
  // 无当前治疗目标的阴性对照(未接触无症状/常规产检/恢复期已无症状):scope 驱动,保守 any
  "NG03", "NG08", "NG09",
  // BO 全组为鲁棒性探针(空/超长/注入/特殊字符),设计意图是"不崩溃",不约定临床结局
  "BO01", "BO02", "BO03", "BO04", "BO05", "BO06", "BO07", "BO08", "BO09", "BO10",
  // 体检调理类咨询:scope 驱动;OK02(疲劳乏力1周)有当前症状,保持缺省 full+dose
  "OK01", "OK03", "OK04", "OK05", "OK06", "OK07", "OK08", "OK09", "OK10",
];
for (const testCase of REDFLAG_MATRIX_100) {
  const stamped = LIMITED_NON_DOSE_IDS.includes(testCase.id)
    ? { m03: "limited", m04: "non_dose" }
    : ANY_OUTCOME_IDS.includes(testCase.id)
      ? { m03: "any", m04: "any" }
      : { m03: "full", m04: "dose" };
  // 行内已字面标注的(ES 类)优先,缺省/类别标注只补空缺字段
  testCase.expect = { ...stamped, ...(testCase.expect || {}) };
}
