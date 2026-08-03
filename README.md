# OPC Studio

OPC Studio is a local-first work system for organizing AI agents into reusable companies and project teams. It coordinates API models and subscription CLIs through task graphs, isolated workspaces, structured handoffs, evidence-backed delivery, governed memory, MCP tools, and reusable company bundles.

> Current release channel: **Windows Private Alpha**. Use it with non-sensitive test projects until you have reviewed the execution permissions and provider configuration.

## Download

Download the latest Windows installer from [GitHub Releases](https://github.com/WUBING2023/OPCStudio/releases/latest).

- Windows x64 installer: approximately 127 MiB
- Installed size: approximately 472 MiB
- No API keys or subscription credentials are bundled

## Core capabilities

- Design persistent companies with roles, responsibilities, permissions, verification edges, Skills, MCP access, and working-directory policies.
- Build a mission-specific task graph instead of forcing every company member into every run.
- Execute through API providers, Codex CLI, Claude Code, and supported ACP/native bridges.
- Preserve run state, A2A handoffs, artifacts, hashes, test evidence, and honest terminal states.
- Store company-, project-, team-, agent-, and user-scoped memory with review and lifecycle controls.
- Import and export versioned company bundles with migration, trust, safety, and fidelity checks.
- Inspect token usage by company, role, worker, provider, model, and task.
- Expose headless CLI, MCP, and integration packages for Codex and Claude workflows.

## Quick start from source

Requirements:

- Node.js 24.x
- pnpm 11.7.0
- Windows, macOS, or Linux for web development; the packaged alpha is currently Windows-only

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:5173`.

Before a real run, configure an API provider or a supported subscription CLI from the application. Keep credentials outside the repository; see [Repository Setup](./docs/REPOSITORY_SETUP.md).

## Build and verify

```bash
pnpm -r typecheck
pnpm test
pnpm run test:security-gate
pnpm run build:electron
```

The Windows installer is written to `electron-app/release/`.

## Architecture

```text
apps/web        React + Vite desktop/web interface
apps/server     Express control plane, orchestration, storage, evidence, memory
apps/cli        Headless CLI, MCP server, ACP and native execution adapters
packages/shared Versioned contracts and schemas
electron-app    Self-contained Windows desktop packaging
integrations    Codex and Claude integration bundles
```

The company structure is the persistent governance layer. Each mission creates a task graph and temporary execution team. Runtime model instances, worktrees, tool sessions, and transient A2A messages end with the run; durable state and accepted evidence remain auditable.

## Security model

OPC Studio runs powerful local tools. Third-party templates, Skills, MCP servers, and subscription CLIs can execute with meaningful host permissions. The product includes path guards, SSRF protection, credential redaction, trust disclosures, approval controls, isolated work roots, and evidence verification, but it is not a complete container sandbox.

Review [Security Boundary](./docs/security-boundary.md) before using untrusted extensions or sensitive repositories. Never commit `.opc/`, provider keys, account files, run evidence, or local workspaces.

## Private Alpha limits

- Windows x64 is the only packaged and installation-tested release.
- Some provider and subscription paths require their vendor CLI and a valid account.
- Subscription usage reports tokens but cannot claim accurate per-request monetary cost.
- Multi-agent execution can be slower and more expensive than a single strong agent; use progressive team sizing and verification where the task justifies it.
- Public template trust, signing, moderation, and cross-platform installers are still evolving.

## Documentation

- [Repository Setup](./docs/REPOSITORY_SETUP.md)
- [Distribution](./docs/DISTRIBUTION.md)
- [Security Boundary](./docs/security-boundary.md)
- [Architecture decisions](./docs/adr/)
- [Product contract](./PRODUCT_CONTRACT.md)
- [Roadmap](./ROADMAP.md)

## License

Licensed under the [Apache License 2.0](./LICENSE).