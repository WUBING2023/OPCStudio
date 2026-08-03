import { describe, it, expect } from "vitest";
import type { AgentMessage, MessageAudience } from "@opc/shared";
import { teamOf, isAncestorOf, visibleTo, filterVisible, defaultAudienceFor } from "./visibility.js";

type Lite = { id: string; role: string; parentId?: string };

// Two-team org under one CEO.
//   ceo
//   ├─ L1 (lead) ─ a1, a2 (workers)
//   └─ L2 (lead) ─ b1, b2 (workers)
const ORG: Lite[] = [
  { id: "ceo", role: "ceo" },
  { id: "L1", role: "lead", parentId: "ceo" },
  { id: "a1", role: "dev", parentId: "L1" },
  { id: "a2", role: "test", parentId: "L1" },
  { id: "L2", role: "lead", parentId: "ceo" },
  { id: "b1", role: "dev", parentId: "L2" },
  { id: "b2", role: "test", parentId: "L2" },
];

function msg(from: string, audience: MessageAudience, phase?: string): AgentMessage {
  return { id: `m-${from}-${audience}`, from, text: "x", timestamp: "2026-01-01T00:00:00Z", visibility: { audience, ...(phase ? { phase } : {}) } };
}

describe("teamOf / isAncestorOf", () => {
  it("team = nearest lead/ceo ancestor; lead is its own team", () => {
    expect(teamOf("a1", ORG)).toBe("L1");
    expect(teamOf("b2", ORG)).toBe("L2");
    expect(teamOf("L1", ORG)).toBe("L1");
    expect(teamOf("ceo", ORG)).toBe("ceo");
  });
  it("ancestor walk includes self and the full chain", () => {
    expect(isAncestorOf("L1", "a1", ORG)).toBe(true);
    expect(isAncestorOf("ceo", "a1", ORG)).toBe(true);
    expect(isAncestorOf("L2", "a1", ORG)).toBe(false);
    expect(isAncestorOf("a1", "a1", ORG)).toBe(true);
  });
});

describe("visibleTo — audiences", () => {
  it("'all' is visible to everyone", () => {
    const m = msg("a1", "all");
    for (const v of ORG) expect(visibleTo(v.id, m, ORG)).toBe(true);
  });

  it("'private' is visible only to the author", () => {
    const m = msg("a1", "private");
    expect(visibleTo("a1", m, ORG)).toBe(true);
    expect(visibleTo("a2", m, ORG)).toBe(false);
    expect(visibleTo("L1", m, ORG)).toBe(false);
    expect(visibleTo("ceo", m, ORG)).toBe(false);
  });

  it("'team' covers teammates + the lead chain, but not a sibling team", () => {
    const m = msg("a1", "team");
    expect(visibleTo("a2", m, ORG)).toBe(true);  // teammate
    expect(visibleTo("L1", m, ORG)).toBe(true);  // own lead
    expect(visibleTo("ceo", m, ORG)).toBe(true); // ancestor oversight
    expect(visibleTo("b1", m, ORG)).toBe(false); // other team
    expect(visibleTo("L2", m, ORG)).toBe(false); // other lead
  });

  it("'lead-only' reaches only the chain above (not teammates)", () => {
    const m = msg("a1", "lead-only");
    expect(visibleTo("L1", m, ORG)).toBe(true);
    expect(visibleTo("ceo", m, ORG)).toBe(true);
    expect(visibleTo("a2", m, ORG)).toBe(false); // teammate cannot see an up-report
    expect(visibleTo("b1", m, ORG)).toBe(false);
  });

  it("'role:X' is visible to every agent of that role", () => {
    const m = msg("L1", "role:test");
    expect(visibleTo("a2", m, ORG)).toBe(true);  // role test
    expect(visibleTo("b2", m, ORG)).toBe(true);  // role test (other team) still matches
    expect(visibleTo("a1", m, ORG)).toBe(false); // role dev
  });

  it("'agents:ids' is visible only to the listed ids", () => {
    const m = msg("a1", "agents:a1,b1");
    expect(visibleTo("b1", m, ORG)).toBe(true);
    expect(visibleTo("a2", m, ORG)).toBe(false);
  });
});

describe("werewolf isolation (狼人杀)", () => {
  // host(lead) runs the game; w1,w2 wolves; v1,v2 villagers; seer. 主持人 is omniscient.
  const GAME: Lite[] = [
    { id: "host", role: "lead" },
    { id: "w1", role: "wolf", parentId: "host" },
    { id: "w2", role: "wolf", parentId: "host" },
    { id: "v1", role: "villager", parentId: "host" },
    { id: "v2", role: "villager", parentId: "host" },
    { id: "seer", role: "seer", parentId: "host" },
  ];
  const HOST = { omniscient: ["host"] };

  it("night wolf chat is hidden from villagers and the seer, visible to wolves + host", () => {
    const night = msg("w1", "agents:w1,w2", "night");
    expect(visibleTo("w2", night, GAME, HOST)).toBe(true);   // fellow wolf
    expect(visibleTo("v1", night, GAME, HOST)).toBe(false);  // villager — MUST NOT see
    expect(visibleTo("v2", night, GAME, HOST)).toBe(false);
    expect(visibleTo("seer", night, GAME, HOST)).toBe(false);
    expect(visibleTo("host", night, GAME, HOST)).toBe(true); // 主持人 omniscient
  });

  it("without host omniscience the lead cannot see a wolves-only message", () => {
    const night = msg("w1", "agents:w1,w2", "night");
    expect(visibleTo("host", night, GAME)).toBe(false); // ancestry does NOT grant agents: visibility
  });

  it("day announcement from host reaches everyone", () => {
    const day = msg("host", "all", "day");
    for (const p of GAME) expect(visibleTo(p.id, day, GAME, HOST)).toBe(true);
  });

  it("filterVisible gives a villager only the public messages", () => {
    const log = [msg("host", "all", "day"), msg("w1", "agents:w1,w2", "night"), msg("seer", "private", "night")];
    const seenByV1 = filterVisible("v1", log, GAME, HOST);
    expect(seenByV1.map((m) => m.from)).toEqual(["host"]);
  });
});

describe("defaultAudienceFor — team policy write-side defaults", () => {
  const worker: Lite = { id: "a1", role: "dev" };
  const lead: Lite = { id: "L1", role: "lead" };
  it("default → team", () => {
    expect(defaultAudienceFor("default", worker)).toBe("team");
  });
  it("isolated → worker reports up (lead-only), lead broadcasts to team", () => {
    expect(defaultAudienceFor("isolated", worker)).toBe("lead-only");
    expect(defaultAudienceFor("isolated", lead)).toBe("team");
  });
  it("game → private (explicit audience required)", () => {
    expect(defaultAudienceFor("game", worker)).toBe("private");
  });
});
