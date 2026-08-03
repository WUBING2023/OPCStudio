# opc-company-architect (skill)

A living Claude Code **skill** for correctly building, cloning, and modifying **companies (multi-agent orgs)** in [OPC Studio](../OPCstudio).

## What it's for

Building a good OPC company is subtle: you pick a team shape for the task, map roles→engines→providers, wire verification edges (cross-verification) and A2A, and create it via API or files — while avoiding traps (the "strawman" of a hand-rolled loop that isn't a real team; G2 capping that silently drops the reviewer; broken worker→synthesizer handoff; file-based provider keys; no hot-reload). This skill encodes all of that so it can be done right every time — and improved every time.

## How to use it

- **As a Claude Code skill** — make it discoverable to Claude Code by copying or symlinking this directory into a skills location, e.g.:
  - project-scoped: `M:/OPC/projects/OPCstudio/.claude/skills/opc-company-architect/`
  - or user-scoped: `~/.claude/skills/opc-company-architect/`
  Then invoke it with `/opc-company-architect` or just ask to "build/modify an OPC company" and Claude loads `SKILL.md`.
- **As a reference** — read `SKILL.md` (the entry point), then `reference/` for depth, `patterns/` for proven team shapes with concrete bundles, `scripts/` for the clone helper.

## Layout

```
SKILL.md                         # entry point — mental model + 5-step build recipe + modify + pitfalls
reference/
  roles-engines-providers.md     # roles, frameworks, providers, engine-selection rules, key locations
  creation-and-modification.md   # exact API endpoints / file method / architect flow / payloads
  pitfalls.md                    # the traps, each with why + how to avoid
patterns/
  research-team.md               # CEO→lead→3 researchers→fact-checker→synth (+ inline bundle)
  coding-team.md                 # CEO→lead→coder→tester+code_reviewer with verification edge (+ bundle)
scripts/
  clone-team.mjs                 # clone an existing company's structure into a new company (additive)
CHANGELOG.md                     # this skill is LIVING — log every refinement
```

## It's a living skill

Every time we build or fix a company (an experiment, a new team, a bug), **refine this skill**: add the pattern, the pitfall, the working example, and log it in `CHANGELOG.md`. The goal is that "build an OPC company" gets easier and more correct over time.
