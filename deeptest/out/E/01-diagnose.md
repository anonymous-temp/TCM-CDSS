正在生成本阶段临床推理，请稍候…

正在组织证候、病机与治法…

正在校验结构化结果与证据来源…

正在完成安全检查…

正在校对辨病辨证与已录入病历的一致性，请稍候…<<<CDSS_STREAM_FINAL>>># 中医辅助诊疗报告

## 西医诊断
**诊断倾向**：妊娠剧吐（倾向）
**判断状态**：考虑；置信度：中
**支持依据**：妊娠8周，恶心呕吐、纳差1周；妊娠8周
**限制与反证**：未提供体重变化、尿酮体、电解质等客观指标，无法评估严重程度及排除其他病因；需排除消化系统其他疾病
**建议检查**：尿常规（尿酮体）；电解质、肝肾功能；甲状腺功能；产科超声评估胎儿情况

### 鉴别方向
- **妊娠合并胃肠炎**：妊娠8周，恶心呕吐、纳差1周；该方向需结合临床表现及相关检查继续鉴别。；建议：大便常规、血常规、CRP
- **妊娠合并甲状腺功能亢进**：当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。；建议：甲状腺功能检测

## 中医诊断
**中医病名**：恶阻
**证型**：恶阻功能失调候

## 病机分析
**总体病机**：妊娠后冲脉之气上逆，胃腑和降功能受扰。
**本证**：冲气上逆，胃腑和降功能受扰
**主要表现**：恶阻
**病机联系**：妊娠后冲脉之气上逆，扰动胃腑，导致恶心呕吐、纳差等恶阻表现。

### 子病机与治法
| 患者事实 | 证候依据 | 子病机 | 对应治法 |
|---|---|---|---|
| 妊娠8周 | 妊娠8周 | 冲脉之气上逆，扰动胃腑。 | 调冲降逆。 |
| 妊娠8周，恶心呕吐、纳差1周 | 妊娠8周，恶心呕吐、纳差1周 | 胃腑和降功能受扰，受纳腐熟功能失调。 | 安胃止呕，恢复和降。 |
| 妊娠8周，恶心呕吐、纳差1周 | 妊娠8周，恶心呕吐、纳差1周 | 胃腑受纳功能失调，食入不化，随冲气上逆而吐出。 | 消食和胃，助其通降。 |
| 不思饮食 | 不思饮食 | 胃腑受纳功能减退，食欲不振。 | 醒脾开胃，促进受纳。 |

## 治则治法
**治则**：调冲降逆，安胃止呕。
**总治法**：调冲降逆，安胃止呕。

| 分治治法 | 对应病机 | 优先级 |
|---|---|---|
| 调冲降逆 | 冲气上逆，扰动胃腑 | 主要 |
| 安胃止呕 | 胃腑和降功能受扰 | 主要 |

