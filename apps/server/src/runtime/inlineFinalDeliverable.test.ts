import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inlineFinalDeliverable } from "./orchestrator.js";

// RC3 回归测试:lead 把报告写进文件、只回指针时,把真 .md 报告内联进 report.md。
// 关键护栏(实测教训):绝不能误抓 worker 误建 Python 环境里的大文件(曾把 6.4MB changelog.html 当报告)。
describe("inlineFinalDeliverable (RC3)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-"));
    fs.writeFileSync(path.join(dir, "report.md"), "# 真实研究报告\n\n" + "正文段落。".repeat(200));
    fs.mkdirSync(path.join(dir, "Python", "pythoncore-3.14-64"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Python", "pythoncore-3.14-64", "changelog.html"), "<html>" + "x".repeat(100000) + "</html>");
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it("指针指向 .md 时内联真报告,不抓更大的 Python html", () => {
    const pointer = "研究报告已完成并保存至:`" + path.join(dir, "report.md") + "`";
    const out = inlineFinalDeliverable(pointer, [], dir);
    expect(out).toContain("真实研究报告");
    expect(out).not.toContain("changelog");
    expect(out).not.toContain("<html>");
  });

  it("fileChanges 里有大 html 也不抓(只认 .md、排环境目录)", () => {
    const fc = [
      { path: "Python/pythoncore-3.14-64/changelog.html", changeType: "create" },
      { path: "report.md", changeType: "create" },
    ];
    const out = inlineFinalDeliverable("报告已生成。", fc as never, dir);
    expect(out).not.toContain("<html>");
    expect(out).toContain("真实研究报告");
  });

  it("正常长报告(非指针)原样返回,不被改动", () => {
    const realReport = "# 完整最终报告\n\n" + "这是直接写出的正文内容。".repeat(300);
    const out = inlineFinalDeliverable(realReport, [], dir);
    expect(out).toBe(realReport);
  });

  it("指向超大 .md(>500KB)时不内联(防把巨文件当报告)", () => {
    fs.writeFileSync(path.join(dir, "huge.md"), "#".repeat(600000));
    const pointer = "已保存至 `" + path.join(dir, "huge.md") + "`";
    const out = inlineFinalDeliverable(pointer, [], dir);
    expect(out).toBe(pointer); // 超限不读 → 原样
  });
});
