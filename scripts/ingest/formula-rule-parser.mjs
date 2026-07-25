import { compactTerms, markdownTableRows } from "./markdown-record-parser.mjs";

const FORMULA_SUFFIX = "(?:汤|散|丸|饮|膏|方)";
const FORMULA_TERM_PATTERN = new RegExp(`[\\u4e00-\\u9fff]{2,14}${FORMULA_SUFFIX}`, "g");

export function formulaNamesInText(value) {
  return [...new Set(String(value || "").match(FORMULA_TERM_PATTERN) || [])]
    .map((name) => name.replace(/^(?:代表方|方剂|见一个就可用|酒客不可用|有汗用|无汗用|偏|用|和|以|主|与)/, ""))
    .filter((name) => name.length >= 3 && !/^(?:大渴饮|喜冷饮|喜热饮|不欲饮)$/.test(name));
}

function parseFormulaCell(value) {
  const normalized = value.replace(/（/g, "(").replace(/）/g, ")").replace(/类$/, "");
  const parenthetical = normalized.match(/^([^()]+)\(([^)]+)\)$/);
  const canonicalPart = (parenthetical?.[1] || normalized).trim();
  const aliases = parenthetical ? formulaNamesInText(parenthetical[2]) : [];
  const names = canonicalPart.split("/").flatMap((part, index, all) => {
    const compact = part.trim();
    if (!compact) return [];
    if (index > 0 && /^[丸散饮]$/.test(compact)) {
      return [`${all[0].trim().replace(/[汤散丸饮]$/, "")}${compact}`];
    }
    return formulaNamesInText(compact).length > 0 ? formulaNamesInText(compact) : [compact];
  });
  return {
    names: [...new Set(names.map((name) => name.replace(/类$/, "")))],
    aliases,
  };
}

function mergeAliases(seedEntries, formulaRows, correctionMarkdown) {
  const aliasMap = new Map();
  const add = (canonical, aliases, sourceRef) => {
    if (!canonical || aliases.length === 0) return;
    const existing = aliasMap.get(canonical) || { canonical, aliases: new Set(), sourceRefs: new Set() };
    aliases.filter((alias) => alias && alias !== canonical).forEach((alias) => existing.aliases.add(alias));
    existing.sourceRefs.add(sourceRef);
    aliasMap.set(canonical, existing);
  };
  for (const entry of seedEntries) {
    add(entry.canonical, entry.aliases, entry.sourceRefs?.[0] || "seed");
  }
  for (const row of formulaRows) {
    const parsed = parseFormulaCell(row.formulaCell);
    if (parsed.names[0]) add(parsed.names[0], parsed.aliases, `formula-patterns.md:${row.line}`);
  }
  for (const row of markdownTableRows(correctionMarkdown)) {
    const before = row.values.Before?.replace(/`/g, "") || "";
    const after = row.values.After?.replace(/`/g, "") || "";
    const canonical = formulaNamesInText(after)[0];
    const alias = formulaNamesInText(before)[0];
    if (canonical && alias) add(canonical, [alias], `correction-decisions.md:${row.line}`);
  }
  return [...aliasMap.values()]
    .map((entry) => ({
      canonical: entry.canonical,
      aliases: [...entry.aliases].sort((left, right) => left.localeCompare(right, "zh-CN")),
      sourceRefs: [...entry.sourceRefs],
    }))
    .sort((left, right) => left.canonical.localeCompare(right.canonical, "zh-CN"));
}

const normalizePair = (from, to) => [from, to].sort((left, right) => left.localeCompare(right, "zh-CN")).join("::");

function buildNodes(formulaRows) {
  const nodes = new Map();
  for (const row of formulaRows) {
    const parsed = parseFormulaCell(row.formulaCell);
    for (const formulaName of parsed.names) {
      const supportTerms = compactTerms(row.pattern).filter((term) => !formulaNamesInText(term).length);
      const existing = nodes.get(formulaName);
      if (existing) {
        existing.supportTerms = [...new Set([...existing.supportTerms, ...supportTerms])];
        existing.sourceRefs.push(`formula-patterns.md:${row.line}`);
        continue;
      }
      nodes.set(formulaName, {
        id: `T14-NODE-${String(nodes.size + 1).padStart(3, "0")}`,
        formulaName,
        formulaAliases: parsed.aliases,
        sixChannelSection: row.heading,
        pattern: row.pattern,
        supportTerms,
        discriminator: row.discriminator,
        safetyClass: /高风险|附子|峻|破血|攻下|不可自行|危重/.test(`${row.pattern}${row.discriminator}`)
          ? "restricted"
          : "standard",
        sourceRefs: [`formula-patterns.md:${row.line}`],
      });
    }
  }
  return [...nodes.values()];
}

