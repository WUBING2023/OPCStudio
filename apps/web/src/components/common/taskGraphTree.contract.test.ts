import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// B6 · 任务图前端接通(契约 Gate B#6)。web 无 DOM 测试基建 → 按 governanceApprovalContract.test.ts
// 同款 fs 源码契约锁住三个不变量:
//   ① 「等待任务图上线」占位卡被真实拆解树(TaskGraphTree)替换,占位键从词典删除;
//   ② 任务图路径产品可达:approveMission 可透传 dispatchMode:"task-graph",422 errors 如实展示;
//   ③ 新增文案键 11 语言全覆盖(含参数占位符)。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const TREE = read("TaskGraphTree.tsx");
const COCKPIT = read("CeoCockpit.tsx");
const CLIENT = read("../../api/client.ts");
const BRIEF_CARD = read("../org/MissionBriefCard.tsx");
const CAPABILITY = read("../capability/CapabilityOverview.tsx");
const DICTS = JSON.parse(read("../../i18n.dict.json")) as Record<string, Record<string, string>>;
const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];

describe("B6 · 占位卡删除,真实拆解树上线", () => {
  it("CeoCockpit 不再渲染「等待任务图上线」占位卡,改挂 TaskGraphTree", () => {
    expect(COCKPIT).not.toContain("org.ceo.tree.placeholder");
    expect(COCKPIT).toContain("TaskGraphTree");
    expect(COCKPIT).toMatch(/mission && <TaskGraphTree missionId=\{mission\.id\}/);
  });

  it("占位键已从词典所有语言删除(MUP 点名禁止的内容不留尸体)", () => {
    for (const lang of LANGS) {
      expect(DICTS[lang]?.["org.ceo.tree.placeholder"], `${lang} 仍有占位键`).toBeUndefined();
    }
  });

  it("TaskGraphTree 消费真实读 API + task_node_* 事件增量刷新;无图整卡不渲染", () => {
    expect(TREE).toContain("getMissionTaskGraph");
    expect(TREE).toContain("task_node_started");
    expect(TREE).toContain("task_node_finished");
    // 404/取数失败 → null;null/空图 → return null(绝不渲染空态假装有数据)
    expect(TREE).toMatch(/catch\(\(\) => setGraph\(null\)\)/);
    expect(TREE).toMatch(/if \(!graph \|\| graph\.nodes\.length === 0\) return null/);
  });

  it("节点行展示条款要求的全部事实:状态/角色/依赖/返工/失败原因/产物/跳转 run", () => {
    for (const marker of [
      "taskGraph.node.status.", "assignedRole", "dependsOn", "revisionCount",
      "node.error", "expectedArtifacts", "resultSummary", "open-task-run",
    ]) {
      expect(TREE, `TaskGraphTree 缺 ${marker}`).toContain(marker);
    }
  });
});

describe("B6 · 任务图派发路径产品可达", () => {
  it("client.approveMission 支持 dispatchMode:\"task-graph\",响应带图快照;getMissionTaskGraph 存在", () => {
    expect(CLIENT).toMatch(/dispatchMode\?: "task-graph"/);
    expect(CLIENT).toMatch(/taskGraphId\?: string/);
    expect(CLIENT).toContain("getMissionTaskGraph");
    expect(CLIENT).toMatch(/\/missions\/\$\{encodeURIComponent\(id\)\}\/task-graph/);
  });

  it("MissionBriefCard 提供任务图派发选项(复杂 mission 默认勾选),approve 透传 dispatchMode", () => {
    expect(BRIEF_CARD).toContain("org.brief.mission.taskGraphOption");
    expect(BRIEF_CARD).toMatch(/dispatchMode: "task-graph"/);
    // 复杂度 L/XL 或多部门默认走图
    expect(BRIEF_CARD).toContain("complexityEstimate?.complexity");
    expect(BRIEF_CARD).toContain("requiredDepartments.length > 1");
  });

  it("422 校验失败的 errors 数组如实展示(不折叠成一句笼统失败)", () => {
    expect(CLIENT).toMatch(/errors\?: string\[\]/); // ApiError 透出结构化 errors
    expect(BRIEF_CARD).toMatch(/\(e as ApiError\)\?\.errors/);
    expect(BRIEF_CARD).toMatch(/errs\.join/);
  });
});

describe("B6 · A2A resolved 闭环真数据", () => {
  it("client 有 /runs/:id/a2a-messages 读侧函数;CapabilityOverview 消费并保留诚实占位回退", () => {
    expect(CLIENT).toMatch(/\/runs\/\$\{encodeURIComponent\(runId\)\}\/a2a-messages/);
    expect(CAPABILITY).toContain("getRunA2AMessages");
    expect(CAPABILITY).toContain("countA2AResolved");
    // 宪法:取数失败仍走 PendingBadge 占位,不显示 0 冒充真值
    expect(CAPABILITY).toContain('"capability.card.pending"');
    expect(CAPABILITY).toContain("capability.card.a2a.resolved");
  });
});

describe("B6 · i18n 新键 11 语言全覆盖", () => {
  const NODE_STATUSES = [
    "pending", "planned", "running", "blocked", "waiting_review",
    "needs_revision", "completed", "accepted", "failed", "cancelled",
  ];
  const GRAPH_STATUSES = ["proposed", "committed", "running", "completed", "failed", "cancelled"];
  const KEYS = [
    "org.ceo.tree.title",
    ...NODE_STATUSES.map(s => `taskGraph.node.status.${s}`),
    ...GRAPH_STATUSES.map(s => `taskGraph.status.${s}`),
    "taskGraph.node.retries", "taskGraph.node.dependsOn", "taskGraph.node.viewRun",
    "org.brief.mission.taskGraphOption", "org.brief.mission.taskGraphDispatched",
  ];

  it("全部键各语言非空", () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("带参数的键在各语言保留占位符", () => {
    for (const lang of LANGS) {
      expect(DICTS[lang]["taskGraph.node.retries"], `${lang} retries 缺 {n}`).toContain("{n}");
      expect(DICTS[lang]["taskGraph.node.dependsOn"], `${lang} dependsOn 缺 {list}`).toContain("{list}");
      expect(DICTS[lang]["org.brief.mission.taskGraphDispatched"], `${lang} dispatched 缺 {n}`).toContain("{n}");
    }
  });
});
