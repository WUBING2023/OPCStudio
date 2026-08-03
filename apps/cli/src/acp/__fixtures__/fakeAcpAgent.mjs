#!/usr/bin/env node
// 单测用假 ACP agent(相1 铁律:测试内禁止真实模型调用)。它是一个"真"ACP agent——用 SDK 的 agent()
// 构建器讲正确的 ndjson JSON-RPC 帧,只是模型回复是写死的确定性脚本。AcpClient 用真 SDK 连它,由此
// 覆盖:握手 / 建会话 / 流事件(message+thought+tool_call+tool_result+usage)/ permission deny / 进程清理。
//
// 用 `node fakeAcpAgent.mjs <scenario>` 起;<scenario> 决定 session/prompt 的脚本:
//   basic            —— thought + 两段 message + tool_call/update + usage_update + PromptResponse.usage
//   permission       —— 发 tool_call 后请求权限(提供 allow_once + reject_once);按 client 决定继续
//   permission-noreject —— 只提供 allow_once,验证 client 无 reject 选项时回 cancelled
//   permission-rejectonly —— 只提供 reject_once,验证 client allow 策略无 allow 选项时安全回退拒绝
//   linger           —— 正常回一句后挂一个 setInterval 常驻(不靠 stdin 关闭退出),验证 PID 树清理
//   refusal          —— 直接返回 stopReason:"refusal"(验证 stopReason 只作外部信号、不被标成功)
//   no-usage         —— 回一句文本但**不发任何 usage**(无 PromptResponse.usage、无 usage_update),
//                       模拟 claude-code ACP 适配器缺 usage → 验证 AcpClient 走文本估算并标 estimated
//   echo-prompt      —— 把收到的 prompt 文本原样回显为 agent_message_chunk,验证 ACP 路径的 prompt 组装
//   empty            —— 完全不发 agent_message_chunk(空交付),验证 report.md/result.json.content 如实空串
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";

const scenario = process.argv[2] || "basic";

async function handlePrompt(params, client) {
  const sessionId = params.sessionId;
  const notify = (update) => client.notify(acp.methods.client.session.update, { sessionId, update });

  if (scenario === "refusal") {
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I cannot help with that." } });
    return { stopReason: "refusal" };
  }

  if (scenario === "no-usage") {
    // 只回文本、绝不发 usage_update、返回也不带 usage —— 逼 AcpClient 走文本估算路径。
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
    return { stopReason: "end_turn" };
  }

  if (scenario === "empty") {
    // 完全不发 agent_message_chunk —— 空交付输出,验证 report.md / result.json.content 如实落空串(不造假)。
    return { stopReason: "end_turn", usage: { totalTokens: 5, inputTokens: 5, outputTokens: 0 } };
  }

  if (scenario === "echo-prompt") {
    // 原样回显收到的 prompt 文本(供测试断言 ACP 路径实际发出的 prompt 组装内容)。
    const echoed = (params.prompt ?? []).map((b) => (b && b.type === "text" ? b.text : "")).join("");
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: echoed } });
    return { stopReason: "end_turn", usage: { totalTokens: 7, inputTokens: 5, outputTokens: 2 } };
  }

  if (scenario === "reconnect-noise") {
    // P0:只发传输层重连/超时横幅(适配器/SDK 以 assistant text 身份下发),无任何真实模型输出 → 整轮传输失败。
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reconnecting... 2/5\n\nReconnecting... 3/5\n\nWarning: Falling back from WebSockets to HTTPS transport. request timed out" } });
    return { stopReason: "end_turn", usage: { totalTokens: 3, inputTokens: 3, outputTokens: 0 } };
  }

  if (scenario === "reconnect-then-content") {
    // P0:先发传输噪声横幅,再发真实模型输出 → 噪声被剥离、只保留真实内容(不因噪声判失败,也不把噪声当交付)。
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reconnecting... 2/5\n\nrequest timed out" } });
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "真实交付:已实现 isPrime 函数并通过测试。" } });
    return { stopReason: "end_turn", usage: { totalTokens: 9, inputTokens: 5, outputTokens: 4 } };
  }

  if (scenario === "mixed-chunk-noise") {
    // P0(用户审计):噪声与真实输出混在【同一个】chunk(lcm 活体实况)——必须逐行剥离,保留真实交付、丢掉横幅。
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reconnecting... 2/5\n真实交付:已实现 lcm 函数。\nrequest timed out\n并通过 node lcm.test.js(exit 0)。" } });
    return { stopReason: "end_turn", usage: { totalTokens: 11, inputTokens: 5, outputTokens: 6 } };
  }

  // 一段"思考"
  await notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about it..." } });
  // 两段正文
  await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
  await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } });

  // 一次不需要权限的工具调用 + 完成更新
  await notify({
    sessionUpdate: "tool_call",
    toolCallId: "call_read_1",
    title: "Read README",
    kind: "read",
    status: "pending",
    rawInput: { path: "README.md" },
  });
  await notify({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_read_1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "file contents here" } }],
    rawOutput: { bytes: 18 },
  });

  if (scenario === "permission" || scenario === "permission-noreject" || scenario === "permission-rejectonly") {
    const options =
      scenario === "permission"
        ? [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ]
        : scenario === "permission-rejectonly"
          ? [{ optionId: "reject", name: "Reject", kind: "reject_once" }] // 只给 reject:验 allow 策略无 allow 选项时安全回退拒绝
          : [{ optionId: "allow", name: "Allow", kind: "allow_once" }];
    const resp = await client.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: "call_write_1", title: "Write config.json", kind: "edit", status: "pending" },
      options,
    });
    const decision = resp?.outcome?.outcome === "selected" ? `selected:${resp.outcome.optionId}` : "cancelled";
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: ` [permission ${decision}]` },
    });
  }

  // 用量(context 窗 + 本轮 token 汇总)
  await notify({ sessionUpdate: "usage_update", used: 1234, size: 200000, cost: { amount: 0, currency: "USD" } });

  if (scenario === "linger") {
    // 常驻:不靠 stdin 关闭退出,逼 AcpClient 走 PID 树清理才能杀掉本进程。
    setInterval(() => {}, 100000);
  }

  return { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 12, outputTokens: 18 } };
}

const toClient = Writable.toWeb(process.stdout);
const fromClient = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(toClient, fromClient);

acp
  .agent({ name: "fake-acp-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "fake-acp-agent", version: "9.9.9" },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: randomUUID() }))
  .onRequest(acp.methods.agent.authenticate, () => ({}))
  .onRequest(acp.methods.agent.session.prompt, (ctx) => handlePrompt(ctx.params, ctx.client))
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .connect(stream);
