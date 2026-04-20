import { DashboardClient } from "@/components/dashboard-client";
import { Shell } from "@/components/shell";

export default function XrpPage() {
  return (
    <Shell activePath="/xrp">
      <DashboardClient asset="xrp" />
    </Shell>
  );
}
