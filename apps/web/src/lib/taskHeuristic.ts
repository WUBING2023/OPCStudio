// 判别"对话 vs 派任务"的启发式正则。BottomChat 和 CockpitPage 共用,避免双份定义漂移(报告 #5)。
// 命中 → 走 api.chatTask 启动一个 run;否则走 api.chat 仅对话回复。
export const TASK_RE = /做|建|写|改|实现|修复|开发|部署|重构|设计|build|create|fix|implement|add|deploy|refactor/i;

export function isTaskLike(text: string): boolean {
  return TASK_RE.test(text);
}
