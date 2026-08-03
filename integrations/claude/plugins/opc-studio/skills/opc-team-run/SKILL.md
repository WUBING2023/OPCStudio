---
name: opc-team-run
description: "Use an OPC Studio company to plan, start, monitor, and collect a durable multi-agent run with explicit confirmation and evidence."
license: MIT
compatibility: Requires an OPC Studio MCP server with the listed high-level tools.
metadata:
  author: OPC Studio
  version: "0.1.0"
allowed-tools: "list_companies inspect_company inspect_capabilities start_run get_run_status get_run_trace list_artifacts get_artifact get_evidence"
---

# OPC Team Run

Use this skill when the user wants an OPC Studio company to perform a durable task.

## Procedure

1. Call list_companies and select only a company the user identifies or approves.
2. Call inspect_company and inspect_capabilities before proposing execution.
3. Explain unavailable providers, verifiers, or permissions instead of silently substituting them.
4. Ask for explicit user confirmation before start_run.
5. Reuse one idempotencyKey if the same start request must be retried.
6. Poll get_run_status. Use get_run_trace only when progress or failure detail is needed.
7. On completion, inspect list_artifacts and get_evidence before claiming success.
8. Treat failed, degraded, missing, or unverified evidence as non-success.

## Safety

- Never place credentials, session tokens, private keys, or secret-bearing text in a task.
- Do not ask OPC Studio to bypass its verification or permission gates.
- Do not infer file delivery from model text. Use artifact and evidence tools.
