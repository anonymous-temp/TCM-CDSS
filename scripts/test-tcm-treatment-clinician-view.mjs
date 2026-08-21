import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { buildClinicianTreatmentProjects } = await import("../src/lib/tcm-treatment-clinician-view.ts");

const INTERNAL_TERMS = /病种模板|未按证型加减|仅项目评估|政府发布方案|国家标准|规范|现场医师|安全边界|待终审|协议缺口|catalog_/;

function project(projectCode, overrides = {}) {
  return {
    projectCode,
    projectName: projectCode,
    availability: "clinic_available",
    riskLevel: "low",
    recommendationMode: "clinician_assessment",
    targetRef: "P1",
    targetPathogenesis: "脾虚失运，胃气上逆",
    protocolStatus: "governed_patient_specific_plan",
    treatmentContent: "本例适用标准项目方案，由现场医师复核后实施。",
    suggestedSitesOrPoints: [],
    scheduleSuggestion: "",
    techniqueBoundary: "由现场医师确认安全边界后实施。",
    protocolSource: "SRC-TEST",
    operatorRequirement: "由受训人员操作",
    requiredChecks: ["核对禁忌"],
    containsMedication: false,
    requiresMedicationAudit: false,
    executable: false,
    clinicianReviewRequired: true,
    ...overrides,
  };
}

function nonPharma({ diet = "", treatments = [] } = {}) {
  return {
    diet,
    lifestyle: "规律作息",
    emotion: "保持情绪平稳",
    acupointCare: null,
    tcmTreatments: treatments,
    precautions: [],
  };
}

{
  const source = nonPharma({
    diet: "少量多餐，晚餐后3小时内不平卧；可用山药小米粥，每周3次。",
    treatments: [project("diet_therapy", {
      projectName: "食疗法",
      scheduleSuggestion: "每周3次，2周后复评。",
    })],
  });
  const before = structuredClone(source);
  const result = buildClinicianTreatmentProjects(source);
  assert.equal(result.length, 1, "具体饮食行为与食物示例齐全时应生成食疗卡");
  assert.equal(result[0].title, "食疗与饮食");
  assert.match(result[0].content, /少量多餐/);
  assert.match(result[0].content, /山药小米粥/);
  assert.deepEqual(source, before, "医生端投影不得修改后台治理对象");
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    diet: "食疗只作调护，由医生结合慢病限制指导。",
    treatments: [project("diet_therapy", { projectName: "食疗法" })],
  }));
  assert.deepEqual(result, [], "只有调护或责任转移套话时不得显示食疗卡");
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    diet: "饮食宜清淡易消化，可适当食用山药、小米粥，避免辛辣、油腻食物。",
    treatments: [project("diet_therapy", {
      projectName: "食疗法",
      scheduleSuggestion: "随三餐日常调整，2周后复评。",
    })],
  }));
  assert.equal(result.length, 1, "已有具体食物示例和明确取舍行为时，不应因没有数字而隐藏食疗卡");
  assert.match(result[0].content, /山药/);
  assert.match(result[0].content, /小米粥/);
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    diet: "少量多餐，晚餐后3小时内不平卧；可用山药小米粥，每周3次。",
    treatments: [],
  }));
  assert.equal(result.length, 1, "具体 diet 不得因模型未把 diet_therapy 塞进三个项目名额而消失");
  assert.equal(result[0].projectCode, "diet_therapy");
  assert.equal(result[0].title, "食疗与饮食");
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("auricular", {
      projectName: "耳穴",
      suggestedSitesOrPoints: ["脾", "胃", "神门", "交感", "胃"],
      scheduleSuggestion: "每日按压3-5次，每次1-2分钟；每3-5天更换一次。",
    })],
  }));
  assert.equal(result.length, 1, "穴位与频次齐全时应显示耳穴卡");
  assert.equal(result[0].title, "耳穴压豆");
  assert.deepEqual(result[0].sitesOrPoints, ["脾", "胃", "神门", "交感"], "穴位应去重并保持顺序");
  assert.match(result[0].schedule, /每日按压3-5次/);
  assert.doesNotMatch(JSON.stringify(result[0]), INTERNAL_TERMS);
}

