import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 令五.4 · Chat 英雄回路展示真实 task graph:任务档案详情页(TracePage)必须给绑定了 missionId 的 run
// 一个"查看任务图"入口,展开后拉真实拆解树(TaskGraphTree);图尚未生成/未拆解时显示诚实占位而非整块消失。
// web 无 DOM 测试基建 → 沿用 taskGraphTree.contract.test.ts 的源码契约做法锁住不变量。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const TRACE = read("TracePage.tsx");
const TREE = read("../components/common/TaskGraphTree.tsx");

describe("令五.4 · TracePage 任务图入口", () => {
  it("引入 TaskGraphTree,入口条件绑定 run 的 missionId", () => {
    expect(TRACE).toContain('import TaskGraphTree from "../components/common/TaskGraphTree.js"');
    // 入口只在 run 有 missionId(Chat 发起 / mission 派发)时出现:从 taskMeta 取 missionId 作条件
    expect(TRACE).toMatch(/taskMeta as[\s\S]{0,120}missionId[\s\S]{0,40}\?\.missionId/);
  });

  it("展开后渲染 TaskGraphTree 并传 showWhenEmpty(空图显示诚实占位而非消失)", () => {
    expect(TRACE).toMatch(/<TaskGraphTree[\s\S]{0,160}showWhenEmpty/);
    expect(TRACE).toContain("showTaskGraph"); // 折叠态存在
    expect(TRACE).toContain("tr={t}");
  });
});

describe("令五.4 · TaskGraphTree 诚实占位", () => {
  it("支持 showWhenEmpty:空图时渲染占位卡(taskGraph.empty),不再一律 return null", () => {
    expect(TREE).toContain("showWhenEmpty");
    expect(TREE).toContain("taskGraph.empty");
    expect(TREE).toMatch(/showWhenEmpty && \(!graph \|\| graph\.nodes\.length === 0\)/);
  });

  it("默认(未传 showWhenEmpty)仍是无图整卡不渲染(不回归 CEO 作战室契约)", () => {
    // taskGraphTree.contract.test.ts 依赖这行精确匹配,这里再锁一次防误删
    expect(TREE).toMatch(/if \(!graph \|\| graph\.nodes\.length === 0\) return null/);
  });
});

describe("令五.4 · 节点展示真实事实(角色/状态/依赖/重试/失败原因/产物/跳转 run)", () => {
  it("TaskGraphTree 仍展示条款要求的全部事实", () => {
    for (const marker of [
      "assignedRole", "dependsOn", "revisionCount", "node.error",
      "expectedArtifacts", "resultSummary", "open-task-run", "taskGraph.node.status.",
    ]) {
      expect(TREE, `TaskGraphTree 缺 ${marker}`).toContain(marker);
    }
  });
});
