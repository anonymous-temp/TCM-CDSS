正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 您是否有呕血或呕吐咖啡色样物？
（追问理由：区分上消化道出血是否活动及出血量，直接影响是否需紧急内镜或输血。）
补录字段：xianbingshi
可选项：
A. 患者无呕血或呕吐咖啡色样物
B. 请补充呕血次数、量及颜色
C. 本次未取得该信息

**问题2：** 您黑便前是否有进食动物血、铁剂或铋剂？
（追问理由：该信息有助于区分不同可能原因并确定下一步检查方向；未确认前保持未知。）
补录字段：xianbingshi
可选项：
A. 黑便前无进食动物血、铁剂或铋剂
B. 请补充具体种类及时间
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"患者黑便、头晕乏力，血压偏低、心率偏快，提示急性上消化道出血可能，需明确出血是否活动及有无呕血，以决定紧急处置方案。","questions":[{"id":"q1","question":"您是否有呕血或呕吐咖啡色样物？","reason":"区分上消化道出血是否活动及出血量，直接影响是否需紧急内镜或输血。","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若有呕血，提示活动性出血，需紧急内镜干预；若无，可先药物保守治疗。","informationGain":0.85,"sourceEvidence":["黑便3天，伴头晕乏力1天"],"options":[{"id":"a","label":"无呕血","answer":"患者无呕血或呕吐咖啡色样物","kind":"clinical_fact","recordValue":"无呕血","requiresDetail":false},{"id":"b","label":"有呕血","answer":"请补充呕血次数、量及颜色","kind":"clinical_fact","requiresDetail":true},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]},{"id":"q2","question":"您黑便前是否有进食动物血、铁剂或铋剂？","reason":"该信息有助于区分不同可能原因并确定下一步检查方向；未确认前保持未知。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"根据回答调整鉴别方向和检查顺序；未确认前不排除或确立具体诊断。","informationGain":0.7,"sourceEvidence":["黑便3天"],"options":[{"id":"a","label":"无相关饮食或药物","answer":"黑便前无进食动物血、铁剂或铋剂","kind":"clinical_fact","recordValue":"无相关饮食或药物史","requiresDetail":false},{"id":"b","label":"有相关饮食或药物","answer":"请补充具体种类及时间","kind":"clinical_fact","requiresDetail":true},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->