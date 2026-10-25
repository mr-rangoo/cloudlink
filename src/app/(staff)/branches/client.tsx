"use client";

import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

export function BranchDialog({ branch }: { branch?: { id: string; name: string; code: string; address: string | null; status: string } }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = { name: v.name, code: v.code, address: v.address ?? null, ...(branch ? { status: v.status } : {}) };
    const ok = await mutate(branch ? `/branches/${branch.id}` : "/branches", { method: branch ? "PATCH" : "POST", body }, { success: branch ? "Branch updated" : "Branch created" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {branch ? (
          <Button size="sm" variant="ghost" aria-label={`Edit ${branch.name}`}>
            <Pencil /> Edit
          </Button>
        ) : (
          <Button>
            <Plus /> New branch
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title={branch ? `Edit ${branch.name}` : "New branch"}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id="b-name" label="Name" error={errors.name} required>
            <Input name="name" defaultValue={branch?.name} />
          </Field>
          <Field id="b-code" label="Code" error={errors.code} required hint="2–16 letters or digits, e.g. NBO">
            <Input name="code" defaultValue={branch?.code} className="uppercase" />
          </Field>
          <Field id="b-addr" label="Address" error={errors.address}>
            <Input name="address" defaultValue={branch?.address ?? ""} />
          </Field>
          {branch ? (
            <Field id="b-status" label="Status">
              <Select name="status" defaultValue={branch.status}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="ARCHIVED">Archived</option>
              </Select>
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {branch ? "Save" : "Create branch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
