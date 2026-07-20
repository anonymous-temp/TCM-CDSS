## CDSS输出层级
**结论**：高风险安全建议模式
**理由**：命中程序化红旗指征，需先完成急危重症排查或转诊评估。
**缺失信息**：高风险主诉需补充生命体征（体温、呼吸）
**处理建议**：立即停止常规诊疗并转急诊；危及生命时呼叫120。先完成急诊/转诊评估或补充检查；若医生已排除急症，可在左侧补充排查结果后重新推理。

## 红旗排查
| 风险类别 | 风险评估 | 患者依据 | 下一步 |
|---------|---------|---------|-------|
| 急危重红旗 | 高风险 | 当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置 | 先急诊/转诊或完成专科排查；补充评估结果后可重新推理 |

## 信息充分度
| 补录项 | 影响环节 | 建议动作 |
|-------|---------|---------|
| 高风险主诉需补充生命体征（体温、呼吸） | 影响红旗排查/辨证或处方安全 | 左侧病历字段或底部补充框补录后重新提交 |

## 西医诊断
| 项目 | 内容 |
|------|------|
| 西医诊断 | 急危重症风险线索待排除，需优先转诊或急诊评估 |
| 支持证据 | 当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置 |
| 建议检查 | 由医生结合主诉和现场情况补充生命体征、必要检验检查及专科评估 |
| 证据依据 | 程序化红旗与安全槽位门控；具体医学依据需结合院内规则和指南复核 |

## 中医证候诊断
**证候诊断**：暂不生成
**证候-病机关联**：信息不足，需补齐主诉、舌象、脉象或处方级安全信息后再进行处方级建议。年龄和非高风险场景下的生命体征不作为通用必填项；性别/生理状态、过敏史、当前用药以及儿童、妊娠哺乳等特殊人群信息必须在剂量级候选方药前明确。
**证据支持**：当前资料不足以形成可采纳的证候-病机链路。
**证据依据**：程序化安全门控；具体医学依据需结合院内规范、指南/文献/说明书检索和医生现场评估复核。

## 证候分布与病机映射
| 候选证候 | 主/兼 | 关联病机 | 治法方向 | 支持证据 | 反证/冲突点 | 置信度 | 下一步 |
|---------|------|---------|---------|---------|------------|-------|-------|
| 暂不生成 | - | 信息不足或安全门控未满足 | 暂不进入方药 | 当前缺少关键补录项或存在红旗排查需求 | 无法形成闭环证据链 | 低 | 补齐后重新推理 |

## 总体病机
**病位**：暂不判断
**病性**：暂不判断
**核心病机**：暂不生成；需补齐安全门控与四诊证据后再判断。
**病机依据**：当前输出只用于补录与安全提示，不作为处方级辨证依据。

## 治法框架
**总治法**：暂不生成
**子治法组合**：待红旗排查与四诊信息补齐后生成。

## 证据链
| 结论 | 支持证据 | 反证/限制 | 缺失信息 | 来源依据 | 置信度 | 下一步 |
|------|---------|-----------|---------|---------|-------|-------|
| 高风险安全建议模式 | 当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置 | 不形成正式诊断或处方 | 高风险主诉需补充生命体征（体温、呼吸） | 程序化安全门控 | 中 | 补齐后重新评估 |

## 本节生成状态
已形成服务端签名的急症限定结果；本结果只用于急诊分流和阻断剂量处方，不声称已完成中医辨证。

<!-- DIAGNOSIS_JSON_START -->
{
  "schemaVersion": "tcm-cdss-reasoning-v2",
  "stage": "diagnose",
  "completeness": {
    "level": "B",
    "redFlag": 0.75,
    "infoGain": 0.5,
    "managementImpact": 1,
    "answerability": 0.5
  },
  "overview": {
    "primarySyndrome": "急症处置优先，中医证候暂缓",
    "primarySyndromeResolution": "unresolved",
    "primarySyndromeBasis": [],
    "primarySyndromeResolutionReason": "已命中急危重安全门禁，不应因追求中医证候闭环而延误急诊处置",
    "secondarySyndromes": [],
    "overallPathogenesis": "当前不形成可采纳的中医病机链",
    "overallTherapy": "立即急诊或专科评估，不进入中药处方",
    "recommendedFormulaDirection": "暂不进入候选方药",
    "recommendedFormulaNames": [],
    "formulaSelectionMode": "none",
    "evidence": {
      "evidenceLevel": "deterministic_rule",
      "source": "服务端急危重安全门禁",
      "confidence": "高"
    }
  },
  "westernDiagnosis": {
    "primary": {
      "name": "急危重症风险待排除",
      "status": "需排除",
      "confidence": "高",
      "supportingFacts": [
        "当前呕血、咖啡样呕吐物、黑便或便血提示活动性消化道出血风险，需立即评估循环状态并急诊处置"
      ],
      "limitations": [
        "本路径只确认急诊处置优先级，不替代现场诊断"
      ],
      "suggestedChecks": [
        "立即按急诊或对应专科流程评估"
      ],
      "evidence": {
        "evidenceLevel": "deterministic_rule",
        "source": "服务端急危重安全门禁",
        "confidence": "高"
      }
    },
    "differentials": []
  },
  "pathogenesis": {
    "summary": "中医病机尚未稳定，本次不做推断。",
    "locationDifferentiation": {
      "items": [],
      "details": [],
      "resolution": "unresolved",
      "resolutionReason": "未形成可复核的病位证据",
      "evidence": {
        "evidenceLevel": "deterministic_rule",
        "source": "服务端急危重安全门禁",
        "confidence": "高"
      }
    },
    "natureDifferentiation": {
      "items": [],
      "rootDeficiency": [],
      "branchExcess": [],
      "basis": "",
      "resolution": "unresolved",
      "resolutionReason": "未形成可复核的病性证据",
      "evidence": {
        "evidenceLevel": "deterministic_rule",
        "source": "服务端急危重安全门禁",
        "confidence": "高"
      }
    },
    "symptomClusters": [],
    "chain": [],
    "uncertainties": [
      {
        "item": "高风险主诉需补充生命体征（体温、呼吸）",
        "reason": "当前应优先完成急诊或专科评估",
        "affects": "中医证候、病机与剂量级候选方药"
      }
    ]
  },
  "therapy": {
    "overallPrinciple": "急诊处置优先，不锁定中医治法",
    "subTherapies": [],
    "overallMethod": "立即急诊或专科评估，不进入中药处方"
  },
  "formula": null,
  "nonPharma": null,
  "lineageAdaptation": null,
  "management": {
    "redFlagLoop": "立即停止常规诊疗并转急诊；危及生命时呼叫120",
    "mustCollect": [
      "高风险主诉需补充生命体征（体温、呼吸）"
    ],
    "followupSafetyNet": "完成现场评估或补录后再重新运行M03"
  },
  "contractSignatureVersion": "tcm-cdss-m03-signature-v4",
  "contractSignature": "hmac-sha256:b7fddaebed36f9d28dd969b440c0dcea8093ea746df437941e2356f243f1b996",
  "clinicalReview": {
    "status": "unavailable",
    "reviewedPayloadHash": "sha256:e892348361b61ec3da0e946fb94de45b2285620d3784f08900de8b4e0e5fb9b2"
  }
}
<!-- DIAGNOSIS_JSON_END -->