# Changelog — opc-company-architect skill

This skill is **living**. Log every refinement here (what changed + why, ideally the run/experiment that taught it).

## v0.1.0 — 2026-07-16 — initial

- Created the skill: mental model + 5-step build recipe + modify + pitfalls (`SKILL.md`).
- Reference: roles/engines/providers, creation & modification methods, pitfalls.
- Patterns: research team (CEO→lead→3 researchers→fact-checker→synth) and coding team (coder + tester + codex code-reviewer with a `code-review` verification edge), with concrete example bundles.
- `scripts/clone-team.mjs`: additive clone of an existing company's structure into a new company, with optional engine remap.
- `INTEGRATION.md`: positioning as a bundled, open-source, living skill that also powers OPC Studio's in-product architect assistant (system-prompt injection — planned, not yet wired).

### Knowledge captured from live experience (2026-07 sessions)
- The **strawman trap**: a scripted `runViaAcpWorker` loop is not a real company (no CEO/lead/A2A/edges/reviewCommit). Only `/api/runs` exercises the real architecture.
- OPC's real verification edge is `reject → needs_revision → defer` (discards output), **not** blind rewrite — so over-rejection *loses good work*; keep the verifier anchored to task requirements.
- Provider keys are **file-based** (`../../keys/*.key`), often absent from `config.apiKeys`.
- `agents.json` has **no hot-reload**; mutate via API while a server is up; never touch an in-flight run.
- G2 progressive-org capping can silently drop the reviewer on "simple" tasks.

## v0.2.0 — 2026-07-18 — MCP/skill reliability (dedicated per-benchmark companies)

Built dedicated rich research companies (`bc-team`/`hb-team`/`dr-team`: CEO→lead→3 distinct
researchers + 1 independent reviewer, each with a `llm-review` verification edge) and ran them
live through `/api/runs`. Two hard-won reliability lessons (now pitfalls #10, #11):

- **Method B (files+restart) does NOT bind bundled skills.** A company built by appending to
  `agents.json`/`companies.json` has no install-transaction, so `isBundledSkillOwnedByCompany`
  correctly excludes every bundled skill (they belong to other companies) → the team runs with
  ZERO methodology skills. Fix: author skill `.md` files with `companyId: <id>` frontmatter into
  the **global** skills dir (`~/.opcstudio/skills`, or `OPC_SKILLS_DIR`); ownership path (a)
  (`meta.companyId === companyId`) then injects them into same-role agents. Skills are read live
  (no restart needed for skills; the restart is only for the new agents). Verified via `/api/skills`.
- **Researchers with no search-budget blow the role timeout → degraded delivery.** Live: `bc-team`
  first run answered correctly (`Ireland vs Romania`, MCP used 168×, verifier edge fired) but
  finished `done/degraded` — 3 researchers each did 88-112 MCP calls (one used 744k tokens),
  2 hit the ACP worker timeout (420s/300s) → salvaged as **partial**, and partial products
  **skip cross-verification** (so the edge silently under-fires) and force the run to ≥degraded.
  Fix: bind a methodology skill with an explicit **convergence cap** ("converge in ~15-25
  searches; if still unsure, answer with best-so-far + note what's unverified; don't loop").

### Validated this session
- **MCP end-to-end in a real team company**: 168 MCP tool calls (`mcp__DuckDuckGo`/`mcp__Fetch`),
  all 6 workers got MCP wired (`acp_mcp_wired`), correct obscure-fact answer. (P1 fix: server
  resolves `config.acpMcp` → seeds sandbox `.opc/acp_mcp.json` → worker reads → `newSession`.)
- **Verification edge fires**: `verifier_result` + `review_committed` + `quality_gate_result`
  (cross_verify stage) observed on non-partial researchers.

### TODO / next
- Wire the distilled guidance into `architectAssistant.ts` system prompt (see `INTEGRATION.md`).
- Add a company-bundle importable JSON that includes `bundledSkills` (one-call create + skill-bind
  via `POST /api/companies/import`), so skill-binding doesn't need the manual file step.
