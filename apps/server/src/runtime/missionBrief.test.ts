import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadMissions, saveMissions, upsertMission, getMission, applyMissionPatch, parseMissionBriefLLMOutput,
  type MissionBrief,
} from "./missionBrief.js";

let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function mkRoot(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mb-"));
  return root;
}

function mission(over: Partial<MissionBrief> = {}): MissionBrief {
  return {
    id: "m-1",
    createdAt: "2026-07-01T00:00:00Z",
    originalIdea: "做一个待办事项 app",
    interpretedGoal: "开发一个简单的待办事项管理应用",
    successCriteria: ["能增删改查任务"],
    nonGoals: [],
    assumptions: [],
    risks: [],
    requiredDepartments: [],
    expectedArtifacts: [],
    suggestedRunType: "quick",
    permissionNeeds: "write_code",
    approvalStatus: "draft",
    ...over,
  };
}

describe("missionBrief 存储 — loadMissions/saveMissions/upsertMission", () => {
  it("文件不存在时 loadMissions 返回空数组", () => {
    mkRoot();
    expect(loadMissions(root)).toEqual([]);
  });

  it("upsertMission 新记录写入后可被 loadMissions/getMission 读到", () => {
    mkRoot();
    const rec = mission();
    upsertMission(root, rec);
    expect(loadMissions(root)).toHaveLength(1);
    expect(getMission(root, "m-1")).toEqual(rec);
  });

  it("upsertMission 对已存在 id 就地更新，不新增记录", () => {
    mkRoot();
    upsertMission(root, mission());
    upsertMission(root, mission({ approvalStatus: "approved" }));
    const all = loadMissions(root);
    expect(all).toHaveLength(1);
    expect(all[0].approvalStatus).toBe("approved");
  });

  it("新记录插入到数组头部（unshift，与 goalRunner 同款）", () => {
    mkRoot();
    upsertMission(root, mission({ id: "m-1" }));
    upsertMission(root, mission({ id: "m-2" }));
    const all = loadMissions(root);
    expect(all.map(m => m.id)).toEqual(["m-2", "m-1"]);
  });

  it("超过 100 条时 upsertMission 按 slice(0,100) 截断（与 goalRunner 同款：saveMissions 本身不截断，upsert 时截）", () => {
    mkRoot();
    const full = Array.from({ length: 100 }, (_, i) => mission({ id: `m-${i}` }));
    saveMissions(root, full);
    expect(loadMissions(root)).toHaveLength(100);
    upsertMission(root, mission({ id: "m-new" }));
    const all = loadMissions(root);
    expect(all).toHaveLength(100);
    expect(all[0].id).toBe("m-new");
    expect(all.some(m => m.id === "m-99")).toBe(false); // 最旧的一条被挤出
  });

  it("JSON 损坏时 loadMissions 回退为空数组而不抛错", () => {
    mkRoot();
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "missions.json"), "{not valid json", "utf-8");
    expect(loadMissions(root)).toEqual([]);
  });
});

describe("applyMissionPatch — 可编辑字段白名单", () => {
  it("允许字段的更新被合并", () => {
    const rec = mission();
    const next = applyMissionPatch(rec, { interpretedGoal: "新的目标", successCriteria: ["a", "b"] });
    expect(next.interpretedGoal).toBe("新的目标");
    expect(next.successCriteria).toEqual(["a", "b"]);
  });

  it("id/createdAt/approvalStatus 即使传入也被忽略", () => {
    const rec = mission();
    const next = applyMissionPatch(rec, { id: "hacked", createdAt: "2000-01-01", approvalStatus: "approved" });
    expect(next.id).toBe(rec.id);
    expect(next.createdAt).toBe(rec.createdAt);
    expect(next.approvalStatus).toBe(rec.approvalStatus);
  });

  it("未传入的字段保持原值不变", () => {
    const rec = mission({ targetUser: "学生" });
    const next = applyMissionPatch(rec, { interpretedGoal: "换个目标" });
    expect(next.targetUser).toBe("学生");
  });
});

describe("parseMissionBriefLLMOutput — 健壮性解析", () => {
  it("正常 JSON 输出被正确解析为各字段", () => {
    const raw = `这是一些前缀文字\n{"interpretedGoal": "做一个待办 app", "successCriteria": ["能增删改查"], "requiredDepartments": ["product", "unknown"], "suggestedRunType": "team", "suggestedTeamMode": "balanced", "permissionNeeds": "write_code"}`;
    const parsed = parseMissionBriefLLMOutput(raw, "做个 todo app");
    expect(parsed.interpretedGoal).toBe("做一个待办 app");
    expect(parsed.successCriteria).toEqual(["能增删改查"]);
    expect(parsed.requiredDepartments).toEqual(["product"]);
    expect(parsed.suggestedRunType).toBe("team");
    expect(parsed.suggestedTeamMode).toBe("balanced");
    expect(parsed.permissionNeeds).toBe("write_code");
    expect(parsed.originalIdea).toBe("做个 todo app");
  });

  it("suggestedRunType 缺省或非法时回退为 quick，且不携带 teamMode", () => {
    const raw = `{"interpretedGoal": "做点什么", "suggestedTeamMode": "balanced"}`;
    const parsed = parseMissionBriefLLMOutput(raw, "idea");
    expect(parsed.suggestedRunType).toBe("quick");
    expect(parsed.suggestedTeamMode).toBeUndefined();
  });

  it("permissionNeeds 非法值回退为 propose_only", () => {
    const raw = `{"interpretedGoal": "做点什么", "permissionNeeds": "god_mode"}`;
    const parsed = parseMissionBriefLLMOutput(raw, "idea");
    expect(parsed.permissionNeeds).toBe("propose_only");
  });

  it("无 JSON 片段时抛错（不编造兜底数据）", () => {
    expect(() => parseMissionBriefLLMOutput("纯文本，没有 JSON", "idea")).toThrow();
  });

  it("缺少 interpretedGoal 时抛错", () => {
    expect(() => parseMissionBriefLLMOutput(`{"successCriteria": ["a"]}`, "idea")).toThrow();
  });

  it("JSON 语法错误时抛错", () => {
    expect(() => parseMissionBriefLLMOutput(`{interpretedGoal: 忘了加引号}`, "idea")).toThrow();
  });
});
