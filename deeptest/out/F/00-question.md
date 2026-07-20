正在比较本轮候选追问的信息增益…

正在排除重复问题和病历中已有答案…<<<CDSS_STREAM_FINAL>>>**问题1：** 您是否有呕血或呕吐咖啡色样物？
（追问理由：判断出血部位和活动性：呕血提示上消化道活动性出血，需紧急内镜干预；无呕血则可能出血量不大或已停止。）
补录字段：xianbingshi
可选项：
A. 患者有呕血或呕吐咖啡色样物
B. 患者无呕血或呕吐咖啡色样物
C. 本次未取得该信息

**问题2：** 发现黑便后，您是否已经停用阿司匹林？
（追问理由：阿司匹林是出血诱因，是否停药直接影响止血效果和再出血风险。）
补录字段：medicationHistory
可选项：
A. 发现黑便后已停用阿司匹林
B. 发现黑便后未停用阿司匹林
C. 本次未取得该信息

<!-- DIAGNOSIS_JSON_START -->
{"completeness":{"level":"B","redFlag":0.7,"infoGain":0.5,"managementImpact":0.5,"answerability":0.6},"m02Plan":{"schemaVersion":"tcm-cdss-m02-plan-v1","decision":"ask","rationale":"患者黑便、头晕乏力，血压偏低、心率偏快，有胃溃疡病史及阿司匹林用药史，高度怀疑上消化道出血。当前需明确出血是否活动、有无呕血，以及阿司匹林是否已停用，这两点直接影响急诊处置和止血方案。","questions":[{"id":"q1","question":"您是否有呕血或呕吐咖啡色样物？","reason":"判断出血部位和活动性：呕血提示上消化道活动性出血，需紧急内镜干预；无呕血则可能出血量不大或已停止。","targetField":"xianbingshi","decisionBranch":"triage","expectedDecisionImpact":"若有呕血，需紧急内镜止血并收入院；若无，可先药物保守治疗并观察。","informationGain":0.9,"sourceEvidence":["黑便3天，伴头晕乏力1天"],"options":[{"id":"a","label":"有呕血","answer":"患者有呕血或呕吐咖啡色样物","kind":"clinical_fact","recordValue":"有呕血或呕吐咖啡色样物","requiresDetail":false},{"id":"b","label":"无呕血","answer":"患者无呕血或呕吐咖啡色样物","kind":"clinical_fact","recordValue":"无呕血或呕吐咖啡色样物","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]},{"id":"q2","question":"发现黑便后，您是否已经停用阿司匹林？","reason":"阿司匹林是出血诱因，是否停药直接影响止血效果和再出血风险。","targetField":"medicationHistory","decisionBranch":"treatment_safety","expectedDecisionImpact":"若已停药，可继续保守治疗；若未停药，需立即停药并评估抗血小板替代方案。","informationGain":0.85,"sourceEvidence":["阿司匹林100mg qd"],"options":[{"id":"a","label":"已停用","answer":"发现黑便后已停用阿司匹林","kind":"clinical_fact","recordValue":"发现黑便后已停用阿司匹林","requiresDetail":false},{"id":"b","label":"未停用","answer":"发现黑便后未停用阿司匹林","kind":"clinical_fact","recordValue":"发现黑便后未停用阿司匹林","requiresDetail":false},{"id":"unknown","label":"本次未取得","answer":"本次未取得该信息","kind":"unknown","requiresDetail":false}]}]}}
<!-- DIAGNOSIS_JSON_END -->