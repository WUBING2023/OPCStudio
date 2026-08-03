# OPC Studio 仓库配置与完整功能启用指南

本文面向源码开发、Windows Private Alpha 打包和新机器迁移。目标是让 Provider API、Codex/Claude Code 订阅、公司工作目录、多 Agent 协作、Skill、记忆、模板导入导出、证据验证和 Electron 打包都使用同一套可复现配置。

## 1. 环境要求

- Windows 10/11（当前发行主平台）。
- Node.js 24.x。
- pnpm 11.7.0。
- Git for Windows。使用 Claude Code/Codex ACP 时需要 Git Bash。
- 至少配置一个可用的 API Provider 或一个已登录的订阅型 CLI。

```powershell
node --version
pnpm --version
git --version
```

## 2. Git 仓库配置

```powershell
git clone <REPOSITORY_URL> OPCstudio
Set-Location OPCstudio
git remote -v
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
```

本仓库使用 `codex/opc-trust-hardening` 作为当前可信执行开发分支。需要推送到自己的远端时：

```powershell
git remote add origin <REPOSITORY_URL> # 已有 origin 时不要重复执行
git push -u origin codex/opc-trust-hardening
```

不要提交 `.opc/config.json`、`.opc/accounts.json`、`.opc/providers.json`、`*.key`、`.env*`、SQLite、run 目录或 Electron staging bundle。`.gitignore` 已覆盖这些本机数据。

## 3. 安装依赖并启动开发环境

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

- Web：`http://localhost:5173`
- Server：`http://127.0.0.1:3100`
- 仅启动后端：`pnpm dev:server`
- 仅启动前端：`pnpm dev:web`

首次启动后先进入“能力/Doctor”，运行 Basic Doctor。配置完成后再运行 Capability Doctor；真实交付前运行 Deep Doctor。

## 4. 密钥配置

密钥解析优先级如下：

1. 环境变量 `<PROVIDER>_API_KEY`。
2. `OPC_KEYS_DIR/<provider>.key`。
3. `<projectRoot>/.opc/keys/<provider>.key`。
4. UI 写入的本机私有配置。

推荐使用仓库外的 keys 目录：

```powershell
$env:OPC_KEYS_DIR = "C:\path\to\opc-keys"
```

文件名示例：`deepseek.key`、`openai.key`、`anthropic.key`、`minimax.key`。每个文件只放一条密钥，不要加引号，不要提交到 Git。

在“设置 -> API 连接”中可添加 Provider、测试连接、选择默认模型，并用模型名称旁的刷新按钮获取供应商最新模型列表。刷新时间会保存到本机 `.opc/model-catalog-state.json`，失败时保留上一次成功目录。

私有/本地 Provider（例如 Ollama）必须显式开启 `allowLocalNetwork`；公网 Provider 不应开启不必要的本地网络权限。

## 5. Codex、Claude Code 与订阅型执行

### Codex

```powershell
codex --version
codex login
```

在“订阅”页面确认 Codex 为“已安装/已登录”，然后刷新模型列表。当前推荐默认配置为：

- 执行方式：`codex`
- Provider：`openai`
- 模型：`gpt-5.6-luna`
- 推理强度：`low`

订阅调用的 `costUsd` 显示为“订阅制”，不会伪装成 `$0.00`；Token 仍会正常统计。

### Claude Code

```powershell
claude --version
claude auth login
$env:CLAUDE_CODE_GIT_BASH_PATH = "C:\Program Files\Git\bin\bash.exe"
```

Windows 下 Doctor 必须同时通过 CLI 探测、Git Bash 前置检查和真实 provider tool canary。宿主文件系统可写不等价于 Claude Code/Codex 能写文件。

订阅账号、多账号隔离目录和 API Key 模式都在“订阅”页配置。账号 API 回包只返回 `hasApiKey/apiKeyPreview/authMode`，不会返回明文密钥。

## 6. 统一默认模型和 Token 控制

系统模型、默认模型、创意档和判定档已经合并为一个“默认 AI 模型”。旧配置中的 `creative/judge` 会读取迁移，新配置只写 `systemModel.default`。

可从 `.opc/config.example.json` 复制结构到本机 `.opc/config.json`，但不要复制真实密钥。核心字段：

```json
{
  "defaultModel": "gpt-5.6-luna",
  "systemModel": {
    "default": {
      "framework": "codex",
      "provider": "openai",
      "model": "gpt-5.6-luna",
      "reasoningEffort": "low"
    }
  },
  "budget": {
    "totalUsd": 0,
    "maxTokensPerTask": 200000,
    "maxAttemptsPerTask": 2,
    "taskTimeoutMs": 600000,
    "maxTokensPerRun": 300000
  },
  "permissions": {
    "allowShell": true,
    "allowFileWrite": true,
    "allowWebAccess": true
  }
}
```

`totalUsd` 只是旧 schema 兼容字段，不参与执行门控。当前产品以 Token、重试次数和超时控制资源。复杂任务若触发 `run_budget_exhausted`，应先缩小任务或提高 `maxTokensPerRun`，不要把失败改写成成功。

