正在生成本阶段临床推理，请稍候…

正在组织证候、病机与治法…

正在校验结构化结果与证据来源…

正在校对辨病辨证与已录入病历的一致性，请稍候…<<<CDSS_STREAM_FINAL>>># 中医辅助诊疗报告

## 西医诊断
**诊断倾向**：高血压病3级（很高危）
**判断状态**：考虑；置信度：高
**支持依据**：反复头晕、头胀3年，加重伴视物模糊1周；生命体征：168/102mmHg；高血压病史3年，平素服药不规律
**限制与反证**：未提供既往血压控制水平、靶器官损害评估（如心电图、超声心动图、肾功能、尿微量白蛋白等）；未提供心血管危险因素全面评估
**建议检查**：动态血压监测；心电图、超声心动图；肾功能、尿微量白蛋白/肌酐比值；眼底检查；血糖、血脂、同型半胱氨酸

### 鉴别方向
- **椎基底动脉供血不足**：反复头晕、头胀3年，加重伴视物模糊1周；该方向需结合临床表现及相关检查继续鉴别。；建议：颈椎影像学、经颅多普勒、头颈部CTA/MRA
- **糖尿病视网膜病变**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：眼底检查、荧光血管造影

## 中医诊断
**中医病名**：眩晕
**证型**：眩晕功能失调候

## 病机分析
**总体病机**：头部气血运行失调，清窍功能受扰，伴睡眠调节失常。
**本证**：头部气血运行失调，睡眠调节失常
**主要表现**：眩晕
**病机联系**：头部气血运行失调，清窍功能受扰，发为眩晕；睡眠调节失常，故入睡困难。

### 子病机与治法
| 患者事实 | 证候依据 | 子病机 | 对应治法 |
|---|---|---|---|
| 反复头晕、头胀3年，加重伴视物模糊1周 | 反复头晕、头胀3年，加重伴视物模糊1周 | 头部气血运行失调，清窍功能受扰。 | 调畅头部气血，改善清窍功能。 |
| 入睡困难 | 入睡困难 | 睡眠调节失常。 | 安神助眠。 |

## 治则治法
**治则**：调畅头部气血，安神助眠。
**总治法**：以调畅头部气血、安神助眠为法。

| 分治治法 | 对应病机 | 优先级 |
|---|---|---|
| 调畅头部气血 | 头部气血运行失调，清窍功能受扰 | 主要 |
| 安神助眠 | 睡眠调节失常 | 主要 |

