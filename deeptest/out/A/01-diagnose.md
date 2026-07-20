正在生成本阶段临床推理，请稍候…

正在组织证候、病机与治法…

正在校验结构化结果与证据来源…<<<CDSS_STREAM_FINAL>>># 中医辅助诊疗报告

## 西医诊断
**诊断倾向**：慢性失眠障碍
**判断状态**：考虑；置信度：中
**支持依据**：入睡困难、多梦易醒3个月，加重半个月；入睡需1-2小时，夜醒2-3次；白天疲倦，活动后加重；近期记忆力下降；曾间断服用褪黑素效果不佳
**限制与反证**：未提供睡眠日记、睡眠量表评估；未排除睡眠呼吸暂停、不宁腿综合征等其他睡眠障碍；未提供情绪状态、咖啡因/酒精摄入等影响因素
**建议检查**：匹兹堡睡眠质量指数（PSQI）评估；多导睡眠监测（PSG）排除其他睡眠障碍；甲状腺功能、血常规等排除器质性疾病

### 鉴别方向
- **焦虑障碍相关失眠**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：GAD-7量表筛查
- **围绝经期失眠**：入睡困难、多梦易醒3个月，加重半个月；该方向需结合临床表现及相关检查继续鉴别。；建议：性激素六项、妇科超声

## 中医诊断
**中医病名**：不寐
**证型**：心脾两虚证

## 病机分析
**总体病机**：思虑劳倦，损伤心脾，气血生化不足，心神失养，神不守舍。
**病位辨证**：心、脾
**病性辨证**：气虚、血虚
**本证**：心脾两虚，气血不足
**主要表现**：不寐
**病机联系**：心脾两虚，气血生化不足，心神失养，故见不寐。

### 子病机与治法
| 患者事实 | 证候依据 | 子病机 | 对应治法 |
|---|---|---|---|
| 入睡困难、多梦易醒3个月，加重半个月 | 入睡困难、多梦易醒3个月，加重半个月 | 思虑劳倦，损伤心脾，气血不足，心神失养，神不守舍，故见失眠。 | 补益心脾，养血安神 |

## 治则治法
**治则**：补益心脾，养血安神
**总治法**：补益心脾，养血安神

| 分治治法 | 对应病机 | 优先级 |
|---|---|---|
| 补益心脾，养血安神 | 心脾两虚，气血不足，心神失养 | 主要 |

