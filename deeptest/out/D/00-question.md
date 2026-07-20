正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 胆囊息肉的诊断时间？是否已行手术或药物治疗？
（追问理由：明确胆囊息肉的处置状态，判断当前消化道症状是否与胆囊疾病相关，影响治疗方向（如是否需转外科或加用利胆药）。）
补录字段：jiwangshi
可选项：
A. 胆囊息肉已行胆囊切除术
B. 胆囊息肉未手术，曾用药物（请补充具体药物）
C. 本次未取得该信息

**问题2：** 大便不调时，是否伴有黏液、脓血或里急后重？
（追问理由：该信息有助于区分不同可能原因并确定下一步检查方向；未确认前保持未知。）
补录字段：xianbingshi
可选项：
A. 大便不调伴有黏液脓血
B. 大便不调无黏液脓血
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"患者脘腹胀满、大便不调半年，舌苔黄腻，脉弦滑，提示湿热内蕴。但胆囊息肉病史需明确是否已手术或药物治疗，以评估当前症状是否与胆囊相关；同时需澄清大便不调的具体表现（如是否伴有黏液脓血），以鉴别肠易激综合征与器质性肠病。","questions":[{"id":"q1","question":"胆囊息肉的诊断时间？是否已行手术或药物治疗？","reason":"明确胆囊息肉的处置状态，判断当前消化道症状是否与胆囊疾病相关，影响治疗方向（如是否需转外科或加用利胆药）。","targetField":"jiwangshi","decisionBranch":"differential","expectedDecisionImpact":"若已手术，则排除胆囊因素；若未手术且息肉较大，需考虑胆囊炎可能，治疗需兼顾肝胆湿热。","informationGain":0.85,"sourceEvidence":["胆囊息肉"],"options":[{"id":"a","label":"已手术","answer":"胆囊息肉已行胆囊切除术","kind":"clinical_fact","recordValue":"胆囊息肉已行胆囊切除术","requiresDetail":false},{"id":"b","label":"未手术，有用药","answer":"胆囊息肉未手术，曾用药物（请补充具体药物）","kind":"clinical_fact","requiresDetail":true},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]},{"id":"q2","question":"大便不调时，是否伴有黏液、脓血或里急后重？","reason":"该信息有助于区分不同可能原因并确定下一步检查方向；未确认前保持未知。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"根据回答调整鉴别方向和检查顺序；未确认前不排除或确立具体诊断。","informationGain":0.8,"sourceEvidence":["大便不调","时干时稀"],"options":[{"id":"a","label":"有黏液脓血","answer":"大便不调伴有黏液脓血","kind":"clinical_fact","recordValue":"大便不调伴有黏液脓血","requiresDetail":false},{"id":"b","label":"无黏液脓血","answer":"大便不调无黏液脓血","kind":"clinical_fact","recordValue":"大便不调无黏液脓血","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->