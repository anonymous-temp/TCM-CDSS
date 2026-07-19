正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 您是否有呕血或呕吐咖啡色样物？
（追问理由：区分上消化道出血是否活动及出血量，直接影响是否需紧急内镜或输血。）
补录字段：xianbingshi
可选项：
A. 患者有呕血或呕吐咖啡色样物
B. 患者无呕血或呕吐咖啡色样物
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"语义复核已移除病历已回答、重复或不满足单选互斥要求的候选问题。","questions":[{"id":"q1","question":"您是否有呕血或呕吐咖啡色样物？","reason":"区分上消化道出血是否活动及出血量，直接影响是否需紧急内镜或输血。","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若有呕血，提示活动性出血，需紧急内镜或输血；若无，可先药物保守治疗。","informationGain":0.85,"sourceEvidence":["黑便3天，伴头晕乏力1天"],"options":[{"id":"a","label":"有呕血","answer":"患者有呕血或呕吐咖啡色样物","kind":"clinical_fact","recordValue":"有呕血或呕吐咖啡色样物","requiresDetail":false},{"id":"b","label":"无呕血","answer":"患者无呕血或呕吐咖啡色样物","kind":"clinical_fact","recordValue":"无呕血或呕吐咖啡色样物","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->