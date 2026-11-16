// 离线回放存档；不读环境文件、不调用模型。用法：node ... <存档工作目录> <输出json>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': `${process.cwd()}/src`, 'server-only': `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const surface = await jiti.import('../src/lib/delivered-surface.ts');
const safety = await jiti.import('../src/lib/diagnosis-safety.ts');
const textbook = await jiti.import('../src/lib/tcm-textbook-syndromes.ts');
const provenance = await jiti.import('../src/lib/tcm-formula-provenance.ts');
const normalization = await jiti.import('../src/lib/tcm-disease-differential-normalization.ts');
const [base, output] = process.argv.slice(2);
if (!base || !output) throw new Error('需指定存档目录和输出json');
const log = console.info; console.info = () => {};
const rows = [];
for (const [round, dir] of [['r46c', 'r1063'], ['r47h', 'r1064']]) {
  for (const collection of ['p100c', 'new40', 'new45', 'retest']) {
    const folder = path.join(base, dir, 'out', `${collection}-${round}`);
    for (const file of readdirSync(folder).filter(name => name.endsWith('.r1.json')).sort()) {
      const a = JSON.parse(readFileSync(path.join(folder, file), 'utf8'));
      const recordText = safety.clinicalGroundingText(a.input);
      const gate = { status: a.redFlags?.gate || 'ready', redFlags: a.redFlags?.redFlags || [], advisories: [...(a.redFlags?.advisories || []), ...(a.redFlags?.semanticTriage?.findings || [])] };
      const caseState = { ...a.input, safetyGate: gate };
      const options = { recordText, caseState, safetyGate: gate };
      const originalDx = a.diagnose?.structured;
      const originalRx = a.prescribe?.structured;
      if (!originalDx || !originalRx) throw new Error(`missing structured: ${folder}/${file}`);
      const dx = surface.projectDeliveredReasoning(originalDx, options);
      const rx = surface.projectDeliveredReasoning(originalRx, options);
      const disease = originalDx.overview?.tcmDiseaseName;
      const permitted = textbook.textbookDiseaseNamesForCase({ sex: a.input.patient?.sex, ageYears: a.input.patient?.age })
        .filter(name => name !== disease && normalization.resolveTcmDiseaseDifferentialName(name, disease).action === 'keep');
      const compatible = textbook.textbookDifferentialSharesAffirmedFinding
        ? permitted.filter(name => textbook.textbookDifferentialSharesAffirmedFinding(name, recordText))
        : permitted;
      const pick = x => { const f = x.formula || {}; const c = f.candidates?.[0] || {}; return { name: c.name, constructionType: c.constructionType, source: c.formulaSource?.source, analysis: c.formulaAnalysis, method: c.decoction?.method, precautions: x.nonPharma?.precautions, mods: f.modifications || [] }; };
      const recommended = originalDx.overview?.recommendedFormulaNames || [];
      const herbs = originalRx.formula?.candidates?.[0]?.herbs?.map(h => h.name) || [];
      rows.push({ round, collection, id: `${collection}-${a.key}`, chief: a.input.chiefComplaint,
        originalWestern: originalDx.westernDiagnosis.primary.name, western: dx.westernDiagnosis.primary.name, basis: dx.westernDiagnosis.primary.clinicalRationale,
        originalRx: pick(originalRx), rx: pick(rx),
        diffCount: (dx.overview.tcmDiseaseDifferentials || []).length, allowedDifferentials: compatible,
        smallBases: recommended.filter(name => provenance.smallBaseOverextended(name, herbs)),
        formulaComposition: recommended.map(name => ({ name, missing: provenance.formulaNameIdentityHerbsMissing(name, herbs) })),
        dropReasons: originalRx.formula?.modificationReview,
      });
    }
  }
}
console.info = log;
writeFileSync(output, JSON.stringify(rows, null, 2));
console.log(JSON.stringify({ rows: rows.length, output }));
