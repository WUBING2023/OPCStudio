// C4(主导航 9→7):"成果"一级入口——trace/ResultSection(任务档案)本身已经是列表+详情
// (①结果 ②过程回放 ③账单)的完整实现,直接复用 TracePage 本体,不重写。这里只是给它一个
// 独立的文件名/导出,让 App.tsx 的路由表读起来和新导航语义(成果)对齐。
export { default } from "./TracePage.js";
