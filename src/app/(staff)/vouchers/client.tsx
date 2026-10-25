"use client";

import * as React from "react";
import { Copy, Download, Pencil, Plus, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { ActionDialog } from "@/components/action-dialog";
import { formValues, useMutation } from "@/components/use-mutation";
import { newIdempotencyKey, rotateOnServerError } from "@/lib/api-client";
import { formatMoney } from "@/lib/utils";

const group = (c: string) => c.replace(/(.{4})(?=.)/g, "$1-");

export function GenerateBatchDialog({
  packages,
  agents,
  routers,
  canExport,
}: {
  packages: Array<{ id: string; label: string }>;
  agents: Array<{ id: string; name: string }>;
  routers: Array<{ id: string; name: string }>;
  canExport: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<{ batchId: string; batchNumber: string; codes: string[] } | null>(null);
  const [key, setKey] = React.useState(() => newIdempotencyKey("batch"));
  const { mutate, pending, errors, formError } = useMutation<{ batch: { id: string; batchNumber: string }; codes: string[] }>();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const res = await mutate(
      "/vouchers/batches",
      { method: "POST", idempotencyKey: key, body: { packageId: v.packageId, quantity: v.quantity, codeLength: v.codeLength, agentId: v.agentId ?? null, routerId: v.routerId ?? null, expiresAt: v.expiresAt ? new Date(`${v.expiresAt}T23:59:59`).toISOString() : null, notes: v.notes ?? null } },
      { success: "Batch generated", onError: (err) => rotateOnServerError(err, () => setKey(newIdempotencyKey("batch"))) },
    );
    if (res) {
      setOpen(false);
      setKey(newIdempotencyKey("batch"));
      setResult({ batchId: res.batch.id, batchNumber: res.batch.batchNumber, codes: res.codes });
    }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>
            <Plus /> Generate batch
          </Button>
        </DialogTrigger>
        <DialogContent title="Generate voucher batch" wide>
          {packages.length === 0 ? (
            <Alert tone="info">Create an active package (usually a Hotspot package) first.</Alert>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              {formError ? <Alert tone="danger">{formError}</Alert> : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="vb-pkg" label="Package" error={errors.packageId} className="sm:col-span-2">
                  <Select name="packageId" defaultValue={packages[0]?.id}>
                    {packages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field id="vb-qty" label="Quantity" error={errors.quantity} hint="Up to 1,000 per batch">
                  <Input name="quantity" type="number" min={1} max={1000} defaultValue={50} />
                </Field>
                <Field id="vb-len" label="Code length" error={errors.codeLength}>
                  <Select name="codeLength" defaultValue="10">
                    <option value="8">8 characters</option>
                    <option value="10">10 characters (recommended)</option>
                    <option value="12">12 characters</option>
                  </Select>
                </Field>
                <Field id="vb-agent" label="Sold by" error={errors.agentId}>
                  <Select name="agentId" defaultValue="">
                    <option value="">Direct (office)</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field id="vb-router" label="Hotspot router" hint={routers.length > 1 ? "Required when more than one router runs a hotspot." : undefined} error={errors.routerId}>
                  <Select name="routerId" defaultValue="">
                    <option value="">{routers.length === 1 ? `Default (${routers[0]!.name})` : routers.length ? "Choose a router" : "No hotspot router registered"}</option>
                    {routers.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field id="vb-exp" label="Redeem by (optional)" error={errors.expiresAt}>
                  <Input name="expiresAt" type="date" />
                </Field>
                <Field id="vb-notes" label="Notes" className="sm:col-span-2">
                  <Input name="notes" maxLength={300} />
                </Field>
              </div>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={pending}>
                  Generate
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={result !== null} onOpenChange={(v) => !v && setResult(null)}>
        <DialogContent title={`Batch ${result?.batchNumber ?? ""} — ${result?.codes.length ?? 0} codes`} description="These codes are shown once. Afterwards they can only be re-exported by staff with export permission, and every export is audited." wide>
          <div className="max-h-[45vh] overflow-y-auto rounded-md border border-border bg-surface-muted p-3">
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-3">
              {result?.codes.map((c) => (
                <li key={c}>{group(c)}</li>
              ))}
            </ul>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText((result?.codes ?? []).map(group).join("\n"));
                  toast.success("Codes copied");
                } catch {
                  toast.error("Copy failed");
                }
              }}
            >
              <Copy /> Copy all
            </Button>
            {canExport && result ? (
              <a href={`/api/v1/vouchers/batches/${result.batchId}/export`} className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-surface-muted">
                <Download className="size-4" /> Printable cards (PDF)
              </a>
            ) : null}
            <Button onClick={() => setResult(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentDialog({ agent }: { agent?: { id: string; name: string; commissionRate: string; status: string } }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const ok = await mutate(agent ? `/agents/${agent.id}` : "/agents", { method: agent ? "PATCH" : "POST", body: agent ? { name: v.name, commissionRate: v.commissionRate, status: v.status } : { name: v.name, phone: v.phone ?? "", commissionRate: v.commissionRate ?? "0" } }, { success: agent ? "Agent updated" : "Agent added" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {agent ? (
          <Button size="sm" variant="ghost" aria-label={`Edit ${agent.name}`}>
            <Pencil /> Edit
          </Button>
        ) : (
          <Button>
            <Plus /> New agent
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title={agent ? `Edit ${agent.name}` : "New agent"} description="Commission is a percentage of the face value of each redeemed voucher from this agent's batches.">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id="ag-name" label="Name" error={errors.name} required>
            <Input name="name" defaultValue={agent?.name} />
          </Field>
          {!agent ? (
            <Field id="ag-phone" label="Phone" error={errors.phone} required>
              <Input name="phone" type="tel" />
            </Field>
          ) : null}
          <Field id="ag-rate" label="Commission (%)" error={errors.commissionRate}>
            <Input name="commissionRate" inputMode="decimal" defaultValue={agent?.commissionRate ?? "10"} />
          </Field>
          {agent ? (
            <Field id="ag-status" label="Status">
              <Select name="status" defaultValue={agent.status}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemittanceDialog({ agentId, name, owed, currency }: { agentId: string; name: string; owed: string; currency: string }) {
  return (
    <ActionDialog
      label={
        <>
          <Wallet /> Remittance
        </>
      }
      triggerVariant="ghost"
      title={`Remittance from ${name}`}
      path={`/agents/${agentId}/remittances`}
      idempotent
      success="Remittance recorded"
      impact={<>Owed: {formatMoney(owed, currency)}. Record only money actually received.</>}
      extraBody={(v) => ({ amount: v.amount, method: v.method, reference: v.reference ?? null, receivedAt: new Date().toISOString() })}
    >
      {(errors) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`rm-amt-${agentId}`} label={`Amount (${currency})`} error={errors.amount} required>
            <Input name="amount" inputMode="decimal" defaultValue={owed} />
          </Field>
          <Field id={`rm-m-${agentId}`} label="Received via">
            <Select name="method" defaultValue="MPESA">
              <option value="MPESA">M-Pesa</option>
              <option value="CASH">Cash</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
            </Select>
          </Field>
          <Field id={`rm-ref-${agentId}`} label="Reference" className="sm:col-span-2">
            <Input name="reference" />
          </Field>
        </div>
      )}
    </ActionDialog>
  );
}

export function StaffRedeemForm() {
  const ref = React.useRef<HTMLFormElement>(null);
  const [done, setDone] = React.useState<{ packageName: string; accessEndsAt: string } | null>(null);
  const { mutate, pending, errors, formError } = useMutation<{ packageName: string; accessEndsAt: string }>();
  return (
    <form
      ref={ref}
      onSubmit={async (e) => {
        e.preventDefault();
        const v = formValues(e.currentTarget);
        setDone(null);
        const r = await mutate("/vouchers/redeem", { method: "POST", body: { code: v.code ?? "", mac: v.mac ?? null } }, { success: "Voucher redeemed" });
        if (r) {
          setDone(r);
          ref.current?.reset();
        }
      }}
      className="max-w-md space-y-3"
      noValidate
    >
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      {done ? <Alert tone="success" title={`${done.packageName} activated until ${new Date(done.accessEndsAt).toLocaleString("en-KE")}`}>Network activation status is tracked separately (mock mode simulates it).</Alert> : null}
      <Field id="rd-code" label="Voucher code" error={errors.code} required>
        <Input name="code" autoCapitalize="characters" className="font-mono uppercase" />
      </Field>
      <Field id="rd-mac" label="Device MAC (optional)" error={errors.mac}>
        <Input name="mac" placeholder="AA:BB:CC:DD:EE:FF" />
      </Field>
      <Button type="submit" loading={pending}>
        Redeem
      </Button>
    </form>
  );
}
