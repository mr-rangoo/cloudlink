"use client";

import * as React from "react";
import { Copy, KeyRound, Pencil, Plus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

type RoleOpt = { id: string; key: string; name: string };
type BranchOpt = { id: string; name: string; code: string };

function OneTimeLink({ link, onClose }: { link: string | null; onClose: () => void }) {
  return (
    <Dialog open={link !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title="One-time setup link" description="Shown once. Share it privately; it expires in 72 hours and works a single time.">
        <p className="break-all rounded-md border border-border bg-surface-muted p-3 font-mono text-xs">{link}</p>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link ?? "");
                toast.success("Link copied");
              } catch {
                toast.error("Copy failed; select the link manually.");
              }
            }}
          >
            <Copy /> Copy
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoleChecklist({ roles, selected, onChange, canGrantOwner }: { roles: RoleOpt[]; selected: string[]; onChange: (ids: string[]) => void; canGrantOwner: boolean }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-sm font-medium">Roles</legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {roles.map((r) => (
          <label key={r.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(r.id)} disabled={r.key === "owner" && !canGrantOwner} onChange={(e) => onChange(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))} />
            {r.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function BranchScope({ branches, all, selected, onAll, onChange }: { branches: BranchOpt[]; all: boolean; selected: string[]; onAll: (v: boolean) => void; onChange: (ids: string[]) => void }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-sm font-medium">Branch access</legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" checked={all} onChange={() => onAll(true)} /> All branches
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" checked={!all} onChange={() => onAll(false)} /> Only selected branches
      </label>
      {!all ? (
        <div className="ml-6 grid gap-1.5 sm:grid-cols-2">
          {branches.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selected.includes(b.id)} onChange={(e) => onChange(e.target.checked ? [...selected, b.id] : selected.filter((x) => x !== b.id))} />
              {b.name} ({b.code})
            </label>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

export function InviteStaffDialog({ roles, branches, canGrantOwner }: { roles: RoleOpt[]; branches: BranchOpt[]; canGrantOwner: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [roleIds, setRoleIds] = React.useState<string[]>([]);
  const [all, setAll] = React.useState(true);
  const [branchIds, setBranchIds] = React.useState<string[]>([]);
  const [link, setLink] = React.useState<string | null>(null);
  const { mutate, pending, errors, formError } = useMutation<{ setupLink: string | null; existingUser: boolean }>();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const res = await mutate("/staff", { method: "POST", body: { name: v.name, email: v.email, roleIds, branchIds: all ? null : branchIds } }, { success: "Staff member added" });
    if (res) {
      setOpen(false);
      if (res.setupLink) setLink(res.setupLink);
      else toast.info("This person already has a Cloudlink account and can sign in with their existing password.");
    }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>
            <UserPlus /> Invite staff
          </Button>
        </DialogTrigger>
        <DialogContent title="Invite staff" wide>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="s-name" label="Full name" error={errors.name} required>
                <Input name="name" />
              </Field>
              <Field id="s-email" label="Work email" error={errors.email} required>
                <Input name="email" type="email" />
              </Field>
            </div>
            <RoleChecklist roles={roles} selected={roleIds} onChange={setRoleIds} canGrantOwner={canGrantOwner} />
            {errors.roleIds ? <p className="text-xs text-danger">{errors.roleIds}</p> : null}
            <BranchScope branches={branches} all={all} selected={branchIds} onAll={setAll} onChange={setBranchIds} />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={pending} disabled={!roleIds.length}>
                Invite
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <OneTimeLink link={link} onClose={() => setLink(null)} />
    </>
  );
}

export function EditStaffDialog({
  member,
  roles,
  branches,
  canGrantOwner,
}: {
  member: { membershipId: string; name: string; status: string; roleIds: string[]; allBranches: boolean; branchIds: string[] };
  roles: RoleOpt[];
  branches: BranchOpt[];
  canGrantOwner: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [roleIds, setRoleIds] = React.useState(member.roleIds);
  const [all, setAll] = React.useState(member.allBranches);
  const [branchIds, setBranchIds] = React.useState(member.branchIds);
  const { mutate, pending, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(`/staff/${member.membershipId}`, { method: "PATCH", body: { roleIds, branchIds: all ? null : branchIds, status: v.status } }, { success: "Staff member updated" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Edit ${member.name}`}>
          <Pencil /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent title={`Edit ${member.name}`} description="Saving signs this person out of this organization so new permissions apply." wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <RoleChecklist roles={roles} selected={roleIds} onChange={setRoleIds} canGrantOwner={canGrantOwner} />
          <BranchScope branches={branches} all={all} selected={branchIds} onAll={setAll} onChange={setBranchIds} />
          <Field id={`st-${member.membershipId}`} label="Access">
            <Select name="status" defaultValue={member.status}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Deactivated (cannot sign in to this organization)</option>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={!roleIds.length}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ResetLinkButton({ membershipId, name, pending: setupPending }: { membershipId: string; name: string; pending: boolean }) {
  const [link, setLink] = React.useState<string | null>(null);
  const { mutate, pending } = useMutation<{ link: string }>();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        loading={pending}
        aria-label={`${setupPending ? "New setup link" : "Password reset link"} for ${name}`}
        onClick={async () => {
          const r = await mutate(`/staff/${membershipId}/reset-link`, { method: "POST", body: {} }, { refresh: false });
          if (r) setLink(r.link);
        }}
      >
        <KeyRound /> {setupPending ? "Setup link" : "Reset"}
      </Button>
      <OneTimeLink link={link} onClose={() => setLink(null)} />
    </>
  );
}

export function RoleEditor({ role, catalogue }: { role?: { id: string; name: string; description: string | null; permissions: string[]; isSystem: boolean; members: number }; catalogue: Array<{ key: string; description: string }> }) {
  const [open, setOpen] = React.useState(false);
  const [perms, setPerms] = React.useState<string[]>(role?.permissions ?? []);
  const { mutate, pending, errors, formError } = useMutation();
  const groups = React.useMemo(() => {
    const m = new Map<string, typeof catalogue>();
    for (const p of catalogue) {
      const g = p.key.split(".")[0]!;
      m.set(g, [...(m.get(g) ?? []), p]);
    }
    return [...m.entries()];
  }, [catalogue]);
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(role ? `/roles/${role.id}` : "/roles", { method: role ? "PATCH" : "POST", body: { name: v.name, description: v.description ?? null, permissions: perms } }, { success: role ? "Role updated" : "Role created" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {role ? (
          <Button size="sm" variant="secondary">
            <Pencil /> Edit permissions
          </Button>
        ) : (
          <Button variant="secondary">
            <Plus /> New custom role
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title={role ? `Edit ${role.name}` : "New custom role"} description={role?.members ? `${role.members} staff member(s) hold this role; changes apply on their next request.` : undefined} wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="r-name" label="Name" error={errors.name} required>
              <Input name="name" defaultValue={role?.name} maxLength={60} />
            </Field>
            <Field id="r-desc" label="Description" error={errors.description}>
              <Input name="description" defaultValue={role?.description ?? ""} maxLength={200} />
            </Field>
          </div>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
            {groups.map(([group, items]) => (
              <fieldset key={group} className="rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.replace("_", " ")}</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {items.map((p) => (
                    <label key={p.key} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-0.5" checked={perms.includes(p.key)} onChange={(e) => setPerms((ps) => (e.target.checked ? [...ps, p.key] : ps.filter((x) => x !== p.key)))} />
                      <span>
                        {p.description}
                        <span className="block font-mono text-[10px] text-muted-foreground">{p.key}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          {perms.some((p) => ["payments.refund", "roles.write", "network.operate", "integrations.write", "staff.write"].includes(p)) ? (
            <Alert tone="warning">This role includes high-risk permissions (refunds, staff/role management, network operations or integration credentials).</Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {role ? "Save permissions" : "Create role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
