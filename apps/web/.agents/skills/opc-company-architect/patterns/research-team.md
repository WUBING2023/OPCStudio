# Pattern: Research team

**Use for**: complex, cross-domain research / analysis questions (the kind where breadth + fact-checking + synthesis plausibly beat a single agent).

## Shape

```
CEO (routes, recognizes "research", hands the team the goal)
└─ Lead (decomposes into dimensions, assigns, SYNTHESIZES the final answer)
   ├─ Researcher A  (dimension 1 — e.g. quantitative / primary evidence)
   ├─ Researcher B  (dimension 2 — e.g. background / context / literature)
   ├─ Researcher C  (dimension 3 — e.g. data / comparisons)
   ├─ Fact-checker  (verifies claims across the dossiers)
   └─ Synthesizer   (writes the ANSWER from the dossiers — not a work report)
```

- Give each researcher a **distinct focus** via its `name`/persona so they don't overlap.
- Keep outputs **textual** so the worker→synthesizer handoff flows via lead-read + A2A (avoids the file-handoff pitfall).
- Research quality depends on **web-search MCP** being available to the researchers — verify it's configured.
- Engine: all-`deepseek` (`hermes`) is cheap, proven, and gives a **clean single-vs-team comparison** (model held constant). Upgrade the lead/synth to a stronger model only if you accept confounding model with collaboration.

## Why this shape (addresses prior failures)

- Parallel researchers = breadth a single context can't cover.
- Fact-checker = independent error-catching (where a team genuinely helps).
- The load-bearing risk is **synthesis**: the lead/synth must fold the researchers' *evidence* into the answer. If the final report reads like a status update, fix the handoff (text outputs) and lean on the lead role's synthesize duty.

## Concrete bundle

See `../examples/research-team.agents.json` for a ready-to-adapt 6-node team (`mr-*`, company `my-research`, all deepseek). To instantiate: clone with `scripts/clone-team.mjs --src research-pro ...`, or import the bundle, or append additively + restart. Then run a research question via `POST /api/runs` and score the answer (rubric judge).
