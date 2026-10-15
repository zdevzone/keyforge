import { useState } from "react";

import { useIsMobile } from "@/hooks/use-mobile";

import { Card } from "../components";
import { Choice } from "./Choice";

interface Usage {
  meterId: string;
  period: string;
  consumed: number;
}

/** Compare periods within one meter; different meters need not share a unit. */
export default function UsageReport({ usage }: { usage: Usage[] }) {
  const isMobile = useIsMobile();
  const meters = [...new Set(usage.map((row) => row.meterId))].sort();
  const [selected, setSelected] = useState("");
  const meter = meters.includes(selected) ? selected : meters[0];
  const totals = new Map<string, number>();
  for (const row of usage) {
    if (row.meterId === meter) {
      totals.set(row.period, (totals.get(row.period) || 0) + row.consumed);
    }
  }
  const periods = [...totals].sort(([a], [b]) => a.localeCompare(b)).slice(-12);
  const maximum = Math.max(1, ...periods.map(([, consumed]) => consumed));
  const plotWidth = isMobile ? Math.max(200, periods.length * 84) : 640;
  const chartWidth = plotWidth + 100;
  const step = plotWidth / Math.max(1, periods.length);
  const barWidth = Math.min(48, step * 0.5);

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl">Usage by period</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Consumed units across licenses. Up to 12 recorded periods for the selected meter.
          </p>
        </div>
        {meters.length > 0 && (
          <Choice
            label="Meter"
            value={meter}
            onChange={setSelected}
            options={meters.map((id) => ({ value: id, label: id }))}
          />
        )}
      </div>
      {periods.length ? (
        <figure className="mt-6">
          <div className="overflow-x-auto">
            {/* SVG charts expose an image role while retaining accessible title/description. */}
            {/* oxlint-disable jsx-a11y/prefer-tag-over-role */}
            <svg
              viewBox={`0 0 ${chartWidth} 240`}
              className="w-full"
              style={{ minWidth: isMobile ? chartWidth : 560 }}
              role="img"
              aria-label={`Consumed units for ${meter}`}
            >
              <title>Consumed units for {meter}</title>
              <desc>
                {periods
                  .map(([period, consumed]) => `${period}: ${consumed.toLocaleString()} units`)
                  .join(". ")}
              </desc>
              {[0, 0.5, 1].map((fraction) => (
                <g key={fraction}>
                  <line
                    x1="80"
                    x2={chartWidth - 20}
                    y1={190 - fraction * 160}
                    y2={190 - fraction * 160}
                    stroke="var(--border)"
                  />
                  <text
                    x="65"
                    y={194 - fraction * 160}
                    textAnchor="end"
                    fill="var(--muted-foreground)"
                    fontSize="12"
                  >
                    {Math.round(maximum * fraction).toLocaleString()}
                  </text>
                </g>
              ))}
              {periods.map(([period, consumed], index) => (
                <g key={period}>
                  <rect
                    x={80 + (index + 0.5) * step - barWidth / 2}
                    y={190 - (consumed / maximum) * 160}
                    width={barWidth}
                    height={(consumed / maximum) * 160}
                    rx="3"
                    fill="var(--primary)"
                  >
                    <title>
                      {period}: {consumed.toLocaleString()} units
                    </title>
                  </rect>
                  <text
                    x={80 + (index + 0.5) * step}
                    y="216"
                    textAnchor="middle"
                    fill="var(--muted-foreground)"
                    fontSize="12"
                  >
                    {period}
                  </text>
                </g>
              ))}
            </svg>
            {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
          </div>
          {isMobile && periods.length > 2 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Scroll horizontally to see all recorded periods.
            </p>
          )}
          <figcaption className="mt-2 text-center text-xs text-muted-foreground">
            {meter} · recorded consumption per period
          </figcaption>
        </figure>
      ) : (
        <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
          <p className="font-medium">No usage recorded yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Consumption will appear here when a trusted service starts using a license quota.
          </p>
        </div>
      )}
    </Card>
  );
}
