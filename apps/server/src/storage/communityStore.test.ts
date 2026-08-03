import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamTemplate } from "@opc/shared";
import {
  saveTeam, getTeam, listTeams,
  loadFavorites, toggleFavorite, isFavorite,
  loadCommunityIndex, incrementDownload, incrementStar,
  unlistLocalEntry, markRemoteUnlisted, loadRemoteUnlisted, isRemoteUnlisted, filterUnlistedRemoteEntries,
} from "./communityStore.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-community-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function team(id: string): TeamTemplate {
  return {
    id, title: `Team ${id}`, description: "d", author: "me", createdAt: "2026-01-01T00:00:00Z",
    tags: ["x"], downloads: 0, stars: 0, readme: "r", leadId: "lead",
    agents: [
      { id: "lead", name: "Lead", role: "lead", childrenIds: ["w1"], model: "m", provider: "p", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true },
      { id: "w1", name: "W1", role: "dev", parentId: "lead", childrenIds: [], model: "m", provider: "p", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true },
    ],
  };
}

describe("team CRUD", () => {
  it("saves a team, lists it in the index, and reads it back", () => {
    saveTeam(root, team("alpha"));
    const list = listTeams(root);
    expect(list.map(t => t.id)).toContain("alpha");
    const entry = list.find(t => t.id === "alpha")!;
    expect(entry.agentCount).toBe(2);
    const full = getTeam(root, "alpha");
    expect(full?.leadId).toBe("lead");
    expect(full?.agents.length).toBe(2);
  });

  it("the index always has a teams shelf (robust to older index.json)", () => {
    const idx = loadCommunityIndex(root);
    expect(Array.isArray(idx.teams)).toBe(true);
  });

  it("increment download/star on a team entry", () => {
    saveTeam(root, team("beta"));
    incrementDownload(root, "teams", "beta");
    incrementStar(root, "teams", "beta");
    const entry = listTeams(root).find(t => t.id === "beta")!;
    expect(entry.downloads).toBe(1);
    expect(entry.stars).toBe(1);
  });
});

describe("favorites shelf", () => {
  it("starts empty for all three content types", () => {
    const fav = loadFavorites(root);
    expect(fav).toEqual({ company: [], team: [], worker: [] });
  });

  it("toggles membership on and off and reflects in isFavorite", () => {
    expect(toggleFavorite(root, "team", "alpha")).toBe(true);
    expect(isFavorite(root, "team", "alpha")).toBe(true);
    expect(loadFavorites(root).team).toEqual(["alpha"]);

    expect(toggleFavorite(root, "team", "alpha")).toBe(false);
    expect(isFavorite(root, "team", "alpha")).toBe(false);
    expect(loadFavorites(root).team).toEqual([]);
  });

  it("keeps content types independent", () => {
    toggleFavorite(root, "company", "c1");
    toggleFavorite(root, "worker", "w1");
    const fav = loadFavorites(root);
    expect(fav.company).toEqual(["c1"]);
    expect(fav.worker).toEqual(["w1"]);
    expect(fav.team).toEqual([]);
  });
});

describe("D8 · 下架(Unlist)—本地库:标记不真删", () => {
  it("unlistLocalEntry 打 visibility+unlistedAt;listTeams 默认过滤,includeUnlisted:true 仍能看到", () => {
    saveTeam(root, team("gamma"));
    expect(listTeams(root).map(t => t.id)).toContain("gamma");

    expect(unlistLocalEntry(root, "teams", "gamma")).toBe(true);

    // 默认列表过滤掉
    expect(listTeams(root).map(t => t.id)).not.toContain("gamma");
    // 显式要求全量仍能看到,且带上了 visibility/unlistedAt
    const all = listTeams(root, { includeUnlisted: true });
    const entry = all.find(t => t.id === "gamma")!;
    expect(entry).toBeTruthy();
    expect(entry.visibility).toBe("unlisted");
    expect(typeof entry.unlistedAt).toBe("string");
  });

  it("下架不是真删除:内容文件(getTeam)和索引条目本体全部原样保留", () => {
    saveTeam(root, team("delta"));
    unlistLocalEntry(root, "teams", "delta");
    // 内容文件依旧完整可读(getTeam 不受 list 的过滤影响,按 id 直读)
    const full = getTeam(root, "delta");
    expect(full?.id).toBe("delta");
    expect(full?.agents.length).toBe(2);
    // 索引里条目本体也还在(只是多了两个字段),不是被移除
    const idx = loadCommunityIndex(root);
    const raw = idx.teams.find(t => t.id === "delta");
    expect(raw).toBeTruthy();
    expect(raw!.title).toBe("Team delta");
  });

  it("对不存在的 id 下架 → 返回 false,不抛错、不污染索引", () => {
    expect(unlistLocalEntry(root, "teams", "no-such-id")).toBe(false);
    expect(loadCommunityIndex(root).teams).toEqual([]);
  });

  it("旧条目没有 visibility 字段(历史数据)→ 视为 listed,照常出现在默认列表里", () => {
    saveTeam(root, team("epsilon"));
    // 模拟老数据:索引条目从未写过 visibility 字段(本就是当前实现的默认状态)
    const idx = loadCommunityIndex(root);
    expect(idx.teams.find(t => t.id === "epsilon")!.visibility).toBeUndefined();
    expect(listTeams(root).map(t => t.id)).toContain("epsilon");
  });
});

describe("D8 · 下架(Unlist)—远程(GitHub 社区仓库)条目的本地标记", () => {
  it("markRemoteUnlisted 落盘;isRemoteUnlisted/loadRemoteUnlisted 能读回", () => {
    expect(isRemoteUnlisted(root, "template", "t1")).toBe(false);
    const rec = markRemoteUnlisted(root, "template", "t1");
    expect(rec.type).toBe("template");
    expect(rec.id).toBe("t1");
    expect(typeof rec.unlistedAt).toBe("string");
    expect(isRemoteUnlisted(root, "template", "t1")).toBe(true);
    expect(loadRemoteUnlisted(root)).toHaveLength(1);
  });

  it("重复下架同一条目 → 幂等更新 unlistedAt,不重复追加记录", () => {
    markRemoteUnlisted(root, "template", "t1");
    const second = markRemoteUnlisted(root, "template", "t1");
    expect(loadRemoteUnlisted(root)).toHaveLength(1);
    expect(second.id).toBe("t1");
  });

  it("filterUnlistedRemoteEntries:本地标记的条目被滤掉,其余条目不受影响", () => {
    markRemoteUnlisted(root, "template", "t-hidden");
    const entries = [
      { type: "template", id: "t-hidden", title: "隐藏的" },
      { type: "template", id: "t-visible", title: "正常的" },
      { type: "agent", id: "t-hidden", title: "同 id 不同 type,不该被误伤" },
    ];
    const filtered = filterUnlistedRemoteEntries(root, entries);
    expect(filtered.map(e => `${e.type}:${e.id}`).sort()).toEqual(["agent:t-hidden", "template:t-visible"]);
  });

  it("filterUnlistedRemoteEntries:内容自带 visibility:'unlisted'(如 PR 已合并)同样被滤掉,双重兜底", () => {
    const entries = [
      { type: "template", id: "t-a", visibility: "unlisted" },
      { type: "template", id: "t-b" },
    ];
    const filtered = filterUnlistedRemoteEntries(root, entries);
    expect(filtered.map(e => e.id)).toEqual(["t-b"]);
  });
});
