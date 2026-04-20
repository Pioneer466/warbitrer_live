import { DashboardClient } from "@/components/dashboard-client";
import { Shell } from "@/components/shell";

export default function EthPage() {
  return (
    <Shell activePath="/eth">
      <DashboardClient asset="eth" />
    </Shell>
  );
}
