import { DashboardClient } from "@/components/dashboard-client";
import { Shell } from "@/components/shell";

export default function HomePage() {
  return (
    <Shell activePath="/">
      <DashboardClient />
    </Shell>
  );
}
