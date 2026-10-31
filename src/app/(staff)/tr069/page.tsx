import type { Metadata } from "next";
import Link from "next/link";
import { RadioTower } from "lucide-react";
import { getStaffContextWith } from "@/server/auth/page";
import { listTr069Devices, tr069ListQuery, WEAK_SIGNAL_DBM } from "@/server/services/tr069";
import { Card } from "@/components/ui/card";
import { Alert, Badge, EmptyState, PageHeader } from "@/components/ui/feedback";
import { Pagination, Table, TBody, Td, Th, THead, Tr, buildHref } from "@/components/ui/table";
import { FilterTabs, SearchForm } from "@/components/list-toolbar";
import { StatStrip } from "@/components/stat-strip";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { CopyButton, DeviceRowMenu, EnrolDeviceDialog, FirmwareDialog, NetworkLoginDialog, SyncButton } from "./client";

export const metadata: Metadata = { title: "TR-069 devices" };

const STATE = {
  CHECKED_IN: { label: "Checked in", tone: "success" },
  NOT_ANSWERING: { label: "Not answering", tone: "danger" },
  NEVER_SEEN: { label: "Never seen", tone: "neutral" },
} as const;

export default async function Tr069Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, allowed } = await getStaffContextWith("inventory.read");
  if (!allowed) return <Forbidden what="TR-069 devices" />;
  const sp = await searchParams;
  const parsed = tr069ListQuery.safeParse(sp);
  const query = parsed.success ? parsed.data : tr069ListQuery.parse({});
  const { rows, total, summary, acs } = await listTr069Devices(ctx, query);
  const canWrite = ctx.permissions.has("inventory.write");
  const tz = ctx.organization.timezone;
  const current = { q: sp.q, tab: sp.tab };
  const href = (tab: string) => buildHref("/tr069", current, { tab: tab === "all" ? undefined : tab, page: undefined });

  return (
    <div className="space-y-6">
      <PageHeader
        title="TR-069 devices"
        description="Customer ONUs and routers managed through your ACS: who is checking in, signal levels and firmware."
        actions={
          <>
            <FirmwareDialog />
            <NetworkLoginDialog acsUrl={acs.acsUrl} acsUsername={acs.acsUsername} />
            {canWrite ? <EnrolDeviceDialog /> : null}
          </>
        }
      />
      {acs.adapter === "mock" ? (
        <Alert tone="info" title="Test mode">
          Device readings are simulated from the serial number and marked &quot;Simulated&quot;. No ACS is contacted.
        </Alert>
      ) : acs.adapter === "disabled" ? (
        <Alert tone="warning" title="No ACS connected">
          Enrolled devices stay &quot;Never seen&quot; until this deployment is connected to an ACS (TR069_ADAPTER=genieacs and TR069_NBI_URL).
        </Alert>
      ) : null}
      <StatStrip
        stats={[
          { label: "Devices", value: summary.devices, hint: "Enrolled" },
          { label: "Checked in", value: summary.checkedIn, tone: summary.checkedIn ? "success" : "default", hint: "Within the last hour" },
          { label: "Not answering", value: summary.notAnswering, tone: summary.notAnswering ? "danger" : "default", href: href("not_answering") },
          { label: "Never seen", value: summary.neverSeen, href: href("never_seen") },
        ]}
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Device status"
            active={query.tab}
            items={[
              { value: "all", label: "All", href: href("all"), count: summary.devices },
              { value: "not_answering", label: "Not answering", href: href("not_answering"), count: summary.notAnswering },
              { value: "never_seen", label: "Never seen", href: href("never_seen"), count: summary.neverSeen },
              { value: "weak_signal", label: "Weak signal", href: href("weak_signal"), count: summary.weakSignal },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchForm action="/tr069" q={sp.q} placeholder="Serial, label or model" hidden={{ tab: sp.tab }} />
            {acs.adapter !== "disabled" && summary.devices ? <SyncButton /> : null}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="space-y-4 p-6">
            <EmptyState
              icon={RadioTower}
              title={summary.devices ? "No devices match" : "No devices enrolled yet"}
              description={summary.devices ? undefined : "Point your devices at the ACS below, then enrol each one by its serial number. Its status appears here after it checks in."}
              action={!summary.devices && canWrite ? <EnrolDeviceDialog /> : undefined}
            />
            {!summary.devices ? (
              <div className="mx-auto max-w-xl space-y-1.5">
                <p className="text-sm font-medium">ACS address</p>
                {acs.acsUrl ? (
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-muted px-3 py-2 font-mono text-xs">{acs.acsUrl}</code>
                    <CopyButton text={acs.acsUrl} label="ACS address" />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Not configured. Set TR069_ACS_URL to the address your devices connect to.</p>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <Th>Device</Th>
                  <Th>Subscriber</Th>
                  <Th>Model</Th>
                  <Th className="text-right">Signal</Th>
                  <Th>Status</Th>
                  <Th>Last check-in</Th>
                  {canWrite ? (
                    <Th className="w-12">
                      <span className="sr-only">Actions</span>
                    </Th>
                  ) : null}
                </tr>
              </THead>
              <TBody>
                {rows.map((d) => (
                  <Tr key={d.id}>
                    <Td label="Device">
                      <div className="min-w-0 text-right md:text-left">
                        <span className="block font-mono text-sm font-medium">{d.serialNumber}</span>
                        <span className="block text-xs text-muted-foreground">{[d.manufacturer, d.label].filter(Boolean).join(" · ") || "—"}</span>
                      </div>
                    </Td>
                    <Td label="Subscriber">
                      {d.subscriber ? (
                        <Link href={`/subscribers/${d.subscriber.id}`} className="text-accent hover:underline">
                          {d.subscriber.displayName} <span className="text-xs text-muted-foreground">{d.subscriber.accountNumber}</span>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Not assigned</span>
                      )}
                    </Td>
                    <Td label="Model">
                      <div className="min-w-0 text-right md:text-left">
                        <span className="block">{d.productClass ?? "—"}</span>
                        {d.softwareVersion ? <span className="block font-mono text-xs text-muted-foreground">{d.softwareVersion}</span> : null}
                      </div>
                    </Td>
                    <Td label="Signal" className="md:text-right">
                      {d.rxPowerDbm === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={d.weakSignal ? "tabular font-medium text-danger" : "tabular"} title={d.weakSignal ? `Below ${WEAK_SIGNAL_DBM} dBm` : undefined}>
                          {d.rxPowerDbm.toFixed(1)} dBm{d.weakSignal ? " · weak" : ""}
                        </span>
                      )}
                    </Td>
                    <Td label="Status">
                      <span className="flex flex-wrap justify-end gap-1 md:justify-start">
                        <Badge tone={STATE[d.state].tone}>{STATE[d.state].label}</Badge>
                        {d.simulated ? <Badge tone="neutral">Simulated</Badge> : null}
                      </span>
                    </Td>
                    <Td label="Last check-in" className="text-sm">
                      {d.lastInformAt ? formatDateTime(d.lastInformAt, tz) : <span className="text-muted-foreground">Never</span>}
                    </Td>
                    {canWrite ? (
                      <Td label="Actions" className="md:text-right">
                        <DeviceRowMenu id={d.id} serial={d.serialNumber} />
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Pagination page={query.page} totalPages={Math.max(1, Math.ceil(total / query.pageSize))} total={total} hrefFor={(p) => buildHref("/tr069", current, { page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
