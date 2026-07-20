正在生成本阶段临床推理，请稍候…

正在组织证候、病机与治法…

正在校验结构化结果与证据来源…

正在完成安全检查…<<<CDSS_STREAM_FINAL>>># 中医辅助诊疗报告

## 西医诊断
**诊断倾向**：慢性阻塞性肺疾病急性加重
**判断状态**：考虑；置信度：中
**支持依据**：反复咳痰喘10年，加重伴痰多1周；既往史：慢性阻塞性肺疾病；吸烟40年
**限制与反证**：未提供肺功能检查结果，无法明确气流受限严重程度；未提供胸部影像学，不能完全排除其他肺部疾病；未提供血气分析，无法评估呼吸衰竭风险
**建议检查**：肺功能检查（FEV1/FVC）；胸部X线或CT；动脉血气分析；心电图、超声心动图（排除心源性喘息）

### 鉴别方向
- **支气管哮喘急性发作**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：支气管舒张试验、PEF变异率
- **左心衰竭**：活动后气促；该方向需结合临床表现及相关检查继续鉴别。；建议：BNP/NT-proBNP、心脏超声

## 中医诊断
**中医病名**：肺胀
**证型**：寒饮伏肺证

## 病机分析
**总体病机**：久病肺虚，痰饮内伏，复感外寒，引动内饮，肺失宣降。
**病位辨证**：肺
**病性辨证**：寒饮
**本证**：寒饮伏肺
**主要表现**：肺胀
**病机联系**：寒饮内停，壅塞肺气，肺气胀满，宣降失常，发为肺胀。

### 子病机与治法
| 患者事实 | 证候依据 | 子病机 | 对应治法 |
|---|---|---|---|
| 反复咳痰喘10年，加重伴痰多1周 | 反复咳痰喘10年，加重伴痰多1周 | 久病肺虚，痰饮内伏，成为发病基础。 | 补肺益气以固本；但当前急则治标，以温化寒饮为主。 |
| 白痰量多、清稀 | 白痰量多、清稀 | 寒饮停肺，肺失通调，水饮上泛。 | 温肺化饮，燥湿化痰。 |
| 活动后气促 | 活动后气促 | 饮邪壅塞，气道不利，肺气胀满。 | 降气平喘，纳气归元。 |

## 治则治法
**治则**：急则治其标，温化寒饮，降气平喘。
**总治法**：温肺化饮，降气平喘。

| 分治治法 | 对应病机 | 优先级 |
|---|---|---|
| 温肺化饮 | 寒饮停肺 | 主要 |
| 降气平喘 | 肺气上逆 | 主要 |

