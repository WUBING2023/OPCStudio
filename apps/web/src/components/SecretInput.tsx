import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}

export default function SecretInput({ value, onChange, placeholder, label }: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      {label && <label className="text-[13px] text-text-primary block mb-1">{label}</label>}
      <div className="flex items-center">
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 border border-border-light border-r-0 rounded-l-md px-2.5 py-2 text-[13px] outline-none focus:border-accent" />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="border border-border-light border-l-0 rounded-r-md px-3 py-2 bg-bg-card cursor-pointer text-text-secondary hover:bg-bg-hover transition-colors">
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}
