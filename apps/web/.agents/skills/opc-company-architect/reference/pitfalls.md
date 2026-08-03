# Pitfalls (each: what → why → avoid)

### 1. The strawman trap (biggest one)
**What**: wiring a "team" by calling `runViaAcpWorker` (or any single-agent primitive) in a loop from a script. **Why it's wrong**: that has **no** CEO/lead, **no** A2A contract bus, **no** verification edges, **no** reviewCommit four-state, **no** quality gates. It only *looks* like a team; results from it do **not** describe OPC's real product. **Avoid**: run through the real orchestrator — `POST /api/runs` on the server. If you must script, script the *dispatch*, not the *orchestration*.

### 2. G2 progressive-org capping silently drops the reviewer
**What**: you built a full team + edge, but a run shows only 1 producer. **Why**: OPC caps trivial/medium tasks to a single producer (verifier dropped) unless the task reads as complex / requires-tests / expand. **Avoid**: to exercise the full team + verification edge, give a genuinely complex task (or one whose classification triggers `requiresTests`/`expand`); confirm via a `team_shape` event in the Trace.

### 3. Broken worker→synthesizer handoff
**What**: researchers produce good evidence but the final answer ignores it (quality drops at synthesis). **Why**: historically, worktree isolation blocked a downstream worker from reading an upstream worker's files. **Avoid**: for research, keep outputs as **text** (flows via lead-read + A2A, not files). Always verify the synthesis actually contains the workers' evidence, not a "work report".

### 4. Over-rejection discards correct output
**What**: a strict reviewer rejects correct work; since the edge path is `reject → needs_revision → defer`, that correct output is **excluded** from synthesis. **Why**: a generic "is this accurate/credible?" prompt invites nitpicks (perf, out-of-scope edges). **Avoid**: keep the verifier judgment anchored to the **task's actual requirements** — reject only on a concrete, reproducible violation; ignore out-of-scope perfectionism. (Encoded in OPC as of the anti-over-rejection prompt change.)

### 5. Provider keys look "missing" but aren't
**What**: `config.apiKeys` is empty so you assume no key. **Why**: keys resolve **env > key files > config.apiKeys**; on this machine they're **file-based** (`../../keys/*.key`). **Avoid**: check the key files, not just config.

### 6. No hot-reload / touching live state
**What**: you edit `.opc/agents.json` and expect the running server to pick it up (it won't), or you restart a server mid-run. **Avoid**: mutate via the API while a server is up; only edit files + restart when the server is idle (0 in-flight runs). Edits to `.opc` must be **additive** — never delete/rewrite existing companies, agents, or run data.

### 7. Verifier doesn't match the edge
**What**: an edge says `code-review` but the team only has a generic `test` role → `governance_degraded`. **Why**: the verifier for an edge must match by role/id, not "first available verifier". **Avoid**: ensure a node whose role matches the edge's `verifier` exists and is enabled.

### 8. Single claude-code/codex account = serial only
**What**: parallelizing claude-code/codex calls to speed up. **Why**: same-subscription concurrency risks rate-limit/ban (OPC caps CLI frameworks to 1 concurrent per account). **Avoid**: keep serial, or give agents distinct `cliConfigDir` logins for true multi-account concurrency.

### 9. Untrusted-code execution can crush the host
**What**: grading/running agent-generated code without limits. **Why**: an infinite-memory bug balloons to GBs and orphans. **Avoid**: run untrusted code with a hard memory cap (Windows Job Object / WSL `ulimit`) + short timeout + kill the whole process tree. (Not a company-arch issue per se, but bites when benchmarking a coding company.)

### 10. A company built from files has NO bundled skills (skill silently absent)
**What**: you build a company via Method B (append to `agents.json`/`companies.json` + restart), then notice the run emits `N 个打包技能因公司归属未决未注入(residual)` and the agents behave without any methodology skill. **Why**: bundled-skill injection is gated by `isBundledSkillOwnedByCompany` (a security fix against cross-company skill leakage). Ownership resolves via (a) the skill's own `companyId`, (b) a non-rolled-back install transaction, or (c) `manifestTemplateId` prefix. A file-built company has **none of these**, so every bundled skill (all owned by *other* companies) is correctly excluded. **Avoid**: author skill `.md` files with `companyId: <your-company>` + `role: <target-role>` + `origin: bundled` + `enabled: true` frontmatter, written to the **global** skills dir (`~/.opcstudio/skills`, override with `OPC_SKILLS_DIR`) — path (a) then makes them owned and they inject into same-role agents. Skills are read **live** (no restart for skills). Confirm via `GET /api/skills` (check `companyId`/`role`/`enabled`) and by the absence of your skill id from the `excluded_bundled_skills` event. Cleaner alternative: `POST /api/companies/import` a bundle whose `bundledSkills[]` carry the skills (install-tx path (b)).

### 11. Researchers with no search-budget blow the role timeout → degraded delivery
**What**: a research team eventually answers (often correctly) but finishes `done/degraded`, and the verification edge under-fires. **Why**: `research_profile_v1.taskTimeoutMs` is 10 min (config `budget.taskTimeoutMs` may lower it, e.g. 420s); a researcher with no convergence discipline will happily do 90-120 web searches until it hits that wall → the ACP worker times out → its output is salvaged as **partial** → partial products **skip cross-verification** (the `llm-review` edge never runs on them) AND force the run to at least `degraded`. Live evidence: `bc-team` — 3 researchers did 88/112/108 MCP calls (one 744k tokens), 2 timed out, run `done/degraded` despite the correct answer. **Avoid**: bind a methodology skill (pitfall #10) with an explicit **convergence cap** — e.g. "converge within ~15-25 searches; once a constraint is verified, lock it and move on; if still unsure at the budget, answer with best-so-far + list what's unverified; never loop the same query." This keeps each worker under the timeout → clean delivery + the edge actually fires.
