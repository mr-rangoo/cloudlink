import type { Metadata } from "next";
import { getStaffContextWith } from "@/server/auth/page";
import { listRoles, listStaff } from "@/server/services/admin";
import { listAccessibleBranches } from "@/server/auth/service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, PageHeader } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { FilterTabs } from "@/components/list-toolbar";
import { Forbidden } from "@/components/shell/forbidden";
import { formatDateTime } from "@/lib/utils";
import { EditStaffDialog, InviteStaffDialog, ResetLinkButton, RoleEditor } from "./client";

export const metadata: Metadata = { title: "Staff & Permissions" };

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { ctx, allowed } = await getStaffContextWith("staff.read");
  if (!allowed) return <Forbidden what="staff management" />;
  const sp = await searchParams;
  const tab = sp.tab === "roles" ? "roles" : "staff";
  const canWrite = ctx.permissions.has("staff.write");
  const canRoles = ctx.permissions.has("roles.write");
  const [staff, roles, branches] = await Promise.all([listStaff(ctx), listRoles(ctx), listAccessibleBranches(ctx)]);
  const roleOptions = roles.roles.map((r) => ({ id: r.id, key: r.key, name: r.name }));
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const tz = ctx.organization.timezone;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team and permissions"
        description="Who can sign in to this organization and what they can do. Permission changes apply immediately; role or branch changes sign the person out."
        actions={canWrite && tab === "staff" ? <InviteStaffDialog roles={roleOptions} branches={branches} canGrantOwner={ctx.roles.includes("owner")} /> : null}
      />
      <FilterTabs
        label="Staff view"
        active={tab}
        items={[
          { value: "staff", label: "Staff", count: staff.length, href: "/staff" },
          { value: "roles", label: "Roles & permissions", count: roles.roles.length, href: "/staff?tab=roles" },
        ]}
      />
      {tab === "staff" ? (
        <Card>
          <Table>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Roles</Th>
                <Th>Branches</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                {canWrite ? <Th className="text-right">Actions</Th> : null}
              </tr>
            </THead>
            <TBody>
              {staff.map((s) => (
                <Tr key={s.membershipId}>
                  <Td label="Name">
                    <div className="text-right md:text-left">
                      <p className="font-medium">
                        {s.name} {s.userId === ctx.userId ? <span className="text-xs text-muted-foreground">(you)</span> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">{s.email}</p>
                    </div>
                  </Td>
                  <Td label="Roles">
                    <span className="flex flex-wrap justify-end gap-1 md:justify-start">
                      {s.roles.map((r) => (
                        <Badge key={r.id} tone={r.key === "owner" ? "info" : "neutral"}>
                          {r.name}
                        </Badge>
                      ))}
                    </span>
                  </Td>
                  <Td label="Branches">{s.allBranches ? "All branches" : s.branchIds.map((b) => branchName.get(b) ?? "—").join(", ")}</Td>
                  <Td label="Status">
                    {s.status !== "ACTIVE" ? <Badge tone="neutral">Deactivated</Badge> : s.pendingSetup ? <Badge tone="warning">Setup pending</Badge> : <Badge tone="success">Active</Badge>}
                  </Td>
                  <Td label="Last sign-in" className="whitespace-nowrap text-muted-foreground">
                    {s.lastLoginAt ? formatDateTime(s.lastLoginAt, tz) : "Never"}
                  </Td>
                  {canWrite ? (
                    <Td label="Actions" className="md:text-right">
                      {s.userId !== ctx.userId ? (
                        <span className="flex justify-end gap-1">
                          <EditStaffDialog member={{ membershipId: s.membershipId, name: s.name, status: s.status, roleIds: s.roles.map((r) => r.id), allBranches: s.allBranches, branchIds: s.branchIds }} roles={roleOptions} branches={branches} canGrantOwner={ctx.roles.includes("owner")} />
                          <ResetLinkButton membershipId={s.membershipId} name={s.name} pending={s.pendingSetup} />
                        </span>
                      ) : null}
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : (
        <div className="space-y-4">
          {roles.roles.map((r) => (
            <Card key={r.id}>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle>
                    {r.name} <span className="text-xs font-normal text-muted-foreground">· {r.members} member(s)</span>
                  </CardTitle>
                  <CardDescription>{r.description ?? (r.isSystem ? "Built-in role" : "Custom role")}</CardDescription>
                </div>
                {canRoles && !r.locked ? <RoleEditor role={r} catalogue={roles.catalogue} /> : r.locked ? <Badge tone="info">All permissions (locked)</Badge> : null}
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {r.permissions.map((p) => (
                  <span key={p} className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {p}
                  </span>
                ))}
              </CardContent>
            </Card>
          ))}
          {canRoles ? <RoleEditor catalogue={roles.catalogue} /> : null}
        </div>
      )}
    </div>
  );
}
