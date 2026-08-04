<div align="center">

# OPC Studio

**A local-first, verifiable work system for long-running AI teams.**

[English](./README.md) · [简体中文](./README_ZH.md) · [日本語](./README_JA.md) · [Deutsch](./README_DE.md)

[![GitHub stars](https://img.shields.io/github/stars/WUBING2023/OPCStudio?style=flat-square&label=Stars)](https://github.com/WUBING2023/OPCStudio/stargazers)
[![Latest release](https://img.shields.io/github/v/release/WUBING2023/OPCStudio?style=flat-square&label=Release)](https://github.com/WUBING2023/OPCStudio/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-171817?style=flat-square)](https://github.com/WUBING2023/OPCStudio/releases/latest)
[![License](https://img.shields.io/github/license/WUBING2023/OPCStudio?style=flat-square)](./LICENSE)

[Website](https://opcstudio.pages.dev/) · [Download](https://github.com/WUBING2023/OPCStudio/releases/latest) · [Documentation](#documentation) · [Report an issue](https://github.com/WUBING2023/OPCStudio/issues)

</div>

![OPC Studio company workspace](./website/assets/opc-studio-home.png)

## What is OPC Studio?

OPC Studio organizes API models and subscription CLIs into reusable AI companies. A company defines long-lived roles, responsibilities, permissions, tools, verification rules, and governed memory. Each mission creates a right-sized task graph and a temporary execution team.

The goal is not to make more agents talk. The goal is to make AI work **traceable, verifiable, reusable, and honest about failure**.

> **Release channel:** Windows Private Alpha. Use non-sensitive test projects until you have reviewed provider permissions and the [security boundary](./docs/security-boundary.md).

## Core model

```text
Organization layer  Roles · responsibilities · permissions · Skills · MCP · memory
Task layer          Mission graph · dependencies · delivery contract · approval points
Execution layer     Model sessions · worktrees · tools · temporary A2A messages
Evidence layer      Artifacts · hashes · tests · lineage · honest terminal state
```

- **Persistent companies** preserve reusable organizational capability.
- **Dynamic teams** avoid forcing every role into every run.
- **Real workspaces** receive actual file changes and downloadable artifacts.
- **Independent verification** binds tests and evidence to the delivered files.
- **Governed memory** separates proposals, approved experience, rejection, and revocation.
- **Versioned company bundles** support migration, trust disclosure, and fidelity checks.

## Download

Download the latest Windows installer from [GitHub Releases](https://github.com/WUBING2023/OPCStudio/releases/latest).

- Windows 10/11 x64
- Installer: approximately 127 MiB
- Installed size: approximately 472 MiB
- API keys and subscription credentials are never bundled

The packaged alpha is Windows-only. Source development is supported on Windows, macOS, and Linux, but those platforms have not all completed packaged-release validation.

## Quick start from source

Requirements: Node.js 24.x and pnpm 11.7.0.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:5173`. Before a real run, configure an API provider or a supported subscription CLI. Keep credentials outside the repository; see [Repository Setup](./docs/REPOSITORY_SETUP.md).

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
apps/server     Control plane, orchestration, storage, evidence, and memory
apps/cli        Headless CLI, MCP server, ACP and native execution adapters
packages/shared Versioned contracts and schemas
electron-app    Self-contained Windows desktop packaging
integrations    Codex and Claude integration bundles
```

## Execution paths

OPC Studio can coordinate API providers, Codex CLI, Claude Code, and supported ACP/native bridges. Every path enters the same task contract, workspace boundary, trace, and delivery acceptance flow. Availability still depends on the provider, installed CLI, account, operating system, and granted permissions.

## Community signal map

The [official website](https://opcstudio.pages.dev/#community) shows the real repository Star count and an aggregate Stargazer map.

- Star totals come from the public GitHub repository API.
- Locations come only from self-declared public GitHub profile locations.
- The generated website data contains country-level counts only.
- Usernames, raw locations, companies, bios, visitor IPs, and precise coordinates are not published.
- Installations and active users are not inferred from Stars.

## Security model

OPC Studio runs powerful local tools. Third-party templates, Skills, MCP servers, and subscription CLIs can execute with meaningful host permissions. The product includes path guards, SSRF protection, credential redaction, approval controls, isolated work roots, and evidence verification, but it is not a complete container sandbox.

Read [Security Boundary](./docs/security-boundary.md) before using untrusted extensions or sensitive repositories. Never commit `.opc/`, provider keys, account files, run evidence, or local workspaces.

## Private Alpha limits

- Windows x64 is the only packaged and installation-tested release.
- Some execution paths require a vendor CLI and a valid account.
- Subscription usage reports tokens but cannot claim accurate per-request monetary cost.
- Multi-agent execution can be slower and more expensive than one strong agent; progressive team sizing should be used where collaboration is justified.
- Public template signing, moderation, complete sandboxing, and cross-platform installers are still evolving.

## Documentation

- [Repository Setup](./docs/REPOSITORY_SETUP.md)
- [Distribution](./docs/DISTRIBUTION.md)
- [Security Boundary](./docs/security-boundary.md)
- [Architecture decisions](./docs/adr/)
- [Product contract](./PRODUCT_CONTRACT.md)
- [Roadmap](./ROADMAP.md)

## Contributing

Bug reports, reproducible provider failures, documentation improvements, and focused pull requests are welcome. Please avoid committing credentials, local run data, generated workspaces, or private company bundles.

## License

Currently licensed under the [Apache License 2.0](./LICENSE).