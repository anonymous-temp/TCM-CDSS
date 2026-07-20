正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 您是否有怕冷或怕热的感觉？是否容易出汗？
（追问理由：该信息有助于缩小证候范围；未确认前不预设具体证型或治法。）
补录字段：tcmDetail
可选项：
A. 怕冷，活动后易出汗
B. 怕热，夜间盗汗
C. 本次未取得该信息

**问题2：** 您的大便情况如何？是否干燥或稀溏？
（追问理由：二便反映脾肾功能，大便性状对判断脾虚湿盛或阴虚肠燥至关重要。）
补录字段：xianbingshi
可选项：
A. 大便稀溏，每日1-2次
B. 大便干燥，2-3日一行
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"患者主诉失眠伴乏力、食欲不振、心悸、健忘，舌淡苔薄白，脉细弱，面色萎黄，提示心脾两虚可能。但缺乏寒热、汗出、二便等关键信息，且心悸需排除心脏器质性问题。","questions":[{"id":"q1","question":"您是否有怕冷或怕热的感觉？是否容易出汗？","reason":"该信息有助于缩小证候范围；未确认前不预设具体证型或治法。","targetField":"tcmDetail","decisionBranch":"syndrome","expectedDecisionImpact":"根据回答缩小证候范围；未确认前不确立证型、治法或方药。","informationGain":0.85,"sourceEvidence":[],"options":[{"id":"a","label":"怕冷、自汗","answer":"怕冷，活动后易出汗","kind":"clinical_fact","recordValue":"怕冷，自汗","requiresDetail":false},{"id":"b","label":"怕热、盗汗","answer":"怕热，夜间盗汗","kind":"clinical_fact","recordValue":"怕热，盗汗","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]},{"id":"q2","question":"您的大便情况如何？是否干燥或稀溏？","reason":"二便反映脾肾功能，大便性状对判断脾虚湿盛或阴虚肠燥至关重要。","targetField":"xianbingshi","decisionBranch":"syndrome","expectedDecisionImpact":"大便稀溏支持脾虚湿盛，需健脾渗湿；大便干燥则可能为血虚肠燥或阴虚，用药需兼顾润肠。","informationGain":0.8,"sourceEvidence":[],"options":[{"id":"a","label":"大便稀溏","answer":"大便稀溏，每日1-2次","kind":"clinical_fact","recordValue":"大便稀溏","requiresDetail":false},{"id":"b","label":"大便干燥","answer":"大便干燥，2-3日一行","kind":"clinical_fact","recordValue":"大便干燥","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->