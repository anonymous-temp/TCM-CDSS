正在生成本阶段临床推理，请稍候…

正在组织证候、病机与治法…

正在校验结构化结果与证据来源…

正在完成安全检查…<<<CDSS_STREAM_FINAL>>># 中医辅助诊疗报告

## 西医诊断
**诊断倾向**：功能性消化不良
**判断状态**：考虑；置信度：中
**支持依据**：脘腹胀满、大便不调半年；压力大时明显；晨起口苦
**限制与反证**：未提供胃镜、腹部超声等检查结果，无法完全排除器质性疾病；胆囊息肉病史需进一步评估与症状的关联
**建议检查**：胃镜及幽门螺杆菌检测；腹部超声（肝胆胰脾）；血常规、肝功能、血糖等基础检查

### 鉴别方向
- **肠易激综合征**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：罗马IV标准评估，必要时结肠镜检查
- **胆囊息肉相关消化不良**：晨起口苦；该方向需结合临床表现及相关检查继续鉴别。；建议：腹部超声复查胆囊息肉变化，评估胆囊功能

## 中医诊断
**中医病名**：痞满
**证型**：肝郁脾虚，湿热内蕴

## 病机分析
**总体病机**：肝气郁结，横逆犯脾，脾失健运，湿浊内生，郁而化热，湿热下注，阻滞气机。
**病位辨证**：肝、脾、胃、下焦
- **下焦**：量偏多色黄
**病性辨证**：气滞、湿热、脾虚
**病性依据**：脘腹胀满、大便不调半年
**本证**：肝郁脾虚，湿热内蕴
**主要表现**：痞满
**病机联系**：肝气郁结，横逆犯脾，脾失健运，湿浊内生，郁而化热，湿热阻滞气机，发为痞满。

### 子病机与治法
| 患者事实 | 证候依据 | 子病机 | 对应治法 |
|---|---|---|---|
| 压力大时明显 | 压力大时明显 | 肝气郁结，疏泄失常，气机不畅 | 疏肝解郁，理气行滞 |
| 脘腹胀满、大便不调半年 | 脘腹胀满、大便不调半年 | 肝气犯脾，脾失健运，湿浊内生，气机壅滞 | 健脾益气，化湿和中 |
| 晨起口苦 | 晨起口苦 | 湿浊内蕴，郁而化热，湿热熏蒸 | 清热化湿，利胆和胃 |
| 量偏多色黄 | 量偏多色黄 | 湿热下注，带脉失约 | 清利下焦湿热，止带 |

## 治则治法
**治则**：疏肝健脾，清热化湿，理气消痞。
**总治法**：疏肝解郁以调畅气机，健脾益气以助运化，清热化湿以除内蕴之邪，理气消痞以通降胃腑。

| 分治治法 | 对应病机 | 优先级 |
|---|---|---|
| 疏肝解郁，理气行滞 | 肝气郁结，气机不畅 | 主要 |
| 健脾益气，化湿和中 | 脾失健运，湿浊内生 | 主要 |
| 清热化湿，利胆和胃 | 湿热内蕴，熏蒸于上 | 次要 |
| 清利下焦湿热，止带 | 湿热下注，带脉失约 | 次要 |