## 需复核的不确定项
- **头部气血失调的具体性质**：缺乏寒热、虚实等进一步分类的依据，无法确定具体病性。；影响：治疗方向的选择
- **睡眠障碍的深层机制**：仅见入睡困难，未提供多梦、易醒等伴随表现，难以判断与头部症状的关联。；影响：安神药物的具体选择
- **舌脉的解读**：舌暗红、苔薄黄、脉象待核实可能提示多种方向；但缺乏其他支持，暂不纳入病机。；影响：整体辨证的精确性

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "clinicalReview": {
    "status": "accepted",
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "source": "preferred",
    "reviewedPayloadHash": "sha256:8b45fd7430f2dfabbb5a7f5c57567dde6cf7b9d2b6b28b5f9e2236122027e16e"
  },
  "overview": {
    "tcmDiseaseName": "眩晕",
    "primarySyndrome": "眩晕功能失调候",
    "primarySyndromeResolution": "bounded",
    "primarySyndromeBasis": [
      "反复头晕、头胀3年，加重伴视物模糊1周",
      "持续性，午后加重",
      "颞侧明显",
      "入睡困难",
      "舌象：舌暗红，苔薄黄",
      "生命体征：168/102mmHg"
    ],
    "primarySyndromeResolutionReason": "当前资料仅见头晕、头胀、视物模糊、入睡困难及舌暗红、苔薄黄、脉象待核实，缺乏支持特定证候分类的典型兼症，故以症状层功能失调候作为低置信度工作表述。",
    "secondarySyndromes": [],
    "overallPathogenesis": "头部气血运行失调，清窍功能受扰，伴睡眠调节失常。",
    "overallTherapy": "调畅头部气血，安神助眠。",
    "recommendedFormulaDirection": "以调畅头部气血、安神助眠为方向，选用相应功能调护药物组方。",
    "recommendedFormulaNames": [],
    "formulaSelectionMode": "none",
    "evidence": {
      "evidenceLevel": "model_inference",
      "source": "病例内推理",
      "confidence": "低"
    }
  },
  "westernDiagnosis": {
    "primary": {
      "name": "高血压",
      "status": "考虑",
      "confidence": "高",
      "supportingFacts": [
        "反复头晕、头胀3年，加重伴视物模糊1周",
        "生命体征：168/102mmHg",
        "高血压病史3年，平素服药不规律"
      ],
      "limitations": [
        "未提供既往血压控制水平、靶器官损害评估（如心电图、超声心动图、肾功能、尿微量白蛋白等）",
        "未提供心血管危险因素全面评估"
      ],
      "suggestedChecks": [
        "动态血压监测",
        "心电图、超声心动图",
        "肾功能、尿微量白蛋白/肌酐比值",
        "眼底检查",
        "血糖、血脂、同型半胱氨酸"
      ],
      "evidence": {
        "evidenceLevel": "insufficient",
        "source": "",
        "confidence": "低"
      }
    },
    "differentials": [
      {
        "name": "椎基底动脉供血不足",
        "reason": "反复头晕、头胀3年，加重伴视物模糊1周；该方向需结合临床表现及相关检查继续鉴别。",
        "nextCheck": "颈椎影像学、经颅多普勒、头颈部CTA/MRA"
      },
      {
        "name": "糖尿病视网膜病变",
        "reason": "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        "nextCheck": "眼底检查、荧光血管造影"
      }
    ]
  },
  "pathogenesis": {
    "summary": "患者反复头晕、头胀，视物模糊，入睡困难，舌暗红，苔薄黄，脉象待核实。当前资料提示头部气血运行失调，清窍功能受扰，睡眠调节失常。",
    "locationDifferentiation": {
      "items": [],
      "details": [],
      "resolution": "unresolved",
      "resolutionReason": "现有症状未提供足够依据以确定具体脏腑经络病位，故病位分类暂不明确。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "natureDifferentiation": {
      "items": [],
      "rootDeficiency": [],
      "branchExcess": [],
      "basis": "",
      "resolution": "unresolved",
      "resolutionReason": "舌暗红、苔薄黄、脉象待核实等表现不足以独立支持寒热虚实分类，病性分类暂不明确。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "symptomClusters": [
      {
        "symptoms": [
          "反复头晕、头胀3年，加重伴视物模糊1周",
          "持续性，午后加重",
          "颞侧明显"
        ],
        "mechanism": "头部气血运行失调，清窍功能受扰"
      },
      {
        "symptoms": [
          "入睡困难"
        ],
        "mechanism": "睡眠调节失常"
      }
    ],
    "caseRelationship": {
      "rootPattern": "头部气血运行失调，睡眠调节失常",
      "mainManifestation": "眩晕",
      "relationship": "头部气血运行失调，清窍功能受扰，发为眩晕；睡眠调节失常，故入睡困难。"
    },
    "chain": [
      {
        "nodeId": "P1",
        "patientFact": "反复头晕、头胀3年，加重伴视物模糊1周",
        "syndromeEvidence": "反复头晕、头胀3年，加重伴视物模糊1周",
        "pathogenesis": "头部气血运行失调，清窍功能受扰。",
        "therapyDirection": "调畅头部气血，改善清窍功能。",
        "pathogenesisType": "始动",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "低"
        }
      },
      {
        "nodeId": "P2",
        "patientFact": "入睡困难",
        "syndromeEvidence": "入睡困难",
        "pathogenesis": "睡眠调节失常。",
        "therapyDirection": "安神助眠。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "低"
        }
      }
    ],
    "uncertainties": [
      {
        "item": "头部气血失调的具体性质",
        "reason": "缺乏寒热、虚实等进一步分类的依据，无法确定具体病性。",
        "affects": "治疗方向的选择"
      },
      {
        "item": "睡眠障碍的深层机制",
        "reason": "仅见入睡困难，未提供多梦、易醒等伴随表现，难以判断与头部症状的关联。",
        "affects": "安神药物的具体选择"
      },
      {
        "item": "舌脉的解读",
        "reason": "舌暗红、苔薄黄、脉象待核实可能提示多种方向；但缺乏其他支持，暂不纳入病机。",
        "affects": "整体辨证的精确性"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "调畅头部气血，安神助眠。",
    "overallMethod": "以调畅头部气血、安神助眠为法。",
    "subTherapies": [
      {
        "therapy": "调畅头部气血",
        "targetPathogenesis": "头部气血运行失调，清窍功能受扰",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "低"
        }
      },
      {
        "therapy": "安神助眠",
        "targetPathogenesis": "睡眠调节失常",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "低"
        }
      }
    ]
  },
  "formula": null,
  "nonPharma": null,
  "lineageAdaptation": {
    "schemaVersion": "tcm-cdss-reasoning-v2",
    "lineageCode": "unrestricted",
    "label": "不限定：循证安全优先",
    "applicable": "partial",
    "applicabilityReason": "当前辨证为功能失调候，未锁定具体证型，故流派适配仅部分适用。",
    "influencedDecisions": [
      {
        "aspect": "辨证视角",
        "detail": "采用症状导向的功能调节视角，避免过早锁定脏腑或病性。"
      }
    ],
    "unaffectedBySafety": [
      "红旗排查",
      "剂量安全",
      "配伍禁忌",
      "特殊人群",
      "相互作用"
    ],
    "safetyDeference": "安全门控和审方规则优先于流派偏好"
  },
  "management": {
    "mustCollect": [
      "既往血压控制水平及最高值",
      "HbA1c或近期血糖谱",
      "肾功能（eGFR）、尿微量白蛋白/肌酐比值",
      "心电图、超声心动图",
      "眼底检查",
      "进一步询问头晕、头胀的诱因、缓解因素及伴随症状（如恶心、耳鸣等）",
      "详细睡眠情况（多梦、易醒、早醒等）",
      "舌下络脉、瘀斑等舌象细节"
    ],
    "followupSafetyNet": "建议2周内复诊评估血压和症状改善情况；接诊时核实相关症状是否存在；规律监测家庭血压并记录。"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:9450c78f05014e9b6d48abd8fe55d760bee716c79ce43998a38295accdd7dcbc"
}
<!-- DIAGNOSIS_JSON_END -->

