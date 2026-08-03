import { useState, useEffect, useRef } from "react";

interface Props {
  label: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}

export default function ProviderJsonEditor({ label, value, onChange }: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (!initRef.current) {
      setText(JSON.stringify(value, null, 2));
      initRef.current = true;
    }
  }, []);

  const handleChange = (raw: string) => {
    setText(raw);
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
        setError("必须是一个 JSON 对象");
        return;
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== "string") {
          setError(`值必须是字符串: ${k}`);
          return;
        }
      }
      setError(null);
      onChange(parsed as Record<string, string>);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(text);
      setText(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[13px] text-text-primary">{label}</label>
        <button
          type="button"
          onClick={handleFormat}
          className="text-[11px] px-2 py-0.5 border border-border-light rounded bg-bg-card cursor-pointer text-text-secondary hover:bg-bg-hover">
          格式化
        </button>
      </div>
      <textarea
        value={text}
        onChange={e => handleChange(e.target.value)}
        rows={6}
        className="w-full rounded-md px-2.5 py-2 text-xs font-mono outline-none resize-y box-border focus:ring-1 focus:ring-accent"
        style={{ border: `1px solid ${error ? "var(--color-red)" : "var(--color-border-light)"}` }} />
      {error && <div className="text-xs text-red mt-1">{error}</div>}
    </div>
  );
}
