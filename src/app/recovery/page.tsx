import { RecoveryClient } from "@/components/recovery-client";
import { Shell } from "@/components/shell";

export default function RecoveryPage() {
  return (
    <Shell activePath="/recovery">
      <RecoveryClient />
    </Shell>
  );
}
