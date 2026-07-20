正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 目前是否静息也喘、不能平卧、说话受限、口唇发紫或呼吸迅速加重？
（追问理由：该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。）
补录字段：xianbingshi
可选项：
A. 存在上述任一情况，请补充具体表现
B. 经询问未见上述呼吸困难或缺氧表现
C. 本次未能确认，请继续现场评估

**问题2：** 患者咳出的白痰是否容易咳出？
（追问理由：痰的易咳出程度反映痰的黏稠度与病邪性质，寒饮痰多清稀易咳，若黏稠难咳则可能兼有热象或燥邪，影响温化与清润的治法选择。）
补录字段：xianbingshi
可选项：
A. 痰易咳出
B. 请补充痰的黏稠度及颜色
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"患者慢阻肺急性加重，痰多清稀，舌淡胖苔白滑，脉弦滑，辨证倾向寒饮伏肺。但需明确痰的性状（是否易咳出）及有无发热，以区分寒饮与痰热，并评估感染风险，影响抗生素使用及温化寒痰或清热化痰的方药选择。","questions":[{"id":"q1","question":"目前是否静息也喘、不能平卧、说话受限、口唇发紫或呼吸迅速加重？","reason":"该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"该已识别线索可能改变即时处置路径，需要先由医生核实当前状态。","informationGain":0.7,"sourceEvidence":[],"options":[{"id":"a","label":"存在上述任一情况，请补充具体表现","answer":"存在上述任一情况，请补充具体表现","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"经询问未见上述呼吸困难或缺氧表现","answer":"经询问未见上述呼吸困难或缺氧表现","kind":"clinical_fact","recordValue":"经询问未见上述呼吸困难或缺氧表现","requiresDetail":false},{"id":"unknown","label":"本次未能确认，请继续现场评估","answer":"本次未能确认，请继续现场评估","kind":"unknown","requiresDetail":false}]},{"id":"q1","question":"患者咳出的白痰是否容易咳出？","reason":"痰的易咳出程度反映痰的黏稠度与病邪性质，寒饮痰多清稀易咳，若黏稠难咳则可能兼有热象或燥邪，影响温化与清润的治法选择。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"若易咳出，支持寒饮伏肺，治以温化；若难咳出，提示痰热或燥痰，需考虑清热化痰或润燥化痰，影响方药如小青龙汤与清金化痰汤的鉴别。","informationGain":0.85,"sourceEvidence":["白痰量多、清稀"],"options":[{"id":"a","label":"易咳出","answer":"痰易咳出","kind":"clinical_fact","recordValue":"痰易咳出","requiresDetail":false},{"id":"b","label":"难咳出","answer":"请补充痰的黏稠度及颜色","kind":"clinical_fact","requiresDetail":true},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->