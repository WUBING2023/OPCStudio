import { describe, it, expect } from "vitest";
import { evaluateDirtyPreflight } from "./workspace.js";

// 五.2(收口作战令)· 脏树 preflight 纯函数验收:解析 git status --porcelain、排除 .opc、
// 编码任务遇脏树 block=true。

describe("evaluateDirtyPreflight", () => {
  it("干净工作树(空输出)→ dirty=false, block=false", () => {
    expect(evaluateDirtyPreflight("", true)).toEqual({ dirty: false, block: false, files: [], fileCount: 0 });
    expect(evaluateDirtyPreflight("\n  \n", true)).toEqual({ dirty: false, block: false, files: [], fileCount: 0 });
  });

  it("脏 + 编码任务(requiresCode=true)→ block=true,列出文件", () => {
    const porcelain = " M src/app.ts\n?? new.txt\nA  added.js";
    const r = evaluateDirtyPreflight(porcelain, true);
    expect(r.dirty).toBe(true);
    expect(r.block).toBe(true);
    expect(r.fileCount).toBe(3);
    expect(r.files).toEqual(["src/app.ts", "new.txt", "added.js"]);
  });

  it("脏 + 非编码任务(requiresCode=false)→ dirty=true 但 block=false", () => {
    const r = evaluateDirtyPreflight(" M src/app.ts", false);
    expect(r.dirty).toBe(true);
    expect(r.block).toBe(false);
    expect(r.files).toEqual(["src/app.ts"]);
  });

  it(".opc 元数据被排除(不算用户脏文件)", () => {
    const porcelain = "?? .opc/runs/x.json\n M .opc\n M src/real.ts";
    const r = evaluateDirtyPreflight(porcelain, true);
    expect(r.files).toEqual(["src/real.ts"]);
    expect(r.fileCount).toBe(1);
    expect(r.block).toBe(true);
  });

  it("仅 .opc 脏 → 视为干净(不拦编码任务)", () => {
    const r = evaluateDirtyPreflight("?? .opc/runs/x.json\n M .opc/config.json", true);
    expect(r.dirty).toBe(false);
    expect(r.block).toBe(false);
  });

  it("rename 记录取目标路径,带引号路径去引号", () => {
    const porcelain = 'R  old/a.ts -> new/b.ts\n?? "spaced name.txt"';
    const r = evaluateDirtyPreflight(porcelain, true);
    expect(r.files).toEqual(["new/b.ts", "spaced name.txt"]);
  });

  it("CRLF 行尾正确解析", () => {
    const r = evaluateDirtyPreflight(" M a.ts\r\n?? b.ts\r\n", true);
    expect(r.files).toEqual(["a.ts", "b.ts"]);
  });
});
