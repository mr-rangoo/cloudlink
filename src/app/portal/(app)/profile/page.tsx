import type { Metadata } from "next";
import { getCustomerContext } from "@/server/portal/page";
import { db } from "@/server/db/client";
import { getPreferences } from "@/server/services/notifications";
import { formatPhone } from "@/server/domain/contact";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PreferencesForm } from "./preferences";

export const metadata: Metadata = { title: "Profile · Customer portal" };

export default async function PortalProfile() {
  const ctx = await getCustomerContext();
  const [sub, prefs] = await Promise.all([
    db.subscriber.findUniqueOrThrow({ where: { id: ctx.subscriberId }, select: { displayName: true, accountNumber: true, phone: true, email: true, addresses: { take: 1 } } }),
    getPreferences(ctx.organizationId, ctx.subscriberId),
  ]);
  const a = sub.addresses[0];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Profile</h1>
      <Card>
        <CardHeader>
          <CardTitle>Account details</CardTitle>
          <CardDescription>To change these details, contact {ctx.organization.name} support.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Name" value={sub.displayName} />
          <Row label="Account number" value={sub.accountNumber} />
          <Row label="Phone" value={formatPhone(sub.phone)} />
          <Row label="Email" value={sub.email ?? "—"} />
          {a ? <Row label="Address" value={[a.line1, a.area, a.town].filter(Boolean).join(", ")} /> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Messages</CardTitle>
          <CardDescription>Choose which messages you receive. Account and security messages are always sent.</CardDescription>
        </CardHeader>
        <CardContent>
          <PreferencesForm initial={prefs} hasEmail={Boolean(sub.email)} />
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
