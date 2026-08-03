#!/usr/bin/env node
// Current Windows Electron acceptance: packaged/dev boot, all primary routes, restart persistence.
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "package.json"));
const { _electron: electron } = require("@playwright/test");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = process.env.PW_OUT || path.join(repoRoot, "evidence", "ecosystem-live", `electron-${stamp}`);
const packagedExe = process.env.OPC_ELECTRON_EXE ? path.resolve(process.env.OPC_ELECTRON_EXE) : null;
const userDataDir = path.join(outDir, "user-data");
fs.mkdirSync(userDataDir, { recursive: true });

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const navItems = [
  ["公司", "/companies"], ["工作台", "/workbench"], ["结果", "/results"],
  ["记忆", "/assets/memory"], ["订阅", "/integrations/subscriptions"],
  ["API", "/integrations/api"], ["MCP", "/integrations/mcp"],
  ["Skill", "/assets/skills"], ["Token 用量", "/usage/tokens"], ["社区", "/assets/community"],
];
const report = {
  schemaVersion: "1",
  generatedAt: new Date().toISOString(),
  target: packagedExe || "electron-app/main.js (development)",
  boot1: {}, boot2: {}, navClicks: [], pageErrors: [],
};

async function boot() {
  if (packagedExe && !fs.existsSync(packagedExe)) throw new Error(`Packaged executable not found: ${packagedExe}`);
  const options = packagedExe
    ? { executablePath: packagedExe, args: [`--user-data-dir=${userDataDir}`], cwd: path.dirname(packagedExe), timeout: 120000 }
    : { args: [path.join(repoRoot, "electron-app"), `--user-data-dir=${userDataDir}`], cwd: repoRoot, timeout: 120000 };
  const app = await electron.launch(options);
  const win = await app.firstWindow({ timeout: 120000 });
  let collectingErrors = true;
  win.on("pageerror", (error) => { if (collectingErrors) report.pageErrors.push(String(error)); });
  win.on("console", (message) => { if (collectingErrors && message.type() === "error") report.pageErrors.push(message.text()); });
  await win.waitForLoadState("domcontentloaded", { timeout: 60000 });
  await win.waitForFunction(() => document.body?.innerText.trim().length > 20, null, { timeout: 60000 });
  await win.waitForTimeout(1000);
  const skip = win.locator('button[title="跳过引导"], button[title="Skip"]');
  const onboardingDismissed = await skip.first().isVisible().catch(() => false);
  if (onboardingDismissed) {
    await skip.first().click({ timeout: 5000, force: true });
    await win.waitForTimeout(300);
  }
  return { app, win, onboardingDismissed, stopErrorCollection: () => { collectingErrors = false; } };
}

async function pageState(win) {
  return win.evaluate(() => {
    const text = document.body.innerText;
    return {
      url: location.href,
      hash: location.hash,
      bodyLength: text.length,
      disconnected: text.includes("实时连接已断开"),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      fatal: text.includes("Something went wrong") || text.includes("出现错误"),
    };
  });
}

try {
  log("boot #1");
  let { app, win, onboardingDismissed, stopErrorCollection } = await boot();
  report.boot1.onboardingDismissed = onboardingDismissed;
  report.boot1.title = await win.title();
  report.boot1.initial = await pageState(win);
  await win.screenshot({ path: path.join(outDir, "home.png") });
  for (const [label, expectedHash] of navItems) {
    try {
      const button = win.getByRole("button", { name: label, exact: true });
      const count = await button.count();
      if (count !== 1) throw new Error(`expected one nav button, found ${count}`);
      await button.click({ timeout: 8000 });
      await win.waitForTimeout(450);
      const state = await pageState(win);
      const passed = state.hash.includes(expectedHash) && state.bodyLength > 100 && !state.disconnected && !state.fatal && state.overflowX === 0;
      report.navClicks.push({ label, expectedHash, passed, ...state });
      if (!passed) throw new Error(`route state mismatch: ${JSON.stringify(state)}`);
    } catch (error) {
      report.navClicks.push({ label, expectedHash, passed: false, error: String(error).slice(0, 300) });
    }
  }
  await win.screenshot({ path: path.join(outDir, "last-route.png") });
  stopErrorCollection();
  await app.close();

  log("boot #2");
  ({ app, win, onboardingDismissed, stopErrorCollection } = await boot());
  report.boot2.onboardingDismissed = onboardingDismissed;
  const resultsButton = win.getByRole("button", { name: "结果", exact: true });
  await resultsButton.click({ timeout: 8000 });
  await win.waitForTimeout(500);
  report.boot2.results = await pageState(win);
  report.boot2.persisted = report.boot2.results.hash.includes("/results") && !report.boot2.results.disconnected && report.boot2.results.overflowX === 0;
  await win.screenshot({ path: path.join(outDir, "restart-results.png") });
  stopErrorCollection();
  await app.close();
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 1200);
}

const passedRoutes = report.navClicks.filter((entry) => entry.passed).length;
const pass = report.boot1.title === "OPC Studio" && passedRoutes === navItems.length && report.boot2.persisted === true && report.pageErrors.length === 0 && !report.error;
report.summary = { passedRoutes: `${passedRoutes}/${navItems.length}`, restarted: report.boot2.persisted === true, pageErrors: report.pageErrors.length, pass };
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
log(JSON.stringify({ outDir, ...report.summary }));
process.exit(pass ? 0 : 1);