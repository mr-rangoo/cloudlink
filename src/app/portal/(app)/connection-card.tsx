import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/feedback";
import { AutoRefresh, Elapsed, LiveDot, UpdatedAgo } from "@/components/live";
import { formatBytes } from "@/components/network-notice";
import { formatDateTime } from "@/lib/utils";
import type { customerConnection } from "@/server/portal/services";

type Connection = Awaited<ReturnType<typeof customerConnection>>;

/** The customer's line as of the last session sync. Re-read every 30 s while the page is open. */
export function ConnectionCard({ c, tz }: { c: Connection; tz: string }) {
  if (c.status === "NOT_SET_UP") return null;
  const online = c.status === "ONLINE";
  return (
    <Card>
      <AutoRefresh seconds={30} />
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>My connection</CardTitle>
        {c.simulated ? <Badge tone="warning">Test data</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="flex items-center gap-2 text-base font-semibold">
          <LiveDot live={online} />
          {online ? "Online" : "Offline"}
          {c.connections > 1 ? <span className="text-sm font-normal text-muted-foreground">· {c.connections} connections</span> : null}
        </p>
        {online ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Online for</dt>
              <dd title={c.since ? `Since ${formatDateTime(c.since, tz)}` : undefined}>{c.since ? <Elapsed since={c.since.toISOString()} fallback={`since ${formatDateTime(c.since, tz)}`} /> : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">IP address</dt>
              <dd className="font-mono text-xs leading-5">{c.address ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Downloaded</dt>
              <dd className="tabular">{formatBytes(c.downloadedBytes)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Uploaded</dt>
              <dd className="tabular">{formatBytes(c.uploadedBytes)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground">
            {c.lastOnlineAt ? `Last online ${formatDateTime(c.lastOnlineAt, tz)}. ` : ""}
            If your service is paid up, restart your router. If it stays offline,{" "}
            <Link href="/portal/tickets" className="text-accent hover:underline">
              contact support
            </Link>
            .
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {c.stale ? (
            "Status may be out of date: we have not heard from the network recently."
          ) : (
            <UpdatedAgo at={c.checkedAt?.toISOString() ?? null} prefix="Checked" fallback="Checked recently" />
          )}
          {online && c.downloadedBytes ? " · Data is for the current session only." : null}
        </p>
      </CardContent>
    </Card>
  );
}
