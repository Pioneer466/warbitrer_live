"use client";

type Series = {
  key: string;
  label: string;
  color: string;
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
  const minValue = flatValues.length > 0 ? Math.min(...flatValues, 0) : 0;
  const maxValue = flatValues.length > 0 ? Math.max(...flatValues, 1) : 1;
  const range = Math.max(maxValue - minValue, 0.05);

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
    <div className="overflow-hidden rounded-[28px] border border-white/8 bg-white/[0.02] p-4">
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

        {series.map((line) => {
          const points = line.values
            .map((value, index) => (value === null ? null : `${getX(index)},${getY(value)}`))
            .filter((value): value is string => value !== null)
            .join(" ");

          return (
            <g key={line.key}>
              <polyline
                fill="none"
                points={points}
                stroke={line.color}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeWidth="3"
              />
              {line.values.map((value, index) =>
                value === null ? null : (
                  <circle
                    key={`${line.key}-${index}`}
                    cx={getX(index)}
                    cy={getY(value)}
                    r="2.4"
                    fill={line.color}
                  />
                ),
              )}
            </g>
          );
        })}

        {labels.map((label, index) => (
          <text
            key={`${label}-${index}`}
            x={getX(index)}
            y={HEIGHT - 4}
            fill="rgba(143, 152, 179, 0.88)"
            fontSize="11"
            textAnchor="middle"
          >
            {label}
          </text>
        ))}
      </svg>
      <div className="mt-3 flex flex-wrap gap-4">
        {series.map((line) => (
          <div key={line.key} className="flex items-center gap-2 text-sm text-mist">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: line.color }} />
            {line.label}
          </div>
        ))}
      </div>
    </div>
  );
}