## 7. 公司与工作目录

每家公司必须绑定一个明确的主工作目录：

1. 打开“公司架构”。
2. 选择公司。
3. 在公司设置中选择工作目录。
4. 已有 Git 仓库可直接绑定；普通目录需选择“初始化为托管工作区”。
5. 员工 `workingDirectory` 使用公司目录内的相对路径，不应指向任意外部绝对路径。

文件读取、写入、删除、shell 和 Git 操作都受公司工作目录与项目根边界约束。危险权限默认可用是为了本地开发能力完整，但第三方模板仍会经过 Safe Install、权限披露和一次性确认。

当前仓库保留七家主公司：默认公司、产品/编码队、强研究队、Fullstack SaaS Team、Security Audit Squad、AI 研究公司、一人公司·全流程团队。

## 8. Skill、员工人设和记忆

三类资产必须区分：

- 用户 Playbook：用户创建/导入的可复用操作知识，可编辑、启用和删除。
- 公司附属能力：模板 bundled Skill 和员工 persona，由公司/员工生命周期管理。
- 记忆：来自真实 run 的结论、经验提案和成长记录，必须经过审核后才能进入后续上下文。

系统不再把内置 Worker 人设批量同步为“系统 Skill”。删除公司时会回收可证明属于该公司的 persona/bundled Skill；共享资产和用户 Playbook不会被误删。

Skill 是否真实使用应从 run Trace 中检查 `injectedSkills`/上下文证据，不能仅凭 Skill 列表存在就认定已调用。

## 9. 公司导入、导出和替代绑定

- 导出使用带 `schema_version` 的 Company Bundle。
- `full` 用于本机备份/迁移；`share` 会脱敏并经过分享安全检查。
- 导入前先运行 Template Doctor。
- 缺少 Provider、订阅、MCP 或模型时，Import Binding Plan 会列出缺口。
- 用户可以逐项绑定到已有模型，也可以先去配置缺失的 API/订阅后再安装。
- 高智能模型应绑定到高推理职责，低成本模型用于低风险、机械性职责；最终映射必须由用户确认。

导入后检查公司架构、A2A 边、验证边、Skill、默认任务、工作目录占位和记忆策略，再运行一个最小验收任务。

## 10. A2A、ACP 和 MCP

- A2A：在公司架构中配置员工间通道；运行时应看到 committed/delivered/acknowledged/resolved 生命周期。
- ACP：Codex/Claude Code 由 External Agent Bridge/ACP worker 执行，产物回收只接受隔离目录中的合法 delta。
- MCP：只使用明确命令、参数和 env；远程 URL 经过 SSRF guard，本地地址需要显式 `allowLocalNetwork`。

对编码任务，producer 负责产出，独立 verifier 负责验证。`verified` 必须有真实文件、测试证据、产物 hash 和绑定证据；否则系统应诚实返回 `tests_ran_unbound`、degraded 或 failed。

## 11. 真实任务验收

建议先跑最小任务：

1. 在全新 Git 工作目录创建一个 CommonJS 模块和测试。
2. 从 CEO 驾驶舱派单。
3. 检查任务从 queued/running 到 done 或 failed。
4. 在 Trace 查看真实 Agent、A2A、工具调用、Token、测试和产物。
5. 确认工作目录真实出现 create/modify/delete。
6. 下载产物并核对 hash。
7. 打开 `/api/runs/<runId>/evidence?verify=1`，要求 `ok: true`。
8. 失败复盘只能创建 memory proposal，之后到记忆页审批。

## 12. 验证命令

```powershell
pnpm -r typecheck
pnpm test
pnpm build
```

相关改动至少应补跑 server/web typecheck 和对应测试簇。发布候选还应执行真实 Provider run、Codex ACP run、公司 Bundle 往返和 Electron 安装态英雄回路。

## 13. Windows EXE 打包

必须从仓库根目录运行：

```powershell
pnpm build:electron
```

该命令会依次：

1. 构建 shared/server/cli/web。
2. staging server、CLI 和 Node runtime。
3. 校验 bundle 依赖与 CLI 入口。
4. 使用 electron-builder 生成 NSIS 安装包。

输出位于 `electron-app/release/`。不要直接在 `electron-app` 内单独执行 `dist:win`，否则可能漏掉 server/CLI runtime staging。

安装后至少人工验证一次：配置 Provider/订阅 -> 绑定公司工作目录 -> CEO 派单 -> 查看 A2A/Trace -> 下载产物 -> 重启后查看历史记录。

## 14. 发布前安全检查

```powershell
git status --short
git ls-files | Select-String -Pattern '\.key$|/keys/|\.env$|accounts\.json|config\.json|auth\.json|\.pem$'
git check-ignore .opc/config.json
git check-ignore .opc/opc.sqlite
git diff --check
```

发布说明应明确：Windows Private Alpha、BYO API/订阅、订阅成本不按量估算、macOS 尚未验收、第三方 CLI/MCP 以本机权限执行。不要把“测试通过”描述成 Provider 在所有机器上都能稳定写盘。
