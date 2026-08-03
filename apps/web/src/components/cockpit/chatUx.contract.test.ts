import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 对话 UX 三件套(自适应输入框 / 消息复制 / 群聊成员头像菜单)的源码契约。组件无 DOM 测试基建
// (纯 node vitest),沿用 citedMemories.contract.test.ts 的源码契约做法锁住关键接线不变量;高度
// 计算的纯函数逻辑另在 lib/autoGrowTextarea.test.ts 用真实断言覆盖。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const CHAT = read("ChatThread.tsx");
const MENU = read("MemberAvatarMenu.tsx");
const BUBBLE = read("../common/MessageBubble.tsx");
const COPY = read("../common/CopyButton.tsx");
const AUTOGROW = read("../common/AutoGrowTextarea.tsx");
const COCKPIT = read("../../pages/CockpitPage.tsx");
const ARCH = read("../org/ArchitectChatPanel.tsx");
const BRIEF = read("../org/BriefingPanel.tsx");
const LAUNCH = read("../LaunchPad.tsx");
const DICTS = JSON.parse(read("../../i18n.dict.json")) as Record<string, Record<string, string>>;

const KEYS = ["chat.copy", "chat.copied", "chat.member.openConfig", "chat.member.openChat"];

describe("A · 自适应输入框:两处对话框共用同一份 AutoGrowTextarea", () => {
  it("AutoGrowTextarea 走纯函数 computeAutoGrowHeight 算高度", () => {
    expect(AUTOGROW).toContain("computeAutoGrowHeight");
    expect(AUTOGROW).toContain("scrollHeight");
  });
  it("工作台对话框(CockpitPage)用 AutoGrowTextarea 且封顶 6 行,不再用裸 textarea", () => {
    expect(COCKPIT).toContain("import AutoGrowTextarea");
    expect(COCKPIT).toMatch(/<AutoGrowTextarea[\s\S]*maxRows=\{6\}/);
    expect(COCKPIT).not.toMatch(/<textarea\b/);
  });
  it("架构/任务对话框(ArchitectChatPanel)用 AutoGrowTextarea 且封顶 6 行,不再用裸 textarea", () => {
    expect(ARCH).toContain("import AutoGrowTextarea");
    expect(ARCH).toMatch(/<AutoGrowTextarea[\s\S]*maxRows=\{6\}/);
    expect(ARCH).not.toMatch(/<textarea\b/);
  });
  // 用户实测漏网:与 CEO 对话的输入框其实在简报栏(BriefingPanel),派单入口在 LaunchPad——上一轮只改了
  // 工作台/架构两处,契约测试也只测那两处,于是"通过"了却没生效。四个对话/派单输入口一并锁死。
  it("简报栏 CEO 对话框(BriefingPanel)用 AutoGrowTextarea 且封顶 6 行,不再用裸 textarea", () => {
    expect(BRIEF).toContain("import AutoGrowTextarea");
    expect(BRIEF).toMatch(/<AutoGrowTextarea[\s\S]*maxRows=\{6\}/);
    expect(BRIEF).not.toMatch(/<textarea\b/);
  });
  it("派单入口(LaunchPad)用 AutoGrowTextarea 且封顶 6 行,不再用裸 textarea", () => {
    expect(LAUNCH).toContain("import AutoGrowTextarea");
    expect(LAUNCH).toMatch(/<AutoGrowTextarea[\s\S]*maxRows=\{6\}/);
    expect(LAUNCH).not.toMatch(/<textarea\b/);
  });
});

describe("B · 消息可复制:气泡挂 CopyButton,点击复制 + 1.5s 反馈", () => {
  it("CopyButton 调 navigator.clipboard.writeText,复制态 1500ms 后复位", () => {
    expect(COPY).toContain("navigator.clipboard");
    expect(COPY).toContain("writeText");
    expect(COPY).toContain("1500");
  });
  it("CopyButton 文案走 i18n(chat.copy / chat.copied),不硬编码", () => {
    expect(COPY).toContain('tr("chat.copied")');
    expect(COPY).toContain('tr("chat.copy")');
  });
  it("MessageBubble 在非卡片气泡挂复制按钮(复制原文 safeContent)", () => {
    expect(BUBBLE).toContain("import CopyButton");
    expect(BUBBLE).toMatch(/<CopyButton[\s\S]*text=\{safeContent\}/);
  });
  it("用户紫气泡(LocalBubble)也挂复制按钮复制原文", () => {
    expect(CHAT).toContain("import CopyButton");
    expect(CHAT).toMatch(/<CopyButton\s+text=\{m\.text\}/);
  });
});

describe("C · 群聊成员头像菜单:进入配置 / 进入对话", () => {
  it("MessageBubble 头像支持左键+右键激活回调(右键 preventDefault 由调用方处理)", () => {
    expect(BUBBLE).toContain("onAvatarActivate");
    expect(BUBBLE).toContain("onClick={onAvatarActivate}");
    expect(BUBBLE).toContain("onContextMenu={onAvatarActivate}");
  });
  it("ChatThread 仅群模式对真实成员启用菜单(非成员/系统卡返回 undefined)", () => {
    expect(CHAT).toContain("import MemberAvatarMenu");
    expect(CHAT).toContain("menuFor");
    expect(CHAT).toContain("<MemberAvatarMenu");
    expect(CHAT).toContain("e.preventDefault();"); // 右键激活时阻止默认菜单
  });
  it("进入配置:预置 org 公司 + select(agentId) + 跳 org 页(opc-navigate)", () => {
    expect(MENU).toContain('localStorage.setItem("opc-org-company"');
    expect(MENU).toContain("select(menu.agentId)");
    expect(MENU).toMatch(/opc-navigate[\s\S]*page:\s*"org"/);
  });
  it("进入对话:复用 cockpit-open-agent 跨页契约", () => {
    expect(MENU).toMatch(/cockpit-open-agent[\s\S]*agentId:\s*menu\.agentId/);
  });
  it("菜单点外/右键/Esc 关闭", () => {
    expect(MENU).toContain('window.addEventListener("click", close)');
    expect(MENU).toContain('window.addEventListener("contextmenu", close)');
    expect(MENU).toContain('e.key === "Escape"');
  });
  it("CockpitPage 收到 cockpit-open-agent 时清空群选中(回到 1:1)", () => {
    expect(COCKPIT).toMatch(/addEventListener\("cockpit-open-agent"/);
    expect(COCKPIT).toContain("setActiveGroup(null)");
  });
});

describe("i18n · 三件套四键 en/zh-CN 存在且非空", () => {
  it("chat.copy / chat.copied / chat.member.openConfig / chat.member.openChat", () => {
    for (const lang of ["en", "zh-CN"]) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });
});
