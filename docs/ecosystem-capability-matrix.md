# Ecosystem Capability Matrix

Status values: `yes`, `partial`, `no`, `optional`. `partial` must never be presented as a guaranteed capability.

| Capability | OPC Native/API | ACP Codex | ACP Claude Code | Codex native adapter | Claude native adapter |
|---|---|---|---|---|---|
| One-shot execution | yes | yes | yes | optional | optional |
| Streaming events | yes | partial | partial | optional | optional |
| Session resume | OPC-owned | partial | partial | optional | optional |
| Session fork | OPC-owned | no | no | optional | optional |
| Interrupt | yes | process-level | process-level | optional | optional |
| Approval callback | OPC-owned | partial | partial | optional | optional |
| Sub-agent visibility | yes | partial | partial | optional | optional |
| File-change evidence | yes | yes | yes | required | required |
| Artifact acceptance gate | yes | yes | yes | required | required |
| Host subscription auth | n/a | host-owned | host-owned | host-owned | host-owned |
| Raw host auth files copied | no | no | no | no | no |

## Routing Rules

- Generic execution prefers ACP when a supported subscription CLI is selected.
- Advanced session features may select a native adapter only after capability negotiation.
- Unavailable native capabilities fall back explicitly; the run event stream records the fallback and any semantic loss.
- No adapter can bypass evidence, delivery acceptance, permission or secret boundaries.

## Maintenance

This matrix is a release artifact. Any adapter capability change must update its deterministic probe, contract fixture and this table in the same change.

