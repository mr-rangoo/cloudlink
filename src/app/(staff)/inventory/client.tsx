"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { ActionDialog } from "@/components/action-dialog";
import { SubscriberPicker, type PickedSubscriber } from "@/components/subscriber-picker";
import { formValues, useMutation } from "@/components/use-mutation";

export function NewItemDialog() {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate("/inventory", { method: "POST", body: { category: v.category, model: v.model, serialNumber: v.serialNumber, macAddress: v.macAddress ?? null, purchaseCost: v.purchaseCost ?? null, notes: v.notes ?? null } }, { success: "Item added" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add item
        </Button>
      </DialogTrigger>
      <DialogContent title="Add equipment" wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="i-cat" label="Category">
              <Select name="category" defaultValue="router">
                <option value="router">Router</option>
                <option value="onu">ONU / ONT</option>
                <option value="cpe">CPE / radio</option>
                <option value="antenna">Antenna</option>
                <option value="switch">Switch</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field id="i-model" label="Model" error={errors.model} required>
              <Input name="model" />
            </Field>
            <Field id="i-serial" label="Serial number" error={errors.serialNumber} required>
              <Input name="serialNumber" className="uppercase" />
            </Field>
            <Field id="i-mac" label="MAC address" error={errors.macAddress}>
              <Input name="macAddress" placeholder="AA:BB:CC:DD:EE:FF" />
            </Field>
            <Field id="i-cost" label="Purchase cost" error={errors.purchaseCost}>
              <Input name="purchaseCost" inputMode="decimal" />
            </Field>
            <Field id="i-notes" label="Notes" error={errors.notes}>
              <Input name="notes" />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Add item
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ItemActions({ id, status, label }: { id: string; status: string; label: string }) {
  const [sub, setSub] = React.useState<PickedSubscriber | null>(null);
  const path = `/inventory/${id}/actions`;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {status === "IN_STOCK" ? (
        <ActionDialog label="Assign" triggerVariant="ghost" title="Assign equipment" description={label} path={path} success="Item assigned" extraBody={(v) => ({ action: "assign", subscriberId: sub?.id, note: v.note })}>
          {(errors) => (
            <>
              <Field id={`as-${id}`} label="Subscriber" error={errors.subscriberId} required>
                <SubscriberPicker id={`as-${id}`} value={sub} onChange={setSub} />
              </Field>
              <Field id={`an-${id}`} label="Note">
                <Input name="note" />
              </Field>
            </>
          )}
        </ActionDialog>
      ) : null}
      {status === "ASSIGNED" ? <ActionDialog label="Return" triggerVariant="ghost" title="Return to stock" description={label} path={path} success="Item returned" extraBody={() => ({ action: "return" })} /> : null}
      {status === "IN_STOCK" || status === "ASSIGNED" ? (
        <ActionDialog label="Faulty" triggerVariant="ghost" title="Mark as faulty" description={label} path={path} tone="danger" success="Marked faulty" extraBody={(v) => ({ action: "mark_faulty", note: v.note })}>
          {() => (
            <Field id={`fn-${id}`} label="What is wrong?">
              <Input name="note" />
            </Field>
          )}
        </ActionDialog>
      ) : null}
      {status === "FAULTY" ? <ActionDialog label="Repaired" triggerVariant="ghost" title="Return repaired item to stock" description={label} path={path} success="Back in stock" extraBody={() => ({ action: "repaired" })} /> : null}
      {status === "IN_STOCK" || status === "FAULTY" ? <ActionDialog label="Retire" triggerVariant="ghost" title="Retire item" description={label} path={path} tone="danger" success="Item retired" impact="Retired items stay on record but can no longer be assigned." extraBody={() => ({ action: "retire" })} /> : null}
    </span>
  );
}