## 需复核的不确定项
- **呕吐物性状、二便情况**：有助于判断寒热、痰湿等兼夹病性；影响：辨证精确性及方药加减
- **寒热喜恶、口干渴饮**：区分脾胃虚寒或胃热等不同证型；影响：方药寒热配伍
- **体重变化、尿酮体、电解质**：评估妊娠剧吐严重程度及是否需要补液支持；影响：西医管理决策

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "clinicalReview": {
    "status": "accepted",
    "provider": "openai-compatible",
    "model": "deepseek-v4-flash",
    "source": "preferred",
    "reviewedPayloadHash": "sha256:7b5e67a7681dc0fa10540763d026ff6cd4bb6b207cc94493c83aa34d5cad19c3"
  },
  "overview": {
    "tcmDiseaseName": "恶阻",
    "primarySyndrome": "恶阻功能失调候",
    "primarySyndromeResolution": "bounded",
    "primarySyndromeBasis": [
      "妊娠8周，恶心呕吐、纳差1周",
      "不思饮食"
    ],
    "primarySyndromeResolutionReason": "基于现有阳性症状可初步判断为恶阻功能失调候；但缺乏寒热、痰湿、脏腑虚损等进一步辨证依据，故以功能失调候作为低置信度工作表述。",
    "secondarySyndromes": [],
    "overallPathogenesis": "妊娠后冲脉之气上逆，胃腑和降功能受扰。",
    "overallTherapy": "调冲降逆，安胃止呕。",
    "recommendedFormulaDirection": "以调冲降逆、安胃止呕为方向，选用平和降逆之品，避免攻伐伤胎。",
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
      "name": "妊娠剧吐（倾向）",
      "status": "考虑",
      "confidence": "中",
      "supportingFacts": [
        "妊娠8周，恶心呕吐、纳差1周",
        "妊娠8周"
      ],
      "limitations": [
        "未提供体重变化、尿酮体、电解质等客观指标，无法评估严重程度及排除其他病因",
        "需排除消化系统其他疾病"
      ],
      "suggestedChecks": [
        "尿常规（尿酮体）",
        "电解质、肝肾功能",
        "甲状腺功能",
        "产科超声评估胎儿情况"
      ],
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "病例内推理",
        "confidence": "中"
      }
    },
    "differentials": [
      {
        "name": "妊娠合并胃肠炎",
        "reason": "妊娠8周，恶心呕吐、纳差1周；该方向需结合临床表现及相关检查继续鉴别。",
        "nextCheck": "大便常规、血常规、CRP"
      },
      {
        "name": "妊娠合并甲状腺功能亢进",
        "reason": "当前资料仅支持列为鉴别方向，需结合临床表现及相关检查复核。",
        "nextCheck": "甲状腺功能检测"
      }
    ]
  },
  "pathogenesis": {
    "summary": "患者妊娠8周，冲脉之气上逆，胃腑和降功能受扰，故见恶心呕吐、纳差，进食后加重。舌淡苔薄白、脉象待核实为妊娠常见之象，当前资料不足以支持具体脏腑虚损或邪气定性。",
    "locationDifferentiation": {
      "items": [],
      "details": [],
      "resolution": "unresolved",
      "resolutionReason": "现有症状仅提示胃腑受扰；但缺乏腹部症状、二便等进一步定位依据，无法明确病位在何脏腑经络。",
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
      "resolutionReason": "病历已记录纳差阳性。",
      "evidence": {
        "evidenceLevel": "model_inference",
        "source": "本例四诊与病史推断",
        "confidence": "低"
      }
    },
    "symptomClusters": [
      {
        "symptoms": [
          "妊娠8周，恶心呕吐、纳差1周",
          "不思饮食"
        ],
        "mechanism": "冲气上逆，胃腑和降功能受扰，受纳腐熟功能失调。"
      }
    ],
    "caseRelationship": {
      "rootPattern": "冲气上逆，胃腑和降功能受扰",
      "mainManifestation": "恶阻",
      "relationship": "妊娠后冲脉之气上逆，扰动胃腑，导致恶心呕吐、纳差等恶阻表现。"
    },
    "chain": [
      {
        "nodeId": "P1",
        "patientFact": "妊娠8周",
        "syndromeEvidence": "妊娠8周",
        "pathogenesis": "冲脉之气上逆，扰动胃腑。",
        "therapyDirection": "调冲降逆。",
        "pathogenesisType": "始动",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P2",
        "patientFact": "妊娠8周，恶心呕吐、纳差1周",
        "syndromeEvidence": "妊娠8周，恶心呕吐、纳差1周",
        "pathogenesis": "胃腑和降功能受扰，受纳腐熟功能失调。",
        "therapyDirection": "安胃止呕，恢复和降。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P3",
        "patientFact": "妊娠8周，恶心呕吐、纳差1周",
        "syndromeEvidence": "妊娠8周，恶心呕吐、纳差1周",
        "pathogenesis": "胃腑受纳功能失调，食入不化，随冲气上逆而吐出。",
        "therapyDirection": "消食和胃，助其通降。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "nodeId": "P4",
        "patientFact": "不思饮食",
        "syndromeEvidence": "不思饮食",
        "pathogenesis": "胃腑受纳功能减退，食欲不振。",
        "therapyDirection": "醒脾开胃，促进受纳。",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      }
    ],
    "uncertainties": [
      {
        "item": "呕吐物性状、二便情况",
        "reason": "有助于判断寒热、痰湿等兼夹病性",
        "affects": "辨证精确性及方药加减"
      },
      {
        "item": "寒热喜恶、口干渴饮",
        "reason": "区分脾胃虚寒或胃热等不同证型",
        "affects": "方药寒热配伍"
      },
      {
        "item": "体重变化、尿酮体、电解质",
        "reason": "评估妊娠剧吐严重程度及是否需要补液支持",
        "affects": "西医管理决策"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "调冲降逆，安胃止呕。",
    "overallMethod": "调冲降逆，安胃止呕。",
    "subTherapies": [
      {
        "therapy": "调冲降逆",
        "targetPathogenesis": "冲气上逆，扰动胃腑",
        "priority": "主要",
        "evidence": {
          "evidenceLevel": "model_inference",
          "source": "本例资料",
          "confidence": "中"
        }
      },
      {
        "therapy": "安胃止呕",
        "targetPathogenesis": "胃腑和降功能受扰",
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
    "applicabilityReason": "本例为妊娠恶阻，功能失调候，以调冲降逆、安胃止呕为方向，流派偏好不影响核心辨证。",
    "influencedDecisions": [
      {
        "aspect": "辨证视角",
        "detail": "从冲气上逆、胃腑和降功能受扰立论，侧重调冲降逆、安胃止呕。"
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
      "呕吐物性状、频率、与进食关系",
      "二便情况",
      "寒热喜恶、口干渴饮",
      "体重变化、尿酮体、电解质"
    ],
    "followupSafetyNet": "若呕吐加重、不能进食、体重下降明显、出现脱水征（如尿少、皮肤干燥）或尿酮体阳性，需及时复诊或住院补液支持；治疗期间监测胎儿情况。"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:3ee35aa39a1ff62103250decd13d2e20be8d36505163c6683792fc89396b4ed6"
}
<!-- DIAGNOSIS_JSON_END -->

