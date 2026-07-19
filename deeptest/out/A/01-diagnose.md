正在生成本阶段临床推理，请稍候…

正在组织证候、病机与治法…

正在校验结构化结果与证据来源…

正在完成安全检查…<<<CDSS_STREAM_FINAL>>># 中医辅助诊疗报告

## 西医诊断
**诊断倾向**：慢性失眠障碍
**判断状态**：考虑；置信度：中
**支持依据**：入睡困难、多梦易醒3个月，加重半个月；入睡需1-2小时，夜醒2-3次；白天疲倦，活动后加重；近期记忆力下降；曾间断服用褪黑素效果不佳
**限制与反证**：未提供睡眠日记或量表评估（如PSQI、ISI）；未排除其他睡眠障碍（如睡眠呼吸暂停、不宁腿综合征）；未提供情绪、咖啡因/酒精使用等影响因素
**建议检查**：匹兹堡睡眠质量指数（PSQI）或失眠严重程度指数（ISI）评估；多导睡眠监测（PSG）以排除其他睡眠障碍；甲状腺功能、血常规、生化等排除躯体疾病

### 鉴别方向
- **阻塞性睡眠呼吸暂停**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：多导睡眠监测（PSG）
- **抑郁障碍相关失眠**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：PHQ-9抑郁筛查量表

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
| 入睡困难、多梦易醒3个月，加重半个月 | 入睡困难、多梦易醒3个月，加重半个月 | 思虑劳倦，损伤心脾，气血不足，心神失养，故入睡困难、多梦易醒。 | 补益心脾，养血安神。 |
| 白天疲倦，活动后加重 | 白天疲倦，活动后加重 | 脾虚气血生化不足，清阳不升，肢体失养，故乏力、活动后加重。 | 健脾益气。 |
| 饭量减少，用法与疗程以审定处方为准用法与疗程以审定处方为准。 | 健脾助运，理气和胃。 |
| 劳累后偶发 | 劳累后偶发 | 血虚不能养心，故心悸，劳累后耗气伤血，更易诱发。 | 养血宁心。 |
| 近期记忆力下降 | 近期记忆力下降 | 心主血，脾为气血生化之源，心脾两虚，气血不能上荣于脑，故健忘。 | 补益心脾，益智安神。 |

## 治则治法
**治则**：补益心脾，养血安神。
**总治法**：补益心脾，养血安神。

| 分治治法 | 对应病机 | 优先级 |
|---|---|---|
| 补益心脾，养血安神 | 心脾两虚，气血不足，心神失养 | 主要 |

