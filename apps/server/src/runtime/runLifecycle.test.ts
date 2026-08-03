import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Run } from "@opc/shared";
import {
  precreateRunTask, markPrecreatedRunFailed,
  decideAndRecordRunGovernance, approveGovernanceForRun, checkGovernanceDispatch,
} from "./runLifecycle.js";
import { getGovernanceRecord, setGovernanceApproval } from "../storage/governanceStore.js";

// A3:Run.status 十态扩展后的向后兼容验证——旧路径(markPrecreatedRunFailed 的守卫逻辑)读到
// 六个新值(planned/blocked/waiting_review/needs_revision/accepted/cancelled)时必须安全降级,
// 不抛错、不错误覆盖一个已经推进到"非 running/pending"状态的 run。

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "run-lifecycle-"));
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

function readTask(runId: string): Run {
  return JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", runId, "task.json"), "utf-8"));
}

describe("markPrecreatedRunFailed — Run.status 十态向后兼容(旧路径读新值不炸)", () => {
  it("旧四态:status=running → 正常降级为 failed", () => {
    precreateRunTask(root, { runId: "r1", goal: "g" });
    markPrecreatedRunFailed(root, "r1", new Error("boom"));
    expect(readTask("r1").status).toBe("failed");
  });

  it.each(["planned", "blocked", "waiting_review", "needs_revision", "accepted", "cancelled"] as const)(
    "新值 status=%s → 守卫判定为「已推进」,不抛错、不覆盖成 failed",
    (newStatus) => {
      precreateRunTask(root, { runId: "r2", goal: "g" });
      const existing = readTask("r2");
      existing.status = newStatus; // 模拟旧代码路径读到一个来自新场景的 run.status
      fs.writeFileSync(path.join(root, ".opc", "runs", "r2", "task.json"), JSON.stringify(existing));

      expect(() => markPrecreatedRunFailed(root, "r2", new Error("boom"))).not.toThrow();
      // 守卫 `!== "running" && !== "pending"` 对任何新值都成立 → 提前 return,不覆盖
      expect(readTask("r2").status).toBe(newStatus);
    },
  );

  it("新值 status=pending 场景下(理论上不会出现,但穷举安全性)仍会被判定为可覆盖", () => {
    precreateRunTask(root, { runId: "r3", goal: "g" });
    const existing = readTask("r3");
    existing.status = "pending";
    fs.writeFileSync(path.join(root, ".opc", "runs", "r3", "task.json"), JSON.stringify(existing));
    markPrecreatedRunFailed(root, "r3", new Error("boom"));
    expect(readTask("r3").status).toBe("failed");
  });
});

describe("precreateRunTask — E4 网关的 pending 预建", () => {
  it("status:'pending' 落 pending(被 L3 网关拦下的 run 还没开工,不冒充 running)", () => {
    precreateRunTask(root, { runId: "rp", goal: "g", status: "pending" });
    expect(readTask("rp").status).toBe("pending");
  });
  it("缺省仍是 running(旧行为逐字节)", () => {
    precreateRunTask(root, { runId: "rr", goal: "g" });
    expect(readTask("rr").status).toBe("running");
  });
});

