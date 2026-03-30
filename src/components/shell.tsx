import Link from "next/link";

type ShellProps = {
  activePath: "/" | "/trades";
  children: React.ReactNode;
};

export function Shell({ activePath, children }: ShellProps) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/8 bg-[#090c12]/92 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/8 bg-white/[0.04] text-sm text-white">
              PA
            </div>
            <div>
              <p className="font-display text-xl font-normal tracking-tight text-white">
                PolyArb
              </p>
              <p className="text-xs uppercase tracking-[0.28em] text-mist/70">
                Paper BTC 15m
              </p>
            </div>
            <nav className="hidden items-center gap-1 rounded-xl border border-white/8 bg-white/[0.02] p-1 sm:flex">
              <Tab href="/" active={activePath === "/"}>
                Dashboard
              </Tab>
              <Tab href="/trades" active={activePath === "/trades"}>
                Trades
              </Tab>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="amber">BTC 15m</Badge>
            <Badge tone="cyan">LIVE</Badge>
            <Badge tone="default">PAPER</Badge>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-6">{children}</main>
    </div>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-3 py-2 text-sm font-normal transition ${
        active ? "bg-white/[0.06] text-white" : "text-mist hover:bg-white/[0.04] hover:text-white"
      }`}
    >
      {children}
    </Link>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "cyan" | "amber" | "default";
}) {
  const toneClass =
    tone === "cyan"
      ? "border-cyan/20 bg-cyan/8 text-cyan"
      : tone === "amber"
        ? "border-amber/20 bg-amber/8 text-amber"
        : "border-white/8 bg-white/[0.03] text-mist";

  return (
    <span
      className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.16em] ${toneClass}`}
    >
      {children}
    </span>
  );
}
