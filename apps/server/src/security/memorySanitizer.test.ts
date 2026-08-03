import { describe, it, expect } from "vitest";
import { sanitizeMemoryText, isSafeToShare } from "./memorySanitizer.js";

describe("memorySanitizer · sanitizeMemoryText", () => {
  it("确实脱敏了已知公司名/员工名(替换成占位符,不残留原名)", () => {
    const { text, safeToShare } = sanitizeMemoryText({
      text: "OPC科技的员工吴斌在跟进这个项目,负责人是吴斌。",
      companyNames: ["OPC科技"],
      memberNames: ["吴斌"],
    });
    expect(text).not.toContain("OPC科技");
    expect(text).not.toContain("吴斌");
    expect(text).toContain("某公司");
    expect(text).toContain("某成员");
    expect(safeToShare).toBe(true);
  });

  it("长名字优先于其子串替换,不留下错位残片(如公司名整体消失,不留半截)", () => {
    const { text } = sanitizeMemoryText({
      text: "ACME Robotics 与 ACME 是同一家公司",
      companyNames: ["ACME", "ACME Robotics"],
    });
    expect(text).not.toContain("ACME");
  });

  it("确实没脱敏该保留的方法论内容(通用教训文本原样保留)", () => {
    const lesson = "超时任务应优先拆分为更小的子任务,而不是简单延长 timeout;先写测试再实现可以显著减少返工。";
    const { text, safeToShare } = sanitizeMemoryText({ text: lesson, companyNames: ["某公司名"], memberNames: ["张三"] });
    expect(text).toBe(lesson);
    expect(safeToShare).toBe(true);
  });

  it("绝对路径(Windows 盘符 / 类 Unix)被替换为占位符", () => {
    const winResult = sanitizeMemoryText({ text: `报告存放在 C:\\Users\\wubin\\project\\out.md` });
    expect(winResult.text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(winResult.text).toContain("[路径已隐去]");
    expect(winResult.safeToShare).toBe(true);

    const unixResult = sanitizeMemoryText({ text: "配置文件在 /etc/passwd 需要小心处理" });
    expect(unixResult.text).not.toContain("/etc/passwd");
    expect(unixResult.text).toContain("[路径已隐去]");
    expect(unixResult.safeToShare).toBe(true);
  });

  it("邮箱 / 中国大陆手机号被替换为占位符", () => {
    const r = sanitizeMemoryText({ text: "联系方式:p0105@example.com,电话 13800001111" });
    expect(r.text).not.toContain("p0105@example.com");
    expect(r.text).not.toContain("13800001111");
    expect(r.text).toContain("[邮箱已隐去]");
    expect(r.text).toContain("[手机号已隐去]");
    expect(r.safeToShare).toBe(true);
  });

  it("空/非字符串输入不抛错", () => {
    expect(sanitizeMemoryText({ text: "" }).text).toBe("");
    expect(() => sanitizeMemoryText({ text: undefined as unknown as string })).not.toThrow();
  });
});

describe("memorySanitizer · isSafeToShare 判定逻辑", () => {
  it("干净的方法论文本 → true", () => {
    expect(isSafeToShare("先写测试再实现,可以显著减少返工")).toBe(true);
  });

  it("仍含疑似绝对路径残留 → false(即便没有已知名单命中)", () => {
    expect(isSafeToShare(`C:\\Users\\someone\\file.ts 未被脱敏`)).toBe(false);
    expect(isSafeToShare("/home/someone/project/secret.txt 未被脱敏")).toBe(false);
  });

  it("仍含疑似邮箱/手机号残留 → false", () => {
    expect(isSafeToShare("联系 a@b.com")).toBe(false);
    expect(isSafeToShare("电话 13900001234")).toBe(false);
  });

  it("已知名称仍原样出现在文本里 → false(即便不含路径/邮箱)", () => {
    expect(isSafeToShare("OPC科技负责这个项目", ["OPC科技"])).toBe(false);
    expect(isSafeToShare("已经替换成某公司了", ["OPC科技"])).toBe(true);
  });

  it("sanitizeMemoryText 内部复用同一判定:脱敏干净后 safeToShare 应为 true", () => {
    const { safeToShare } = sanitizeMemoryText({
      text: "OPC科技的 C:\\Users\\wubin\\a.ts 由吴斌负责,联系 a@b.com",
      companyNames: ["OPC科技"], memberNames: ["吴斌"],
    });
    expect(safeToShare).toBe(true);
  });
});
