正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>⚠️ 本轮追问已降级：模型问题计划未通过结构校验，以下为通用安全追问；医生可直接补充更相关的患者事实后继续。

**问题1：** 妊娠期或可能妊娠时，是否出现一侧剧烈腹痛、大量阴道流血、晕厥、抽搐或胎动异常？
（追问理由：该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。）
补录字段：xianbingshi
可选项：
A. 存在上述任一情况，请补充具体表现
B. 经询问未见上述妊娠相关急症表现
C. 本次未能确认，请继续现场评估

**问题2：** 与刚出现时相比，目前主要不适总体在加重、缓解，还是反复波动？
（追问理由：症状变化趋势会改变当前处置优先级和首要鉴别方向。）
补录字段：xianbingshi
可选项：
A. 近期明显加重或出现新表现
B. 目前总体稳定、反复波动或有所缓解
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.6,"infoGain":0.4,"managementImpact":0.4,"answerability":0.4},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"模型结构化追问计划不可用，改为核实最可能改变下一步判断的症状变化趋势。","questions":[{"id":"q1","question":"妊娠期或可能妊娠时，是否出现一侧剧烈腹痛、大量阴道流血、晕厥、抽搐或胎动异常？","reason":"该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。","targetField":"xianbingshi","decisionBranch":"treatment_safety","expectedDecisionImpact":"该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。","informationGain":0.7,"sourceEvidence":[],"options":[{"id":"a","label":"存在上述任一情况，请补充具体表现","answer":"存在上述任一情况，请补充具体表现","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"经询问未见上述妊娠相关急症表现","answer":"经询问未见上述妊娠相关急症表现","kind":"clinical_fact","recordValue":"经询问未见上述妊娠相关急症表现","requiresDetail":false},{"id":"unknown","label":"本次未能确认，请继续现场评估","answer":"本次未能确认，请继续现场评估","kind":"unknown","requiresDetail":false}]},{"id":"q1","question":"与刚出现时相比，目前主要不适总体在加重、缓解，还是反复波动？","reason":"症状变化趋势会改变当前处置优先级和首要鉴别方向。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"帮助区分进展性问题与稳定或改善中的常见问题。","informationGain":0.7,"sourceEvidence":[],"options":[{"id":"worse","label":"近期明显加重","answer":"近期明显加重或出现新表现","kind":"clinical_fact","requiresDetail":true},{"id":"stable","label":"稳定或缓解","answer":"目前总体稳定、反复波动或有所缓解","kind":"clinical_fact","recordValue":"目前总体稳定、反复波动或有所缓解","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->