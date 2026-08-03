---
name: opc-run-review
description: "Review an OPC Studio run from authoritative state, trace, artifact references, and committed evidence without trusting status text alone."
license: MIT
compatibility: Requires an OPC Studio MCP server with the listed high-level tools.
metadata:
  author: OPC Studio
  version: "0.1.0"
allowed-tools: "get_run_status get_run_trace list_artifacts get_artifact get_evidence"
---

# OPC Run Review

Use this skill to audit a completed, failed, or degraded OPC Studio run.

## Review order

1. Read get_run_status and record status, final state, degradation, and acceptance.
2. Read get_run_trace to reconstruct the producer, verifier, tool, and approval sequence.
3. Read list_artifacts. Open only recorded artifact identifiers with get_artifact.
4. Call get_evidence with verify enabled when a strong integrity claim is required.
5. Report mismatches, missing artifacts, unbound tests, deferred work, and rejected evidence.

## Claims

- Verified means the committed evidence supports the claim, not merely that a worker said it passed.
- Degraded and failed runs may still contain useful artifacts; label them accurately.
- Never expose redacted or sensitive fields and never reconstruct hidden credentials.
