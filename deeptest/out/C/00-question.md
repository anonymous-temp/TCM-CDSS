**问题1：** 近1周是否出现发热（体温升高）、恶寒、痰色变黄或脓痰？
（追问理由：明确有无感染性加重，决定是否使用抗生素及辨证寒热转化方向，直接影响方药选择。）
补录字段：问诊补充
可选项：
A. 存在上述任一情况（发热、恶寒、痰色变黄或脓痰），请补充具体表现
B. 无发热、无恶寒，痰色仍白
C. 本次未取得该信息

**问题2：** 近1周有无下肢水肿、夜间阵发性呼吸困难或心悸？
（追问理由：鉴别慢阻肺急性加重是否合并心力衰竭，影响是否加用利尿剂/强心药及温阳利水治法。）
补录字段：问诊补充
可选项：
A. 存在上述任一情况（下肢水肿、夜间阵发性呼吸困难、心悸），请补充具体表现
B. 无上述任何表现
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"当前主诉加重伴痰多1周，畏寒背冷，但未明确有无感染性发热及是否合并心衰，这两项信息将直接改变抗生素使用、利尿剂选择和方剂方向。","questions":[{"id":"q1","question":"近1周是否出现发热（体温升高）、恶寒、痰色变黄或脓痰？","reason":"明确有无感染性加重，决定是否使用抗生素及辨证寒热转化方向。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"如有发热/黄痰→考虑痰热壅肺或外寒内饮化热，需加清热解毒药或改用清法；如无→维持外寒内饮辨证，以温化为主。","informationGain":0.85,"sourceEvidence":["反复咳痰喘10年，加重伴痰多1周","白痰量多、清稀","畏寒（背冷）"],"options":[{"id":"a","label":"存在异常","answer":"存在上述任一情况（发热、恶寒、痰色变黄或脓痰），请补充具体表现","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"无异常","answer":"无发热、无恶寒，痰色仍白","kind":"clinical_fact","recordValue":"无发热，无恶寒，痰色白"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]},{"id":"q2","question":"近1周有无下肢水肿、夜间阵发性呼吸困难或心悸？","reason":"鉴别慢阻肺急性加重是否合并心力衰竭，影响是否加用利尿剂/强心药及温阳利水治法。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"如有下肢水肿或夜间呼吸困难→提示肺心病/右心衰，需加用苓桂术甘汤或真武汤，并考虑利尿剂；如无→维持原心脏功能评估，侧重肺系治疗。","informationGain":0.8,"sourceEvidence":["慢性阻塞性肺疾病","活动后气促（redFlag SemanticFact urgency=urgent）"],"options":[{"id":"a","label":"存在异常","answer":"存在上述任一情况（下肢水肿、夜间阵发性呼吸困难、心悸），请补充具体表现","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"无异常","answer":"无上述任何表现","kind":"clinical_fact","recordValue":"无下肢水肿，无夜间阵发性呼吸困难，无心悸"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]}]}}
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