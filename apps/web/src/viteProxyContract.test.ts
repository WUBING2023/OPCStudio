import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// MUP B5 · Vite proxy 回归契约:server 只绑 127.0.0.1(apps/server/src/index.ts 显式 IPv4 loopback),
// proxy 目标必须写 http://127.0.0.1:3100 —— Windows 上 localhost 可解析成 ::1,代理间歇失败会让
// "实时连接已断开"横幅在后端健康时长期滞留。组件无 DOM 测试基建,沿用 appShellI18n.test.ts 的
// 源码契约做法锁住不变量。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VITE_CONFIG = fs.readFileSync(path.join(HERE, "..", "vite.config.ts"), "utf-8");

describe("MUP B5 · vite.config.ts /api proxy 契约", () => {
  it("proxy 目标是 IPv4 字面量 127.0.0.1:3100(禁 localhost,server 只绑 IPv4 loopback)", () => {
    expect(VITE_CONFIG).toContain('API_PROXY_TARGET = "http://127.0.0.1:3100"');
    expect(VITE_CONFIG).not.toMatch(/localhost:3100/);
  });

  it("/api 前缀映射到 API_PROXY_TARGET", () => {
    expect(VITE_CONFIG).toMatch(/proxy:\s*\{\s*"\/api":\s*\{\s*target:\s*API_PROXY_TARGET/);
  });
});
