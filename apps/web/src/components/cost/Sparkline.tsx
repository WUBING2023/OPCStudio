// Hand-written 7-day trend sparkline — no chart library. Renders null when there isn't enough
// signal to draw a meaningful line; the caller decides what honest empty copy to show instead
// (a flat line at zero would silently misrepresent "no data" as "definitely zero forever").
export function Sparkline({
  values, width = 96, height = 28, color = "var(--color-accent)",
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const pad = 3;
  const coords = values.map((v, i) => [
    i * stepX,
    pad + (height - pad * 2) * (1 - (v - min) / range),
  ]);
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = coords[coords.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <path d={area} fill={color} fillOpacity={0.12} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.25} fill={color} />
    </svg>
  );
}
