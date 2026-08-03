import { AlertTriangle } from "lucide-react";
import { useT } from "../../i18n.js";

// 本地文件导入(CompanyTemplateSchema 校验)失败时的详情弹层——逐条列出具体是哪个字段不对,
// 不是笼统的"格式错误"。issues 既可能是 zod 的多条 "path: message",也可能是单条网络/服务端错误。
export default function LocalImportErrorModal({
  fileName, issues, onClose,
}: {
  fileName: string;
  issues: string[];
  onClose: () => void;
}) {
  const tr = useT();
  return (
    <div className="fixed inset-0 bg-black/45 flex items-center justify-center z-[1200]" onClick={onClose}>
      <div className="bg-bg-card rounded-xl p-6 w-[460px] max-w-[90vw] max-h-[80vh] overflow-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={20} className="text-red shrink-0" />
          <b className="text-[14px] text-text-primary">{tr("c.importLocalErrorTitle")}</b>
        </div>
        <p className="text-[13px] text-text-secondary m-0 mb-2 break-all">{tr("c.importLocalErrorFile", { name: fileName })}</p>
        <p className="text-[13px] text-text-secondary m-0 mb-2">{tr("c.importLocalValidationIntro")}</p>
        <ul className="m-0 pl-4 flex flex-col gap-1 mb-4">
          {issues.map((issue, i) => (
            <li key={i} className="text-[12px] text-red font-mono break-all">{issue}</li>
          ))}
        </ul>
        <div className="flex justify-end">
          <button onClick={onClose} className="btn-primary">{tr("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
