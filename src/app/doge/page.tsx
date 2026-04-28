import { DashboardClient } from "@/components/dashboard-client";
import { Shell } from "@/components/shell";

export default function DogePage() {
  return (
    <Shell activePath="/doge">
      <DashboardClient asset="doge" />
    </Shell>
  );
}
