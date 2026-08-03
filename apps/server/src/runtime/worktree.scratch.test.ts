import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import { createScratchDir, removeWorktree, type Worktree } from "./worktree.js";

// blocker 回归:同一 lead 下并行 noCode worker 的 id 经 sanitize+slice 后曾撞名(runId(8)+leadId
// 占满前缀、workerId 被截断)→ 落到同一 ~/opcwt/<dir> → 并发 rmSync 互删对方在写的 .md。
// 唯一性后缀必须保证:同一 id 多次创建得到互不相同的目录。
describe("createScratchDir 唯一性(blocker 回归)", () => {
  const made: Worktree[] = [];
  afterAll(() => { for (const wt of made) removeWorktree("", wt); });

  it("同一长 id 多次创建 → 目录互不相同(消除并发互删)", () => {
    const id = "abc12345-engineering-lead/frontend"; // 旧实现 slice(0,24) 会让三者撞同名
    const a = createScratchDir(id); made.push(a);
    const b = createScratchDir(id); made.push(b);
    const c = createScratchDir(id); made.push(c);
    expect(a.dir).not.toBe(b.dir);
    expect(b.dir).not.toBe(c.dir);
    expect(a.dir).not.toBe(c.dir);
  });

  it("返回目录真实存在、标记 scratch、非 git", () => {
    const wt = createScratchDir("run-x/lead/worker"); made.push(wt);
    expect(fs.existsSync(wt.dir)).toBe(true);
    expect(wt.scratch).toBe(true);
    expect(wt.isGit).toBe(false);
  });
});
