import Link from "next/link";

type ShellProps = {
  activePath: "/" | "/btc" | "/eth" | "/trades" | "/recovery";
  children: React.ReactNode;
};

export function Shell({ activePath, children }: ShellProps) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-white/8 bg-[#090c12]/88 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-7">
          <div className="flex items-center gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(133,115,255,0.95),rgba(91,123,255,0.95))] text-sm tracking-[0.2em] text-white shadow-[0_0_24px_rgba(102,123,255,0.18)]">
              W
            </div>
            <nav className="flex items-center gap-1 rounded-2xl border border-white/8 bg-white/[0.03] p-1">
              <Tab href="/" active={activePath === "/"}>
                Portfolio
              </Tab>
              <Tab href="/btc" active={activePath === "/btc"}>
                BTC
              </Tab>
              <Tab href="/eth" active={activePath === "/eth"}>
                ETH
              </Tab>
              <Tab href="/trades" active={activePath === "/trades"}>
                Trades
              </Tab>
              <Tab href="/recovery" active={activePath === "/recovery"}>
                Recup
              </Tab>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="amber">BTC + ETH 15m</Badge>
            <Badge tone="cyan">MULTI</Badge>
            <Badge tone="default">POSTGRES</Badge>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1320px] px-5 py-5 sm:px-7 sm:py-7">{children}</main>
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
      className={`rounded-xl px-4 py-2 text-sm font-normal transition ${
        active ? "border border-white/10 bg-white/[0.06] text-white" : "border border-transparent text-mist hover:border-white/8 hover:bg-white/[0.03] hover:text-white"
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
        : "border-white/8 bg-white/[0.03] text-mist";

  return (
    <span
      className={`rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] ${toneClass}`}
    >
      {children}
    </span>
  );
}
