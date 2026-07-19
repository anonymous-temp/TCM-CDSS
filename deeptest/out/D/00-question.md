正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 患者是否有怕冷或怕热的感觉？是否容易出汗？
（追问理由：该信息有助于缩小证候范围；未确认前不预设具体证型或治法。）
补录字段：tcmDetail
可选项：
A. 患者怕冷，无汗或汗少
B. 患者怕热，多汗
C. 本次未取得该信息

**问题2：** 患者饮食情况如何？是否有食欲不振、喜冷饮或喜热饮？
（追问理由：饮食偏好和食欲反映脾胃功能及寒热倾向，对判断湿热、食积或虚寒有重要价值。）
补录字段：xianbingshi
可选项：
A. 食欲不振，喜热饮
B. 食欲可，喜冷饮
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"主诉脘腹胀满、大便不调半年，舌苔黄腻，脉弦滑，提示湿热或肝郁化热可能。但缺乏寒热、汗出、饮食等关键信息，影响证候判断和方药选择。","questions":[{"id":"q1","question":"患者是否有怕冷或怕热的感觉？是否容易出汗？","reason":"该信息有助于缩小证候范围；未确认前不预设具体证型或治法。","targetField":"tcmDetail","decisionBranch":"syndrome","expectedDecisionImpact":"根据回答缩小证候范围；未确认前不确立证型、治法或方药。","informationGain":0.85,"sourceEvidence":[],"options":[{"id":"a","label":"怕冷，无汗或汗少","answer":"患者怕冷，无汗或汗少","kind":"clinical_fact","recordValue":"怕冷，无汗或汗少","requiresDetail":false},{"id":"b","label":"怕热，多汗","answer":"患者怕热，多汗","kind":"clinical_fact","recordValue":"怕热，多汗","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]},{"id":"q2","question":"患者饮食情况如何？是否有食欲不振、喜冷饮或喜热饮？","reason":"饮食偏好和食欲反映脾胃功能及寒热倾向，对判断湿热、食积或虚寒有重要价值。","targetField":"xianbingshi","decisionBranch":"syndrome","expectedDecisionImpact":"若食欲不振、喜热饮，提示脾胃虚寒；若食欲可、喜冷饮，提示胃热或湿热。","informationGain":0.8,"sourceEvidence":[],"options":[{"id":"a","label":"食欲不振，喜热饮","answer":"食欲不振，喜热饮","kind":"clinical_fact","recordValue":"食欲不振，喜热饮","requiresDetail":false},{"id":"b","label":"食欲可，喜冷饮","answer":"食欲可，喜冷饮","kind":"clinical_fact","recordValue":"食欲可，喜冷饮","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->