{
  const missingPoints = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("auricular", {
      projectName: "耳穴",
      scheduleSuggestion: "每日按压3-5次，每次1-2分钟；每3-5天更换一次。",
    })],
  }));
  const missingSchedule = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("auricular", {
      projectName: "耳穴",
      suggestedSitesOrPoints: ["脾", "胃"],
    })],
  }));
  assert.deepEqual(missingPoints, [], "耳穴缺穴位时必须隐藏");
  assert.deepEqual(missingSchedule, [], "耳穴缺频次时必须隐藏");
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("moxibustion", {
      projectName: "灸法",
      suggestedSitesOrPoints: ["中脘", "足三里"],
      scheduleSuggestion: "每周3次，连续2周后复评。",
    })],
  }));
  assert.equal(result.length, 1, "穴位与疗程齐全时应显示灸法卡");
  assert.equal(result[0].title, "灸法");
  assert.deepEqual(result[0].sitesOrPoints, ["中脘", "足三里"]);
  assert.match(result[0].schedule, /每周3次/);
  assert.doesNotMatch(JSON.stringify(result[0]), INTERNAL_TERMS);
}

{
  const missingPoints = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("moxibustion", {
      projectName: "灸法",
      scheduleSuggestion: "每周3次，连续2周后复评。",
    })],
  }));
  const missingSchedule = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("moxibustion", {
      projectName: "灸法",
      suggestedSitesOrPoints: ["中脘", "足三里"],
    })],
  }));
  assert.deepEqual(missingPoints, [], "灸法缺穴位时必须隐藏");
  assert.deepEqual(missingSchedule, [], "灸法缺频次时必须隐藏");
}

{
  const source = nonPharma({
    treatments: [
      project("qigong_daoyin", {
        projectName: "气功导引疗法",
        protocolStatus: "assessment_only_no_patient_specific_protocol",
        treatmentContent: "本例仅进入项目评估，不形成操作计划。",
      }),
      project("moxibustion", {
        projectName: "灸法",
        protocolStatus: "assessment_only_no_patient_specific_protocol",
        treatmentContent: "由现场医师确认热证、皮肤感觉和烫伤风险后实施。",
        suggestedSitesOrPoints: ["中脘"],
        scheduleSuggestion: "每周3次。",
      }),
    ],
  });
  const result = buildClinicianTreatmentProjects(source);
  assert.deepEqual(result, [], "评估态项目不得以治理说明卡的形式展示");
  assert.equal(source.tcmTreatments[0].protocolStatus, "assessment_only_no_patient_specific_protocol",
    "医生端隐藏评估态卡片不得删除后台真实状态");
  assert.equal(source.tcmTreatments[0].protocolSource, "SRC-TEST", "后台来源字段必须保留");
  assert.deepEqual(source.tcmTreatments[0].requiredChecks, ["核对禁忌"], "后台必查项必须保留");
  assert.equal(source.tcmTreatments[0].clinicianReviewRequired, true, "后台复核合同必须保留");
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("tuina", {
      projectName: "推拿",
      treatmentContent: "按揉中脘、足三里，每穴1分钟。",
      suggestedSitesOrPoints: ["中脘", "足三里"],
      scheduleSuggestion: "每日1次，7日后复评。",
    })],
  }));
  assert.equal(result.length, 1, "其他项目有具体操作、部位和频次时可以显示");
  assert.deepEqual(Object.keys(result[0]).sort(), ["content", "projectCode", "schedule", "sitesOrPoints", "title"], "医生端 DTO 只能携带核心可执行字段");
  assert.doesNotMatch(JSON.stringify(result), INTERNAL_TERMS);
}

