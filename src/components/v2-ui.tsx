"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ACTIVE_MARKET_ASSETS } from "@/lib/market-catalog";
import type { MarketAsset } from "@/lib/types";

export type V2Tone = "gold" | "emerald" | "rose" | "amber" | "indigo" | "mist";

export const V2_TONE_TEXT: Record<V2Tone, string> = {
  gold: "text-[var(--wa-gold)]",
  emerald: "text-[var(--wa-emerald)]",
  rose: "text-[var(--wa-rose)]",
  amber: "text-[var(--wa-amber)]",
  indigo: "text-[var(--wa-indigo)]",
  mist: "text-[var(--wa-mist)]",
};

type ShellProps = {
  activePath: "/" | `/${MarketAsset}` | "/trades" | "/recovery";
  children: React.ReactNode;
};

export function V2Shell({ activePath, children }: ShellProps) {
  return (
    <div className="min-h-screen bg-[var(--wa-bg0)]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[88px] flex-col items-center border-r border-[var(--wa-gold-border)] bg-[var(--wa-bg1)] px-3 py-4 md:flex">
        <Link
          href="/"
          aria-label="Portfolio"
          className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[var(--wa-gold-border-strong)] bg-[var(--wa-bg0)] shadow-[0_0_22px_rgba(201,168,100,0.18)]"
        >
          <Image src="/logo.png" alt="Wolff Arbitrer" width={50} height={50} className="h-[50px] w-[50px] rounded-full object-cover" priority />
        </Link>
        <div className="mb-3 h-px w-8 bg-[var(--wa-gold-border)]" />
        <SideTab href="/" label="PORT" active={activePath === "/"} icon="◈" />
        {ACTIVE_MARKET_ASSETS.map((asset) => (
          <SideTab key={asset} href={`/${asset}`} label={asset.toUpperCase()} active={activePath === `/${asset}`} icon={asset[0]!.toUpperCase()} />
        ))}
        <div className="my-3 h-px w-8 bg-[var(--wa-gold-border)]" />
        <SideTab href="/trades" label="TRD" active={activePath === "/trades"} icon="↕" />
        <SideTab href="/recovery" label="REC" active={activePath === "/recovery"} icon="⟳" />
      </aside>

      <div className="min-w-0 md:pl-[88px]">
        <TickerBar />
        <MobileNav activePath={activePath} />
        <main className="wa-readable w-full px-4 py-5 sm:px-6 lg:px-7 lg:py-7">{children}</main>
      </div>
    </div>
  );
}

function SideTab({
  href,
  label,
  active,
  icon,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: string;
}) {
  return (
    <Link
      href={href}
      title={label}
      className={`relative mb-1.5 flex h-[58px] w-16 flex-col items-center justify-center gap-1 rounded-lg border text-center transition ${
        active
          ? "border-[var(--wa-gold-border-strong)] bg-[rgba(201,168,100,0.10)] text-[var(--wa-gold)]"
          : "border-transparent text-[var(--wa-mist)] hover:border-[var(--wa-gold-border)] hover:bg-[rgba(201,168,100,0.05)] hover:text-[var(--wa-ivory)]"
      }`}
    >
      {active ? <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-[var(--wa-gold)]" /> : null}
      <span className="text-base leading-none">{icon}</span>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em]">{label}</span>
    </Link>
  );
}

