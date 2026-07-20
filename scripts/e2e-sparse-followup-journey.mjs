import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE_URL = (process.env.BASE_URL || "http://[::1]:3000").replace(/\/$/, "");
const IPV6_LOCAL_DEV = /^http:\/\/\[::1\](?::\d+)?$/.test(BASE_URL);
const NAV_BASE_URL = IPV6_LOCAL_DEV ? BASE_URL.replace("http://[::1]", "http://localhost") : BASE_URL;
const TOKEN = process.env.CDSS_API_TOKEN || "";
const OUTPUT_DIR = resolve(process.env.E2E_OUTPUT_DIR || "artifacts/release-current/sparse-followup");
mkdirSync(OUTPUT_DIR, { recursive: true });

const checks = [];
const failures = [];
const pageErrors = [];
let shot = 0;
const STRUCTURED_FOLLOWUP_FIELD_TEST_IDS = [
  "present-history",
  "past-history",
  "allergy-history",
  "medication-history",
  "vitals-t",
  "vitals-p",
  "vitals-r",
  "vitals-bp",
  "tcm-tongue",
  "tcm-pulse",
  "tcm-detail",
  "aux-exam",
];

function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push({ name, detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  << ${detail}`}`);
}

async function screenshot(page, name) {
  shot += 1;
  await page.screenshot({
    path: resolve(OUTPUT_DIR, `${String(shot).padStart(2, "0")}-${name}.png`),
    fullPage: true,
  });
}

async function loginIfRequired(page) {
  if (!/\/login(?:\?|$)/.test(page.url())) return;
  if (!TOKEN) throw new Error("CDSS_API_TOKEN is required for this deployment");
  await page.getByLabel("访问口令").fill(TOKEN);
  await page.getByRole("button", { name: "进入系统" }).click();
  await page.waitForURL(/\/diagnosis(?:\?|$)/, { timeout: 30_000 });
}

const browser = await chromium.launch({
  headless: true,
  args: IPV6_LOCAL_DEV ? ["--host-resolver-rules=MAP localhost [::1]"] : [],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !/favicon|ERR_ABORTED/.test(message.text())) pageErrors.push(message.text());
});

try {
  await page.goto(`${NAV_BASE_URL}/diagnosis`, { waitUntil: "networkidle", timeout: 30_000 });
  await loginIfRequired(page);
  await page.getByTestId("chief-complaint").fill("夜间出汗伴入睡困难1个月");
  await screenshot(page, "sparse-history");
  await page.getByRole("button", { name: "执行辅助推理" }).click();

  const questionTitle = page.getByText("需补充的信息", { exact: true });
  await questionTitle.waitFor({ state: "visible", timeout: 60_000 });
  const reasonLines = page.getByText(/^追问理由：/);
  const questionCount = await reasonLines.count();
  check("稀疏病历触发一轮1至2个高信息追问", questionCount >= 1 && questionCount <= 2, `count=${questionCount}`);
  check("追问可由医生跳过", await page.getByRole("button", { name: /跳过.*继续|按现有信息继续/ }).isVisible());
  await screenshot(page, "followup-round");

  for (let index = 0; index < questionCount; index += 1) {
    const card = reasonLines.nth(index).locator("..");
    const options = card.getByRole("button");
    if (await options.count()) await options.first().click();
  }
  const firstCard = reasonLines.first().locator("..");
  const freeText = firstCard.getByPlaceholder("记录患者实际回答、医生查体或已取得的检查结果");
  await freeText.fill("无发热、咳嗽、消瘦或心悸，盗汗以入睡后为主，醒后可缓解。");
  await screenshot(page, "followup-answered");

  const submit = page.getByRole("button", { name: "提交本轮回答并继续推理" });
  check("点选与自然语言回答后可提交", await submit.isEnabled());
  await submit.click();

  await page.waitForFunction(
    (testIds) => testIds.some((testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      const value = element && "value" in element ? String(element.value) : "";
      return /无发热|盗汗以入睡后为主|醒后可缓解/.test(value);
    }),
    STRUCTURED_FOLLOWUP_FIELD_TEST_IDS,
    { timeout: 30_000 },
  );
  const structuredFollowupValues = await Promise.all(STRUCTURED_FOLLOWUP_FIELD_TEST_IDS.map(async (testId) => ({
    testId,
    value: await page.getByTestId(testId).inputValue(),
  })));
  const projectedField = structuredFollowupValues.find(({ value }) => /无发热|盗汗以入睡后为主|醒后可缓解/.test(value));
  check(
    "M02自然语言回答回填到授权的结构化病例字段",
    Boolean(projectedField),
    JSON.stringify(structuredFollowupValues.filter(({ value }) => value)),
  );

  const progress = await Promise.race([
    page.getByTestId("streaming-preview-card").waitFor({ state: "visible", timeout: 30_000 }).then(() => "streaming"),
    page.getByTestId("ai-report-v2").waitFor({ state: "visible", timeout: 30_000 }).then(() => "result"),
  ]);
  check("提交追问后进入M03且有进度反馈", progress === "streaming" || progress === "result");
  await screenshot(page, "m03-progress");

  await page.getByTestId("ai-report-v2").waitFor({ state: "visible", timeout: 180_000 });
  await page.getByTestId("ai-report-v2").getByText("候选方药", { exact: true }).waitFor({ state: "visible", timeout: 240_000 });
  // 审方板块标题随结果三态变化，用稳定 section id 等待。
  await page.locator("#cdss-section-risk-review").waitFor({ state: "visible", timeout: 120_000 });
  await page.getByText("健康调护与随访", { exact: true }).waitFor({ state: "visible", timeout: 120_000 });
  await screenshot(page, "completed");

  const stepLabels = ["病历采集", "重点追问", "辨病辨证", "候选方药", "审方随访"];
  for (const label of stepLabels) {
    const step = page.getByText(label, { exact: true }).first().locator("..");
    check(`${label}阶段已完成`, (await step.getAttribute("class") || "").includes("emerald"), await step.getAttribute("class") || "");
  }
  check("追问提交后没有流程死锁", await page.getByText("健康调护与随访", { exact: true }).isVisible());
  check("浏览器无未处理错误", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
} finally {
  writeFileSync(
    resolve(OUTPUT_DIR, "result.json"),
    JSON.stringify({ baseUrl: BASE_URL, checks, failures, pageErrors, screenshots: shot }, null, 2),
  );
  await context.close();
  await browser.close();
}

console.log(JSON.stringify({ baseUrl: BASE_URL, checks: checks.length, failures, screenshots: shot }, null, 2));
process.exit(failures.length ? 1 : 0);
