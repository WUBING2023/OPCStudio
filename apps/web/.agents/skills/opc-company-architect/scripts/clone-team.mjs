#!/usr/bin/env node
// Clone an existing OPC company's STRUCTURE into a new company (additive), optionally remapping the engine.
// Additive & safe: never removes/rewrites other companies or agents. Server has no hot-reload → restart (idle only) after.
//
// Usage:
//   node clone-team.mjs --src research-pro --id my-research --name "My Research Team" [--engine deepseek] [--root <projectRoot>]
//
// --engine (optional) overrides framework/provider/model for ALL cloned roles:
//   deepseek → hermes/deepseek/deepseek-v4-pro   |   sonnet → claude-code/anthropic/sonnet
//   haiku    → claude-code/anthropic/haiku        |   minimax → api/minimax/MiniMax-M3
// If omitted, keeps each source agent's original engine.
import fs from "node:fs";
import path from "node:path";

const arg = (k, d = undefined) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = arg("--root", process.env.OPC_PROJECT_ROOT || "M:/OPC/projects/OPCstudio");
const SRC = arg("--src", "research-pro");
const NEW_ID = arg("--id");
const NAME = arg("--name", NEW_ID);
const ENGINE = arg("--engine");
if (!NEW_ID) { console.error("need --id <newCompanyId>"); process.exit(1); }

const ENGINES = {
  deepseek: { framework: "hermes", provider: "deepseek", model: "deepseek-v4-pro" },
  sonnet:   { framework: "claude-code", provider: "anthropic", model: "sonnet" },
  haiku:    { framework: "claude-code", provider: "anthropic", model: "haiku" },
  minimax:  { framework: "api", provider: "minimax", model: "MiniMax-M3" },
};
if (ENGINE && !ENGINES[ENGINE]) { console.error("--engine must be one of:", Object.keys(ENGINES).join(", ")); process.exit(1); }

const AGENTS = path.join(ROOT, ".opc", "agents.json");
const COMPANIES = path.join(ROOT, ".opc", "companies.json");
const agents = JSON.parse(fs.readFileSync(AGENTS, "utf8"));
let companies = [];
try { companies = JSON.parse(fs.readFileSync(COMPANIES, "utf8")); } catch { companies = []; }

const src = agents.filter((a) => a.companyId === SRC);
if (!src.length) { console.error(`source company '${SRC}' not found`); process.exit(1); }
if (agents.some((a) => a.companyId === NEW_ID) || companies.some((c) => c.id === NEW_ID)) {
  console.error(`company '${NEW_ID}' already exists — pick a fresh id (this script is additive, won't overwrite)`); process.exit(1);
}

const prefix = NEW_ID.slice(0, 3).replace(/[^a-z0-9]/gi, "") || "co";
const srcPrefix = (src[0].id.match(/^([a-z]+)-/i) || [, ""])[1];
const reId = (id) => `${prefix}-${id.replace(new RegExp(`^${srcPrefix}-`), "")}`;

const clones = src.map((a) => {
  const eng = ENGINE ? ENGINES[ENGINE] : { framework: a.framework, provider: a.provider, model: a.model };
  const c = {
    ...a, ...eng,
    id: reId(a.id), companyId: NEW_ID,
    parentId: a.parentId ? reId(a.parentId) : undefined,
    childrenIds: (a.childrenIds || []).map(reId),
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    currentTask: undefined, lastAction: undefined,
  };
  if (c.parentId === undefined) delete c.parentId;
  return c;
});

const ceo = src.find((a) => a.role === "ceo");
companies.push({ id: NEW_ID, name: NAME, description: `Cloned from ${SRC}${ENGINE ? ` (engine=${ENGINE})` : ""}`, ceoId: ceo ? reId(ceo.id) : undefined, createdAt: new Date().toISOString(), workflow: { verificationEdges: [] } });

fs.writeFileSync(AGENTS, JSON.stringify([...agents, ...clones], null, 2));
fs.writeFileSync(COMPANIES, JSON.stringify(companies, null, 2));
console.log(`✓ cloned ${SRC} → ${NEW_ID}: ${clones.length} agents${ENGINE ? ` (all ${ENGINE})` : " (kept engines)"}.`);
console.log(`  Restart the OPC server (only when idle) to load it, or import the produced entries via the API.`);
