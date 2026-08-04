<div align="center">

# OPC Studio

**一个本地优先、可验证、面向长期 AI 团队的工作系统。**

[English](./README.md) · [简体中文](./README_ZH.md) · [日本語](./README_JA.md) · [Deutsch](./README_DE.md)

[![GitHub stars](https://img.shields.io/github/stars/WUBING2023/OPCStudio?style=flat-square&label=Stars)](https://github.com/WUBING2023/OPCStudio/stargazers)
[![Latest release](https://img.shields.io/github/v/release/WUBING2023/OPCStudio?style=flat-square&label=Release)](https://github.com/WUBING2023/OPCStudio/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-171817?style=flat-square)](https://github.com/WUBING2023/OPCStudio/releases/latest)
[![License](https://img.shields.io/github/license/WUBING2023/OPCStudio?style=flat-square)](./LICENSE)

[官方网站](https://opcstudio.pages.dev/) · [下载安装](https://github.com/WUBING2023/OPCStudio/releases/latest) · [文档](#文档) · [反馈问题](https://github.com/WUBING2023/OPCStudio/issues)

</div>

![OPC Studio 公司工作台](./website/assets/opc-studio-home.png)

## OPC Studio 是什么？

OPC Studio 将 API 模型和订阅型 CLI 组织成可复用的 AI 公司。公司定义长期存在的岗位、责任、权限、工具、验证制度和受治理的记忆；每个任务则创建适配当前目标的任务图和临时执行团队。

目标不是让更多 Agent 互相聊天，而是让 AI 工作变得**可追溯、可验证、可复用，并对失败保持诚实**。

> **当前发布通道：** Windows Private Alpha。在检查供应商权限和[安全边界](./docs/security-boundary.md)之前，请优先使用非敏感测试项目。

## 核心模型

```text
组织层    岗位 · 责任 · 权限 · Skill · MCP · 记忆
任务层    Mission 图 · 依赖 · 交付合同 · 审批点
执行层    模型会话 · worktree · 工具 · 临时 A2A 消息
证据层    产物 · hash · 测试 · 血缘 · 诚实终态
```

- **长期公司**保存可复用的组织能力。
- **动态团队**避免每个任务都强制全员参与。
- **真实工作区**接收真实文件修改和可下载产物。
- **独立验证**把测试与证据绑定到实际交付文件。
- **受治理记忆**区分提案、批准经验、拒绝和撤销。
- **版本化公司 Bundle**支持迁移、信任披露和保真检查。

## 下载

从 [GitHub Releases](https://github.com/WUBING2023/OPCStudio/releases/latest) 下载最新 Windows 安装包。

- Windows 10/11 x64
- 安装包约 127 MiB
- 安装后约 472 MiB
- 安装包不包含 API Key 或订阅凭据

当前只有 Windows 发行包。Windows、macOS 和 Linux 可以进行源码开发，但其他平台尚未全部完成安装包级别的发布验收。

## 从源码启动

需要 Node.js 24.x 和 pnpm 11.7.0。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 `http://localhost:5173`。真实运行前，需要配置 API 供应商或受支持的订阅 CLI。凭据必须保存在仓库之外，详见[仓库配置](./docs/REPOSITORY_SETUP.md)。

## 构建与验证

```bash
pnpm -r typecheck
pnpm test
pnpm run test:security-gate
pnpm run build:electron
```

Windows 安装包输出到 `electron-app/release/`。

## 架构

```text
apps/web        React + Vite 桌面端与网页界面
apps/server     控制面、编排、存储、证据与记忆
apps/cli        Headless CLI、MCP Server、ACP 与原生执行适配器
packages/shared 版本化合同与 Schema
electron-app    Windows 自包含桌面端打包
integrations    Codex 与 Claude 集成包
```

## 执行路径

OPC Studio 可以协调 API 供应商、Codex CLI、Claude Code 和受支持的 ACP/原生桥接。所有路径都会进入同一套任务合同、工作目录边界、Trace 和交付验收流程。实际可用性仍取决于供应商、已安装 CLI、账号、操作系统和授权权限。

## 社区信号地图

[官方网站](https://opcstudio.pages.dev/#community)展示真实仓库 Star 数和聚合后的 Stargazer 地图。

- Star 总数来自 GitHub 公开仓库 API。
- 地理位置只读取 GitHub 用户主动填写的公开位置。
- 官网数据只保存国家/地区级别的聚合数量。
- 不发布用户名、原始位置、公司、简介、访问者 IP 或精确坐标。
- 不使用 Star 推断安装量或活跃用户。

## 安全模型

OPC Studio 会运行具备本机能力的工具。第三方模板、Skill、MCP Server 和订阅 CLI 可能拥有重要的宿主权限。系统已经包含路径守卫、SSRF 防护、凭据脱敏、审批控制、隔离工作根和证据验证，但它仍不是完整容器沙箱。

在敏感仓库或不受信任扩展上使用前，请阅读[安全边界](./docs/security-boundary.md)。不要提交 `.opc/`、供应商密钥、账号文件、运行证据、本地工作区或私有公司 Bundle。

## Private Alpha 边界

- Windows x64 是目前唯一完成打包和安装验收的平台。
- 部分执行路径需要供应商 CLI 和有效账号。
- 订阅路径会记录 Token，但不能声称准确的单次货币成本。
- 多 Agent 可能比单个强 Agent 更慢、更贵；应只在协作价值明确时渐进扩充团队。
- 公共模板签名、社区治理、完整沙箱和跨平台安装包仍在持续建设。

## 文档

- [仓库配置](./docs/REPOSITORY_SETUP.md)
- [发行说明](./docs/DISTRIBUTION.md)
- [安全边界](./docs/security-boundary.md)
- [架构决策](./docs/adr/)
- [产品合同](./PRODUCT_CONTRACT.md)
- [路线图](./ROADMAP.md)

## 参与贡献

欢迎提交可复现的 Bug、供应商失败证据、文档改进和边界清晰的 Pull Request。请不要提交凭据、本地运行数据、生成工作区或私有公司 Bundle。

## 开源协议

当前采用 [Apache License 2.0](./LICENSE)。