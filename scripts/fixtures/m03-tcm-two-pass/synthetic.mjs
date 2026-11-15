// Synthetic records only; no customer/archive narrative is copied here.
export const fixture = () => {
  const fact = (fieldPath, text, observation = "abnormal", polarity = "affirmed", scope = "current") => ({ fieldPath, text, observation, polarity, scope });
  const ctx = {
    facts: [fact("symptoms.appetite", "近日纳少"), fact("symptoms.abdomen", "饭后腹胀"), fact("symptoms.stool", "每日便溏"),
      fact("symptoms.energy", "神疲乏力"), fact("tongue", "舌淡红苔薄白", "normal")],
    chiefComplaint: "食少腹胀两周", diseases: [{ name: "虚劳", diagnosisPoints: ["脏腑功能减退表现"], sourceId: "fixture:virtual" }, { name: "胃痞", diagnosisPoints: ["胃脘痞满"], sourceId: "fixture:virtual2" }],
    units: [{ id: "L1", label: "脾", kind: "location", locationIds: [], criteriaIds: ["运化失职定位"] },
      { id: "E1", label: "气虚", kind: "root", locationIds: ["L1"], criteriaIds: ["纳少", "腹胀", "便溏", "神疲乏力"], criteriaName: "脾气虚证" }],
    syndromes: [{ name: "脾气虚证", locationIds: ["L1"], elementIds: ["E1"] }, { name: "脾失健运证", locationIds: ["L1"], elementIds: [], neutral: true }],
    methods: [{ id: "M1", text: "健脾益气", targets: ["L1", "E1"], sourceId: null }, { id: "M0", text: "调理脾胃", targets: ["L1"], sourceId: null }],
    differentials: { disease: [{ id: "D1", name: "郁病", typicalManifestation: "以情志抑郁为主要表现。" }, { id: "D2", name: "不寐", typicalManifestation: "以经常不能获得正常睡眠为主要表现。" }], syndrome: [] },
    lineage: null, safety: { redFlag: false, context: "沿用确定性门结果" }, findingsChecklist: ["纳少", "腹胀", "便溏", "神疲乏力"],
  };
  const proposal = { disease: { name: "虚劳", quotes: [0] }, quotePool: ["纳少", "腹胀", "便溏", "神疲乏力", "舌淡红苔薄白"].map((quote) => ({ quote, sourceHint: null })),
    locations: [{ id: "L1", quotes: [1], criteria: ["运化失职定位"] }],
    elements: { root: [{ id: "E1", quotes: [0, 1, 2, 3], criteria: ["纳少", "腹胀", "便溏", "神疲乏力"] }], branch: [] },
    primary: "脾气虚证", secondary: [], methods: [{ text: "健脾益气", targets: ["E1"], quotes: [0, 1, 2] }], direction: "", lineage: null };
  const sentence = (id, text, quoteIds = ["Q1"], unitIds = ["E1"]) => ({ id, text, quoteIds, unitIds });
  const narrative = {
    diseaseRationale: [sentence("dr", "食少伴乏力，本次从虚劳辨治。")], rationale: [sentence("ra", "纳少腹胀便溏相合，辨为脾气虚证。", ["Q1", "Q2", "Q3"])],
    overall: [sentence("ov", "脾气不足，运化失健。")],
    chain: [{ ...sentence("ch1", "脾失健运，食后腹胀。", ["Q2"], ["L1", "E1"]), factQuoteIds: ["Q2"], evidenceQuoteIds: ["Q2"], methodIds: ["M1"], dependsOn: [] }],
    uncertainties: [], diseaseDifferentials: ["D1", "D2"].map((candidateId, i) => ({ candidateId,
      reason: sentence(`dif${i}r`, "两者均可有纳少。"), distinguishingPoints: sentence(`dif${i}d`, "本次主要为纳少，尚须结合其余表现鉴别。"), nextCheck: null })),
    syndromeDifferentials: [], lineageText: null,
  };
  return { ctx, proposal, narrative, sentence };
};
export const envelope = (input, result) => ({ baseRevision: input.baseRevision, inputHash: input.inputHash, result });
export const textPass = (input, violations = []) => ({ baseRevision: input.baseRevision, inputHash: input.inputHash, conclusionHash: input.conclusionHash, status: violations.length ? "fail" : "pass", violations });
export const violation = (sentenceIds, code = "fixture_semantic") => ({ code, sentenceIds, nodeIds: [], expectedUnitIds: [], recordQuoteIds: ["Q1"], detail: "合成核对结论" });
export function fakeIO(data, overrides = {}) {
  const calls = [];
  const io = {
    calls, caseSafety: { activeBleeding: false, barredHerb: () => false },
    complete: async (request) => { calls.push(request); return { value: structuredClone(request.task === "m03_tcm_conclusion" ? data.proposal : data.narrative), finishReason: "stop" }; },
    checkUnits: async (input) => envelope(input, [...input.proposal.locations, ...input.proposal.elements.root, ...input.proposal.elements.branch].map((unit) => ({
      id: unit.id, status: "matched", matches: unit.criteria.map((item, i) => ({ item, quoteId: `Q${unit.quotes[Math.min(i, unit.quotes.length - 1)] + 1}` })),
    }))),
    checkDisease: async (input) => envelope(input, [{ checker: "visit_reason", status: "pass", replacement: null, quoteIds: ["Q1"] }, { checker: "disease_points", status: "pass", replacement: null, quoteIds: ["Q1"] }]),
    checkMethods: async (input) => envelope(input, data.ctx.methods.map((method) => ({ id: method.id, status: "pass" }))),
    checkLineage: async (input) => envelope(input, { status: "pass" }),
    checkIntegrity: async (input) => textPass(input), checkFacts: async (input) => textPass(input), checkSemantics: async (input) => textPass(input),
    ...overrides,
  };
  return io;
}
