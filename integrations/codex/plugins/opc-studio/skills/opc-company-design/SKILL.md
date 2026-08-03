---
name: opc-company-design
description: "Inspect an OPC Studio company and draft a responsibility, capability, and verification design proposal without directly mutating the company."
license: MIT
compatibility: Requires an OPC Studio MCP server with the listed high-level tools.
metadata:
  author: OPC Studio
  version: "0.1.0"
allowed-tools: "list_companies inspect_company inspect_capabilities"
---

# OPC Company Design

Use this skill to review a company and propose a safer, right-sized design.

## Procedure

1. Inspect the selected company, its workers, responsibilities, providers, and capability report.
2. Separate long-lived organization policy from the mission task graph and disposable execution sessions.
3. Prefer one capable producer plus independent verification for small tasks.
4. Add managers or parallel workers only when dependency, risk, or review needs justify them.
5. Define producer-to-verifier responsibility and acceptance evidence explicitly.
6. Return a proposal with rationale, expected impact, risks, and rollback notes.

## Boundary

This exported skill is proposal-only. It does not expose company mutation tools.
Do not embed company memory, user history, credentials, local paths, or runtime state in the proposal.
