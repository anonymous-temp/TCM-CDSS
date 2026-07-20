正在生成本阶段临床推理，请稍候…

正在组织证候、病机与治法…

正在校验结构化结果与证据来源…

正在校对辨病辨证与已录入病历的一致性，请稍候…<<<CDSS_STREAM_FINAL>>># 中医辅助诊疗报告

## 西医诊断
**诊断倾向**：高血压病3级（很高危）
**判断状态**：考虑；置信度：高
**支持依据**：反复头晕、头胀3年，加重伴视物模糊1周；生命体征：168/102mmHg；高血压病史3年，平素服药不规律
**限制与反证**：未提供动态血压监测结果，无法排除白大衣高血压；未提供眼底检查、尿微量白蛋白等靶器官损害评估
**建议检查**：动态血压监测；眼底检查；尿微量白蛋白/肌酐比值；血电解质、肾功能（eGFR）；心电图、超声心动图

### 鉴别方向
- **椎基底动脉供血不足**：反复头晕、头胀3年，加重伴视物模糊1周；该方向需结合临床表现及相关检查继续鉴别。；建议：颈椎影像学检查、经颅多普勒超声
- **糖尿病视网膜病变**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：眼底检查、荧光血管造影

## 中医诊断
**中医病名**：眩晕
**证型**：眩晕功能失调候

## 病机分析
**总体病机**：头部气血运行失调，清窍功能受扰。
**本证**：头部气血运行失调，清窍功能受扰
**主要表现**：眩晕
**病机联系**：头部气血运行失调，清窍功能受扰，发为眩晕。

### 子病机与治法
| 患者事实 | 证候依据 | 子病机 | 对应治法 |
|---|---|---|---|
| 反复头晕、头胀3年，加重伴视物模糊1周 | 反复头晕、头胀3年，加重伴视物模糊1周 | 头部气血运行失调，清窍功能受扰，故见头晕、头胀、视物模糊。 | 调畅头部气血，改善清窍功能 |
| 舌象：舌暗红，苔薄黄 | 舌象：舌暗红，苔薄黄 | 舌暗红提示头部气血运行不畅，苔薄黄可能与体内某些功能状态有关。 | 辅助调畅气血 |

## 治则治法
**治则**：调畅头部气血，安神定眩
**总治法**：调畅头部气血，安神定眩

| 分治治法 | 对应病机 | 优先级 |
|---|---|---|
| 调畅头部气血，改善清窍功能 | 头部气血运行失调，清窍功能受扰 | 主要 |
| 辅助调畅气血 | 舌暗红提示气血运行不畅 | 次要 |