## 需复核的不确定项
- **饮食、睡眠、小便情况**：影响脾虚程度和湿热定位的精确判断；影响：辨证/方药
- **胆囊息肉与当前症状的因果关系**：需影像学复查及专科评估；影响：西医诊断/风险
- **腹诊情况**：有助于判断气滞与湿阻的侧重；影响：辨证/方药

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "clinicalReview": {
    "status": "accepted",
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "source": "preferred",
    "reviewedPayloadHash": "sha256:bf130db103565a93e0bfd6d59cc8d717ba2501649e8517cd6279b039c9fb83eb"
  },
  "overview": {
    "tcmDiseaseName": "痞满",
    "primarySyndrome": "肝郁脾虚，湿热内蕴",
    "primarySyndromeResolution": "bounded",
    "primarySyndromeBasis": [
      "脘腹胀满、大便不调半年",
      "压力大时明显",
      "晨起口苦",
      "量偏多色黄",
      "舌象：舌淡红，苔黄腻"
    ],
    "primarySyndromeResolutionReason": "缺少腹诊、饮食情况、睡眠、小便等兼症信息，对脾虚程度和湿热定位的精确判断受限；胆囊息肉病史与当前症状的因果关系待进一步明确。",
    "secondarySyndromes": [],
    "overallPathogenesis": "肝气郁结，横逆犯脾，脾失健运，湿浊内生，郁而化热，湿热下注，阻滞气机。",
    "overallTherapy": "疏肝健脾，清热化湿，理气消痞。",
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
      "name": "功能性消化不良",
      "status": "考虑",
      "confidence": "中",
      "supportingFacts": [
        "脘腹胀满、大便不调半年",
        "压力大时明显",
        "晨起口苦"
      ],
      "limitations": [
        "未提供胃镜、腹部超声等检查结果，无法完全排除器质性疾病",
        "胆囊息肉病史需进一步评估与症状的关联"
      ],
      "suggestedChecks": [
        "胃镜及幽门螺杆菌检测",
        "腹部超声（肝胆胰脾）",
        "血常规、肝功能、血糖等基础检查"
      ],
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "病例内推理",
        "confidence": "中"
      }
    },
    "differentials": [
      {
        "name": "肠易激综合征",
        "reason": "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        "nextCheck": "罗马IV标准评估，必要时结肠镜检查"
      },
      {
        "name": "胆囊息肉相关消化不良",
        "reason": "晨起口苦；该方向需结合临床表现及相关检查继续鉴别。",
        "nextCheck": "腹部超声复查胆囊息肉变化，评估胆囊功能"
      }
    ]
  },
  "pathogenesis": {
    "summary": "患者以脘腹胀满、大便不调为主诉，病程半年，饭后加重，提示脾胃运化失职，气机壅滞。情绪低落、压力大时明显，脉象待核实，为肝气郁结之象。口苦、苔黄腻、脉象待核实，为湿热内蕴之征。带下量多色黄，乃湿热下注所致。舌淡红提示脾虚尚不严重；但已受肝木克伐。综合病位在肝、脾、胃、下焦，病性属虚实夹杂，以气滞、湿热为标，脾虚为本。",
    "locationDifferentiation": {
      "items": [
        "肝",
        "脾",
        "胃",
        "下焦"
      ],
      "details": [
        {
          "location": "下焦",
          "basis": "量偏多色黄"
        }
      ],
      "resolution": "bounded",
      "resolutionReason": "病位推断基于现有四诊信息；但缺少腹诊、小便等进一步定位依据。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "natureDifferentiation": {
      "items": [
        "气滞",
        "湿热",
        "脾虚"
      ],
      "rootDeficiency": [
        "脾虚"
      ],
      "branchExcess": [
        "气滞",
        "湿热"
      ],
      "basis": "脘腹胀满、大便不调半年",
      "resolution": "bounded",
      "resolutionReason": "脾虚程度需结合饮食、乏力等表现进一步明确；湿热定位在下焦有带下支持；但中焦湿热证据尚不充分。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "symptomClusters": [
      {
        "symptoms": [
          "脘腹胀满、大便不调半年"
        ],
        "mechanism": "脾虚失运，气机壅滞，湿浊内生"
      },
      {
        "symptoms": [
          "压力大时明显"
        ],
        "mechanism": "肝气郁结，疏泄失常"
      },
      {
        "symptoms": [
          "晨起口苦",
          "舌象：舌淡红，苔黄腻"
        ],
        "mechanism": "湿热内蕴，熏蒸于上"
      },
      {
        "symptoms": [
          "量偏多色黄"
        ],
        "mechanism": "湿热下注，带脉失约"
      }
    ],
    "caseRelationship": {
      "rootPattern": "肝郁脾虚，湿热内蕴",
      "mainManifestation": "痞满",
      "relationship": "肝气郁结，横逆犯脾，脾失健运，湿浊内生，郁而化热，湿热阻滞气机，发为痞满。"
    },
    "chain": [
      {
        "nodeId": "P1",
        "patientFact": "压力大时明显",
        "syndromeEvidence": "压力大时明显",
        "pathogenesis": "肝气郁结，疏泄失常，气机不畅",
        "therapyDirection": "疏肝解郁，理气行滞",
        "pathogenesisType": "始动",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P2",
        "patientFact": "脘腹胀满、大便不调半年",
        "syndromeEvidence": "脘腹胀满、大便不调半年",
        "pathogenesis": "肝气犯脾，脾失健运，湿浊内生，气机壅滞",
        "therapyDirection": "健脾益气，化湿和中",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P3",
        "patientFact": "晨起口苦",
        "syndromeEvidence": "晨起口苦",
        "pathogenesis": "湿浊内蕴，郁而化热，湿热熏蒸",
        "therapyDirection": "清热化湿，利胆和胃",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P4",
        "patientFact": "量偏多色黄",
        "syndromeEvidence": "量偏多色黄",
        "pathogenesis": "湿热下注，带脉失约",
        "therapyDirection": "清利下焦湿热，止带",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      }
    ],
    "uncertainties": [
      {
        "item": "饮食、睡眠、小便情况",
        "reason": "影响脾虚程度和湿热定位的精确判断",
        "affects": "辨证/方药"
      },
      {
        "item": "胆囊息肉与当前症状的因果关系",
        "reason": "需影像学复查及专科评估",
        "affects": "西医诊断/风险"
      },
      {
        "item": "腹诊情况",
        "reason": "有助于判断气滞与湿阻的侧重",
        "affects": "辨证/方药"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "疏肝健脾，清热化湿，理气消痞。",
    "overallMethod": "疏肝解郁以调畅气机，健脾益气以助运化，清热化湿以除内蕴之邪，理气消痞以通降胃腑。",
    "subTherapies": [
      {
        "therapy": "疏肝解郁，理气行滞",
        "targetPathogenesis": "肝气郁结，气机不畅",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "健脾益气，化湿和中",
        "targetPathogenesis": "脾失健运，湿浊内生",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "清热化湿，利胆和胃",
        "targetPathogenesis": "湿热内蕴，熏蒸于上",
        "priority": "次要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "清利下焦湿热，止带",
        "targetPathogenesis": "湿热下注，带脉失约",
        "priority": "次要",
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
    "applicabilityReason": "本例肝郁脾虚、湿热内蕴证候明确，不限定流派可灵活选用经典方剂；但需注意安全边界。",
    "influencedDecisions": [
      {
        "aspect": "辨证视角",
        "detail": "从脏腑辨证入手，以肝脾为核心，兼顾湿热，符合本例病机特点。"
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
      "饮食、睡眠、小便情况",
      "腹部超声复查（胆囊息肉及肝胆胰脾）",
      "胃镜及幽门螺杆菌检测"
    ],
    "followupSafetyNet": "接诊时核实相关症状是否存在；治疗2-4周后复诊评估疗效，调整方药。"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:7289ff2d56f8bbe6fe9f8fb933412bed66f1da4eec31692a42116d75997d2573"
}
<!-- DIAGNOSIS_JSON_END -->

