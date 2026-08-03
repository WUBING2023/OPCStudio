import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";

describe("jsonFile 原子写 + 损坏读取兜底", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("writeJSON 落盘后不留 tmp 文件,readJSON 能读回原值", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jf-"));
    const f = path.join(root, "sub", "data.json");
    writeJSON(f, { a: 1 });
    expect(readJSON(f, {})).toEqual({ a: 1 });
    const leftover = fs.readdirSync(path.join(root, "sub")).filter((n) => n.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });

  it("writeJSON 覆盖已存在文件(模拟重复保存)结果仍是最新值,无残留 tmp", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jf-"));
    const f = path.join(root, "data.json");
    writeJSON(f, { v: 1 });
    writeJSON(f, { v: 2 });
    expect(readJSON(f, {})).toEqual({ v: 2 });
    const leftover = fs.readdirSync(root).filter((n) => n.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });

  it("文件不存在 → 直接回退 fallback,不产生 .corrupt 存证", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jf-"));
    const f = path.join(root, "missing.json");
    expect(readJSON(f, { x: 1 })).toEqual({ x: 1 });
    expect(fs.existsSync(root) && fs.readdirSync(root).length).toBe(0);
  });

  it("JSON 损坏(截断)→ 存证为 .corrupt-<ts> 副本 + 回退 fallback,且不把 fallback 立即回写原文件", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "jf-"));
    const f = path.join(root, "agents.json");
    fs.writeFileSync(f, '[{"id":"a1","name":"trunc', "utf-8"); // 模拟进程中途被杀截断的半截 JSON

    const got = readJSON(f, [] as unknown[]);
    expect(got).toEqual([]);

    const files = fs.readdirSync(root);
    expect(files).toContain("agents.json");
    const corrupt = files.find((n) => n.startsWith("agents.json.corrupt-"));
    expect(corrupt).toBeTruthy();
    expect(fs.readFileSync(path.join(root, corrupt!), "utf-8")).toBe('[{"id":"a1","name":"trunc');

    // 原文件必须原样保留损坏内容 —— 没有被静默回写成 "[]"(否则救援副本就没意义了)。
    expect(fs.readFileSync(f, "utf-8")).toBe('[{"id":"a1","name":"trunc');
  });
});
