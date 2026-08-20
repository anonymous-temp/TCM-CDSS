import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
const OUTPUT_DIR = resolve(process.env.E2E_OUTPUT_DIR || "artifacts/811-evidence/reflux-treatment");
const CHROMIUM_EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
mkdirSync(OUTPUT_DIR, { recursive: true });

const checks = [];
const failures = [];
const screenshots = [];

function check(name, condition, detail = "") {
  const item = { name, ok: Boolean(condition), detail };
  checks.push(item);
  if (!item.ok) failures.push(item);
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${name}${item.ok ? "" : `  << ${detail}`}`);
}

async function screenshot(page, name, locator) {
  const path = resolve(OUTPUT_DIR, `${name}.png`);
  if (locator) await locator.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
  screenshots.push(path);
}

async function loginIfRequired(page) {
  if (!/\/login(?:\?|$)/.test(page.url())) return;
  if (!TOKEN) throw new Error("CDSS_API_TOKEN is required for the authenticated browser journey");
  if (!CUSTOMER_ID) throw new Error("CDSS_CUSTOMER_ID is required for the authenticated browser journey");
  await page.getByLabel("客户标识").fill(CUSTOMER_ID);
  await page.getByLabel("访问口令").fill(TOKEN);
  await page.getByRole("button", { name: "进入系统" }).click();
  await page.waitForURL(/\/diagnosis(?:\?|$)/, { timeout: 30_000 });
}

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROMIUM_EXECUTABLE_PATH,
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, locale: "zh-CN" });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !/favicon|ERR_ABORTED/.test(message.text())) pageErrors.push(message.text());
});

try {
  await page.goto(`${BASE_URL}/diagnosis`, { waitUntil: "networkidle", timeout: 30_000 });
  await loginIfRequired(page);
  await page.getByTestId("chief-complaint").waitFor({ state: "visible" });

  await page.getByTestId("patient-sex").selectOption("女");
  await page.getByTestId("patient-age").fill("78岁");
  await page.getByTestId("chief-complaint").fill("反酸、嗳气反复1年余");
  await page.getByTestId("present-history").fill(
    "1年多前因饮食不规律出现反酸、嗳气，餐后及进食辛辣油腻后明显，近1年反复发作，每次约10分钟，伴胃脘隐痛、食欲下降。否认吞咽困难、呕血、黑便及不明原因体重下降。",
  );
  await page.getByTestId("past-history").fill("高血压病史10年，目前血压稳定；已绝经28年，无妊娠、哺乳或备孕可能。");
  await page.getByTestId("allergy-history").fill("否认食物及药物过敏史。");
  await page.getByTestId("medication-history").fill("现服苯磺酸氨氯地平片，未使用其他药物。");
  await page.getByTestId("tcm-face").fill("面色萎黄");
  await page.getByTestId("tcm-tongue").fill("舌淡，苔白腻");
  await page.getByTestId("tcm-pulse").fill("脉细缓");
  await screenshot(page, "01-reflux-case-entered");

  const runButton = page.getByRole("button", { name: "执行辅助推理" });
  check("反流病例可启动推理", await runButton.isEnabled());
  await runButton.click();
  await Promise.race([
    page.getByTestId("streaming-preview-card").waitFor({ state: "visible", timeout: 90_000 }),
    page.getByTestId("ai-report-v2").waitFor({ state: "visible", timeout: 90_000 }),
  ]);
  await screenshot(page, "02-reflux-reasoning-progress");

  await page.getByTestId("ai-report-v2").waitFor({ state: "visible", timeout: 240_000 });
  await page.locator("#cdss-section-prescription").waitFor({ state: "visible", timeout: 240_000 });
  await page.locator("#cdss-section-followup").waitFor({ state: "visible", timeout: 180_000 });
  const treatmentSection = page.locator("#cdss-section-tcm-treatment");
  await treatmentSection.waitFor({ state: "visible", timeout: 180_000 });

  const treatmentText = await treatmentSection.innerText();
  const reportText = await page.getByTestId("ai-report-v2").innerText();
  const forbidden = /病种模板|未按证型加减|仅项目评估|政府发布方案|国家标准|规范|现场医师|来源权威|安全边界|待终审|catalog_/;
  check("反流病例显示中医非药物方案", treatmentText.includes("中医非药物方案"), treatmentText);
  check("反流食疗给出具体食物方案", /食疗与饮食/.test(treatmentText) && /山药|小米|粥|汤|羹|蔬菜|水果/.test(treatmentText), treatmentText);
  check("反流耳穴给出穴位与频次", /耳穴压豆/.test(treatmentText) && /穴位\/部位：/.test(treatmentText) && /频次\/复评：/.test(treatmentText), treatmentText);
  check("治疗项目不泄漏内部治理话术", !forbidden.test(treatmentText), treatmentText);
  check("每张可见方案都有核心内容", (await treatmentSection.getByText("核心内容：", { exact: true }).count()) >= 1, treatmentText);
  check("反流工作诊断带规范 ICD 编码", /反酸/.test(reportText) && /R12/.test(reportText), reportText.slice(0, 1000));
  check("78岁女性不出现妊娠哺乳未知提示", !/妊娠状态未知|确认是否妊娠或哺乳/.test(reportText), reportText.slice(-1500));

  await screenshot(page, "03-reflux-treatment-desktop", treatmentSection);
  await screenshot(page, "04-reflux-result-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await treatmentSection.scrollIntoViewIfNeeded();
  await screenshot(page, "05-reflux-treatment-mobile", treatmentSection);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  check("反流结果移动端无横向溢出", scrollWidth <= 400, `scrollWidth=${scrollWidth}`);
  check("反流浏览器链路无未处理错误", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));

  writeFileSync(resolve(OUTPUT_DIR, "result.json"), JSON.stringify({
    baseUrl: BASE_URL,
    checks,
    failures,
    pageErrors,
    treatmentText,
    screenshots,
  }, null, 2));
} catch (error) {
  await screenshot(page, "99-reflux-failure").catch(() => {});
  writeFileSync(resolve(OUTPUT_DIR, "result.json"), JSON.stringify({
    baseUrl: BASE_URL,
    checks,
    failures,
    pageErrors,
    error: error instanceof Error ? error.message : String(error),
    screenshots,
  }, null, 2));
  throw error;
} finally {
  await context.close();
  await browser.close();
}

console.log(JSON.stringify({ checks: checks.length, failures, screenshots }, null, 2));
process.exit(failures.length > 0 ? 1 : 0);
