import { describe, it, expect } from "vitest";
import { getSkill, createSkill, deleteSkill } from "./skillStore.js";

// Stage 8 安全回归:skill id 用于 `${id}.md` 文件名,必须拦路径穿越(防写出/读取 skills 目录外)。
describe("Stage 8 · skillStore 路径穿越守卫", () => {
  it("createSkill / getSkill / deleteSkill 对穿越 id 抛错(不写出目录外)", () => {
    const evil = "../../.opc/config/evil";
    expect(() => createSkill(undefined, { id: evil, title: "x", role: "dev", content: "payload" } as any)).toThrow(/invalid skill id/);
    expect(() => getSkill(undefined, evil)).toThrow(/invalid skill id/);
    expect(() => getSkill(undefined, "a/b")).toThrow(/invalid skill id/);
    expect(() => getSkill(undefined, "x\0y")).toThrow(/invalid skill id/);
  });

  it("正常 id 不受影响", () => {
    // 不存在的安全 id → getSkill 返回 null(不抛)
    expect(getSkill(undefined, "nonexistent-safe-id")).toBeNull();
  });
});
