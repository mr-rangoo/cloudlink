import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { listBranches } from "@/server/services/admin";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { RecordStatusBadge } from "@/components/status";
import { Forbidden } from "@/components/shell/forbidden";
import { BranchDialog } from "./client";

export const metadata: Metadata = { title: "Branches" };

export default async function BranchesPage() {
  const { ctx, allowed } = await getStaffContextWith("branches.read");
  if (!allowed) return <Forbidden what="branches" />;
  const branches = await listBranches(ctx);
  const canWrite = ctx.permissions.has("branches.write");
  return (
    <div className="space-y-6">
      <PageHeader title="Your branches" description="Branches scope subscribers, invoices and staff access. Archiving is blocked while subscribers are assigned." actions={canWrite && !ctx.branchIds ? <BranchDialog /> : null} />
      <Card>
        <Table>
          <THead>
            <tr>
              <Th>Branch</Th>
              <Th>Code</Th>
              <Th>Address</Th>
              <Th className="text-right">Subscribers</Th>
              <Th>Status</Th>
              {canWrite ? <Th className="text-right">Actions</Th> : null}
            </tr>
          </THead>
          <TBody>
            {branches.map((b) => (
              <Tr key={b.id}>
                <Td label="Branch" className="font-medium">
                  {b.name}
                </Td>
                <Td label="Code" className="font-mono text-xs">
                  {b.code}
                </Td>
                <Td label="Address">{b.address ?? "—"}</Td>
                <Td label="Subscribers" className="tabular md:text-right">
                  {b.subscribers}
                </Td>
                <Td label="Status">
                  <RecordStatusBadge status={b.status} />
                </Td>
                {canWrite ? (
                  <Td label="Actions" className="md:text-right">
                    <BranchDialog branch={{ id: b.id, name: b.name, code: b.code, address: b.address, status: b.status }} />
                  </Td>
                ) : null}
              </Tr>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
