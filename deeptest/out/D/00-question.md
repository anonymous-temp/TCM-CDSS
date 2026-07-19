**问题1：** 您最近半年有没有怕冷或怕热的感觉？有没有出现一阵冷一阵热、交替发作的情况？
（追问理由：需明确是否存在寒热往来或明显的恶寒发热，区分病位在少阳还是阳明，直接影响小柴胡汤类方与清湿热方剂的选用。）
补录字段：问诊补充
可选项：
A. 存在上述任一情况，请补充具体表现
B. 既无怕冷也无怕热，无寒热往来
C. 本次未取得该信息

**问题2：** 您的月经情况如何？周期、经量、经色、有无血块、经前或经期腹痛？
（追问理由：患者38岁、带下色黄量多，提示下焦湿热，月经异常与否影响是否需兼顾调经及活血药的使用，改变处方安全边界。）
补录字段：问诊补充
可选项：
A. 存在异常，请补充具体表现
B. 月经正常（周期规律、经量适中、色红无血块、无痛经）
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.6,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"寒热和月经信息对证型判别及用药安全有明确影响，且当前病历完全缺失。","questions":[{"id":"q1","question":"您最近半年有没有怕冷或怕热的感觉？有没有出现一阵冷一阵热、交替发作的情况？","reason":"明确有无少阳病寒热往来或阳明热证，直接决定和解少阳或清利湿热的处方方向。","targetField":"tcmDetail","decisionBranch":"syndrome","expectedDecisionImpact":"若存在寒热往来，优先考虑少阳病合并湿热；若无，则侧重阳明湿热或脾胃湿热，方药从柴胡类转向平胃散、甘露消毒丹等。","informationGain":0.85,"sourceEvidence":["舌淡红苔黄腻","脉弦滑","口苦","情绪低落"],"options":[{"id":"a","label":"存在寒热异常","answer":"存在上述任一情况，请补充具体表现","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"无寒热异常","answer":"既无怕冷也无怕热，无寒热往来","kind":"clinical_fact","recordValue":"无怕冷怕热，无寒热往来"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]},{"id":"q2","question":"您的月经情况如何？周期、经量、经色、有无血块、经前或经期腹痛？","reason":"下焦湿热（带下色黄）是否影响月经，决定是否需加调经、化瘀药物，以及用药禁忌（如活血药在经期调整）。","targetField":"tcmDetail","decisionBranch":"treatment_safety","expectedDecisionImpact":"若月经异常，需兼顾清热利湿调经，避免使用烈性活血药；若正常，则专注清利湿热，处方安全范围更宽。","informationGain":0.80,"sourceEvidence":["带下量偏多色黄","情绪低落"],"options":[{"id":"a","label":"月经异常","answer":"存在异常，请补充具体表现","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"月经正常","answer":"月经正常（周期规律、经量适中、色红无血块、无痛经）","kind":"clinical_fact","recordValue":"月经正常，周期规律，经量适中，色红无血块，无痛经"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]}]}}
<!-- DIAGNOSIS_JSON_END --><<<CDSS_STREAM_FINAL>>>**问题1：** 与刚出现时相比，目前主要不适总体在加重、缓解，还是反复波动？
（追问理由：症状变化趋势会改变当前处置优先级和首要鉴别方向。）
补录字段：xianbingshi
可选项：
A. 近期明显加重或出现新表现
B. 目前总体稳定、反复波动或有所缓解
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.6,"infoGain":0.4,"managementImpact":0.4,"answerability":0.4},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"模型结构化追问计划不可用，改为核实最可能改变下一步判断的症状变化趋势。","questions":[{"id":"q1","question":"与刚出现时相比，目前主要不适总体在加重、缓解，还是反复波动？","reason":"症状变化趋势会改变当前处置优先级和首要鉴别方向。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"帮助区分进展性问题与稳定或改善中的常见问题。","informationGain":0.7,"sourceEvidence":[],"options":[{"id":"worse","label":"近期明显加重","answer":"近期明显加重或出现新表现","kind":"clinical_fact","requiresDetail":true},{"id":"stable","label":"稳定或缓解","answer":"目前总体稳定、反复波动或有所缓解","kind":"clinical_fact","recordValue":"目前总体稳定、反复波动或有所缓解","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->