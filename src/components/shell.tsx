import { V2Shell } from "@/components/v2-ui";
import type { MarketAsset } from "@/lib/types";

type ShellProps = {
  activePath: "/" | `/${MarketAsset}` | "/trades" | "/recovery";
  children: React.ReactNode;
};

export function Shell({ activePath, children }: ShellProps) {
  return <V2Shell activePath={activePath}>{children}</V2Shell>;
}
