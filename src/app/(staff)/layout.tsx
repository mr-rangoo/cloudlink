import { cookies } from "next/headers";
import { AppShell } from "@/components/shell/app-shell";
import { getStaffContext } from "@/server/auth/page";
import { listAccessibleBranches, listUserOrganizations } from "@/server/auth/service";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getStaffContext();
  const [organizations, branches] = await Promise.all([listUserOrganizations(ctx.userId), listAccessibleBranches(ctx)]);
  const theme = (await cookies()).get("cloudlink_theme")?.value;

  return (
    <AppShell
      user={{ name: ctx.userName, email: ctx.email, roles: ctx.roles }}
      organization={{ id: ctx.organization.id, name: ctx.organization.name }}
      organizations={organizations}
      branches={branches}
      activeBranchId={ctx.activeBranchId}
      branchScope={ctx.branchIds === null ? "all" : "restricted"}
      permissions={[...ctx.permissions]}
      theme={theme === "dark" || theme === "system" ? theme : "light"}
      isDemo={process.env.ENABLE_DEMO_SEED === "true" && process.env.APP_ENV !== "production"}
    >
      {children}
    </AppShell>
  );
}
