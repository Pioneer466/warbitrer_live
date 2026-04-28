import { DashboardClient } from "@/components/dashboard-client";
import { Shell } from "@/components/shell";

export default function HypePage() {
  return (
    <Shell activePath="/hype">
      <DashboardClient asset="hype" />
    </Shell>
  );
}
