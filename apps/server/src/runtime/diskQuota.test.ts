import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dirSizeExceeds } from "./diskQuota.js";

// P6 真隔离:配额看门狗的核心判断——dir 总字节超过 limit 就触发(短路、不抛)。
describe("dirSizeExceeds (P6 磁盘配额看门狗)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "p6quota-"));
    fs.writeFileSync(path.join(dir, "small.txt"), "x".repeat(1000));
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "big.bin"), Buffer.alloc(2 * 1024 * 1024)); // 2MB
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it("总量在配额内 → false", () => {
    expect(dirSizeExceeds(dir, 10 * 1024 * 1024)).toBe(false); // 限 10MB,实际 ~2MB
  });

  it("总量超配额(含子目录)→ true", () => {
    expect(dirSizeExceeds(dir, 1 * 1024 * 1024)).toBe(true); // 限 1MB,实际 ~2MB
  });

  it("不存在的目录 → false 且不抛", () => {
    expect(() => dirSizeExceeds(path.join(dir, "nope"), 1)).not.toThrow();
    expect(dirSizeExceeds(path.join(dir, "nope"), 1)).toBe(false);
  });

  it("限额为 0 → 任何非空目录都 true", () => {
    expect(dirSizeExceeds(dir, 0)).toBe(true);
  });
});
