import { PortfolioClient } from "@/components/portfolio-client";
import { Shell } from "@/components/shell";

export default function HomePage() {
  return (
    <Shell activePath="/">
      <PortfolioClient />
    </Shell>
  );
}
