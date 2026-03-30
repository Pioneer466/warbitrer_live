import { Shell } from "@/components/shell";
import { TradesClient } from "@/components/trades-client";

export default function TradesPage() {
  return (
    <Shell activePath="/trades">
      <TradesClient />
    </Shell>
  );
}