function MobileNav({ activePath }: Pick<ShellProps, "activePath">) {
  const links: Array<{ href: ShellProps["activePath"]; label: string }> = [
    { href: "/", label: "Portfolio" },
    ...ACTIVE_MARKET_ASSETS.map((asset) => ({ href: `/${asset}` as const, label: asset.toUpperCase() })),
    { href: "/trades", label: "Trades" },
    { href: "/recovery", label: "Recup" },
  ];

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-[var(--wa-gold-border)] bg-[var(--wa-bg1)] px-3 py-2 md:hidden">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`whitespace-nowrap rounded px-3 py-2 text-xs uppercase tracking-[0.14em] ${
            activePath === link.href
              ? "border border-[var(--wa-gold-border-strong)] bg-[rgba(201,168,100,0.10)] text-[var(--wa-gold)]"
              : "text-[var(--wa-mist)]"
          }`}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

function TickerBar() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const items = [
    ["POLY", "LIVE"],
    ["KALSHI", "LIVE"],
    ["ENGINE", "MULTI-ASSET"],
    ["BTC", "15M"],
    ["ETH", "15M"],
    ["DOGE", "15M"],
    ["SOL", "15M"],
    ["POSTGRES", "SYNC"],
    ["INTENTS", "MONITOR"],
    ["PNL", "STABLE"],
  ];

  return (
    <div className="sticky top-0 z-20 h-[30px] overflow-hidden border-b border-[var(--wa-gold-border)] bg-[var(--wa-bg0)]">
      <div className="pointer-events-none absolute left-0 right-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--wa-gold)] to-transparent opacity-45" />
      <div className="wa-ticker flex h-[30px] items-center whitespace-nowrap">
        {[...items, ...items, ...items].map(([label, value], index) => (
          <div key={`${label}-${index}`} className="flex h-[30px] items-center gap-2 border-r border-[var(--wa-gold-border)] px-4">
            <span className="text-[8px] uppercase tracking-[0.18em] text-[var(--wa-dim)]">{label}</span>
            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--wa-mist)]">{value}</span>
          </div>
        ))}
      </div>
      <div className="absolute bottom-0 right-0 top-0 flex items-center gap-2 border-l border-[var(--wa-gold-border)] bg-[var(--wa-bg0)] px-3">
        <span className="hidden font-mono text-[9px] text-[var(--wa-dim)] sm:inline">
          {now ? now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "--"}
        </span>
        <span className="font-mono text-[10px] tracking-[0.04em] text-[var(--wa-ivory)]">
          {now ? now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}
        </span>
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--wa-emerald)] shadow-[0_0_10px_rgba(30,216,126,0.8)]" />
        <span className="text-[9px] uppercase tracking-[0.20em] text-[var(--wa-emerald)]">Live</span>
      </div>
    </div>
  );
}

export function PageSection({
  watermark,
  children,
  className = "",
}: {
  watermark?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`relative ${className}`}>
      {watermark ? (
        <div className="pointer-events-none absolute -right-2 -top-5 z-0 select-none font-mono text-[clamp(4rem,12vw,8rem)] font-extrabold leading-none tracking-[-0.04em] text-[rgba(201,168,100,0.025)]">
          {watermark}
        </div>
      ) : null}
      <div className="relative z-10">{children}</div>
    </section>
  );
}

export function SectionLabel({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className="h-4 w-[3px] rounded bg-[var(--wa-gold)]" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--wa-gold)]">{children}</span>
      </div>
      {right ? <div className="font-mono text-[10px] text-[var(--wa-dim)]">{right}</div> : null}
    </div>
  );
}

export function Surface({
  children,
  glow = false,
  className = "",
}: {
  children: React.ReactNode;
  glow?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`wa-surface relative overflow-hidden rounded-lg border bg-[var(--wa-bg1)] ${
        glow
          ? "border-[var(--wa-gold-border-strong)] shadow-[0_0_40px_rgba(201,168,100,0.08),inset_0_1px_0_rgba(201,168,100,0.08)]"
          : "border-[var(--wa-gold-border)]"
      } ${className}`}
    >
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export function BigMetric({
  label,
  value,
  sub,
  tone = "mist",
  huge = false,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: V2Tone;
  huge?: boolean;
}) {
  return (
    <div className="px-5 py-5 sm:px-6">
      <div className="mb-2 text-[10px] uppercase tracking-[0.26em] text-[rgba(201,168,100,0.50)]">{label}</div>
      <div className={`font-mono ${huge ? "text-[clamp(2.5rem,7vw,3.25rem)]" : "text-[clamp(1.75rem,4vw,2.125rem)]"} leading-none ${V2_TONE_TEXT[tone]}`}>
        {value}
      </div>
      {sub ? <div className="mt-2 max-w-[280px] text-[11px] leading-5 text-[var(--wa-mist)]">{sub}</div> : null}
    </div>
  );
}

export function MetricCell({
  label,
  value,
  tone = "mist",
  meta,
}: {
  label: string;
  value: string;
  tone?: V2Tone;
  meta?: string;
}) {
  return (
    <div className="border-r border-[var(--wa-gold-border)] px-4 py-4 last:border-r-0">
      <div className="mb-2 text-[9px] uppercase tracking-[0.24em] text-[rgba(201,168,100,0.45)]">{label}</div>
      <div className={`font-mono text-[22px] leading-none ${V2_TONE_TEXT[tone]}`}>{value}</div>
      {meta ? <div className="mt-2 text-[10px] leading-4 text-[var(--wa-mist)]">{meta}</div> : null}
    </div>
  );
}

export function Chip({ children, tone = "mist" }: { children: React.ReactNode; tone?: V2Tone }) {
  const className =
    tone === "gold"
      ? "border-[var(--wa-gold-border-strong)] bg-[rgba(201,168,100,0.10)] text-[var(--wa-gold)]"
      : tone === "emerald"
        ? "border-[rgba(30,216,126,0.28)] bg-[rgba(30,216,126,0.09)] text-[var(--wa-emerald)]"
        : tone === "rose"
          ? "border-[rgba(232,80,106,0.28)] bg-[rgba(232,80,106,0.09)] text-[var(--wa-rose)]"
          : tone === "amber"
            ? "border-[rgba(245,184,74,0.28)] bg-[rgba(245,184,74,0.09)] text-[var(--wa-amber)]"
            : tone === "indigo"
              ? "border-[rgba(138,159,255,0.22)] bg-[rgba(138,159,255,0.09)] text-[var(--wa-indigo)]"
              : "border-[rgba(122,130,153,0.18)] bg-[rgba(122,130,153,0.08)] text-[var(--wa-mist)]";

  return (
    <span className={`inline-flex items-center rounded border px-2.5 py-1 text-[9px] uppercase tracking-[0.18em] ${className}`}>
      {children}
    </span>
  );
}

export function V2EmptyState({ message }: { message: string }) {
  return (
    <div className="border-t border-[var(--wa-gold-border)] px-4 py-7 text-center font-mono text-xs tracking-[0.06em] text-[var(--wa-dim)]">
      -- {message} --
    </div>
  );
}

export function V2Expand({
  expanded,
  n,
  onClick,
}: {
  expanded: boolean;
  n: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 rounded border border-[var(--wa-gold-border)] bg-transparent px-4 py-2 text-left text-[11px] tracking-[0.06em] text-[var(--wa-mist)] transition hover:border-[var(--wa-gold-border-strong)] hover:text-[var(--wa-gold)]"
    >
      {expanded ? "↑ réduire" : `↓ voir ${n} de plus`}
    </button>
  );
}

export function MiniLineChart({
  series,
  height = 100,
}: {
  series: Array<{ key: string; color: string; values: Array<number | null> }>;
  height?: number;
}) {
  const width = 600;
  const allValues = series.flatMap((item) => item.values).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (allValues.length === 0) {
    return <div className="flex items-center justify-center text-sm text-[var(--wa-dim)]" style={{ height }}>--</div>;
  }

  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 0.01;
  const pad = { top: 8, bottom: 20, left: 40, right: 8 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const points = (values: Array<number | null>) =>
    values
      .map((value, index) => {
        if (value === null || !Number.isFinite(value)) {
          return null;
        }
        const x = pad.left + (index / Math.max(1, values.length - 1)) * innerWidth;
        const y = pad.top + (1 - (value - min) / range) * innerHeight;
        return [x, y] as const;
      })
      .filter((value): value is readonly [number, number] => value !== null);
  const path = (values: Array<number | null>) =>
    points(values)
      .map((point, index) => `${index === 0 ? "M" : "L"}${point[0].toFixed(1)},${point[1].toFixed(1)}`)
      .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      {Array.from({ length: 5 }).map((_, index) => {
        const y = pad.top + (index / 4) * innerHeight;
        const value = max - (index / 4) * range;
        return (
          <g key={index}>
            <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="rgba(201,168,100,0.07)" strokeWidth="1" strokeDasharray="3,4" />
            <text x={pad.left - 6} y={y + 4} textAnchor="end" fontSize="8" fill="rgba(201,168,100,0.35)" fontFamily="IBM Plex Mono">
              {value.toFixed(2)}
            </text>
          </g>
        );
      })}
      {series.map((item) => (
        <path key={item.key} d={path(item.values)} fill="none" stroke={item.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function formatV2Usd(value: number | null | undefined, compact = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (compact && abs >= 1_000) {
    return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  }
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatV2Countdown(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "--:--";
  }
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
