// src/lib/tcm-constants.ts

// 四诊快捷标签
export const TONGUE_TAGS = ["舌红", "舌淡", "舌淡胖齿印", "舌暗紫瘀斑"] as const;
export const COATING_TAGS = ["苔薄白", "苔黄腻", "苔厚腻", "苔黑燥"] as const;
export const PULSE_TAGS = ["脉弦", "脉细弱", "脉沉迟", "脉滑数", "脉涩", "脉洪大"] as const;

// 常见主诉模板
export const COMMON_COMPLAINTS = [
  "失眠多梦、心悸半年",
  "月经不调伴小腹冷痛3月",
  "纳差乏力、大便溏薄2周",
  "头痛反复发作伴眩晕1月",
  "腰痛伴右下肢放射痛1周",
  "全身散在红色皮疹伴瘙痒2天",
] as const;

// 辨证分型参考（供 prompt 使用）
export const COMMON_PATTERNS = [
  {
    name: "气血两虚",
    symptoms: "面色少华，精神倦怠，声低懒言",
    tongue: "舌淡红苔薄白",
    pulse: "脉细弱",
  },
  {
    name: "脾虚湿困",
    symptoms: "面色萎黄，食少腹胀，大便溏薄",
    tongue: "舌淡胖有齿印苔白滑",
    pulse: "脉濡缓",
  },
  {
    name: "肝火上炎",
    symptoms: "面红目赤，口苦咽干，烦躁易怒",
    tongue: "舌红苔黄",
    pulse: "脉弦数",
  },
  {
    name: "肾阳虚",
    symptoms: "畏寒肢冷，腰膝酸软，夜尿频多",
    tongue: "舌淡胖苔白润",
    pulse: "脉沉迟无力",
  },
  {
    name: "风热表证",
    symptoms: "发热重恶寒轻，咽红肿痛",
    tongue: "舌尖红苔薄黄",
    pulse: "脉浮数",
  },
] as const;

// 合规声明（附在 M01/M02 每次 AI 回复末尾）
export const SAFETY_DISCLAIMER =
  "⚠️ 本系统仅供辅助参考，不替代医生临床判断。最终诊疗决策须由执业医师负责。";
