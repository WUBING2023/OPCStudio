import { describe, it, expect, beforeEach } from "vitest";
import type { TraceEvent } from "@opc/shared";
import { useAgentStore } from "./useAgentStore.js";

// B7 泄漏面:server 侧 stripThinkBlocks 把 <think> 从交付正文剥离后,以 agent_output_chunk{thinking:true}
// 单独 emit。画布气泡(outputChunks)绝不能累积这类 chunk——否则用户仍看得到模型思考流。

let seq = 0;
function chunkEvent(agentId: string, payload: unknown): TraceEvent {
  return { id: `e${++seq}`, runId: "r1", timestamp: new Date().toISOString(), type: "agent_output_chunk", agentId, payload } as TraceEvent;
}

beforeEach(() => {
  useAgentStore.setState({ agents: [], events: [], outputChunks: {}, loadedHistoryRuns: [], selectedId: null });
});

describe("useAgentStore · thinking chunk 不进画布(B7)", () => {
  it("addEvent:thinking:true 的 chunk 被丢弃,正文 chunk 正常累积", () => {
    const st = useAgentStore.getState();
    st.addEvent(chunkEvent("dev-1", { chunk: "正文A", thinking: false }));
    st.addEvent(chunkEvent("dev-1", { chunk: "我在推理…", thinking: true }));
    st.addEvent(chunkEvent("dev-1", { chunk: "正文B" }));
    expect(useAgentStore.getState().outputChunks["dev-1"]).toBe("正文A正文B");
  });

  it("addEvent:纯 thinking chunk 不创建 outputChunks 条目", () => {
    useAgentStore.getState().addEvent(chunkEvent("dev-2", { chunk: "只有思考", thinking: true }));
    expect(useAgentStore.getState().outputChunks["dev-2"]).toBeUndefined();
  });

  it("mergeRunHistory:历史回放同样跳过 thinking chunk", () => {
    useAgentStore.getState().mergeRunHistory("r9", [
      chunkEvent("dev-3", { chunk: "历史正文" }),
      chunkEvent("dev-3", { chunk: "历史思考", thinking: true }),
    ]);
    expect(useAgentStore.getState().outputChunks["dev-3"]).toBe("历史正文");
  });
});