// E3 · run 启动钩子:判级 + 落 record(输入取数走真实盘:agents.json / mcp_servers.json / goal 文本)。
describe("decideAndRecordRunGovernance — 判级钩子", () => {
  function writeAgents(n: number, framework = "hermes") {
    const agents = Array.from({ length: n }, (_, i) => ({
      id: `a${i}`, name: `A${i}`, role: i === 0 ? "ceo" : "dev", childrenIds: [],
      model: "m", provider: "deepseek", framework, companyId: "default",
      status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
      editable: true, deletable: true, enabled: true,
    }));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents));
  }

  it("短的只读 goal + 无 agents/MCP → L0,record 落盘且 reason 非空", () => {
    const rec = decideAndRecordRunGovernance(root, { runId: "g0", goal: "今天天气如何" });
    expect(rec.level).toBe("L0");
    expect(rec.reason.length).toBeGreaterThan(0);
    expect(getGovernanceRecord(root, "g0")?.level).toBe("L0");
    expect(rec.approvalRequired).toBeUndefined();
  });

  it("中等研究 goal(估算 M 档)→ 规则 L0 被预估抬到 L1", () => {
    // ≥80 字(+1)+ 调研/分析关键词(+1)→ score 2 → M 档 → 预估监督等级 1;规则侧无信号 L0 → 取较严格者 L1。
    const goal = "请深入调研国内三家主要云厂商的对象存储定价策略并输出对比结论,"
      + "覆盖标准存储、低频存储与归档存储三个档位的定价与流量费用,"
      + "并给出近一年价格变化趋势与选型建议,最终写成一份面向管理层的评测报告。";
    const rec = decideAndRecordRunGovernance(root, { runId: "g1", goal });
    expect(rec.level).toBe("L1");
    expect(rec.reason.join()).toContain("取较严格者");
  });

  it("代码 goal → 写文件规则 L1 + 预估代码档 2 → L2", () => {
    const rec = decideAndRecordRunGovernance(root, { runId: "g2", goal: "帮我重构这个函数的接口" });
    expect(rec.level).toBe("L2");
    expect(rec.inputs.writesFiles).toBe(true);
  });

  it("显式 shell 信号 → L3 + approvalRequired + approval_requested 事件", () => {
    const rec = decideAndRecordRunGovernance(root, { runId: "g3", goal: "整理一下下载目录", involvesShell: true });
    expect(rec.level).toBe("L3");
    expect(rec.approvalRequired).toBe(true);
    expect(rec.approval?.status).toBe("pending");
    expect(rec.events.some(e => e.kind === "approval_requested")).toBe(true);
  });

  it("mcp_servers.json 有 enabled server 且未显式传 involvesMcp → 判 MCP 涉入 → ≥L2", () => {
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "mcp_servers.json"), JSON.stringify([{ id: "s1", enabled: true }]));
    const rec = decideAndRecordRunGovernance(root, { runId: "g4", goal: "查个资料" });
    expect(rec.level).toBe("L2");
    expect(rec.inputs.involvesMcp).toBe(true);
  });

  it("公司 agents 的 framework 进入输入摘要;≥8 人 + 长代码研究 goal → 估算 XL → L3", () => {
    writeAgents(8);
    const goal = ("请全面调研分析并重构我们数据管道的 python 代码," + "细化每个模块的接口与验收标准。").repeat(25); // 稳超 800 字 → 长度规则满分
    const rec = decideAndRecordRunGovernance(root, { runId: "g5", goal, pendingDispatch: { goal, runType: "quick" } });
    expect(rec.level).toBe("L3");
    expect(rec.approvalRequired).toBe(true);
    expect(rec.pendingDispatch?.runType).toBe("quick");
    expect(rec.inputs.frameworks).toContain("hermes");
  });

  it("幂等:同 runId 第二次调用返回既有 record", () => {
    const a = decideAndRecordRunGovernance(root, { runId: "g6", goal: "写一首诗" });
    const b = decideAndRecordRunGovernance(root, { runId: "g6", goal: "帮我重构这个函数的接口" });
    expect(b.level).toBe(a.level);
  });
});

describe("L3 审批网关 — 未批不派发", () => {
  it("pending → checkGovernanceDispatch 拦下并落 dispatch_blocked;批准后放行", () => {
    const rec = decideAndRecordRunGovernance(root, { runId: "gate1", goal: "危险任务", involvesShell: true });
    expect(rec.approvalRequired).toBe(true);

    const blocked = checkGovernanceDispatch(root, "gate1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.record?.events.some(e => e.kind === "dispatch_blocked")).toBe(true);

    const approved = approveGovernanceForRun(root, "gate1", "tester");
    expect(approved?.approval?.status).toBe("approved");
    expect(checkGovernanceDispatch(root, "gate1").allowed).toBe(true);
  });

  it("非 L3 record 的 run 与无 record 的旧 run 一律放行", () => {
    decideAndRecordRunGovernance(root, { runId: "gate2", goal: "写一首诗" });
    expect(checkGovernanceDispatch(root, "gate2").allowed).toBe(true);
    expect(checkGovernanceDispatch(root, "no-record").allowed).toBe(true);
  });

  it("approveGovernanceForRun 对非审批 record 是 no-op(不伪造审批史)", () => {
    decideAndRecordRunGovernance(root, { runId: "gate3", goal: "写一首诗" });
    const rec = approveGovernanceForRun(root, "gate3", "tester");
    expect(rec?.approval).toBeUndefined();
  });

  it("rejected 是终态:approveGovernanceForRun 不许翻转,checkGovernanceDispatch 仍拦", () => {
    const rec = decideAndRecordRunGovernance(root, { runId: "gate4", goal: "危险任务", involvesShell: true });
    expect(rec.approvalRequired).toBe(true);
    setGovernanceApproval(root, "gate4", "rejected", "tester");

    const after = approveGovernanceForRun(root, "gate4", "tester");
    expect(after?.approval?.status).toBe("rejected");
    expect(checkGovernanceDispatch(root, "gate4").allowed).toBe(false);
  });
});
