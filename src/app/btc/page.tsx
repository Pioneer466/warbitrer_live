import { DashboardClient } from "@/components/dashboard-client";
import { Shell } from "@/components/shell";

export default function BtcPage() {
  return (
    <Shell activePath="/btc">
      <DashboardClient asset="btc" />
    </Shell>
  );
}
