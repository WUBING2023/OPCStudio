# OPC Studio Security Boundary

Status: Accepted

This document defines the security boundary for the local-first OPC Studio
runtime. Code, tests, release notes, and user-facing capability disclosures
must not claim stronger isolation than this document provides.

## Trust domains

### Trusted control plane

The OPC Studio server, its schemas, policy engine, task graph scheduler,
evidence verifier, and storage repositories are trusted to enforce policy.
They may read OPC-owned metadata under `.opc/`, but must never serialize raw
credentials into events, reports, bundles, or community content.

### User-authorized workspace

A company may operate only inside the configured project root and explicitly
bound company workspaces. Lexical containment is insufficient: all reads and
writes are checked against canonical paths, and writes through symlinks or
junctions are rejected. Reads through links are allowed only when the resolved
target remains inside an authorized root and the applicable policy permits it.

### Untrusted inputs

Community bundles, imported Skills, MCP configuration, model output, external
URLs, uploaded files, prompts, and third-party tool output are untrusted. They
are parsed with bounded schemas and do not gain authority by describing an
action in natural language.

### External executors

Codex, Claude Code, Gemini CLI, GLM/Kimi/Grok subscription CLIs, generic CLIs,
and MCP servers execute outside the Core process. A WorkerLaunchReceipt records
the selected executable, arguments, capabilities, workspace, network posture,
and configuration hashes. Subscription authentication remains owned by the
provider CLI. OPC Studio must not copy or export its authentication directory.

An external process is not a sandbox merely because its working directory is a
run worktree. Unless a platform sandbox or container backend is active, it may
retain the host access granted by the operating-system user. The UI and
evidence must describe this posture as host-trusted rather than isolated.

## Credential boundary

- API keys are accepted only by write endpoints and are never returned in API
  responses. Public account data uses `hasApiKey`, `apiKeyPreview`, and
  `authMode`.
- Runtime secrets are issued through the credential broker as short-lived,
  one-use references. Raw values are resolved only immediately before a
  process or request is launched.
- Event payloads, headers, environment maps, reports, diagnostics, and audit
  records are recursively redacted.
- CLI authentication directories are referenced in process environment only;
  they are not seeded into isolated worker roots, bundles, or evidence packs.

## Process and tool boundary

- MCP stdio and CLI execution use an executable plus an argument array with
  `shell: false`. Executable policy is deny-first; environment variable names
  and values are bounded and dangerous injection variables are rejected.
- Imported MCP/CLI/file-write capabilities require an install preview and a
  one-use confirmation token bound to the complete configuration hash.
- Capability manifests are immutable for one launch. Expired capabilities,
  changed MCP configuration, or a mismatched receipt fail closed.
- Cancellation is propagated through a shared `AbortSignal`; terminal runs
  reject subsequent writes and critical event emission.

## Network boundary

Core-owned HTTP calls use the guarded fetch path. Every redirect hop is
revalidated, private, loopback, link-local, metadata, and DNS-rebinding targets
are denied by default, response bodies are bounded, and sensitive headers are
not forwarded across origins. `allowLocalNetwork` is an explicit, auditable
exception for a configured local provider.

External CLIs may implement their own network stack. OPC Studio cannot claim
per-domain egress control for those processes unless a sandbox backend proves
that control and records it in the launch receipt.

## Persistence and evidence boundary

- A run exists only when its durable `task.json` exists. Missing run endpoints
  return 404 and never fall back to the project root.
- Task graph claims use leases, attempts, input hashes, idempotency keys, and
  compare-and-swap revisions. Startup reconciliation marks ambiguous work as
  `uncertain`; it never silently reports success.
- Critical events are sequenced and persisted before success is projected.
- Evidence manifests are atomically written, reloaded from disk, schema
  validated, and cross-checked against the requested run and real files.
  Missing, empty, mismatched, or unwritable manifests cannot verify.
- Reports, artifacts, changes, and acceptance state are projections of the same
  canonical facts. A failed projection cannot upgrade the canonical run state.

## Memory boundary

Memory is company and scope isolated. New knowledge enters through governed
proposals and is not injected until approved or committed under policy. Failed,
degraded, simulated, partial, uncertain, or evidence-invalid runs cannot create
reusable success experience. Personal facts and raw episodic context are not
exported by default. Skills and memory are separate asset types.

Legacy memory stores are read-only compatibility inputs during migration. They
must not become a second authority for new writes.

## Explicit non-goals for Private Alpha

- OPC Studio does not protect a user from a malicious executable that the user
  explicitly allows to run with full host privileges.
- OPC Studio does not claim cryptographic publisher identity for community
  templates until real signing and key distribution are implemented.
- Local JSON compatibility stores are not multi-host transactional databases.
  SQLite is the default durable backend for new installations; cross-machine
  coordination remains out of scope.
- A passing model-generated review is not evidence. Verification requires
  structured verdicts and independently checkable artifacts or test evidence.

## Release invariants

Any release candidate must demonstrate the negative security tests, crash and
restart recovery, concurrent graph claims, live success and failure runs,
artifact download, memory reuse, and bundle round-trip listed in the two active
implementation reports. A limitation that cannot be demonstrated must remain
visible in release notes and capability posture; it may not be converted into
an optimistic success state.
