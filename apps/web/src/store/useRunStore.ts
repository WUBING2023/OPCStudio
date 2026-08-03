import { create } from "zustand";
import * as api from "../api/client.js";

interface RunItem { id: string; goal: string; status: string; startedAt: string; }

interface RunStore {
  runs: RunItem[];
  load: () => Promise<void>;
}

// 运行列表只读 store(数据来自 GET /api/runs,服务端从 .opc/runs 读盘派生)。
// 启动 run 一律走 api.chatTask(POST /api/chat/task);旧的 submitGoal(POST /api/runs)已删——它从未被调用,
// 且与真实启动路径不一致(见报告 #5)。
export const useRunStore = create<RunStore>((set) => ({
  runs: [],
  load: async () => {
    const runs = await api.get<RunItem[]>("/runs");
    set({ runs });
  },
}));