## 需复核的不确定项
- **二便、饮食、睡眠情况**：影响脾肾阳虚、水饮内停的判断，以及整体正气评估。；影响：辨证细化、方药加减及预后判断
- **肺部听诊、胸部影像学、肺功能**：明确COPD严重程度及有无合并感染、心衰等。；影响：西医诊断分级、治疗强度及安全边界

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "clinicalReview": {
    "status": "accepted",
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "source": "preferred",
    "reviewedPayloadHash": "sha256:43994ea08906a9283d1ba429502884ee7c0beff47d78b75b52501e9180d273cd"
  },
  "overview": {
    "tcmDiseaseName": "肺胀",
    "primarySyndrome": "寒饮伏肺证",
    "primarySyndromeResolution": "bounded",
    "primarySyndromeBasis": [
      "反复咳痰喘10年，加重伴痰多1周",
      "白痰量多、清稀",
      "活动后气促",
      "舌象：舌淡胖，苔白滑"
    ],
    "primarySyndromeResolutionReason": "缺少听诊、胸部影像学及肺功能等客观检查，无法完全排除其他心肺疾病；舌脉信息虽支持寒饮；但未提供二便、饮食等兼症，证候细化受限。",
    "secondarySyndromes": [],
    "overallPathogenesis": "久病肺虚，痰饮内伏，复感外寒，引动内饮，肺失宣降。",
    "overallTherapy": "温肺化饮，降气平喘。",
    "recommendedFormulaDirection": "按已锁定病机与治法辨证组方",
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
      "name": "慢性阻塞性肺疾病急性加重",
      "status": "考虑",
      "confidence": "中",
      "supportingFacts": [
        "反复咳痰喘10年，加重伴痰多1周",
        "既往史：慢性阻塞性肺疾病",
        "吸烟40年"
      ],
      "limitations": [
        "未提供肺功能检查结果，无法明确气流受限严重程度",
        "未提供胸部影像学，不能完全排除其他肺部疾病",
        "未提供血气分析，无法评估呼吸衰竭风险"
      ],
      "suggestedChecks": [
        "肺功能检查（FEV1/FVC）",
        "胸部X线或CT",
        "动脉血气分析",
        "心电图、超声心动图（排除心源性喘息）"
      ],
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "病例内推理",
        "confidence": "中"
      }
    },
    "differentials": [
      {
        "name": "支气管哮喘急性发作",
        "reason": "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        "nextCheck": "支气管舒张试验、PEF变异率"
      },
      {
        "name": "左心衰竭",
        "reason": "活动后气促；该方向需结合临床表现及相关检查继续鉴别。",
        "nextCheck": "BNP/NT-proBNP、心脏超声"
      }
    ]
  },
  "pathogenesis": {
    "summary": "患者年高体弱，久患肺胀，肺气亏虚，宣降失司，津液不布，聚而为饮。此次因外寒引动，内外合邪，寒饮迫肺，肺气上逆，故见咳嗽、喘息、痰多清稀。背冷、畏寒为寒饮内盛，阳气不达之象。舌淡胖、苔白滑、脉象待核实均为寒饮内停之征。病位在肺，病性属寒饮，总属本虚标实，以标实为主。",
    "locationDifferentiation": {
      "items": [
        "肺"
      ],
      "details": [],
      "resolution": "bounded",
      "resolutionReason": "仅凭症状推断，未排除心、肾等其他脏腑影响；但当前证据集中指向肺。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "natureDifferentiation": {
      "items": [
        "寒饮"
      ],
      "rootDeficiency": [
        "肺气虚"
      ],
      "branchExcess": [
        "寒饮"
      ],
      "basis": "",
      "resolution": "bounded",
      "resolutionReason": "虚证依据仅来自病程推断，未提供气短、乏力、自汗等直接气虚表现，故本虚判断受限。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "symptomClusters": [
      {
        "symptoms": [
          "白痰量多、清稀",
          "活动后气促"
        ],
        "mechanism": "寒饮迫肺，肺失宣降，气逆于上"
      },
      {
        "symptoms": [
          "舌象：舌淡胖，苔白滑"
        ],
        "mechanism": "寒饮内盛，阳气不布"
      }
    ],
    "caseRelationship": {
      "rootPattern": "寒饮伏肺",
      "mainManifestation": "肺胀",
      "relationship": "寒饮内停，壅塞肺气，肺气胀满，宣降失常，发为肺胀。"
    },
    "chain": [
      {
        "nodeId": "P1",
        "patientFact": "反复咳痰喘10年，加重伴痰多1周",
        "syndromeEvidence": "反复咳痰喘10年，加重伴痰多1周",
        "pathogenesis": "久病肺虚，痰饮内伏，成为发病基础。",
        "therapyDirection": "补肺益气以固本；但当前急则治标，以温化寒饮为主。",
        "pathogenesisType": "始动",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P2",
        "patientFact": "白痰量多、清稀",
        "syndromeEvidence": "白痰量多、清稀",
        "pathogenesis": "寒饮停肺，肺失通调，水饮上泛。",
        "therapyDirection": "温肺化饮，燥湿化痰。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P3",
        "patientFact": "活动后气促",
        "syndromeEvidence": "活动后气促",
        "pathogenesis": "饮邪壅塞，气道不利，肺气胀满。",
        "therapyDirection": "降气平喘，纳气归元。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      }
    ],
    "uncertainties": [
      {
        "item": "二便、饮食、睡眠情况",
        "reason": "影响脾肾阳虚、水饮内停的判断，以及整体正气评估。",
        "affects": "辨证细化、方药加减及预后判断"
      },
      {
        "item": "肺部听诊、胸部影像学、肺功能",
        "reason": "明确COPD严重程度及有无合并感染、心衰等。",
        "affects": "西医诊断分级、治疗强度及安全边界"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "急则治其标，温化寒饮，降气平喘。",
    "overallMethod": "温肺化饮，降气平喘。",
    "subTherapies": [
      {
        "therapy": "温肺化饮",
        "targetPathogenesis": "寒饮停肺",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "降气平喘",
        "targetPathogenesis": "肺气上逆",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
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
    "applicabilityReason": "本例寒饮证明确，小青龙汤为经典方证，流派偏好不影响核心选方。",
    "influencedDecisions": [
      {
        "aspect": "辨证视角",
        "detail": "从方证对应角度，小青龙汤证“伤寒表不解，心下有水气”与本例外寒内饮病机高度吻合。"
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
      "肺部听诊结果",
      "胸部X线或CT",
      "肺功能检查",
      "动脉血气分析",
      "心电图、BNP或心脏超声（排除心衰）",
      "详细问诊二便、饮食、睡眠、汗出、口干等情况"
    ],
    "followupSafetyNet": "若喘息加重、痰量骤增、出现紫绀或意识改变，需立即急诊；治疗3天后症状无缓解应复诊；使用温燥药物期间注意观察有无伤阴化热迹象。"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:394e6ac880ff8466096479cb260244d9b66a52fc095f4d67f9ab1ecc6cdf130f"
}
<!-- DIAGNOSIS_JSON_END -->

