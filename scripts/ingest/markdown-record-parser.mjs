const stripMarkdown = (value) => String(value || "")
  .replace(/[*`_]/g, "")
  .replace(/\s+/g, " ")
  .trim();

export function markdownTableRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const output = [];
  let heading = "";
  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = lines[index].match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      heading = stripMarkdown(headingMatch[2]);
      continue;
    }
    if (!lines[index].trim().startsWith("|") || !lines[index + 1]?.trim().startsWith("|")) continue;
    const header = splitTableLine(lines[index]);
    const divider = splitTableLine(lines[index + 1]);
    if (
      header.length === 0 ||
      divider.length !== header.length ||
      !divider.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) continue;
    index += 2;
    while (index < lines.length && lines[index].trim().startsWith("|")) {
      const cells = splitTableLine(lines[index]);
      if (cells.length === header.length) {
        output.push({
          heading,
          line: index + 1,
          values: Object.fromEntries(header.map((name, cellIndex) => [stripMarkdown(name), stripMarkdown(cells[cellIndex])])),
        });
      }
      index += 1;
    }
    index -= 1;
  }
  return output;
}

export function markdownSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const output = [];
  let current;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,4})\s+(.+)$/);
    if (match) {
      if (current) output.push(current);
      current = { heading: stripMarkdown(match[2]), line: index + 1, lines: [] };
    } else if (current) {
      current.lines.push(lines[index]);
    }
  }
  if (current) output.push(current);
  return output;
}

export function bulletsAfterLabel(lines, label) {
  const start = lines.findIndex((line) => stripMarkdown(line).replace(/[：:]$/, "") === label.replace(/[：:]$/, ""));
  if (start < 0) return [];
  const output = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const value = lines[index].match(/^\s*-\s+(.+)$/)?.[1];
    if (value) {
      output.push(stripMarkdown(value).replace(/[。；;]$/, ""));
      continue;
    }
    if (output.length > 0 && lines[index].trim() && !lines[index].trim().startsWith(">")) break;
  }
  return output;
}

export function compactTerms(value) {
  const stop = /^(是否|有无|还是|分别|情况|如何|方向|课程|相关|主要|需要|必须|不可|不能|看|偏|与)$/;
  return [...new Set(stripMarkdown(value)
    .replace(/[？?。；;：:（）()“”"'`]/g, "、")
    .split(/[、，,\s/＋+]|(?:还是)|(?:以及)|(?:或者)|(?:伴有)|(?:并有)/)
    .map((item) => item.replace(/^(?:是否|有无|更偏|偏向|兼|并见)/, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 12 && !stop.test(item)))];
}

function splitTableLine(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(stripMarkdown);
}