## 需复核的不确定项
- **大便情况**：接诊时核实相关症状是否存在。；影响：辨证细化、方药加减
- **情绪状态**：肝郁可加重失眠，需排除肝郁脾虚证。；影响：辨证、是否需加疏肝药
- **睡眠环境与习惯**：影响失眠的病因判断和非药物干预建议。；影响：管理建议

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "clinicalReview": {
    "status": "accepted",
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "source": "preferred",
    "reviewedPayloadHash": "sha256:76555d0cdb65423f2f21aed715561b154ffbd82ba1333938f8be93dc83ca4cb4"
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
    "primarySyndromeResolutionReason": "缺少大便、睡眠环境、情绪状态等兼症信息，可能影响对脾虚湿蕴或肝郁程度的判断；但现有四诊资料已可形成心脾两虚的工作判断。",
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
        "未提供睡眠日记或量表评估（如PSQI、ISI）",
        "未排除其他睡眠障碍（如睡眠呼吸暂停、不宁腿综合征）",
        "未提供情绪、咖啡因/酒精使用等影响因素"
      ],
      "suggestedChecks": [
        "匹兹堡睡眠质量指数（PSQI）或失眠严重程度指数（ISI）评估",
        "多导睡眠监测（PSG）以排除其他睡眠障碍",
        "甲状腺功能、血常规、生化等排除躯体疾病"
      ],
      "evidence": {
        "evidenceLevel": "insufficient",
        "source": "",
        "confidence": "低"
      }
    },
    "differentials": [
      {
        "name": "阻塞性睡眠呼吸暂停",
        "reason": "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        "nextCheck": "多导睡眠监测（PSG）"
      },
      {
        "name": "失眠障碍",
        "reason": "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        "nextCheck": "PHQ-9抑郁筛查量表"
      }
    ]
  },
  "pathogenesis": {
    "summary": "患者以入睡困难、多梦易醒为主诉，病程3个月，加重半月。结合乏力、食欲不振、心悸、健忘及舌淡苔薄白、脉象待核实、面色萎黄等表现，病位在心、脾，病性属气血两虚。总由思虑劳倦，损伤心脾，气血生化不足，心神失养所致。",
    "locationDifferentiation": {
      "items": [
        "心",
        "脾"
      ],
      "details": [],
      "resolution": "bounded",
      "resolutionReason": "病位判断基于现有症状、舌脉；但缺少大便情况等脾虚湿蕴的直接依据。",
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
      "resolutionReason": "病性判断基于现有四诊；但缺少寒热、汗出等进一步区分阴阳虚损的信息。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "symptomClusters": [
      {
        "symptoms": [
          "入睡困难、多梦易醒3个月，加重半个月"
        ],
        "mechanism": "心神失养，神不守舍。"
      },
      {
        "symptoms": [
          "白天疲倦，活动后加重",
          "饭量减少，饭后脘腹胀"
        ],
        "mechanism": "脾气虚弱，运化失职，气血生化不足。"
      },
      {
        "symptoms": [
          "劳累后偶发",
          "近期记忆力下降"
        ],
        "mechanism": "心血不足，心神失养。"
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
        "pathogenesis": "思虑劳倦，损伤心脾，气血不足，心神失养，故入睡困难、多梦易醒。",
        "therapyDirection": "补益心脾，养血安神。",
        "pathogenesisType": "始动",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P2",
        "patientFact": "白天疲倦，活动后加重",
        "syndromeEvidence": "白天疲倦，活动后加重",
        "pathogenesis": "脾虚气血生化不足，清阳不升，肢体失养，故乏力、活动后加重。",
        "therapyDirection": "健脾益气。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P3",
        "patientFact": "饭量减少，饭后脘腹胀",
        "syndromeEvidence": "饭量减少，饭后脘腹胀",
        "pathogenesis": "脾虚失运，食入不化，气机壅滞，故食欲不振、饭后脘腹胀。",
        "therapyDirection": "健脾助运，理气和胃。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P4",
        "patientFact": "劳累后偶发",
        "syndromeEvidence": "劳累后偶发",
        "pathogenesis": "血虚不能养心，故心悸，劳累后耗气伤血，更易诱发。",
        "therapyDirection": "养血宁心。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P5",
        "patientFact": "近期记忆力下降",
        "syndromeEvidence": "近期记忆力下降",
        "pathogenesis": "心主血，脾为气血生化之源，心脾两虚，气血不能上荣于脑，故健忘。",
        "therapyDirection": "补益心脾，益智安神。",
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
        "reason": "接诊时核实相关症状是否存在。",
        "affects": "辨证细化、方药加减"
      },
      {
        "item": "情绪状态",
        "reason": "肝郁可加重失眠，需排除肝郁脾虚证。",
        "affects": "辨证、是否需加疏肝药"
      },
      {
        "item": "睡眠环境与习惯",
        "reason": "影响失眠的病因判断和非药物干预建议。",
        "affects": "管理建议"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "补益心脾，养血安神。",
    "overallMethod": "补益心脾，养血安神。",
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
    "applicabilityReason": "本例辨证为心脾两虚，归脾汤为经典方，与流派偏好无关，可直接选用。",
    "influencedDecisions": [
      {
        "aspect": "辨证视角",
        "detail": "从脏腑辨证入手，定位心脾，未引入其他流派特殊辨证体系。"
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
      "大便性状与频率",
      "情绪状态（抑郁、焦虑筛查）",
      "睡眠卫生习惯与咖啡因/酒精使用情况"
    ],
    "followupSafetyNet": "建议2周后复诊评估睡眠改善情况；若出现情绪低落、兴趣减退或体重明显下降，需及时就医排除抑郁障碍；若出现打鼾、呼吸暂停、白天嗜睡加重，需行多导睡眠监测。"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:95979f63d5093ed247c87ada9336dbb969727b2f4f15eac69fe4c5caca8e559c"
}
<!-- DIAGNOSIS_JSON_END -->

