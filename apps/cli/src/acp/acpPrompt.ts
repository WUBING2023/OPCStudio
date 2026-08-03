// ACP worker 路径的 prompt 组装。Client 不代理 fs/terminal，但外部 agent 可以在隔离工作目录中使用
// 自己的原生文件/命令工具；permission request 由 worker 路径显式批准，最终变更仍由 Core 校验回收。
// 外部 CLI 不拥有 memory/A2A/success，产出一律进入 Runtime Contract 由 Core 验收。
//
// 因此这里**不复用** server 侧的 hermes 角色 prompt(getRolePrompt):那些 prompt 内嵌了"必须调用 writeFile
// 工具,否则产出丢失""DIRECT_ANSWER/## PLAN/## LEAD 机器解析格式"等 hermes 内核指令。
// 这里只说明真实能力边界并要求工具证据，避免模型把隔离执行误判成 text-only，导致测试 Agent 不创建测试、不运行命令。


export interface AcpTaskBriefInput {
  goal: string;
  role: string;
}

export function buildAcpTaskBrief(input: AcpTaskBriefInput): string {
  const role = input.role.trim() || "worker";
  const goal = input.goal.trim();
  return [
    "# 任务简报",
    "",
    `你是本次任务的执行者(角色:${role})。请完成下面的目标,并直接在回复中以文本给出结果。`,
    "",
    "## 目标",
    goal,
    "",
    "## 上下文",
    "- 运行模式:隔离工作目录。可使用引擎原生的文件与命令工具；所有变更会由 Core 校验后再回收。",
    "- 若任务要求创建或修改文件，必须实际落盘；若要求测试，必须实际运行测试命令。不要用代码块或自然语言声称替代真实执行。",
    "- 回复中简要列出实际修改的文件与实际运行的命令/结果。Core 只把磁盘变更和工具证据作为权威依据。",
    "",
    "## 期望产出",
    "- 直接输出完成结果本身,不要复述任务、也不要加多余的寒暄或说明。",
    "- 若目标要求“只输出 X”,就恰好只回复 X,不要添加任何额外字符。",
  ].join("\n");
}
