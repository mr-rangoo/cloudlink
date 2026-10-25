"use client";

import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

export interface PackageFormValues {
  id: string;
  name: string;
  description: string;
  serviceType: string;
  price: string;
  taxRate: string;
  billingUnit: string;
  billingCount: number;
  downloadKbps: number | null;
  uploadKbps: number | null;
  dataQuotaMb: number | null;
  deviceLimit: number | null;
  status: string;
}

export function PackageDialog({ initial, currency }: { initial?: PackageFormValues; currency: string }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const editing = Boolean(initial);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = {
      name: v.name,
      description: v.description ?? null,
      serviceType: v.serviceType,
      price: v.price,
      taxRate: v.taxRate ?? "0",
      billingUnit: v.billingUnit,
      billingCount: v.billingCount,
      downloadKbps: v.downloadKbps ?? null,
      uploadKbps: v.uploadKbps ?? null,
      dataQuotaMb: v.dataQuotaMb ?? null,
      deviceLimit: v.deviceLimit ?? null,
      ...(editing ? { status: v.status } : {}),
    };
    const ok = await mutate(editing ? `/packages/${initial!.id}` : "/packages", { method: editing ? "PATCH" : "POST", body }, { success: editing ? "Package updated" : "Package created" });
    if (ok) setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {editing ? (
          <Button variant="ghost" size="sm" aria-label={`Edit ${initial!.name}`}>
            <Pencil /> Edit
          </Button>
        ) : (
          <Button>
            <Plus /> New package
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title={editing ? `Edit ${initial!.name}` : "New package"} description={editing ? "Changes apply to new subscriptions only." : `Prices are in ${currency}.`} wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="pkg-name" label="Name" error={errors.name} required className="sm:col-span-2">
              <Input name="name" defaultValue={initial?.name} maxLength={80} />
            </Field>
            <Field id="pkg-type" label="Service type" error={errors.serviceType} required>
              <Select name="serviceType" defaultValue={initial?.serviceType ?? "PPPOE"}>
                <option value="PPPOE">PPPoE</option>
                <option value="HOTSPOT">Hotspot</option>
                <option value="STATIC_IP">Static IP</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
            <Field id="pkg-price" label={`Price (${currency})`} error={errors.price} required hint="Excluding tax, e.g. 2500.00">
              <Input name="price" inputMode="decimal" defaultValue={initial?.price} />
            </Field>
            <Field id="pkg-unit" label="Billing period" error={errors.billingUnit}>
              <Select name="billingUnit" defaultValue={initial?.billingUnit ?? "MONTH"}>
                <option value="HOUR">Hour(s)</option>
                <option value="DAY">Day(s)</option>
                <option value="WEEK">Week(s)</option>
                <option value="MONTH">Month(s)</option>
                <option value="YEAR">Year(s)</option>
              </Select>
            </Field>
            <Field id="pkg-count" label="Every" error={errors.billingCount} hint="Number of periods per billing cycle">
              <Input name="billingCount" type="number" min={1} max={365} defaultValue={initial?.billingCount ?? 1} />
            </Field>
            <Field id="pkg-tax" label="Tax rate (%)" error={errors.taxRate} hint="e.g. 16 for VAT, 0 if not applicable">
              <Input name="taxRate" inputMode="decimal" defaultValue={initial?.taxRate ?? "0"} />
            </Field>
            {editing ? (
              <Field id="pkg-status" label="Status" error={errors.status}>
                <Select name="status" defaultValue={initial?.status}>
                  <option value="ACTIVE">Active (can be sold)</option>
                  <option value="INACTIVE">Inactive (hidden from new sales)</option>
                  <option value="ARCHIVED">Archived</option>
                </Select>
              </Field>
            ) : null}
            <Field id="pkg-down" label="Download (kbps)" error={errors.downloadKbps} hint="10240 = 10 Mbps">
              <Input name="downloadKbps" type="number" min={1} defaultValue={initial?.downloadKbps ?? ""} />
            </Field>
            <Field id="pkg-up" label="Upload (kbps)" error={errors.uploadKbps}>
              <Input name="uploadKbps" type="number" min={1} defaultValue={initial?.uploadKbps ?? ""} />
            </Field>
            <Field id="pkg-quota" label="Data quota (MB)" error={errors.dataQuotaMb} hint="Leave empty for unlimited">
              <Input name="dataQuotaMb" type="number" min={1} defaultValue={initial?.dataQuotaMb ?? ""} />
            </Field>
            <Field id="pkg-devices" label="Device limit" error={errors.deviceLimit}>
              <Input name="deviceLimit" type="number" min={1} defaultValue={initial?.deviceLimit ?? ""} />
            </Field>
            <Field id="pkg-desc" label="Description" error={errors.description} className="sm:col-span-2">
              <Textarea name="description" defaultValue={initial?.description} maxLength={500} rows={2} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              {editing ? "Save changes" : "Create package"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
