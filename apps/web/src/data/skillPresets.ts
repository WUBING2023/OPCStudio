// Curated skill presets — original write-ups distilled from well-known engineering references,
// each citing its real source. One-click import creates a LOCAL skill (role-bound), in the same
// "source-attributed, enable-with-one-click" spirit as the codex / claude-code skill importers.
export interface SkillPreset {
  id: string;
  title: string;
  role: string;
  description: string;
  source: string;      // real upstream reference (attribution)
  sourceLabel: string;
  content: string;     // original content authored here (not fetched)
}

export const SKILL_PRESETS: SkillPreset[] = [
  {
    id: "code-review-checklist",
    title: "代码审查清单",
    role: "test",
    description: "提交评审前的系统化自检：正确性、可读性、测试、边界。",
    source: "https://github.com/google/eng-practices",
    sourceLabel: "google/eng-practices",
    content: `# 代码审查清单（提炼自 Google Engineering Practices）

评审一段代码时，按以下顺序判断，发现阻塞项就明确指出而非含糊带过：

1. **设计**：改动是否放在正确的层？是否引入了不必要的耦合或抽象？有没有更简单的实现？
2. **正确性**：逻辑边界（空、零、越界、并发）是否覆盖？错误路径是否被处理而非吞掉？
3. **可读性**：命名是否自解释？复杂处是否有"为什么"的注释（而非"做了什么"）？
4. **测试**：新逻辑是否有对应测试？测试是否真的会因 bug 失败（而非永远通过）？
5. **一致性**：是否遵循本仓库既有风格与惯例，而不是引入个人偏好？

评审原则：对事不对人；区分"必须改(blocking)"与"建议(nit)"；能给出可执行的修改建议，而不仅是指出问题。`,
  },
  {
    id: "conventional-commits",
    title: "规范化提交信息",
    role: "dev",
    description: "Conventional Commits 规范：type(scope): subject 结构化提交。",
    source: "https://github.com/conventional-commits/conventionalcommits.org",
    sourceLabel: "conventional-commits",
    content: `# 规范化提交信息（Conventional Commits）

格式：\`<type>(<scope>): <subject>\`，正文空一行后写动机与影响。

常用 type：
- **feat**：新功能　**fix**：缺陷修复　**docs**：文档
- **refactor**：不改行为的重构　**perf**：性能　**test**：测试
- **build/ci**：构建与流水线　**chore**：杂项

要求：subject 用祈使句、现在时、≤50 字、结尾不加句号；破坏性变更在正文加 \`BREAKING CHANGE:\` 说明。好的提交让 \`git log\` 自身就是一份可读的变更史。`,
  },
  {
    id: "twelve-factor",
    title: "12-Factor 应用准则",
    role: "ops",
    description: "云原生应用的配置、依赖、进程、日志等 12 条准则。",
    source: "https://github.com/heroku/12factor",
    sourceLabel: "heroku/12factor",
    content: `# 12-Factor 应用准则（运维视角要点）

- **配置**：一切随环境变化的值走环境变量，绝不硬编码进代码或提交进仓库。
- **依赖**：显式声明并隔离依赖（锁文件），不依赖系统全局包。
- **进程**：应用是无状态进程；任何需持久化的状态进后端服务（DB/缓存/对象存储）。
- **端口绑定**：自身通过端口暴露服务，不依赖运行时注入的 web 容器。
- **并发**：通过进程模型水平扩展，而非单进程内无限加线程。
- **可处置性**：快速启动、优雅关闭（处理完在途请求再退出）。
- **日志**：当作事件流写到 stdout，由平台收集，应用不自己管理日志文件。

部署一个服务前，逐条对照这份清单，能挡掉大多数"在我机器上能跑"的问题。`,
  },
  {
    id: "owasp-secure-coding",
    title: "安全编码要点",
    role: "security",
    description: "OWASP 视角的输入校验、鉴权、密钥与依赖安全基线。",
    source: "https://github.com/OWASP/CheatSheetSeries",
    sourceLabel: "OWASP/CheatSheetSeries",
    content: `# 安全编码要点（提炼自 OWASP Cheat Sheet Series）

- **输入即不可信**：所有外部输入做白名单校验；SQL 用参数化查询，绝不拼接；输出按上下文转义防 XSS。
- **鉴权与会话**：密码用 bcrypt/argon2 加盐哈希；会话令牌高熵、可失效；敏感操作二次校验。
- **访问控制**：默认拒绝，按最小权限授权；每个对象访问都校验归属，防越权（IDOR）。
- **密钥管理**：密钥/令牌走密钥管理服务或环境变量，绝不进代码库；定期轮换。
- **依赖安全**：锁定版本 + 定期扫描已知漏洞（CVE）；及时升级有补丁的组件。
- **错误处理**：对外返回模糊错误信息，详细堆栈只进内部日志，避免信息泄露。`,
  },
  {
    id: "testing-strategy",
    title: "测试策略（测试金字塔）",
    role: "test",
    description: "单元/集成/端到端的比例与取舍，写出会失败的测试。",
    source: "https://github.com/goldbergyoni/javascript-testing-best-practices",
    sourceLabel: "javascript-testing-best-practices",
    content: `# 测试策略（测试金字塔）

- **底层多、上层少**：大量快速的单元测试，适量集成测试，少量端到端（E2E）测试。E2E 慢且脆，只覆盖关键用户路径。
- **测行为，不测实现**：断言对外可观察的行为，而非内部私有细节，否则一重构测试全红。
- **AAA 结构**：Arrange-Act-Assert，每个测试只验证一件事，命名描述"在什么条件下，期望什么结果"。
- **测试要会失败**：写完测试先让它对着 bug 失败一次，确认它真的有保护力，而不是永远绿。
- **隔离副作用**：网络/时间/随机用替身（mock/fake）固定，使测试确定可重复。`,
  },
  {
    id: "system-design-tradeoffs",
    title: "系统设计权衡",
    role: "architect",
    description: "容量估算、瓶颈识别、一致性与可用性的工程取舍。",
    source: "https://github.com/donnemartin/system-design-primer",
    sourceLabel: "system-design-primer",
    content: `# 系统设计权衡（提炼自 System Design Primer）

设计一个系统时按此推进，并把每个取舍的理由说清楚：

1. **澄清需求**：读写比、QPS、数据量、延迟与可用性目标——先量化再设计。
2. **容量估算**：估算存储、带宽、QPS 的数量级，判断单机够不够、瓶颈在哪。
3. **自顶向下**：先画清接口与数据流，再细化每个组件，最后才谈优化。
4. **核心取舍**：
   - 一致性 vs 可用性（CAP）：金融偏强一致，社交可接受最终一致。
   - 读多写少 → 缓存 + 读副本；写多 → 分片 + 异步队列削峰。
   - 不要过早分布式：单库扛得住就别上微服务，复杂度是真实成本。
5. **识别瓶颈**：指出单点故障与热点，给出降级与扩展路径。`,
  },
];