for (const [label, item] of [
  ["灸法每日目录排程", project("moxibustion", {
    projectName: "灸法",
    suggestedSitesOrPoints: ["中脘", "足三里"],
    scheduleSuggestion: "每日1次，每次30分钟",
  })],
  ["拔罐隔日目录排程", project("cupping", {
    projectName: "拔罐",
    suggestedSitesOrPoints: ["背俞穴区"],
    scheduleSuggestion: "隔日1次，每次约30分钟",
  })],
  ["推拿点按目录排程", project("tuina", {
    projectName: "推拿",
    treatmentContent: "按揉肺俞、列缺",
    suggestedSitesOrPoints: ["肺俞", "列缺"],
    scheduleSuggestion: "咳嗽点按每日1次",
  })],
  ["导引每周目录排程", project("qigong_daoyin", {
    projectName: "气功导引",
    treatmentContent: "练习八段锦",
    scheduleSuggestion: "每周2次",
  })],
  ["导引每日累计目录排程", project("qigong_daoyin", {
    projectName: "气功导引",
    treatmentContent: "进行舒缓身体活动",
    scheduleSuggestion: "身体活动每日累计不少于30分钟",
  })],
]) {
  const result = buildClinicianTreatmentProjects(nonPharma({ treatments: [item] }));
  assert.equal(result.length, 1, `${label}必须保留为医生可见卡片`);
  assert.equal(result[0].schedule, item.scheduleSuggestion);
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("moxibustion", {
      projectName: "灸法",
      suggestedSitesOrPoints: ["中脘", "足三里"],
      scheduleSuggestion: "每日1次，每次30分钟",
      techniqueBoundary: "由现场医师确认热证、皮肤感觉和烫伤风险后实施。",
      requiredChecks: ["感觉障碍", "糖尿病足", "皮损和烫伤风险"],
      operatorRequirement: "由受训人员操作",
    })],
  }));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    projectCode: "moxibustion",
    title: "灸法",
    content: "按所列穴位进行灸法调护",
    sitesOrPoints: ["中脘", "足三里"],
    schedule: "每日1次，每次30分钟",
  });
  assert.doesNotMatch(
    JSON.stringify(result[0]),
    /现场医师|政府发布方案|SRC-TEST|protocolStatus|安全边界|烫伤风险|糖尿病足|受训人员|资质|注意事项|实施要求/,
    "医生端最小投影不得重新携带后台安全闸门、操作资质或责任转移话术",
  );
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("acupuncture", {
      projectName: "针刺疗法",
      treatmentContent: "本例命中该病种标准取穴模板，由现场医师复核后实施；本轮尚未按本例证型加减。",
      suggestedSitesOrPoints: ["中脘", "双侧天枢", "足三里", "内关"],
      scheduleSuggestion: "每日1次；每次选穴和疗程根据症状变化复评。",
    })],
  }));
  assert.equal(result.length, 1, "已有明确穴位和排程的针刺项目不应被治理套话连坐隐藏");
  assert.equal(result[0].title, "针刺疗法");
  assert.deepEqual(result[0].sitesOrPoints, ["中脘", "双侧天枢", "足三里", "内关"]);
  assert.doesNotMatch(JSON.stringify(result[0]), INTERNAL_TERMS);
}

{
  const result = buildClinicianTreatmentProjects(nonPharma({
    treatments: [project("tuina", {
      projectName: "推拿",
      treatmentContent: "本例进入项目评估，由现场医师复核后实施。",
      suggestedSitesOrPoints: ["中脘"],
      scheduleSuggestion: "每日1次，7日后复评。",
    })],
  }));
  assert.equal(result.length, 1, "通用穴位项目有明确部位和排程时，应忽略治理套话并保留结构化方案");
  assert.equal(result[0].content, "按所列穴位/部位进行推拿");
  assert.doesNotMatch(JSON.stringify(result[0]), INTERNAL_TERMS);
}

assert.deepEqual(buildClinicianTreatmentProjects(null), [], "空 nonPharma 不渲染模块");
assert.deepEqual(buildClinicianTreatmentProjects(undefined), [], "缺失 nonPharma 不渲染模块");

{
  const prompt = readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
  const repair = readFileSync("src/lib/structured-clinical-repair.ts", "utf8");
  assert.match(prompt, /diet[^\n]*至少[^\n]*(?:普通食物|餐食示例)/,
    "M04 首轮合同必须要求具体普通食物/餐食示例，不能只要求泛化饮食建议");
  assert.match(repair, /diet[^\n]*(?:普通食物|餐食示例)/,
    "M04 修复轮必须保留具体食物示例要求，不能修复后又退回空泛 diet");
}

console.log("tcm treatment clinician view tests passed");
