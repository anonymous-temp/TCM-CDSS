正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 您最近一周是否因头晕或视物模糊而出现过一过性意识不清、肢体无力或言语不利？
（追问理由：该信息可能改变即时处置优先级，需要先核实当前状态。）
补录字段：xianbingshi
可选项：
A. 否认一过性意识不清、肢体无力或言语不利
B. 请补充具体表现
C. 本次未取得该信息

**问题2：** 您近一周是否规律服用降压药？血压最高时达到多少？
（追问理由：明确血压控制情况及用药依从性，判断头晕是否与血压波动相关。）
补录字段：medicationHistory
可选项：
A. 近一周规律服用氨氯地平，自测血压最高170/100mmHg
B. 近一周未规律服用氨氯地平，未监测血压
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"患者血压168/102mmHg，属2级高血压，且近期出现视物模糊，需排除高血压急症或靶器官损害；同时需明确头晕与血压波动的关联，以指导降压方案调整。","questions":[{"id":"q1","question":"您最近一周是否因头晕或视物模糊而出现过一过性意识不清、肢体无力或言语不利？","reason":"该信息可能改变即时处置优先级，需要先核实当前状态。","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"核实结果用于决定是否需要优先现场或急诊评估；未确认前不预设风险等级。","informationGain":0.9,"sourceEvidence":["加重伴视物模糊1周","168/102mmHg"],"options":[{"id":"a","label":"无上述症状","answer":"否认一过性意识不清、肢体无力或言语不利","kind":"clinical_fact","recordValue":"否认一过性意识不清、肢体无力或言语不利","requiresDetail":false},{"id":"b","label":"存在上述任一情况","answer":"请补充具体表现","kind":"clinical_fact","requiresDetail":true},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]},{"id":"q2","question":"您近一周是否规律服用降压药？血压最高时达到多少？","reason":"明确血压控制情况及用药依从性，判断头晕是否与血压波动相关。","targetField":"medicationHistory","decisionBranch":"treatment_safety","expectedDecisionImpact":"若规律服药且血压仍高，需调整方案；若漏服，需强调依从性并评估是否需要联合用药。","informationGain":0.85,"sourceEvidence":["氨氯地平5mg qd（常漏服）","168/102mmHg"],"options":[{"id":"a","label":"规律服药，血压最高约170/100","answer":"近一周规律服用氨氯地平，自测血压最高170/100mmHg","kind":"clinical_fact","recordValue":"近一周规律服用氨氯地平，自测血压最高170/100mmHg","requiresDetail":false},{"id":"b","label":"未规律服药，血压未测","answer":"近一周未规律服用氨氯地平，未监测血压","kind":"clinical_fact","recordValue":"近一周未规律服用氨氯地平，未监测血压","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->