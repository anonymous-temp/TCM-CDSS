import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { affirmedClinicalText } = await jiti.import("../src/lib/clinical-polarity.ts").catch(()=>jiti.import("../src/lib/clinical-state.ts"));
for (const t of ["恶寒发热，无汗","无汗","脉浮紧","否认无汗"]) console.log(JSON.stringify(t), "→", JSON.stringify(affirmedClinicalText(t, "affirmed")));
