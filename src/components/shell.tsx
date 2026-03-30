import Link from "next/link";

type ShellProps = {
  activePath: "/" | "/trades";
  children: React.ReactNode;
};

export function Shell({ activePath, children }: ShellProps) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/8 bg-[#090c12]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-lilac to-[#4f8cff] text-lg font-semibold text-white">
              PA
            </div>
            <div>
              <p className="font-display text-2xl font-semibold tracking-tight text-white">
                PolyArb
              </p>
              <p className="text-xs uppercase tracking-[0.28em] text-mist/70">
                Paper BTC 15m
              </p>
            </div>
            <nav className="hidden items-center gap-1 rounded-2xl border border-white/8 bg-white/[0.03] p-1 sm:flex">
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
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
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
      className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
        active ? "bg-white/10 text-white" : "text-mist hover:bg-white/[0.05] hover:text-white"
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
      ? "border-cyan/20 bg-cyan/10 text-cyan"
      : tone === "amber"
        ? "border-amber/20 bg-amber/10 text-amber"
        : "border-white/8 bg-white/5 text-mist";

  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] ${toneClass}`}
    >
      {children}
    </span>
  );
}
