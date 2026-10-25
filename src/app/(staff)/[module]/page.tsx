import { notFound } from "next/navigation";
import { Construction } from "lucide-react";
import { findNavItem } from "@/lib/navigation";
import { getStaffContextWith } from "@/server/auth/page";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/feedback";
import { Forbidden } from "@/components/shell/forbidden";

/**
 * Catch-all for modules that are listed in navigation but not yet implemented.
 * It states plainly that the module is unavailable rather than showing a mock screen.
 */
export default async function ModulePlaceholder({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const item = findNavItem(module);
  if (!item || item.available) notFound();
  const { allowed } = await getStaffContextWith(item.permission);
  if (!allowed) return <Forbidden what={item.label} />;

  return (
    <div className="space-y-6">
      <PageHeader title={item.label} description={item.description} />
      <Card>
        <EmptyState
          icon={Construction}
          title={`${item.label} is not yet available`}
          description={`This module is scheduled for implementation phase ${item.phase}. No data is shown here until it is built with real persistence, validation and permissions.`}
        />
      </Card>
    </div>
  );
}
