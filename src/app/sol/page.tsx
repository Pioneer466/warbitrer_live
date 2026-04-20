import { DashboardClient } from "@/components/dashboard-client";
import { Shell } from "@/components/shell";

export default function SolPage() {
  return (
    <Shell activePath="/sol">
      <DashboardClient asset="sol" />
    </Shell>
  );
}
