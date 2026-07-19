**问题1：** 您目前的月经情况是怎样的？是已经绝经，还是仍在来月经？如果还在来月经，周期和经量有无异常？
（追问理由：52岁女性失眠，月经状态直接影响证型判断（肾虚、肝郁或血虚）和用药方向，例如是否可用滋肾或调肝法。）
补录字段：问诊补充
可选项：
A. 已绝经（停经超过1年）
B. 月经尚规律，经量正常
C. 本次未取得该信息

**问题2：** 您最近是否感觉身体怕冷或怕热？有没有不自觉地出汗，比如白天稍动即出汗，或晚上睡着后出汗？
（追问理由：寒热与汗出是气血阴阳虚实的核心鉴别指标，怕冷伴自汗偏阳虚，怕热盗汗偏阴虚，直接影响治则选方。）
补录字段：问诊补充
可选项：
A. 怕冷明显，手足凉，不活动时也容易自汗
B. 怕热，心烦，夜间入睡后出汗（盗汗）
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.6,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"已明确舌脉及乏力纳差等气血虚表现，但缺乏月经史和寒热汗出信息，这两个维度对证候分型和用药安全具有高信息增益，可显著改变治疗方向。","questions":[{"id":"q1","question":"您目前的月经情况是怎样的？是已经绝经，还是仍在来月经？如果还在来月经，周期和经量有无异常？","reason":"月经状态决定失眠证型是偏肾虚、肝郁还是血虚，直接影响方药选择（如二仙汤、酸枣仁汤或逍遥散）。","targetField":"tcmDetail","decisionBranch":"differential","expectedDecisionImpact":"若已绝经，偏向肾虚；若月经尚规律，需考虑肝郁血虚或心脾两虚，治法不同。","informationGain":0.9,"sourceEvidence":["患者为52岁女性","主诉失眠3月"],"options":[{"id":"a","label":"已绝经","answer":"已绝经（停经超过1年）","kind":"clinical_fact","recordValue":"已绝经（停经超过1年）"},{"id":"b","label":"月经规律","answer":"月经尚规律，经量正常","kind":"clinical_fact","recordValue":"月经尚规律，经量正常"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]},{"id":"q2","question":"您最近是否感觉身体怕冷或怕热？有没有不自觉地出汗，比如白天稍动即出汗，或晚上睡着后出汗？","reason":"寒热与汗出是辨阴阳虚实的核心，怕冷自汗多阳虚，怕热盗汗多阴虚，直接影响温补或清润方向。","targetField":"tcmDetail","decisionBranch":"syndrome","expectedDecisionImpact":"若怕冷自汗→阳虚证，可考虑桂枝加龙骨牡蛎汤；若怕热盗汗→阴虚证，可考虑黄连阿胶汤或天王补心丹。","informationGain":0.85,"sourceEvidence":["舌淡苔薄白","脉细弱","心悸劳累后偶发"],"options":[{"id":"a","label":"怕冷自汗","answer":"怕冷明显，手足凉，不活动时也容易自汗","kind":"clinical_fact","recordValue":"怕冷明显，手足凉，不活动时也容易自汗"},{"id":"b","label":"怕热盗汗","answer":"怕热，心烦，夜间入睡后出汗（盗汗）","kind":"clinical_fact","recordValue":"怕热，心烦，夜间入睡后出汗（盗汗）"},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown"}]}]}}
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