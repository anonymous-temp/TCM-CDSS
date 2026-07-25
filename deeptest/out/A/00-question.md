正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 睡眠时是否有大声打鼾、被目击呼吸暂停，或近期使用安眠药、酒精助眠？
（追问理由：睡眠呼吸线索和助眠物质会改变鉴别诊断及用药安全边界。）
补录字段：xianbingshi
可选项：
A. 存在打鼾呼吸暂停或助眠药物酒精使用，请补充具体情况
B. 经询问均无上述表现和使用情况
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.6,"infoGain":0.6,"managementImpact":0.6,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"确定性复核已移除病历已回答或不满足单选互斥要求的候选问题。","questions":[{"id":"q2","question":"睡眠时是否有大声打鼾、被目击呼吸暂停，或近期使用安眠药、酒精助眠？","reason":"睡眠呼吸线索和助眠物质会改变鉴别诊断及用药安全边界。","targetField":"xianbingshi","decisionBranch":"treatment_safety","expectedDecisionImpact":"睡眠呼吸线索和助眠物质会改变鉴别诊断及用药安全边界。","informationGain":0.7,"sourceEvidence":[],"options":[{"id":"a","label":"存在打鼾呼吸暂停或助眠药物酒精使用，请补充具体情况","answer":"存在打鼾呼吸暂停或助眠药物酒精使用，请补充具体情况","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"经询问均无上述表现和使用情况","answer":"经询问均无上述表现和使用情况","kind":"clinical_fact","recordValue":"经询问均无上述表现和使用情况","requiresDetail":false},{"id":"unknown","label":"本次未取得该信息","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->