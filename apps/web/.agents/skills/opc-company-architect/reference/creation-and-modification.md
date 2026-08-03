# Creating & modifying a company

Server assumed at `http://localhost:3100` (start it from the OPCstudio repo root with `OPC_PROJECT_ROOT` set; on Windows also `CLAUDE_CODE_GIT_BASH_PATH`). **There is no hot-reload of `agents.json`** — file edits require a server restart; the API mutates in-memory state live.

## Method A — API (preferred while a server is running; additive, no restart)

1. **Create the shell**: `POST /api/companies { "name": "...", "description": "..." }` → returns the company; it auto-creates a `ceo-<companyId>` (deepseek, framework `api`). Response includes the new `id`.
2. **Build out the tree**: there is **no** generic "add agent" endpoint — use one of:
   - `POST /api/companies/import` with a **full CompanyTemplate/Bundle** (company + all agents + `workflow.verificationEdges`) — cleanest for a full team in one call. Passes through Template Doctor (errors → 422).
   - The **architect flow** (LLM-assisted): `POST /api/companies/:id/architect-decompose` (design from a description) → `POST /api/companies/:id/architect-apply` (apply the patch; supports ops like `add_verification_edge` by role name).
   - `PATCH /api/agents/:id` to adjust engine/role/parent of existing nodes.
3. Target a run at it: `POST /api/runs` with the goal (routes via the org / CEO). Confirm the team really ran via the Trace.

## Method B — Files + restart (full control; do it ADDITIVELY)

1. Append your agent nodes to `.opc/agents.json` and your company to `.opc/companies.json` — **never remove or rewrite existing entries** (other companies + in-flight state live there).
2. Keep the tree consistent: every `childrenIds` entry has a matching node with the right `parentId`; the company's `ceoId` points at the CEO node.
3. Restart the server so it reloads. Never restart while a run is in flight.

## Method C — Clone an existing good team (fast, safe)

`node scripts/clone-team.mjs --src research-pro --id my-research --name "My Research Team" --engine deepseek` clones the source company's structure into a new company id, remapping ids and (optionally) engines, additively. Then restart (Method B) or import the produced bundle (Method A). See the script header for options.

## Modifying

- `PATCH /api/companies/:id { name?, description? }` — rename/redescribe (folder changes go through `POST /:id/folder`, not here).
- `PATCH /api/agents/:id { framework?, provider?, model?, role?, parentId?, enabled?, ... }` — retune an agent.
- **Verification edges**: `architect-apply` with `add_verification_edge` (resolves a role by display name), or patch `company.workflow.verificationEdges` directly:
  ```json
  { "producer": "dev", "verifier": "code_reviewer", "method": "code-review", "onReject": "redo", "maxRounds": 2 }
  ```
- Delete a company: `DELETE /api/companies/:id` (auto-backs-up first, cascades agent + memory cleanup).

## Minimal shapes to copy

**Company (companies.json entry):**
```json
{ "id": "my-research", "name": "My Research Team", "description": "...", "ceoId": "mr-ceo",
  "createdAt": "<iso>", "workflow": { "verificationEdges": [] } }
```
**Agent (agents.json entry):**
```json
{ "id": "mr-lead", "name": "Lead", "role": "lead", "companyId": "my-research", "parentId": "mr-ceo",
  "childrenIds": ["mr-r1","mr-r2","mr-fc","mr-synth"], "framework": "hermes", "provider": "deepseek",
  "model": "deepseek-v4-pro", "status": "idle", "tokenUsage": {"prompt":0,"completion":0,"total":0},
  "costUsd": 0, "editable": true, "deletable": true, "enabled": true }
```
