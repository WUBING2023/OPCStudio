import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { archiveReport } from "./projectStore.js";

// MUP B7 · 团队归档报告(.opc/reports/<leadId>/*.md)与 run 级 report.md 同口径脱敏:
// 写盘前过 redactSecrets(storage 层收口,orchestrator 两个调用点一次覆盖)。

describe("archiveReport — 写盘前密钥脱敏", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-report-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("leadSummary 含密钥 → 归档 md 落盘为 [REDACTED],正文其余内容保留", () => {
    const md = "# 报告\n\n引擎错误:Invalid API key: sk-46d6d77debaa4153ba9055e9\n\n正文结论。";
    const filename = archiveReport(root, "lead-1", "test goal", md);
    const written = fs.readFileSync(path.join(root, ".opc", "reports", "lead-1", filename), "utf-8");
    expect(written).not.toContain("sk-46d6");
    expect(written).toContain("[REDACTED]");
    expect(written).toContain("正文结论。");
  });

  it("无密钥内容零改动", () => {
    const md = "# 跨团队工作报告\n\n一切正常。";
    const filename = archiveReport(root, "__cross-team", "another goal", md);
    const written = fs.readFileSync(path.join(root, ".opc", "reports", "__cross-team", filename), "utf-8");
    expect(written).toBe(md);
  });
});
