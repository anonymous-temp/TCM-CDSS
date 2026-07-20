正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 头晕发作时是否伴有恶心呕吐、肢体麻木无力或言语不利？
（追问理由：该信息有助于区分不同可能原因并确定下一步检查方向；未确认前保持未知。）
补录字段：xianbingshi
可选项：
A. 头晕时伴有恶心呕吐、肢体麻木无力或言语不利
B. 头晕时无恶心呕吐、肢体麻木无力或言语不利
C. 本次未取得该信息

**问题2：** 近1周是否因视物模糊就诊眼科或测过眼压？
（追问理由：排除青光眼等眼科急症，避免延误治疗。）
补录字段：xianbingshi
可选项：
A. 近1周因视物模糊就诊眼科，测眼压结果异常
B. 近1周未因视物模糊就诊眼科，未测眼压
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"患者血压168/102mmHg，伴视物模糊加重1周，需排除高血压急症；同时需明确头晕性质以鉴别中风或眩晕。","questions":[{"id":"q1","question":"头晕发作时是否伴有恶心呕吐、肢体麻木无力或言语不利？","reason":"该信息有助于区分不同可能原因并确定下一步检查方向；未确认前保持未知。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"根据回答调整鉴别方向和检查顺序；未确认前不排除或确立具体诊断。","informationGain":0.85,"sourceEvidence":["反复头晕、头胀3年，加重伴视物模糊1周","168/102mmHg"],"options":[{"id":"a","label":"有上述任一症状","answer":"头晕时伴有恶心呕吐、肢体麻木无力或言语不利","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"无上述症状","answer":"头晕时无恶心呕吐、肢体麻木无力或言语不利","kind":"clinical_fact","recordValue":"头晕时无恶心呕吐、肢体麻木无力或言语不利","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]},{"id":"q2","question":"近1周是否因视物模糊就诊眼科或测过眼压？","reason":"排除青光眼等眼科急症，避免延误治疗。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"若A则需眼科会诊；若B则继续按高血压处理。","informationGain":0.75,"sourceEvidence":["加重伴视物模糊1周"],"options":[{"id":"a","label":"已就诊或测过眼压","answer":"近1周因视物模糊就诊眼科，测眼压结果异常","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"未就诊","answer":"近1周未因视物模糊就诊眼科，未测眼压","kind":"clinical_fact","recordValue":"近1周未因视物模糊就诊眼科，未测眼压","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->