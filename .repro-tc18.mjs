import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { evaluateSafetyGate, detectProgrammaticRedFlags } = await jiti.import("./src/lib/diagnosis-safety.ts");
const { normalizeCaseStateInput } = await jiti.import("./src/lib/diagnosis-types.ts");

function apiState(c) {
  const state = { patient: {}, chiefComplaint: c.chief, historyPresentIllness: c.hist };
  if (c.vitals && Object.keys(c.vitals).length) {
    state.vitals = {};
    if (c.vitals.bp) state.vitals.bp = c.vitals.bp;
    if (c.vitals.hr) state.vitals.heartRate = String(c.vitals.hr);
    if (c.vitals.t) state.vitals.temperature = String(c.vitals.t);
    if (c.vitals.rr) state.vitals.respiratoryRate = String(c.vitals.rr);
    if (c.vitals.spo2) state.vitals.spo2 = String(c.vitals.spo2);
  }
  return normalizeCaseStateInput(state) || state;
}

const probes = [
  { id: "TC18", chief: "中风后遗左侧肢体无力", hist: "半年前脑梗,遗留左肢力弱,可扶行。舌暗有瘀斑。", vitals: { bp: "135/85" } },
  { id: "P1", chief: "复诊咨询", hist: "半年前脑梗，遗留左肢力弱，可扶行。", vitals: {} },
  { id: "P2", chief: "复诊咨询", hist: "半年前脑梗，今突发右侧肢体无力。", vitals: {} },
  { id: "P3", chief: "复诊咨询", hist: "陈旧性脑梗，遗留右侧肢体无力，可独立行走。", vitals: {} },
  { id: "P4", chief: "复诊咨询", hist: "脑梗后遗症期，右侧肢体无力，扶持下可行走。", vitals: {} },
  { id: "P5", chief: "复诊咨询", hist: "既往脑梗，遗留右侧肢体无力。", vitals: {} },
  { id: "P6", chief: "复诊咨询", hist: "数年前脑出血，遗留言语不清。", vitals: {} },
];
for (const c of probes) {
  const s = apiState(c);
  const g = evaluateSafetyGate(s);
  console.log(c.id, g.status, JSON.stringify(g.redFlags));
}
