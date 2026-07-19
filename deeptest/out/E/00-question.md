**问题1：** 您每天大约呕吐几次？最近一周是否完全无法进食或饮水？
（追问理由：明确呕吐严重程度，判断属于普通妊娠恶阻还是妊娠剧吐，决定是否需要紧急补液或住院处置。）
补录字段：现病史
可选项：
A. 每日呕吐≥3次，完全不能进食水，或伴有体重明显下降
B. 每日呕吐≤2次，尚能少量进食水，体重无明显变化
C. 本次未取得该信息

**问题2：** 最近有没有出现腹痛或阴道出血？
（追问理由：鉴别是否存在先兆流产、异位妊娠等产科急症，直接影响接诊路径和用药安全。）
补录字段：现病史
可选项：
A. 存在上述任一情况，请补充具体表现
B. 无腹痛，无阴道出血
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.8,"managementImpact":0.9,"answerability":0.7},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"呕吐严重程度和有无腹痛/出血是决定处置方向和安全边界的关键未决信息，且红旗提示urgent需优先澄清。","questions":[{"id":"q1","question":"您每天大约呕吐几次？最近一周是否完全无法进食或饮水？","reason":"区分妊娠恶阻与妊娠剧吐，决定是否需紧急补液住院。","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若严重呕吐则需产科急诊及补液治疗，轻度则按常规恶阻处理。","informationGain":0.85,"sourceEvidence":["病历：妊娠8周，恶心呕吐、纳差1周；呕吐胃内容物"],"options":[{"id":"a","label":"频繁呕吐","answer":"每日呕吐≥3次，完全不能进食水，或伴有体重明显下降","kind":"clinical_fact","recordValue":"每日呕吐≥3次，完全不能进食水，体重下降"},{"id":"b","label":"偶有呕吐","answer":"每日呕吐≤2次，尚能少量进食水，体重无明显变化","kind":"clinical_fact","recordValue":"每日呕吐≤2次，可少量进食水"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]},{"id":"q2","question":"最近有没有出现腹痛或阴道出血？","reason":"排除先兆流产、异位妊娠等产科急症，确保用药安全。","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若有则需紧急转诊并暂停所有药；若无则可继续辨病辨证。","informationGain":0.9,"sourceEvidence":["病历：妊娠8周，恶心呕吐，纳差"],"options":[{"id":"a","label":"存在异常","answer":"请补充实际异常","kind":"clinical_fact","requiresDetail":true},{"id":"b","label":"无异常","answer":"无腹痛，无阴道出血","kind":"clinical_fact","recordValue":"无腹痛，无阴道出血"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]}]}}
<!-- DIAGNOSIS_JSON_END --><<<CDSS_STREAM_FINAL>>>**问题1：** 与刚出现时相比，目前主要不适总体在加重、缓解，还是反复波动？
（追问理由：症状变化趋势会改变当前处置优先级和首要鉴别方向。）
补录字段：xianbingshi
可选项：
A. 近期明显加重或出现新表现
B. 目前总体稳定、反复波动或有所缓解
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.6,"infoGain":0.4,"managementImpact":0.4,"answerability":0.4},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"模型结构化追问计划不可用，改为核实最可能改变下一步判断的症状变化趋势。","questions":[{"id":"q1","question":"与刚出现时相比，目前主要不适总体在加重、缓解，还是反复波动？","reason":"症状变化趋势会改变当前处置优先级和首要鉴别方向。","targetField":"xianbingshi","decisionBranch":"differential","expectedDecisionImpact":"帮助区分进展性问题与稳定或改善中的常见问题。","informationGain":0.7,"sourceEvidence":[],"options":[{"id":"worse","label":"近期明显加重","answer":"近期明显加重或出现新表现","kind":"clinical_fact","requiresDetail":true},{"id":"stable","label":"稳定或缓解","answer":"目前总体稳定、反复波动或有所缓解","kind":"clinical_fact","recordValue":"目前总体稳定、反复波动或有所缓解","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->