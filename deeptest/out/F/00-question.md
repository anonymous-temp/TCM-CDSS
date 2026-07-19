**问题1：** 患者目前是否已停用阿司匹林？
（追问理由：阿司匹林是否停用直接影响出血风险和用药方案，是立即止血和抗血小板管理的安全边界）
补录字段：medicationHistory
可选项：
A. 已停用阿司匹林
B. 仍每日服用阿司匹林100mg
C. 本次未取得该信息

**问题2：** 患者有无发生过晕厥或短暂意识丧失？
（追问理由：晕厥提示失血性休克或低血容量，决定是否紧急扩容、输血及评估紧急内镜介入时机）
补录字段：xianbingshi
可选项：
A. 有晕厥发作
B. 无晕厥或意识不清，仅有头晕
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.7,"managementImpact":0.9,"answerability":0.8},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"目前黑便、头晕乏力、生命体征不稳定，需明确阿司匹林用药状态和有无晕厥，以决定是否紧急逆转抗血小板、扩容输血及内镜时机。","questions":[{"id":"q1","question":"患者目前是否已停用阿司匹林？","reason":"阿司匹林是否停用直接影响出血风险和用药方案，是立即止血和抗血小板管理的安全边界","targetField":"medicationHistory","decisionBranch":"treatment_safety","expectedDecisionImpact":"若已停用，可常规止血、评估内镜时机；若仍服用，需考虑停用或血小板输注，并调整抗凝方案。","informationGain":0.85,"sourceEvidence":["长期口服阿司匹林"],"options":[{"id":"a","label":"已停用","answer":"已停用阿司匹林","kind":"clinical_fact","recordValue":"已停用阿司匹林"},{"id":"b","label":"仍服用","answer":"仍每日服用阿司匹林100mg","kind":"clinical_fact","recordValue":"仍每日服用阿司匹林100mg"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]},{"id":"q2","question":"患者有无发生过晕厥或短暂意识丧失？","reason":"晕厥提示失血性休克或低血容量，决定是否紧急扩容、输血及评估紧急内镜介入时机","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若有晕厥，需优先建立静脉通路、查血型交叉配血、考虑紧急输血和急诊内镜；若无，可继续稳定循环、动态观察。","informationGain":0.82,"sourceEvidence":["黑便3天，伴头晕乏力1天"],"options":[{"id":"a","label":"有晕厥","answer":"有晕厥发作","kind":"clinical_fact","recordValue":"有晕厥发作"},{"id":"b","label":"无晕厥","answer":"无晕厥或意识不清，仅有头晕","kind":"clinical_fact","recordValue":"无晕厥或意识不清，仅有头晕"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]}]}}
<!-- DIAGNOSIS_JSON_END --><<<CDSS_STREAM_FINAL>>>**问题1：** 患者目前是否已停用阿司匹林？
（追问理由：阿司匹林是否停用直接影响出血风险和用药方案，是立即止血和抗血小板管理的安全边界）
补录字段：medicationHistory
可选项：
A. 已停用阿司匹林
B. 仍每日服用阿司匹林100mg
C. 本次未取得该信息

**问题2：** 患者有无发生过晕厥或短暂意识丧失？
（追问理由：晕厥提示失血性休克或低血容量，决定是否紧急扩容、输血及评估紧急内镜介入时机）
补录字段：xianbingshi
可选项：
A. 有晕厥发作
B. 无晕厥或意识不清，仅有头晕
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.7,"managementImpact":0.9,"answerability":0.8},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"目前黑便、头晕乏力、生命体征不稳定，需明确阿司匹林用药状态和有无晕厥，以决定是否紧急逆转抗血小板、扩容输血及内镜时机。","questions":[{"id":"q1","question":"患者目前是否已停用阿司匹林？","reason":"阿司匹林是否停用直接影响出血风险和用药方案，是立即止血和抗血小板管理的安全边界","targetField":"medicationHistory","decisionBranch":"treatment_safety","expectedDecisionImpact":"若已停用，可常规止血、评估内镜时机；若仍服用，需考虑停用或血小板输注，并调整抗凝方案。","informationGain":0.85,"sourceEvidence":["长期口服阿司匹林"],"options":[{"id":"a","label":"已停用","answer":"已停用阿司匹林","kind":"clinical_fact","recordValue":"已停用阿司匹林","requiresDetail":false},{"id":"b","label":"仍服用","answer":"仍每日服用阿司匹林100mg","kind":"clinical_fact","recordValue":"仍每日服用阿司匹林100mg","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]},{"id":"q2","question":"患者有无发生过晕厥或短暂意识丧失？","reason":"晕厥提示失血性休克或低血容量，决定是否紧急扩容、输血及评估紧急内镜介入时机","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若有晕厥，需优先建立静脉通路、查血型交叉配血、考虑紧急输血和急诊内镜；若无，可继续稳定循环、动态观察。","informationGain":0.82,"sourceEvidence":["黑便3天，伴头晕乏力1天"],"options":[{"id":"a","label":"有晕厥","answer":"有晕厥发作","kind":"clinical_fact","recordValue":"有晕厥发作","requiresDetail":false},{"id":"b","label":"无晕厥","answer":"无晕厥或意识不清，仅有头晕","kind":"clinical_fact","recordValue":"无晕厥或意识不清，仅有头晕","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->