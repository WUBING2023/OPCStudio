# OPC Studio 分发 / 打包框架(密钥安全)

> 目标:打包成 exe、推送到 GitHub、做社区分享时 —— **代码可携带,密钥绝不携带**。

## 一、密钥从哪来(三层,优先级 高→低)

应用启动时 `syncProvidersFromStore` 调 `collectApiKeys()` 按此顺序取密钥:
1. **环境变量** `<PROVIDER>_API_KEY` —— `DEEPSEEK_API_KEY` / `MINIMAX_API_KEY` / `DOUBAO_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。(部署/CI/exe 用户首选)
2. **keys 目录的 `<provider>.key` 文件**,按序探测:`OPC_KEYS_DIR` > **`<projectRoot>/.opc/keys`(项目内,推荐——整目录可搬运、自包含)** > `<projectRoot>/../../keys`(旧父目录布局,兼容)。这些目录**已 gitignore**。
3. **`.opc/config.json` 的 `apiKeys`** —— 本地私有文件,**已 gitignore**,UI 里填的 key 写在这。

→ 三处都**不进版本库、不进 exe**。代码里没有任何密钥。

> 新机器一键引导见 `scripts/setup.ps1`(检查 node/pnpm、装依赖、检测/安装 Hermes、建 `.opc/keys`、构建 web)。
> 历史:旧的 Python 版 OPC 已归档为 `notuse.zip`,不再是本项目的一部分;OPC Studio(本目录,TypeScript)自包含。

## 二、哪些东西不提交 / 不打包(.gitignore 已覆盖)

- 密钥:`**/*.key`、`keys/`、`.env*`、`.opc/config.json`、`.opc/accounts.json`、`**/auth.json`、`**/.credentials.json`、`*.pem`
- 运行时数据:`.opc/runs/`、`.opc-studio/`(各公司 worktree + run 产出)、`*.log`
- 依赖/产物:`node_modules/`、`dist/`、`release/`、`*.egg-info/`
- 保留模板:`.opc/config.example.json`

## 三、exe 打包(electron-builder)只带代码

`electron-app/package.json` 的 `extraResources` 只打包:`apps/server/src`、`apps/web/dist`、`packages/shared`、`node_modules`。
**不含** `.opc/`、`keys/` —— 所以 exe 里没有密钥。用户安装后通过环境变量 / keys 目录 / UI 自行提供密钥。

## 四、分发前自检清单

```bash
# 1) 确认没有密钥被 git 跟踪(应为空输出)
git ls-files | grep -iE '\.key$|/keys/|\.env$|accounts\.json|config\.json|auth\.json|\.pem$'
# 2) 确认敏感文件被忽略(应打印路径)
git check-ignore .opc/config.json keys/deepseek.key
# 3) 若历史中曾误提交密钥 → 必须轮换密钥(history rewrite 才能彻底清除历史)
```

## 五、Hermes(执行层)注意

- Hermes 自身的 provider 凭证存在 `~/.hermes/`(`hermes auth add`),**在用户机器本地,不随项目分发**。新机器需用户自己 `hermes auth add <provider> --api-key …`。
- Hermes Agent CLI 本体系统级安装(`~/.local/bin/hermes.exe`),不打进项目 exe;分发时文档提示用户先装 Hermes(`install.ps1`)。

## 六、用户首次使用(BYOK,Bring Your Own Keys)

1. 装 Hermes:`iex (irm https://hermes-agent.nousresearch.com/install.ps1)` → `hermes auth add deepseek --api-key sk-…`
2. 给 OPC 提供密钥(任选一):设环境变量 `DEEPSEEK_API_KEY=…`;或放 `keys/deepseek.key`;或在 UI 的供应商设置页填写(写入本地 `.opc/config.json`)。
3. 启动 OPC Studio。

## 七、商业边界(WS7):本地优先 + BYO-account,卖控制平面不卖额度

- **定位红线**:OPC 是**本地优先的编排/治理层**。用户在自己的机器、用**自己的账号/订阅/API key** 运行各 CLI/引擎。OPC **不转售、不代持** Claude Code / Codex / ChatGPT 等的订阅额度或登录态。
- **依据**:Anthropic 商业条款禁止未经批准转售服务、禁止为构建竞品访问服务;OpenAI ToS 禁止共享账号凭证、转售/分发、程序化提取输出、规避限制。Claude Code / Codex CLI 官方均支持用户**本地用自己的账号/订阅或 API key** 登录使用 —— 这正是 OPC 的合规切口。
- **OPC 卖什么**:编排、可视化、trace、workflow、记忆、团队协作、可复用资产、评测、权限与安全治理 —— **不是模型调用本身**。企业版重心 = team workspace / 私有资产库 / 审计·SSO·权限,而非"多一个模型入口"。
- **实现约束**:云端(若有)只做社区资产 / marketplace / 账号同步;**绝不在服务端代持用户 CLI 登录态、不替用户跑订阅额度**。

## 八、MCP / 插件供应链治理(WS7)

OPC 一旦开放社区资产 / skills / 工具市场 / MCP bridge,工具供应链即攻击面。**协议层不保证安全**(MCP 规范明示授权/访问控制由实施方负责);对开源 MCP server 的大样本研究发现存在 MCP 特有的 tool-poisoning。治理要点(**别等"社区起量后"才做** —— 一旦 agent 有本地执行能力,风险从 prompt 层放大成系统层):
- **allowlist / managed-only**:默认只允许白名单内的 MCP server / skill。
- **descriptor 签名 + 版本钉住**:工具描述符签名校验 + 版本固定,防供应链替换。
- **provenance**:每个 tool/provider 记来源。
- **最小权限默认**:工具默认最小文件/网络/凭据权限;敏感操作需用户确认。
- **隔离运行 + 健康扫描**:外部 MCP server 隔离运行;定期扫描已知风险。
