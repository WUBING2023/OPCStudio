import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 溯源(A)+ 员工可交互(B)的源码接线契约。纯逻辑另在 lib/messageAttribution.test.ts 用真实断言覆盖;
// 这里锁住"归属字段渲染 + 可点击落点"在各消息流渲染点的接线不变量(沿用 chatUx.contract.test.ts 做法)。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const BUBBLE = read("MessageBubble.tsx");
const DECOMP = read("DecomposerLine.tsx");
const BRIEF = read("../org/BriefingPanel.tsx");
const ARCH = read("../org/ArchitectChatPanel.tsx");
const LIB = read("../../lib/messageAttribution.ts");
const TASK_ROUTE = read("../../../../server/src/routes/taskRoutes.ts");
const ARCH_ROUTE = read("../../../../server/src/routes/architectRoutes.ts");
const DICTS = JSON.parse(read("../../i18n.dict.json")) as Record<string, Record<string, string>>;

describe("A · 系统消息溯源", () => {
  it("服务端 task/architect 拆解响应把 decomposer.agent.id 作为 agentId 透传(前端才有落点可点)", () => {
    expect(TASK_ROUTE).toContain("agentId: decomposer.agent.id");
    expect(ARCH_ROUTE).toContain("agentId: decomposer.agent.id");
  });
  it("MessageBubble 支持 attributedTo:带归属的系统消息显示产出者名/角色色 + '系统'小标", () => {
    expect(BUBBLE).toContain("attributedTo");
    expect(BUBBLE).toContain('variant === "system" && !!attributedTo?.name');
    expect(BUBBLE).toContain('tr("org.brief.systemName")'); // 系统小标复用既有词典键
  });
  it("BriefingPanel 派发结果(失败/成功/待审批)归属到该轮拆解产出者(decomposer)", () => {
    expect(BRIEF).toContain("attributionFromDecomposer(entry.decomposer)");
    // 三个派发分支都带 attributedTo
    expect(BRIEF.match(/kind: "system", attributedTo/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(BRIEF).toContain("attributedTo={en.attributedTo}");
  });
  it("真·系统消息(无归属)不设 attributedTo → 保留灰色'系统'身份(纯逻辑见 resolveBubbleIdentity)", () => {
    expect(LIB).toContain("systemTag: false");
    expect(LIB).toContain("resolveBubbleIdentity");
  });
});

describe("B · 员工可交互:发送者名/产出者名可点进单聊", () => {
  it("MessageBubble 发送者名与头像共用 onAvatarActivate(名字也可点,不只头像)", () => {
    const nameBlock = BUBBLE.slice(BUBBLE.indexOf("{displayName}") - 400, BUBBLE.indexOf("{displayName}"));
    expect(nameBlock).toContain("onClick={onAvatarActivate}");
    expect(nameBlock).toContain("onContextMenu={onAvatarActivate}");
  });
  it("DecomposerLine 的产出者名:能对应真实 agent 才可点,点击复用 cockpit-open-agent", () => {
    expect(DECOMP).toContain("isRealAgent");
    expect(DECOMP).toMatch(/cockpit-open-agent[\s\S]*agentId: decomposer\.agentId/);
    // 查无此人 → 退回纯文本,不做假链接
    expect(DECOMP).toContain("if (!clickable)");
  });
  it("BriefingPanel 消息流:能对应真实 agent 的发送者/产出者派发 cockpit-open-agent 进单聊", () => {
    expect(BRIEF).toContain("resolveBubbleIdentity(en, isRealAgent)");
    expect(BRIEF).toMatch(/cockpit-open-agent[\s\S]*agentId: id\.linkAgentId/);
    // agent 类事件条目带 agentId(发送者落点)
    expect(BRIEF).toContain("agentId: e.agentId");
  });
  it("两处方案卡(BriefingPanel/ArchitectChatPanel)都用 DecomposerLine 让产出者名可点", () => {
    expect(BRIEF).toContain("import DecomposerLine");
    expect(BRIEF).toContain("<DecomposerLine");
    expect(ARCH).toContain("import DecomposerLine");
    expect(ARCH).toContain("<DecomposerLine");
  });
});

describe("i18n · 溯源/交互复用的键 en/zh-CN 存在且非空", () => {
  const KEYS = ["org.brief.systemName", "chat.member.openChat", "org.brief.exec.byLead", "org.brief.exec.byCeoFallback", "arch.exec.byLead", "arch.exec.byCeoFallback"];
  it("键齐备", () => {
    for (const lang of ["en", "zh-CN"]) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });
  it("byLead / byCeoFallback 模板含 {name} 占位(DecomposerLine 按占位拆分嵌可点名字)", () => {
    for (const key of ["org.brief.exec.byLead", "org.brief.exec.byCeoFallback", "arch.exec.byLead", "arch.exec.byCeoFallback"]) {
      for (const lang of ["en", "zh-CN"]) {
        expect(DICTS[lang][key], `${lang} ${key} 缺 {name}`).toContain("{name}");
      }
    }
  });
});
