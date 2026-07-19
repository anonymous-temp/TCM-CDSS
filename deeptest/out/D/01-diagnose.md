正在生成本阶段临床推理，请稍候…

正在组织证候、病机与治法…

正在校验结构化结果与证据来源…

正在完成安全检查…<<<CDSS_STREAM_FINAL>>># 中医辅助诊疗报告

## 西医诊断
**诊断倾向**：功能性消化不良
**判断状态**：考虑；置信度：中
**支持依据**：脘腹胀满、大便不调半年；压力大时明显；晨起口苦；既往史：胆囊息肉
**限制与反证**：未行胃镜、腹部超声等检查排除器质性疾病；未提供罗马IV标准中其他关键症状如早饱、上腹痛等
**建议检查**：胃镜及幽门螺杆菌检测；腹部超声（肝胆胰脾）；血常规、肝肾功能、血糖、甲状腺功能

### 鉴别方向
- **肠易激综合征**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：详细询问腹痛特点及排便相关性，必要时行结肠镜
- **胆囊息肉相关消化不良**：晨起口苦；该方向需结合临床表现及相关检查继续鉴别。；建议：复查腹部超声，评估息肉大小及胆囊功能

## 中医诊断
**中医病名**：痞满
**证型**：肝郁脾虚，湿热内蕴

## 病机分析
**总体病机**：肝郁气滞，横逆犯脾，脾失健运，湿浊内生，郁而化热，湿热下注。
**病位辨证**：脾胃、肝胆、下焦
- **下焦**：量偏多色黄
**病性辨证**：气滞、脾虚、湿热
**本证**：肝郁脾虚，湿热内蕴
**主要表现**：痞满
**病机联系**：肝郁克脾，脾虚生湿，湿郁化热，湿热中阻则脘腹胀满，下注则带下色黄，肠道传导失司则大便不调。

### 子病机与治法
| 患者事实 | 证候依据 | 子病机 | 对应治法 |
|---|---|---|---|
| 压力大时明显 | 压力大时明显 | 肝气郁结，疏泄失常 | 疏肝解郁 |
| 脘腹胀满、大便不调半年 | 脘腹胀满、大便不调半年 | 肝郁犯脾，脾失健运，气机壅滞 | 健脾行气 |
| 晨起口苦 | 晨起口苦 | 肝郁化热，湿热内生 | 清热化湿 |
| 量偏多色黄 | 量偏多色黄 | 湿热下注，带脉失约 | 清利湿热，止带 |

## 治则治法
**治则**：疏肝健脾，清热化湿。
**总治法**：疏肝解郁以调畅气机，健脾助运以杜生湿之源，清热利湿以除内蕴之邪，兼以止带。

| 分治治法 | 对应病机 | 优先级 |
|---|---|---|
| 疏肝解郁 | 肝气郁结 | 主要 |
| 健脾行气 | 脾虚气滞 | 主要 |
| 清热化湿 | 湿热内蕴 | 主要 |
| 清利湿热，止带 | 湿热下注 | 次要 |

