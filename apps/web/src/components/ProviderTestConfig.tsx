import { useState } from "react";
import CollapsibleSection from "./CollapsibleSection.js";
import * as api from "../api/client.js";
import type { ProviderConfig } from "@opc/shared";

interface Props {
  form: Partial<ProviderConfig>;
}

interface TestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

const inputClass = "w-full border border-border-light rounded-md px-2.5 py-2 text-[13px] outline-none box-border focus:border-accent focus:ring-1 focus:ring-accent";

export default function ProviderTestConfig({ form }: Props) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [testModel, setTestModel] = useState(form.test?.model || form.defaultModel || "");
  const [testPrompt, setTestPrompt] = useState(form.test?.prompt || "Say hello in one word.");
  const [timeoutMs, setTimeoutMs] = useState(form.test?.timeoutMs || 15000);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.post<TestResult>("/providers/test", {
        apiFormat: form.apiFormat,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        providerId: form.id,
        model: testModel,
        prompt: testPrompt,
        timeoutMs,
      });
      setResult(r);
    } catch (e: any) {
      setResult({ ok: false, latencyMs: 0, model: testModel, message: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <CollapsibleSection title="测试连接">
      <div className="flex flex-col gap-3">
        <div className="flex gap-2.5">
          <div className="flex-1">
            <label className="text-[13px] text-text-primary block mb-1">测试模型</label>
            <input className={inputClass} value={testModel}
              onChange={e => setTestModel(e.target.value)} placeholder="gpt-5.1" />
          </div>
          <div className="flex-1">
            <label className="text-[13px] text-text-primary block mb-1">超时 (ms)</label>
            <input className={inputClass} type="number" value={timeoutMs}
              onChange={e => setTimeoutMs(parseInt(e.target.value) || 15000)} />
          </div>
        </div>
        <div>
          <label className="text-[13px] text-text-primary block mb-1">测试 Prompt</label>
          <textarea className={`${inputClass} resize-y min-h-[60px]`}
            value={testPrompt} onChange={e => setTestPrompt(e.target.value)} rows={3} />
        </div>
        <button
          onClick={handleTest}
          disabled={testing || !form.baseUrl || !form.apiKey}
          className="btn-primary self-start">
          {testing ? "测试中..." : "测试连接"}
        </button>
        {result && (
          <div className={`p-3 rounded-md text-[13px] border ${
            result.ok ? "bg-green/10 border-green/20 text-green" : "bg-red/10 border-red/20 text-red"
          }`}>
            <div><strong>状态:</strong> {result.ok ? "成功 ✅" : "失败 ❌"}</div>
            <div><strong>延迟:</strong> {result.latencyMs}ms</div>
            <div><strong>模型:</strong> {result.model}</div>
            <div className="mt-1 break-all"><strong>响应:</strong> {result.message}</div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
