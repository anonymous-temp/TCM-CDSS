**问题1：** 您头晕发作时是否伴有恶心呕吐、肢体麻木或言语不清？
（追问理由：明确有无脑血管意外或高血压急症表现，决定是否需紧急处理）
补录字段：现病史
可选项：
A. 存在上述任一情况，请补充具体表现
B. 无上述情况
C. 本次未取得该信息

**问题2：** 您平时怕热、容易出汗，还是怕冷？
（追问理由：辅助鉴别肝阳上亢（怕热）或阳虚/寒证（怕冷），影响辨证和方药方向）
补录字段：问诊补充
可选项：
A. 怕热、易出汗
B. 怕冷、无汗或不易出汗
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.55,"managementImpact":0.8,"answerability":0.7},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"血压168/102mmHg属高危，但非急诊；需排除脑血管意外及高血压急症体征，并确认寒热以精确辨证。","questions":[{"id":"q1","question":"您头晕发作时是否伴有恶心呕吐、肢体麻木或言语不清？","reason":"明确有无脑血管意外或高血压急症表现，决定是否需紧急处理","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若有上述症状，需立即转诊或急诊检查；若无，可继续常规诊疗流程并重点关注血压控制","informationGain":0.85,"sourceEvidence":["血压168/102mmHg（redFlagSemanticFacts：vital_instability/urgent）","主诉：反复头晕、头胀3年，加重伴视物模糊1周"],"options":[{"id":"a","label":"存在异常","answer":"存在上述任一情况，请补充具体表现","kind":"clinical_fact","requiresDetail":true,"recordValue":""},{"id":"b","label":"无上述症状","answer":"无恶心呕吐、肢体麻木或言语不清","kind":"clinical_fact","recordValue":"无恶心呕吐、肢体麻木或言语不清"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]},{"id":"q2","question":"您平时怕热、容易出汗，还是怕冷？","reason":"确认寒热性质，辅助辨别肝阳上亢（多怕热）或阳虚/寒证（怕冷），影响方药选择","targetField":"tcmDetail","decisionBranch":"syndrome","expectedDecisionImpact":"若怕热易出汗，支持肝阳上亢，可选用天麻钩藤饮；若怕冷无汗，则需考虑潜阳或温补，方药方向改变","informationGain":0.7,"sourceEvidence":["舌暗红苔薄黄","脉弦","主诉头晕头胀"],"options":[{"id":"a","label":"怕热易出汗","answer":"怕热、易出汗","kind":"clinical_fact","recordValue":"怕热、易出汗"},{"id":"b","label":"怕冷不易汗","answer":"怕冷、无汗或不易出汗","kind":"clinical_fact","recordValue":"怕冷、无汗或不易出汗"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]}]}}
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