## 需复核的不确定项
- **饮食、二便细节**：未描述食欲、食量、大便性状频率等，影响脾虚程度判断；影响：健脾药物选择与剂量
- **带下具体性状及妇科检查**：未描述气味、质地、有无阴痒等，无法排除阴道炎等局部病变；影响：清热利湿药的侧重及是否需要局部治疗
- **胆囊息肉现状**：未提供息肉大小、数量、有无症状等，影响肝胆病位权重；影响：疏肝利胆药物的选择

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "clinicalReview": {
    "status": "accepted",
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "source": "preferred",
    "reviewedPayloadHash": "sha256:8347f1377eb247f6e37b45cbede709722c482e8bfcf5f69ba6d8193e9adcc35e"
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
    "primarySyndromeResolutionReason": "缺少腹诊、饮食二便细节、带下具体性状及妇科检查，无法完全排除其他兼夹证候；但现有四诊已可形成有边界的工作判断。",
    "secondarySyndromes": [],
    "overallPathogenesis": "肝郁气滞，横逆犯脾，脾失健运，湿浊内生，郁而化热，湿热下注。",
    "overallTherapy": "疏肝健脾，清热化湿。",
    "recommendedFormulaDirection": "逍遥散合易黄汤加减",
    "recommendedFormulaNames": [
      "逍遥散",
      "易黄汤"
    ],
    "formulaSelectionMode": "combined",
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
        "晨起口苦",
        "既往史：胆囊息肉"
      ],
      "limitations": [
        "未行胃镜、腹部超声等检查排除器质性疾病",
        "未提供罗马IV标准中其他关键症状如早饱、上腹痛等"
      ],
      "suggestedChecks": [
        "胃镜及幽门螺杆菌检测",
        "腹部超声（肝胆胰脾）",
        "血常规、肝肾功能、血糖、甲状腺功能"
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
        "nextCheck": "详细询问腹痛特点及排便相关性，必要时行结肠镜"
      },
      {
        "name": "胆囊息肉相关消化不良",
        "reason": "晨起口苦；该方向需结合临床表现及相关检查继续鉴别。",
        "nextCheck": "复查腹部超声，评估息肉大小及胆囊功能"
      }
    ]
  },
  "pathogenesis": {
    "summary": "患者以脘腹胀满、大便不调为主诉，病位在脾胃，与肝胆密切相关。情绪低落、脉象待核实为肝郁之象；饭后胀甚、大便时干时稀为脾虚不运；口苦、苔黄腻、带下色黄量多、脉象待核实为湿热内蕴之征。总属肝郁脾虚，湿热内蕴之证。",
    "locationDifferentiation": {
      "items": [
        "脾胃",
        "肝胆",
        "下焦"
      ],
      "details": [
        {
          "location": "下焦",
          "basis": "量偏多色黄"
        }
      ],
      "resolution": "bounded",
      "resolutionReason": "病位推断基于现有症状；但缺乏腹诊、妇科检查等直接定位依据。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "natureDifferentiation": {
      "items": [
        "气滞",
        "脾虚",
        "湿热"
      ],
      "rootDeficiency": [
        "脾虚"
      ],
      "branchExcess": [
        "气滞",
        "湿热"
      ],
      "basis": "",
      "resolution": "bounded",
      "resolutionReason": "病性判断基于四诊；但缺少更多虚证表现（如乏力、纳差）的直接描述。",
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
        "mechanism": "脾虚失运，气机壅滞"
      },
      {
        "symptoms": [
          "压力大时明显",
          "晨起口苦"
        ],
        "mechanism": "肝郁化热，胆气上逆"
      },
      {
        "symptoms": [
          "量偏多色黄",
          "舌象：舌淡红，苔黄腻"
        ],
        "mechanism": "湿热下注"
      }
    ],
    "caseRelationship": {
      "rootPattern": "肝郁脾虚，湿热内蕴",
      "mainManifestation": "痞满",
      "relationship": "肝郁克脾，脾虚生湿，湿郁化热，湿热中阻则脘腹胀满，下注则带下色黄，肠道传导失司则大便不调。"
    },
    "chain": [
      {
        "nodeId": "P1",
        "patientFact": "压力大时明显",
        "syndromeEvidence": "压力大时明显",
        "pathogenesis": "肝气郁结，疏泄失常",
        "therapyDirection": "疏肝解郁",
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
        "pathogenesis": "肝郁犯脾，脾失健运，气机壅滞",
        "therapyDirection": "健脾行气",
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
        "pathogenesis": "肝郁化热，湿热内生",
        "therapyDirection": "清热化湿",
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
        "therapyDirection": "清利湿热，止带",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      }
    ],
    "uncertainties": [
      {
        "item": "饮食、二便细节",
        "reason": "未描述食欲、食量、大便性状频率等，影响脾虚程度判断",
        "affects": "健脾药物选择与剂量"
      },
      {
        "item": "带下具体性状及妇科检查",
        "reason": "未描述气味、质地、有无阴痒等，无法排除阴道炎等局部病变",
        "affects": "清热利湿药的侧重及是否需要局部治疗"
      },
      {
        "item": "胆囊息肉现状",
        "reason": "未提供息肉大小、数量、有无症状等，影响肝胆病位权重",
        "affects": "疏肝利胆药物的选择"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "疏肝健脾，清热化湿。",
    "overallMethod": "疏肝解郁以调畅气机，健脾助运以杜生湿之源，清热利湿以除内蕴之邪，兼以止带。",
    "subTherapies": [
      {
        "therapy": "疏肝解郁",
        "targetPathogenesis": "肝气郁结",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "健脾行气",
        "targetPathogenesis": "脾虚气滞",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "清热化湿",
        "targetPathogenesis": "湿热内蕴",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "清利湿热，止带",
        "targetPathogenesis": "湿热下注",
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
      "本次主诉及伴随症状变化",
      "带下具体性状（气味、质地、有无阴痒等）及妇科检查",
      "胆囊息肉复查结果（大小、数量、有无症状）"
    ],
    "followupSafetyNet": "接诊时核实相关症状是否存在；治疗2-4周后评估疗效，调整方案。"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:3615fd18fb9252e73734933bfa1a7ff383f14535e31466d6c76704667ff1d33f"
}
<!-- DIAGNOSIS_JSON_END -->