function buildEdges(nodes, formulaRows, seedEdges) {
  const nodeByName = new Map(nodes.map((node) => [node.formulaName, node]));
  const edges = [];
  const seen = new Set();
  const add = (from, to, discriminator, ruleId, sourceRefs, priority = 50) => {
    if (!nodeByName.has(from) || !nodeByName.has(to) || from === to) return;
    const key = normalizePair(from, to);
    if (seen.has(key)) return;
    seen.add(key);
    const fromNode = nodeByName.get(from);
    const toNode = nodeByName.get(to);
    edges.push({
      id: `T14-${String(edges.length + 1).padStart(3, "0")}`,
      from,
      to,
      discriminator,
      discriminatingSymptom: discriminator,
      questionText: `当前阳性事实更支持“${fromNode.pattern}”，还是“${toNode.pattern}”？`,
      sides: {
        from: { supportTerms: fromNode.supportTerms.slice(0, 12), againstTerms: toNode.supportTerms.slice(0, 8) },
        to: { supportTerms: toNode.supportTerms.slice(0, 12), againstTerms: fromNode.supportTerms.slice(0, 8) },
      },
      contraindicationHints: [fromNode, toNode]
        .filter((node) => node.safetyClass !== "standard")
        .map((node) => `${node.formulaName}含高风险课程方向，不能据图自动处方`),
      priority,
      ruleId,
      sourceRefs,
    });
  };

  for (const edge of seedEdges) {
    add(edge.from, edge.to, edge.discriminator, edge.ruleId, edge.sourceRefs, 100);
  }

  for (const row of formulaRows) {
    const rowNames = parseFormulaCell(row.formulaCell).names;
    const current = rowNames[0];
    if (!current) continue;
    for (const variant of rowNames.slice(1)) {
      add(
        current,
        variant,
        `${row.formulaCell}为同一课程条目中的不同剂型或并列方证，须依据原方组成与病情轻重另行复核`,
        `T14-VARIANT-${row.line}`,
        [`formula-patterns.md:${row.line}`],
        70,
      );
    }
    const referenced = nodes
      .filter((node) => node.formulaName !== current && row.discriminator.includes(node.formulaName))
      .map((node) => node.formulaName);
    for (const other of referenced) {
      add(current, other, row.discriminator, `T14-FORMULA-${row.line}`, [`formula-patterns.md:${row.line}`], 90);
    }
  }

  const rowsBySection = Map.groupBy(formulaRows, (row) => row.heading);
  for (const rows of rowsBySection.values()) {
    for (let index = 0; index < rows.length - 1; index += 1) {
      const from = parseFormulaCell(rows[index].formulaCell).names[0];
      const to = parseFormulaCell(rows[index + 1].formulaCell).names[0];
      if (!from || !to) continue;
      add(
        from,
        to,
        `${from}：${rows[index].pattern}；${to}：${rows[index + 1].pattern}`,
        `T14-SECTION-${rows[index].line}-${rows[index + 1].line}`,
        [`formula-patterns.md:${rows[index].line}`, `formula-patterns.md:${rows[index + 1].line}`],
        40,
      );
    }
  }
  return edges;
}

export function buildFormulaRuleAssets({
  seedAliases,
  seedGraph,
  formulaPatternMarkdown,
  correctionMarkdown,
}) {
  const formulaRows = markdownTableRows(formulaPatternMarkdown)
    .filter((row) => row.values["方剂"] && row.values["课程方证"])
    .map((row) => ({
      heading: row.heading,
      line: row.line,
      formulaCell: row.values["方剂"],
      pattern: row.values["课程方证"],
      discriminator: row.values["鉴别点"] || "",
    }));
  const nodes = buildNodes(formulaRows);
  const edges = buildEdges(nodes, formulaRows, seedGraph.edges);
  return {
    formulaRows,
    formulaAliases: {
      ...seedAliases,
      schemaVersion: "tcm-formula-aliases-v2",
      entries: mergeAliases(seedAliases.entries, formulaRows, correctionMarkdown),
    },
    formulaDiscriminationGraph: {
      ...seedGraph,
      schemaVersion: "tcm-formula-discrimination-graph-v2",
      nodes,
      edges,
    },
  };
}
