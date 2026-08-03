import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// P1-5 · chatTask 接派发队列的前端契约(纯 node vitest,无 DOM 基建 —— 沿用 appShellI18n /
// governanceApprovalContract 的源码契约做法)。锁住:撞上单 run 互斥闸(chatTask 返回 queued:true)
// 时,聊天流各入口都如实回一条"已排队#N"系统消息(走 org.brief.taskQueued 词典键,不假报"已派任务"),
// 且新增的 org.brief.taskQueued 键 11 语言全覆盖。
// 注:撤单中性态"已撤销"(trace.status.cancelled)的落点在 trace 徽章体系(resolveBadge / traceTypes.ts),
// 属本泳道文件域外(禁碰 trace 组件),故本轮不落该键/断言——见交付说明的 blocker。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const USE_TASK_CHAT = read("lib/useTaskChat.ts");
const LAUNCH_PAD = read("components/LaunchPad.tsx");
const COCKPIT = read("pages/CockpitPage.tsx");
const CLIENT = read("api/client.ts");
const DICTS = JSON.parse(read("i18n.dict.json")) as Record<string, Record<string, string>>;
const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];

describe("P1-5 · chatTask 撞忙入队的前端回执", () => {
  it("ChatTaskResponse 暴露 queued / queuePosition", () => {
    expect(CLIENT).toMatch(/queued\?:\s*boolean/);
    expect(CLIENT).toMatch(/queuePosition\?:\s*number/);
  });

  it("三个派发入口都检查 r.queued 并用 org.brief.taskQueued 文案", () => {
    for (const [name, src] of [
      ["useTaskChat", USE_TASK_CHAT], ["LaunchPad", LAUNCH_PAD], ["CockpitPage", COCKPIT],
    ] as const) {
      expect(src, `${name} 缺少 r.queued 分支`).toMatch(/\.queued\b/);
      expect(src, `${name} 缺少 org.brief.taskQueued 文案`).toContain("org.brief.taskQueued");
    }
  });

  it("queued 分支在 approvalRequired 判定之后(先拦审批,再报排队,不假报已派)", () => {
    for (const src of [USE_TASK_CHAT, LAUNCH_PAD, COCKPIT]) {
      expect(src.indexOf(".approvalRequired")).toBeGreaterThan(-1);
      expect(src.indexOf(".approvalRequired")).toBeLessThan(src.indexOf(".queued"));
    }
  });
});

describe("P1-5 · 新增 i18n 键 11 语言全覆盖", () => {
  it("org.brief.taskQueued 各语言非空", () => {
    for (const lang of LANGS) {
      for (const key of ["org.brief.taskQueued"]) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("org.brief.taskQueued 各语言保留 {position} / {id} 占位符", () => {
    for (const lang of LANGS) {
      for (const ph of ["{position}", "{id}"]) {
        expect(DICTS[lang]["org.brief.taskQueued"], `${lang} taskQueued 缺 ${ph}`).toContain(ph);
      }
    }
  });
});
