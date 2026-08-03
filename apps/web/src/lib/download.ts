// 共用的"生成 JSON 文件并触发浏览器下载"辅助函数——统一走 JSON.stringify(obj, null, 2)
// (缩进换行,人可读),不是压缩成一整行。之前公司导出走 <a href="/api/.../export"> 直接导航,
// 下载到的是服务端 res.json() 的压缩单行输出;这里改成 fetch 内容后本地生成带缩进的 Blob 再下载,
// 与 CompanyStructureForms.tsx 的「记忆摘要下载」同一套写法(现在两处共用这一份实现)。
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
