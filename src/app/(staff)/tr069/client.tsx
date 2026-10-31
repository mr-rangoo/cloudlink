"use client";

import * as React from "react";
import { Copy, Cpu, KeyRound, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { RowMenu } from "@/components/ui/menu";
import { SubscriberPicker, type PickedSubscriber } from "@/components/subscriber-picker";
import { formValues, useMutation } from "@/components/use-mutation";
import { api } from "@/lib/api-client";

export function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success(`${label} copied`);
        } catch {
          toast.error("Copy failed. Select the text instead.");
        }
      }}
    >
      <Copy /> Copy
    </Button>
  );
}

/** Enrol a device by serial number, optionally for a subscriber. */
export function EnrolDeviceDialog() {
  const [open, setOpen] = React.useState(false);
  const [subscriber, setSubscriber] = React.useState<PickedSubscriber | null>(null);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate("/tr069/devices", { method: "POST", body: { serialNumber: v.serialNumber, manufacturer: v.manufacturer ?? null, productClass: v.productClass ?? null, label: v.label ?? null, subscriberId: subscriber?.id ?? null } }, { success: "Device enrolled" });
    if (ok) {
      setOpen(false);
      setSubscriber(null);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Enrol device
        </Button>
      </DialogTrigger>
      <DialogContent title="Enrol a device" description="Use the serial number printed on the device (the ACS reports the same number).">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id="tr-serial" label="Serial number" error={errors.serialNumber} required>
            <Input name="serialNumber" autoComplete="off" spellCheck={false} placeholder="48575443A1B2C3D4" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="tr-maker" label="Manufacturer" error={errors.manufacturer}>
              <Input name="manufacturer" placeholder="Huawei" />
            </Field>
            <Field id="tr-model" label="Model" error={errors.productClass}>
              <Input name="productClass" placeholder="HG8145V5" />
            </Field>
          </div>
          <Field id="tr-label" label="Label" error={errors.label} hint="Optional, e.g. the house or flat.">
            <Input name="label" />
          </Field>
          <div className="space-y-1.5">
            <label htmlFor="tr-subscriber" className="text-sm font-medium">
              Subscriber
            </label>
            <SubscriberPicker id="tr-subscriber" value={subscriber} onChange={setSubscriber} invalid={Boolean(errors.subscriberId)} />
            {errors.subscriberId ? <p className="text-xs text-danger">{errors.subscriberId}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Enrol
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Firmware versions across the devices, by model. Upgrades themselves are pushed from the ACS. */
export function FirmwareDialog() {
  const [rows, setRows] = React.useState<Array<{ model: string | null; version: string | null; devices: number }> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      setRows((await api<{ data: Array<{ model: string | null; version: string | null; devices: number }> }>("/tr069/firmware")).data);
    } catch {
      setError("Could not load firmware versions.");
    }
  };
  return (
    <Dialog onOpenChange={(o) => (o ? void load() : setRows(null))}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Cpu /> Firmware
        </Button>
      </DialogTrigger>
      <DialogContent title="Firmware" description="Versions reported by your devices. Upgrades are pushed from your ACS.">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {rows === null && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {rows && rows.length === 0 ? <p className="text-sm text-muted-foreground">No devices enrolled yet.</p> : null}
        {rows && rows.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border text-sm">
            {rows.map((r) => (
              <li key={`${r.model}-${r.version}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className="block font-medium">{r.model ?? "Model not reported"}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{r.version ?? "Version not reported"}</span>
                </span>
                <span className="tabular shrink-0 text-muted-foreground">{r.devices === 1 ? "1 device" : `${r.devices} devices`}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** How devices log in to the ACS (deployment settings). The password is never shown here. */
export function NetworkLoginDialog({ acsUrl, acsUsername }: { acsUrl: string | null; acsUsername: string | null }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <KeyRound /> Network login
        </Button>
      </DialogTrigger>
      <DialogContent title="Network login" description="Set these on each device under TR-069 / Remote management (or in your provisioning template).">
        <div className="space-y-3 text-sm">
          {acsUrl ? (
            <div className="space-y-1">
              <p className="font-medium">ACS address</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-muted px-3 py-2 font-mono text-xs">{acsUrl}</code>
                <CopyButton text={acsUrl} label="ACS address" />
              </div>
            </div>
          ) : (
            <Alert tone="warning">No ACS address is configured for this deployment (TR069_ACS_URL).</Alert>
          )}
          {acsUsername ? (
            <div className="space-y-1">
              <p className="font-medium">ACS username</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-muted px-3 py-2 font-mono text-xs">{acsUsername}</code>
                <CopyButton text={acsUsername} label="ACS username" />
              </div>
            </div>
          ) : null}
          <p className="text-muted-foreground">The ACS password is kept on the ACS and the devices only. Ask your administrator for it. Enable periodic inform (every 5–15 minutes) so the status here stays current.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SyncButton() {
  const { mutate, pending } = useMutation();
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={async () => {
        const ok = await mutate("/tr069/sync", { method: "POST" }, { success: "Reading devices from the ACS. Results appear in a few seconds.", refresh: false });
        if (ok) setTimeout(() => window.location.reload(), 3000);
      }}
    >
      <RefreshCw /> Check now
    </Button>
  );
}

function AssignDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [subscriber, setSubscriber] = React.useState<PickedSubscriber | null>(null);
  const { mutate, pending, formError } = useMutation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Assign to a subscriber">
        <div className="space-y-4">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <SubscriberPicker id={`tr-assign-${id}`} value={subscriber} onChange={setSubscriber} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              loading={pending}
              onClick={async () => {
                const ok = await mutate(`/tr069/devices/${id}`, { method: "PATCH", body: { subscriberId: subscriber?.id ?? null } }, { success: subscriber ? "Device assigned" : "Device unassigned" });
                if (ok) onOpenChange(false);
              }}
            >
              {subscriber ? "Assign" : "Unassign"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DeviceRowMenu({ id, serial }: { id: string; serial: string }) {
  const [assign, setAssign] = React.useState(false);
  const [remove, setRemove] = React.useState(false);
  return (
    <>
      <RowMenu
        label={`Actions for ${serial}`}
        items={[
          { label: "Assign to a subscriber", onSelect: () => setAssign(true) },
          { label: "Remove", tone: "danger", separated: true, onSelect: () => setRemove(true) },
        ]}
      />
      <AssignDialog id={id} open={assign} onOpenChange={setAssign} />
      {remove ? <RemoveDialog id={id} serial={serial} onClose={() => setRemove(false)} /> : null}
    </>
  );
}

function RemoveDialog({ id, serial, onClose }: { id: string; serial: string; onClose: () => void }) {
  const { mutate, pending, formError } = useMutation();
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent title="Remove device" description={serial}>
        <div className="space-y-4 text-sm">
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <p>The device leaves Cloudlink. The ACS keeps its own record, and you can enrol it again later.</p>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={async () => {
                const ok = await mutate(`/tr069/devices/${id}`, { method: "DELETE" }, { success: "Device removed" });
                if (ok) onClose();
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

