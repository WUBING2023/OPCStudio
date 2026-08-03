import { useState } from "react";
import { useT } from "../../i18n.js";
import { fmtTok, fmtTokShort } from "./format.js";
import { colorForProvider } from "./providerColor.js";
import type { Timeseries } from "./types.js";

// y 轴上界取整到"漂亮"刻度(1/2/2.5/5/10 × 10^n),让坐标干净。
function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const exp = Math.floor(Math.log10(n)); const base = Math.pow(10, exp); const f = n / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * base;
}

// 月度堆叠柱状图(SVG,响应式不溢出)。x=当月每天,y=token,按 provider 分色堆叠。
// 交互:悬停预览 / 点击固定(selected),明细显示在右侧 in-flow 面板(不再用浮动浮层 → 不溢出、不左右摇晃)。
export default function StackedChart({ ts }: { ts: Timeseries }) {
  const tr = useT();
  const [hover, setHover] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const active = selected ?? hover;
  const W = 700, H = 196, padL = 38, padB = 22, padT = 10, padR = 6;
  const chartW = W - padL - padR, chartH = H - padB - padT;
  const niceMax = niceCeil(Math.max(1, ...ts.days.map(d => d.total)));
  const bw = chartW / Math.max(1, ts.days.length);
  const barW = Math.max(2, bw * 0.6), barGap = (bw - Math.max(2, bw * 0.6)) / 2;

  const ad = active != null ? ts.days[active] : null;
  const adRows = ad ? ts.providers.map(p => ({ p, v: ad.byProvider[p] ?? 0 })).filter(r => r.v > 0).sort((a, b) => b.v - a.v) : [];
  const dayMax = Math.max(1, ...adRows.map(r => r.v));

  return (
    <div className="flex flex-wrap gap-4 items-stretch">
      <div className="flex-1 min-w-[280px]" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H + 6 }} preserveAspectRatio="xMidYMid meet">
          {[0, 0.25, 0.5, 0.75, 1].map(f => {
            const y = padT + chartH * (1 - f);
            return (
              <g key={f}>
                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--color-hairline)" strokeWidth={1} strokeOpacity={f === 0 ? 0.9 : 0.3} />
                {(f === 0 || f === 0.5 || f === 1) && <text x={padL - 5} y={y + 3} textAnchor="end" fontSize={9} fill="var(--color-ink-subtle, #8f8f8f)">{fmtTokShort(niceMax * f)}</text>}
              </g>
            );
          })}
          {active != null && (
            <rect x={padL + active * bw} y={padT} width={bw} height={chartH} rx={2}
              fill="var(--color-accent, #0285ff)" fillOpacity={0.08} stroke="var(--color-accent, #0285ff)" strokeOpacity={0.3} strokeWidth={1} pointerEvents="none" />
          )}
          {ts.days.map((d, i) => {
            let yCursor = padT + chartH; const x = padL + i * bw;
            const dayNum = Number(d.date.slice(-2));
            return (
              <g key={d.date} style={{ opacity: active != null && active !== i ? 0.28 : 1, transition: "opacity 120ms" }}>
                {ts.providers.map(p => {
                  const v = d.byProvider[p] ?? 0; if (v <= 0) return null;
                  const h = (v / niceMax) * chartH; yCursor -= h;
                  return <rect key={p} x={x + barGap} y={yCursor} width={barW} height={Math.max(0.5, h)} rx={1} fill={colorForProvider(p)} />;
                })}
                {(dayNum === 1 || dayNum % 5 === 0) && <text x={x + bw / 2} y={H - 7} textAnchor="middle" fontSize={9} fill="var(--color-ink-subtle, #8f8f8f)">{dayNum}</text>}
              </g>
            );
          })}
          {ts.days.map((d, i) => {
            const x = padL + i * bw;
            return <rect key={"hit" + d.date} x={x} y={padT} width={bw} height={chartH} fill="transparent"
              onMouseEnter={() => setHover(i)} onClick={() => setSelected(s => s === i ? null : i)} style={{ cursor: "pointer" }} />;
          })}
        </svg>
        <div className="flex flex-wrap gap-3 mt-1 px-1">
          {ts.providers.map(p => (
            <span key={p} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: colorForProvider(p) }} />{p}
            </span>
          ))}
          {!ts.providers.length && <span className="text-[11px] text-ink-muted">{tr("cost.chart.noData")}</span>}
        </div>
      </div>

      <div className="w-full sm:w-56 shrink-0 rounded-lg border border-hairline/60 bg-surface-0 p-3 text-[12px]">
        {ad ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-ink font-semibold tabular-nums">{ad.date}</span>
              {selected != null
                ? <button onClick={() => setSelected(null)} className="text-[10px] text-ink-subtle hover:text-ink cursor-pointer bg-surface-2 rounded-full px-1.5 py-0.5 border-none">{tr("cost.chart.pinned")}</button>
                : <span className="text-[10px] text-ink-subtle">{tr("cost.chart.clickToPin")}</span>}
            </div>
            {adRows.length === 0 ? <div className="text-ink-subtle">{tr("cost.chart.noDayData")}</div> : (
              <div className="space-y-1.5">
                {adRows.map(r => (
                  <div key={r.p}>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colorForProvider(r.p) }} />
                      <span className="text-ink-muted flex-1 truncate">{r.p}</span>
                      <span className="text-ink tabular-nums">{fmtTok(r.v)}</span>
                      <span className="text-ink-subtle tabular-nums w-8 text-right">{Math.round(r.v / ad.total * 100)}%</span>
                    </div>
                    <div className="h-1 rounded-full bg-surface-2 mt-1 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(r.v / dayMax) * 100}%`, background: colorForProvider(r.p) }} /></div>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-1.5 mt-1.5 border-t border-hairline/60">
                  <span className="text-ink-muted font-medium">{tr("cost.chart.total")}</span>
                  <span className="text-ink font-semibold tabular-nums">{fmtTok(ad.total)} tok</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="h-full flex flex-col justify-center text-ink-subtle text-[12px] gap-1">
            <span>{tr("cost.chart.hoverHint1")}</span>
            <span>{tr("cost.chart.hoverHint2")}</span>
            <div className="mt-2 pt-2 border-t border-hairline/60 text-ink-muted">{tr("cost.chart.monthTotal")} <span className="text-ink font-semibold tabular-nums">{fmtTok(ts.monthTotal)}</span> tok</div>
          </div>
        )}
      </div>
    </div>
  );
}
