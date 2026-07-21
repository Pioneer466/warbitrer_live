"use client";

type Series = {
  key: string;
  label: string;
  color: string;
  fill: string;
  values: Array<number | null>;
};

type LineChartProps = {
  series: Series[];
  labels: string[];
};

const WIDTH = 760;
const HEIGHT = 260;
const PADDING = 22;

export function LineChart({ series, labels }: LineChartProps) {
  const flatValues = series.flatMap((line) => line.values.filter((value): value is number => value !== null));
  const hasData = flatValues.length > 0;
  const minValue = flatValues.length > 0 ? Math.min(...flatValues, 0) : 0;
  const maxValue = flatValues.length > 0 ? Math.max(...flatValues, 1) : 1;
  const range = Math.max(maxValue - minValue, 0.05);
  const baselineY = HEIGHT - PADDING;
  const labelStep = labels.length > 6 ? Math.ceil(labels.length / 6) : 1;

  function getX(index: number) {
    if (labels.length <= 1) {
      return WIDTH / 2;
    }
    return PADDING + (index / (labels.length - 1)) * (WIDTH - PADDING * 2);
  }

  function getY(value: number) {
    return HEIGHT - PADDING - ((value - minValue) / range) * (HEIGHT - PADDING * 2);
  }

  return (
    <div className="overflow-hidden rounded-[24px] border border-white/6 bg-[#0b0e15] p-4">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-[260px] w-full">
        {Array.from({ length: 5 }).map((_, index) => {
          const y = PADDING + (index / 4) * (HEIGHT - PADDING * 2);
          return (
            <line
              key={index}
              x1={PADDING}
              x2={WIDTH - PADDING}
              y1={y}
              y2={y}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="1"
            />
          );
        })}

        {Array.from({ length: 6 }).map((_, index) => {
          const x = PADDING + (index / 5) * (WIDTH - PADDING * 2);
          return (
            <line
              key={`vertical-${index}`}
              x1={x}
              x2={x}
              y1={PADDING}
              y2={HEIGHT - PADDING}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth="1"
            />
          );
        })}

        {series.map((line) => {
          const points = line.values
            .map((value, index) => (value === null ? null : { x: getX(index), y: getY(value) }))
            .filter((value): value is { x: number; y: number } => value !== null);

          const linePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
          const areaPoints =
            points.length > 1
              ? [
                  `${points[0].x},${baselineY}`,
                  ...points.map((point) => `${point.x},${point.y}`),
                  `${points[points.length - 1].x},${baselineY}`,
                ].join(" ")
              : "";

          if (points.length === 0) {
            return null;
          }

          return (
            <g key={line.key}>
              {areaPoints ? <polygon points={areaPoints} fill={line.fill} /> : null}
              <polyline
                fill="none"
                points={linePoints}
                stroke={line.color}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeWidth="2"
              />
              {points.length === 1 ? <circle cx={points[0].x} cy={points[0].y} r="4" fill={line.color} /> : null}
            </g>
          );
        })}

        {!hasData ? (
          <text x={WIDTH / 2} y={HEIGHT / 2} fill="rgba(143, 152, 179, 0.72)" fontSize="14" textAnchor="middle">
            Pas encore de points pour ce créneau.
          </text>
        ) : null}

        {labels.map((label, index) =>
          index % labelStep === 0 || index === labels.length - 1 ? (
            <text
              key={`${label}-${index}`}
              x={getX(index)}
              y={HEIGHT - 4}
              fill="rgba(143, 152, 179, 0.72)"
              fontSize="11"
              textAnchor="middle"
            >
              {label}
            </text>
          ) : null,
        )}
      </svg>
      <div className="mt-3 flex flex-wrap gap-4">
        {series.map((line) => (
          <div key={line.key} className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-mist/70">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: line.color }} />
            {line.label}
          </div>
        ))}
      </div>
    </div>
  );
}
