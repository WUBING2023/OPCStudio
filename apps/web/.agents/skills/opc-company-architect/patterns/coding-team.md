# Pattern: Coding team (with cross-verification)

**Use for**: coding / bug-fix tasks where you want an independent reviewer to catch what the coder missed. Only worth the extra cost when the coder actually errs (a strong coder on easy tasks leaves nothing to catch).

## Shape

```
CEO (routes)
└─ Lead (decomposes, assigns, synthesizes)
   ├─ Coder       (writes/fixes the code)          framework claude-code, sonnet (or haiku = weaker, more to catch)
   ├─ Tester      (runs tests)                      framework api/deepseek, role test
   └─ Code reviewer (independent cross-check)       framework codex, gpt-5.5, role code_reviewer
```

**Verification edge** (in `company.workflow.verificationEdges`):
```json
{ "producer": "dev", "verifier": "code_reviewer", "method": "code-review", "onReject": "redo", "maxRounds": 2 }
```

## Key rules (learned from live runs)

- The reviewer should be a **different provider** from the coder (codex reviewing claude-code) → genuinely independent signal.
- OPC's real edge is `reject → needs_revision → defer`. Keep the reviewer **anchored to task requirements** (reject only on a concrete, reproducible violation) — an over-strict reviewer discards correct output.
- If you want the reviewer's rejection to *fix* (not just discard), the revise must be **minimal** (don't rewrite working code) and ideally **monotonic** (only accept a revision verified no-worse). On easy tasks a fixed loop is net-neutral (0 regressions, occasional rescue); the value grows only with a weaker coder or harder tasks.
- Make the reviewer **execution-grounded** where possible (run the code / a cited counterexample) rather than reviewing by reading — it cuts false rejections.

## Concrete bundle

See `../examples/coding-team.agents.json` (`mc-*`, company `my-coding`) + the edge in `../examples/coding-team.company.json`. Force the full team (avoid G2 capping) with a genuinely non-trivial task, then run via `POST /api/runs` and confirm a `review_committed` event fired.
