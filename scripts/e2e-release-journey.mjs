import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE_URL = (process.env.BASE_URL || "http://[::1]:3000").replace(/\/$/, "");
// Next dev accepts localhost as a first-party HMR origin. The app itself listens on IPv6 because
// another local service owns IPv4:3000, so make Chromium resolve localhost to ::1 for this run.
const IPV6_LOCAL_DEV = /^http:\/\/\[::1\](?::\d+)?$/.test(BASE_URL);
const NAV_BASE_URL = IPV6_LOCAL_DEV ? BASE_URL.replace("http://[::1]", "http://localhost") : BASE_URL;
const TOKEN = process.env.CDSS_API_TOKEN || "";
const OUTPUT_DIR = resolve(process.env.E2E_OUTPUT_DIR || "artifacts/release-current/browser-journey");
mkdirSync(OUTPUT_DIR, { recursive: true });

const failures = [];
const checks = [];
let shot = 0;

function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push({ name, detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  << ${detail}`}`);
}

async function screenshot(page, name) {
  shot += 1;
  const path = resolve(OUTPUT_DIR, `${String(shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function loginIfRequired(page) {
  if (!/\/login(?:\?|$)/.test(page.url())) return;
  if (!TOKEN) throw new Error("CDSS_API_TOKEN is required for this deployment");
  await page.getByLabel("访问口令").fill(TOKEN);
  await screenshot(page, "login-filled");
  await page.getByRole("button", { name: "进入系统" }).click();
  await page.waitForURL(/\/diagnosis(?:\?|$)/, { timeout: 30_000 });
}

async function clickPresetAndCheckAnchor(page, triggerName, optionText, fieldTestId, screenshotName) {
  const trigger = page.getByRole("button", { name: triggerName });
  const triggerBox = await trigger.boundingBox();
  await trigger.click();
  const option = page.getByRole("button", { name: optionText, exact: true }).last();
  await option.waitFor({ state: "visible", timeout: 5_000 });
  const optionBox = await option.boundingBox();
  check(`${triggerName}菜单锚定当前控件`, Boolean(triggerBox && optionBox && Math.abs(optionBox.x - triggerBox.x) < 520 && optionBox.y >= triggerBox.y - 40), JSON.stringify({ triggerBox, optionBox }));
  await screenshot(page, `${screenshotName}-open`);
  await option.click();
  await screenshot(page, `${screenshotName}-selected`);
  check(`${triggerName}点选回填病历`, (await page.getByTestId(fieldTestId).inputValue()).includes(optionText), await page.getByTestId(fieldTestId).inputValue());
}

async function waitForFullResult(page) {
  await page.getByTestId("ai-report-v2").waitFor({ state: "visible", timeout: 180_000 });
  await screenshot(page, "m03-visible");
  await page.getByTestId("ai-report-v2").getByText("候选方药", { exact: true }).waitFor({ state: "visible", timeout: 240_000 });
  await screenshot(page, "m04-visible");
  // The streamed M04 body appears immediately, but an upstream model repair can make the
  // authoritative replacement a long-tail request. Keep the release journey strict about
  // visible streaming while allowing the completed M05 handoff enough time to arrive.
  // 合理用药审查在无具体风险时应完全隐藏，不能把该可选区域当作完成信号。
  await page.getByText("健康调护与随访", { exact: true }).waitFor({ state: "visible", timeout: 120_000 });
  await screenshot(page, "m05-complete");
}

const browser = await chromium.launch({
  headless: true,
  args: IPV6_LOCAL_DEV ? ["--host-resolver-rules=MAP localhost [::1]"] : [],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, locale: "zh-CN" });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !/favicon|ERR_ABORTED/.test(message.text())) pageErrors.push(message.text());
});

try {
  await page.goto(`${NAV_BASE_URL}/diagnosis`, { waitUntil: "networkidle", timeout: 30_000 });
  await loginIfRequired(page);
  await page.getByTestId("chief-complaint").waitFor({ state: "visible" });
  await screenshot(page, "initial-workspace");
  check("首屏是可用诊疗工作台", await page.getByText("门诊病历", { exact: true }).isVisible());

  await page.getByTestId("patient-sex").selectOption("男");
  await page.getByTestId("chief-complaint").fill("头晕反复3天");
  await page.getByTestId("present-history").fill("起身或转头时明显，每次持续数分钟，休息后缓解，无晕厥、胸痛或呼吸困难。");
  await screenshot(page, "history-entered");

  await clickPresetAndCheckAnchor(page, "面象选择", "面色少华", "tcm-face", "face-menu");
  await clickPresetAndCheckAnchor(page, "脉象选择", "脉细", "tcm-pulse", "pulse-menu");
  await clickPresetAndCheckAnchor(page, "舌象选择", "舌淡白", "tcm-tongue", "tongue-menu");

  const runButton = page.getByRole("button", { name: "执行辅助推理" });
  check("主诉填写后可启动", await runButton.isEnabled());
  await screenshot(page, "before-run");
  await runButton.click();
  await screenshot(page, "after-run-click");

  const questionTitle = page.getByText("需补充的信息", { exact: true });
  await Promise.race([
    questionTitle.waitFor({ state: "visible", timeout: 45_000 }),
    page.getByTestId("ai-report-v2").waitFor({ state: "visible", timeout: 45_000 }),
  ]);

  if (await questionTitle.isVisible().catch(() => false)) {
    const reasonLines = page.getByText(/^追问理由：/);
    const questionCount = await reasonLines.count();
    check("追问一轮包含1至2个高信息问题", questionCount >= 1 && questionCount <= 2, `count=${questionCount}`);
    await screenshot(page, "question-round");

    const firstCard = reasonLines.first().locator("..");
    const otherInput = firstCard.getByPlaceholder("记录患者实际回答、医生查体或已取得的检查结果");
    await otherInput.fill("无耳鸣听力下降，发作与体位改变相关，近三日睡眠尚可。");
    await screenshot(page, "question-other-filled");
    for (let index = 1; index < questionCount; index += 1) {
      const card = reasonLines.nth(index).locator("..");
      const option = card.getByRole("button").first();
      if (await option.count()) await option.click();
    }
    await screenshot(page, "question-options-selected");
    const submit = page.getByRole("button", { name: "提交本轮回答并继续推理" });
    check("点选或自由输入后可继续", await submit.isEnabled());
    await submit.click();
    await screenshot(page, "question-submitted");
  }

  const streamingOrResult = await Promise.race([
    page.getByTestId("streaming-preview-card").waitFor({ state: "visible", timeout: 20_000 }).then(() => "streaming"),
    page.getByTestId("ai-report-v2").waitFor({ state: "visible", timeout: 20_000 }).then(() => "result"),
  ]);
  check("推理阶段有流式内容或已快速完成", ["streaming", "result"].includes(streamingOrResult));
  await screenshot(page, "reasoning-progress");
  await waitForFullResult(page);

  const prescriptionText = await page.locator("#cdss-section-prescription").innerText();
  check("候选方药不混入审方状态套话", !/候选方药状态|审方提示|需调整后复核|有限候选|流派适配说明|服务端知识契约/.test(prescriptionText), prescriptionText.slice(0, 500));
  check("候选方药不把病例推断冒充参考依据", !/参考依据[^\n]*基于本例病史与症状推断/.test(prescriptionText), prescriptionText.slice(0, 500));
  const reportText = await page.getByTestId("ai-report-v2").innerText();
  check("客户报告不展示证据占位词", !/证据不足|待检索|内部证据缺口/.test(reportText));
  check("客户报告不展示低把握度与有限资料免责套话", !/判断把握度低|当前为有限资料下的工作判断|接诊时核实相关症状是否存在|本次生成依据/.test(reportText));
  check("完整饮片候选展示频次与服法", !/候选方药/.test(reportText) || /频次与服法|每日1剂/.test(reportText));
  const auditHeadings = page.getByText(/^合理用药审查(?:\s*·.*)?$/);
  const auditHeadingCount = await auditHeadings.count();
  check("合理用药审查无风险时隐藏、有风险时至多展示一次", auditHeadingCount <= 1, `count=${auditHeadingCount}`);
  check("客户报告不再出现旧审方品牌标题", !/Lingxi 建议性复核/.test(reportText));

  const chiefBeforeReload = await page.getByTestId("chief-complaint").inputValue();
  await page.reload({ waitUntil: "networkidle", timeout: 30_000 });
  await loginIfRequired(page);
  await page.getByTestId("chief-complaint").waitFor({ state: "visible" });
  check("刷新后恢复病历", (await page.getByTestId("chief-complaint").inputValue()) === chiefBeforeReload);
  check("刷新后恢复诊疗结果", await page.getByTestId("ai-report-v2").isVisible());
  await screenshot(page, "after-reload-restored");

  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, "mobile-restored");
  const bodyScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  check("移动端无页面级横向溢出", bodyScrollWidth <= 400, `scrollWidth=${bodyScrollWidth}`);
  check("浏览器运行无未处理错误", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
} finally {
  writeFileSync(resolve(OUTPUT_DIR, "result.json"), JSON.stringify({ baseUrl: BASE_URL, checks, failures, pageErrors }, null, 2));
  await context.close();
  await browser.close();
}

console.log(JSON.stringify({ baseUrl: BASE_URL, screenshots: shot, checks: checks.length, failures }, null, 2));
process.exit(failures.length > 0 ? 1 : 0);
