正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 目前是否静息也喘、不能平卧、说话受限、口唇发紫或呼吸迅速加重？
（追问理由：该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。）
补录字段：xianbingshi
可选项：
A. 存在上述任一情况，请补充具体表现
B. 经询问未见上述呼吸困难或缺氧表现
C. 本次未能确认，请继续现场评估

**问题2：** 您活动后气促到什么程度？比如平地走路会喘吗？还是休息时也喘？
（追问理由：明确呼吸困难分级，判断是否需要紧急处理或住院。）
补录字段：xianbingshi
可选项：
A. 静息时呼吸困难
B. 仅活动后气促，平地走路无喘
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"患者慢阻肺急性加重，活动后气促（红旗），需明确呼吸困难程度及痰色以评估感染和处置紧迫性。","questions":[{"id":"q1","question":"目前是否静息也喘、不能平卧、说话受限、口唇发紫或呼吸迅速加重？","reason":"该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。","informationGain":0.7,"sourceEvidence":[],"options":[{"id":"a","label":"存在上述任一情况，请补充具体表现","answer":"存在上述任一情况，请补充具体表现","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"经询问未见上述呼吸困难或缺氧表现","answer":"经询问未见上述呼吸困难或缺氧表现","kind":"clinical_fact","recordValue":"经询问未见上述呼吸困难或缺氧表现","requiresDetail":false},{"id":"unknown","label":"本次未能确认，请继续现场评估","answer":"本次未能确认，请继续现场评估","kind":"unknown","requiresDetail":false}]},{"id":"q1","question":"您活动后气促到什么程度？比如平地走路会喘吗？还是休息时也喘？","reason":"明确呼吸困难分级，判断是否需要紧急处理或住院。","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若休息时也喘（静息呼吸困难），需紧急评估；若仅活动后气促，可继续门诊治疗。","informationGain":0.85,"sourceEvidence":["活动后气促"],"options":[{"id":"a","label":"静息时也喘","answer":"静息时呼吸困难","kind":"clinical_fact","recordValue":"静息时呼吸困难","requiresDetail":false},{"id":"b","label":"仅活动后喘","answer":"仅活动后气促，平地走路无喘","kind":"clinical_fact","recordValue":"仅活动后气促","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->