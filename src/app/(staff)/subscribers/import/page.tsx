import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { listImportJobs, IMPORT_COLUMNS } from "@/server/services/imports";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { ImportWizard } from "./wizard";

export const metadata: Metadata = { title: "Import subscribers" };

export default async function ImportPage() {
  const { ctx, allowed } = await getStaffContextWith("subscribers.import");
  if (!allowed) return <Forbidden what="subscriber imports" />;
  const jobs = await listImportJobs(ctx);
  const tz = ctx.organization.timezone;

  return (
    <div className="space-y-6">
      <PageHeader title="Import subscribers" description="Upload a CSV, review every row, then commit. Imports are all-or-nothing: if any row fails, nothing is created." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ImportWizard />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>File format</CardTitle>
            <CardDescription>UTF-8 CSV with a header row, up to 5,000 rows / 2 MB.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Required: <code className="rounded bg-surface-muted px-1">phone</code>, plus <code className="rounded bg-surface-muted px-1">first_name</code> (individuals) or{" "}
              <code className="rounded bg-surface-muted px-1">company_name</code> with <code className="rounded bg-surface-muted px-1">type=business</code>.
            </p>
            <p className="text-muted-foreground">All columns: {IMPORT_COLUMNS.join(", ")}.</p>
            <p className="text-muted-foreground">
              <code className="rounded bg-surface-muted px-1">package</code> must match an active package name; imported subscriptions start as <em>pending</em> until activated.{" "}
              <code className="rounded bg-surface-muted px-1">branch_code</code> must match a branch code.
            </p>
            {/* Plain anchor on purpose: this is a file download from an API route, not a page navigation. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/api/v1/subscribers/imports/template" className="inline-block font-medium text-accent hover:underline">
              Download template
            </a>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent imports</CardTitle>
        </CardHeader>
        {jobs.length === 0 ? (
          <CardContent className="text-sm text-muted-foreground">No imports yet.</CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>File</Th>
                <Th>Status</Th>
                <Th className="text-right">Rows</Th>
                <Th className="text-right">Errors</Th>
                <Th>Uploaded</Th>
              </tr>
            </THead>
            <TBody>
              {jobs.map((j) => (
                <Tr key={j.id}>
                  <Td label="File">{j.fileName}</Td>
                  <Td label="Status">
                    <Badge tone={j.status === "COMMITTED" ? "success" : j.status === "FAILED" ? "danger" : "info"}>{j.status.toLowerCase()}</Badge>
                  </Td>
                  <Td label="Rows" className="tabular md:text-right">
                    {j.totalRows}
                  </Td>
                  <Td label="Errors" className="tabular md:text-right">
                    {j.errorRows}
                  </Td>
                  <Td label="Uploaded">{formatDateTime(j.createdAt, tz)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