## 需复核的不确定项
- **大便情况**：脾虚常伴便溏，未提供大便信息，影响脾虚程度判断；影响：辨证准确性、方药加减
- **情绪状态**：教育工作压力可能诱发焦虑，未提供情绪信息，影响肝郁兼证判断；影响：辨证准确性、方药加减
- **饮食、咖啡因、酒精摄入**：可能影响睡眠，未提供相关信息；影响：西医诊断、治疗建议

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "clinicalReview": {
    "status": "accepted",
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "source": "preferred",
    "reviewedPayloadHash": "sha256:917834fb37f273b779b99a6995b57bac3210a7501961b4d99893c44b8fdfb5b7"
  },
  "overview": {
    "tcmDiseaseName": "不寐",
    "primarySyndrome": "心脾两虚证",
    "primarySyndromeResolution": "bounded",
    "primarySyndromeBasis": [
      "入睡困难、多梦易醒3个月，加重半个月",
      "白天疲倦，活动后加重",
      "饭量减少，饭后脘腹胀",
      "劳累后偶发",
      "近期记忆力下降",
      "舌象：舌淡，苔薄白",
      "白天疲倦，活动后加重；面象：面色萎黄，神疲"
    ],
    "primarySyndromeResolutionReason": "缺少大便、睡眠环境、情绪状态等兼症信息，可能影响兼证判断；但核心症状、舌脉已支持心脾两虚证。",
    "secondarySyndromes": [],
    "overallPathogenesis": "思虑劳倦，损伤心脾，气血生化不足，心神失养，神不守舍。",
    "overallTherapy": "补益心脾，养血安神。",
    "recommendedFormulaDirection": "归脾汤加减",
    "recommendedFormulaNames": [
      "归脾汤"
    ],
    "formulaSelectionMode": "single",
    "evidence": {
      "evidenceLevel": "model_inference",
      "source": "病例内推理",
      "confidence": "低"
    }
  },
  "westernDiagnosis": {
    "primary": {
      "name": "慢性失眠障碍",
      "status": "考虑",
      "confidence": "中",
      "supportingFacts": [
        "入睡困难、多梦易醒3个月，加重半个月",
        "入睡需1-2小时，夜醒2-3次",
        "白天疲倦，活动后加重；近期记忆力下降",
        "曾间断服用褪黑素效果不佳"
      ],
      "limitations": [
        "未提供睡眠日记、睡眠量表评估",
        "未排除睡眠呼吸暂停、不宁腿综合征等其他睡眠障碍",
        "未提供情绪状态、咖啡因/酒精摄入等影响因素"
      ],
      "suggestedChecks": [
        "匹兹堡睡眠质量指数（PSQI）评估",
        "多导睡眠监测（PSG）排除其他睡眠障碍",
        "甲状腺功能、血常规等排除器质性疾病"
      ],
      "evidence": {
        "evidenceLevel": "insufficient",
        "source": "",
        "confidence": "低"
      }
    },
    "differentials": [
      {
        "name": "失眠障碍",
        "reason": "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        "nextCheck": "GAD-7量表筛查"
      },
      {
        "name": "失眠障碍",
        "reason": "入睡困难、多梦易醒3个月，加重半个月；该方向需结合临床表现及相关检查继续鉴别。",
        "nextCheck": "性激素六项、妇科超声"
      }
    ]
  },
  "pathogenesis": {
    "summary": "患者以入睡困难、多梦易醒为主诉，病程3个月，加重半月。伴乏力、食欲不振、饭后脘腹胀、心悸、健忘，舌淡苔薄白，脉象待核实，面色萎黄，神疲。病位在心、脾，病性属气血两虚。总由思虑劳倦，损伤心脾，气血生化不足，心神失养，神不守舍所致。",
    "locationDifferentiation": {
      "items": [
        "心",
        "脾"
      ],
      "details": [],
      "resolution": "bounded",
      "resolutionReason": "病位判断基于现有症状、舌脉；但缺少大便情况等脾虚佐证，边界尚可。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "natureDifferentiation": {
      "items": [
        "气虚",
        "血虚"
      ],
      "rootDeficiency": [
        "气虚",
        "血虚"
      ],
      "branchExcess": [],
      "basis": "",
      "resolution": "bounded",
      "resolutionReason": "病性判断基于现有症状、舌脉；但缺少血虚的典型表现如头晕、爪甲色淡等，边界尚可。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "symptomClusters": [
      {
        "symptoms": [
          "入睡困难、多梦易醒3个月，加重半个月",
          "近期记忆力下降"
        ],
        "mechanism": "心血不足，心神失养，神不守舍"
      },
      {
        "symptoms": [
          "白天疲倦，活动后加重",
          "饭量减少，饭后脘腹胀",
          "白天疲倦，活动后加重；面象：面色萎黄，神疲"
        ],
        "mechanism": "脾气虚弱，运化失职，气血生化不足"
      }
    ],
    "caseRelationship": {
      "rootPattern": "心脾两虚，气血不足",
      "mainManifestation": "不寐",
      "relationship": "心脾两虚，气血生化不足，心神失养，故见不寐。"
    },
    "chain": [
      {
        "nodeId": "P1",
        "patientFact": "入睡困难、多梦易醒3个月，加重半个月",
        "syndromeEvidence": "入睡困难、多梦易醒3个月，加重半个月",
        "pathogenesis": "思虑劳倦，损伤心脾，气血不足，心神失养，神不守舍，故见失眠。",
        "therapyDirection": "补益心脾，养血安神",
        "pathogenesisType": "始动",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      }
    ],
    "uncertainties": [
      {
        "item": "大便情况",
        "reason": "脾虚常伴便溏，未提供大便信息，影响脾虚程度判断",
        "affects": "辨证准确性、方药加减"
      },
      {
        "item": "情绪状态",
        "reason": "教育工作压力可能诱发焦虑，未提供情绪信息，影响肝郁兼证判断",
        "affects": "辨证准确性、方药加减"
      },
      {
        "item": "饮食、咖啡因、酒精摄入",
        "reason": "可能影响睡眠，未提供相关信息",
        "affects": "西医诊断、治疗建议"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "补益心脾，养血安神",
    "overallMethod": "补益心脾，养血安神",
    "subTherapies": [
      {
        "therapy": "补益心脾，养血安神",
        "targetPathogenesis": "心脾两虚，气血不足，心神失养",
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
    "applicabilityReason": "本例辨证为心脾两虚，归脾汤为经典方，流派偏好不影响核心选方。",
    "influencedDecisions": [
      {
        "aspect": "辨证视角",
        "detail": "从脏腑辨证入手，心脾两虚证明确，方选归脾汤加减。"
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
      "大便情况（次数、性状）",
      "情绪状态（焦虑、抑郁筛查）",
      "睡眠卫生习惯（咖啡因、酒精、睡前活动）"
    ],
    "followupSafetyNet": "2周后复诊评估睡眠改善情况；若出现情绪低落、兴趣减退或自杀观念，需立即精神科就诊；若治疗4周无效，需重新评估诊断。"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:f356d4618accc67dcc277a1e90b2c985a8fe8f06c831a708bb7af5db6c37e8d7"
}
<!-- DIAGNOSIS_JSON_END -->

