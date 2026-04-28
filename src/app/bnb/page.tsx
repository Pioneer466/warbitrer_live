import { DashboardClient } from "@/components/dashboard-client";
import { Shell } from "@/components/shell";

export default function BnbPage() {
  return (
    <Shell activePath="/bnb">
      <DashboardClient asset="bnb" />
    </Shell>
  );
}