## 需复核的不确定项
- **具体病位病性**：现有症状、舌脉信息有限，无法明确脏腑、寒热虚实归属。；影响：影响辨证的精确性
- **舌暗红、苔薄黄、脉象待核实的具体意义**：缺乏更多伴随症状支持，难以单独作为证型依据。；影响：影响病机判断

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "clinicalReview": {
    "status": "accepted",
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "source": "preferred",
    "reviewedPayloadHash": "sha256:f049eaea22461a9905d5789ed76d63a9bda469a77efdd2a20399036a0a1fe643"
  },
  "overview": {
    "tcmDiseaseName": "眩晕",
    "primarySyndrome": "眩晕功能失调候",
    "primarySyndromeResolution": "bounded",
    "primarySyndromeBasis": [
      "反复头晕、头胀3年，加重伴视物模糊1周",
      "舌象：舌暗红，苔薄黄"
    ],
    "primarySyndromeResolutionReason": "仅凭现有症状、舌脉，无法确立具体证型，暂以症状层功能失调候作为低置信度工作表述。",
    "secondarySyndromes": [],
    "overallPathogenesis": "头部气血运行失调，清窍功能受扰。",
    "overallTherapy": "调畅头部气血，安神定眩。",
    "recommendedFormulaDirection": "以调畅头部气血、安神定眩为方向，自拟组方。",
    "recommendedFormulaNames": [],
    "formulaSelectionMode": "self_devised",
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
        "未提供动态血压监测结果，无法排除白大衣高血压",
        "未提供眼底检查、尿微量白蛋白等靶器官损害评估"
      ],
      "suggestedChecks": [
        "动态血压监测",
        "眼底检查",
        "尿微量白蛋白/肌酐比值",
        "血电解质、肾功能（eGFR）",
        "心电图、超声心动图"
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
        "nextCheck": "颈椎影像学检查、经颅多普勒超声"
      },
      {
        "name": "糖尿病视网膜病变",
        "reason": "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        "nextCheck": "眼底检查、荧光血管造影"
      }
    ]
  },
  "pathogenesis": {
    "summary": "患者反复头晕、头胀，视物模糊，舌暗红，苔薄黄，脉象待核实，提示头部气血运行失调，清窍功能受扰。",
    "locationDifferentiation": {
      "items": [],
      "details": [],
      "resolution": "unresolved",
      "resolutionReason": "现有症状、舌脉不足以明确病位归属，暂不进行脏腑经络定位。",
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
      "resolutionReason": "现有症状、舌脉不足以明确病性，暂不进行寒热虚实分类。",
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
          "颞侧明显"
        ],
        "mechanism": "头部气血运行失调，午后加重可能与日常活动累积有关。"
      },
      {
        "symptoms": [
          "反复头晕、头胀3年，加重伴视物模糊1周",
          "入睡困难"
        ],
        "mechanism": "头部不适影响睡眠调节功能。"
      }
    ],
    "caseRelationship": {
      "rootPattern": "头部气血运行失调，清窍功能受扰",
      "mainManifestation": "眩晕",
      "relationship": "头部气血运行失调，清窍功能受扰，发为眩晕。"
    },
    "chain": [
      {
        "nodeId": "P1",
        "patientFact": "反复头晕、头胀3年，加重伴视物模糊1周",
        "syndromeEvidence": "反复头晕、头胀3年，加重伴视物模糊1周",
        "pathogenesis": "头部气血运行失调，清窍功能受扰，故见头晕、头胀、视物模糊。",
        "therapyDirection": "调畅头部气血，改善清窍功能",
        "pathogenesisType": "始动",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "低"
        }
      },
      {
        "nodeId": "P2",
        "patientFact": "舌象：舌暗红，苔薄黄",
        "syndromeEvidence": "舌象：舌暗红，苔薄黄",
        "pathogenesis": "舌暗红提示头部气血运行不畅，苔薄黄可能与体内某些功能状态有关。",
        "therapyDirection": "辅助调畅气血",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "低"
        }
      }
    ],
    "uncertainties": [
      {
        "item": "具体病位病性",
        "reason": "现有症状、舌脉信息有限，无法明确脏腑、寒热虚实归属。",
        "affects": "影响辨证的精确性"
      },
      {
        "item": "舌暗红、苔薄黄、脉象待核实的具体意义",
        "reason": "缺乏更多伴随症状支持，难以单独作为证型依据。",
        "affects": "影响病机判断"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "调畅头部气血，安神定眩",
    "overallMethod": "调畅头部气血，安神定眩",
    "subTherapies": [
      {
        "therapy": "调畅头部气血，改善清窍功能",
        "targetPathogenesis": "头部气血运行失调，清窍功能受扰",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "低"
        }
      },
      {
        "therapy": "辅助调畅气血",
        "targetPathogenesis": "舌暗红提示气血运行不畅",
        "priority": "次要",
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
    "applicabilityReason": "本例以头部气血运行失调为核心，自拟方剂需遵循安全原则。",
    "influencedDecisions": [
      {
        "aspect": "辨证视角",
        "detail": "采用功能调节视角，暂不进行具体脏腑辨证。"
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
      "动态血压监测结果",
      "眼底检查报告",
      "肾功能（eGFR）、电解质",
      "尿微量白蛋白/肌酐比值",
      "心电图、超声心动图"
    ],
    "followupSafetyNet": "接诊时核实相关症状是否存在；定期监测血压、血糖，规律服药；2周后复诊评估症状改善情况。"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:8f287f167af8aec25309320154defc3753e94641fb151da03589a7a39ee04e06"
}
<!-- DIAGNOSIS_JSON_END -->

