"use client";

import * as React from "react";
import { Eye, Megaphone, Pencil, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { ActionDialog } from "@/components/action-dialog";
import { formValues, useMutation } from "@/components/use-mutation";

export interface CampaignDraft {
  id?: string;
  name: string;
  channel: "SMS" | "EMAIL";
  kind: "service" | "marketing";
  subject: string;
  body: string;
  audience: Record<string, string | undefined>;
}

interface Preview {
  matched: number;
  willReceive: number;
  excluded: number;
  sample: { to: string; subject: string | null; body: string } | null;
}

const EMPTY: CampaignDraft = { name: "", channel: "SMS", kind: "service", subject: "", body: "", audience: {} };

function bodyOf(v: Record<string, string | undefined>) {
  const audience = Object.fromEntries(["subscription", "service", "routerId", "packageId", "created", "vip", "risk"].map((k) => [k, v[`a_${k}`] || undefined]).filter(([, x]) => x));
  return { name: v.name ?? "", channel: v.channel, kind: v.kind, subject: v.subject || null, body: v.body ?? "", audience };
}

/** Write or edit a draft campaign, see who it would reach and a sample, then save. Sending is a separate step. */
export function CampaignDialog({ draft, routers, packages }: { draft?: CampaignDraft; routers: Array<{ id: string; name: string }>; packages: Array<{ id: string; name: string }> }) {
  const d = draft ?? EMPTY;
  const [open, setOpen] = React.useState(false);
  const [channel, setChannel] = React.useState(d.channel);
  const [kind, setKind] = React.useState(d.kind);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const save = useMutation();
  const check = useMutation<Preview>();
  const errors = { ...check.errors, ...save.errors };
  const runPreview = async () => {
    if (!formRef.current) return;
    const r = await check.mutate("/campaigns/preview", { method: "POST", body: bodyOf(formValues(formRef.current)) }, { refresh: false });
    if (r) setPreview(r);
  };
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const ok = await save.mutate(d.id ? `/campaigns/${d.id}` : "/campaigns", { method: d.id ? "PATCH" : "POST", body: bodyOf(formValues(e.currentTarget)) }, { success: d.id ? "Draft updated" : "Draft saved. Send it from the list when ready." });
    if (ok) setOpen(false);
  };
  const a = d.audience;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPreview(null);
      }}
    >
      <DialogTrigger asChild>
        {d.id ? (
          <Button size="sm" variant="ghost">
            <Pencil /> Edit
          </Button>
        ) : (
          <Button>
            <Megaphone /> New campaign
          </Button>
        )}
      </DialogTrigger>
      <DialogContent title={d.id ? "Edit campaign" : "New campaign"} description="Saved as a draft. Nothing is sent until you choose Send." wide>
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
          {save.formError || check.formError ? <Alert tone="danger">{save.formError ?? check.formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="c-name" label="Name (staff only)" error={errors.name} required className="sm:col-span-3">
              <Input name="name" defaultValue={d.name} placeholder="Ruaka fibre cut" />
            </Field>
            <Field id="c-channel" label="Channel" error={errors.channel}>
              <Select name="channel" value={channel} onChange={(e) => setChannel(e.target.value as CampaignDraft["channel"])}>
                <option value="SMS">SMS</option>
                <option value="EMAIL">Email</option>
              </Select>
            </Field>
            <Field id="c-kind" label="Type" error={errors.kind} className="sm:col-span-2">
              <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value as CampaignDraft["kind"])}>
                <option value="service">Service notice (outage, maintenance, changes)</option>
                <option value="marketing">Offer or promotion</option>
              </Select>
            </Field>
          </div>
          {kind === "marketing" ? (
            <Alert tone="info">Offers go only to customers who agreed to receive them (recorded on the subscriber or chosen in the portal).</Alert>
          ) : null}
          {channel === "EMAIL" ? (
            <Field id="c-subject" label="Subject" error={errors.subject} required>
              <Input name="subject" defaultValue={d.subject} />
            </Field>
          ) : null}
          <Field id="c-body" label="Message" error={errors.body} required hint={`Placeholders: {{name}}, {{accountNumber}}, {{packageName}}, {{endDate}}, {{organization}}.${channel === "SMS" ? " Up to 480 characters." : ""}`}>
            <Textarea name="body" rows={4} defaultValue={d.body} maxLength={channel === "SMS" ? 480 : 5000} />
          </Field>
          <fieldset className="space-y-2 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium">Who receives it</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field id="c-a-sub" label="Subscription">
                <Select name="a_subscription" defaultValue={a.subscription ?? ""}>
                  <option value="">Any (including none)</option>
                  <option value="ACTIVE">Active</option>
                  <option value="SUSPENDED">Suspended</option>
                  <option value="EXPIRED">Expired</option>
                  <option value="NONE">No live plan</option>
                </Select>
              </Field>
              <Field id="c-a-service" label="Service">
                <Select name="a_service" defaultValue={a.service ?? ""}>
                  <option value="">Any</option>
                  <option value="PPPOE">PPPoE</option>
                  <option value="HOTSPOT">Hotspot</option>
                  <option value="STATIC_IP">Static IP</option>
                </Select>
              </Field>
              <Field id="c-a-pkg" label="Plan">
                <Select name="a_packageId" defaultValue={a.packageId ?? ""}>
                  <option value="">Any</option>
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {routers.length ? (
                <Field id="c-a-router" label="Router">
                  <Select name="a_routerId" defaultValue={a.routerId ?? ""}>
                    <option value="">Any</option>
                    {routers.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <Field id="c-a-created" label="Joined">
                <Select name="a_created" defaultValue={a.created ?? ""}>
                  <option value="">Any time</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="90d">Last 90 days</option>
                </Select>
              </Field>
              <div className="flex flex-col justify-end gap-1.5 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="a_vip" value="1" defaultChecked={a.vip === "1"} /> VIP only
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="a_risk" value="1" defaultChecked={a.risk === "1"} /> At risk only
                </label>
              </div>
            </div>
          </fieldset>
          {preview ? (
            <div className="space-y-2 rounded-md bg-surface-muted p-3 text-sm" aria-live="polite">
              <p>
                <span className="font-semibold">{preview.willReceive}</span> of {preview.matched} matching subscriber{preview.matched === 1 ? "" : "s"} would receive it
                {preview.excluded ? ` (${preview.excluded} excluded: ${kind === "marketing" ? "no agreement to offers" : "opted out"})` : ""}.
              </p>
              {preview.sample ? (
                <p className="whitespace-pre-wrap rounded border border-border bg-surface p-2 text-xs">
                  <span className="mb-1 block text-muted-foreground">Sample for {preview.sample.to}:</span>
                  {preview.sample.subject ? <span className="block font-medium">{preview.sample.subject}</span> : null}
                  {preview.sample.body}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" loading={check.pending} onClick={runPreview}>
              <Eye /> Preview audience
            </Button>
            <Button type="submit" loading={save.pending}>
              {d.id ? "Save changes" : "Save draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Send a draft now or at a chosen time. The audience is worked out when sending starts. */
export function SendCampaignDialog({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = React.useState(false);
  const [when, setWhen] = React.useState<"now" | "later">("now");
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const scheduledAt = when === "later" && v.at ? new Date(v.at).toISOString() : null;
    const ok = await mutate(`/campaigns/${id}/send`, { method: "POST", body: { scheduledAt } }, { success: scheduledAt ? "Campaign scheduled" : "Sending started" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Send /> Send
        </Button>
      </DialogTrigger>
      <DialogContent title="Send campaign" description={name}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <fieldset className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="when" checked={when === "now"} onChange={() => setWhen("now")} /> Send now
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="when" checked={when === "later"} onChange={() => setWhen("later")} /> Send at a chosen time
            </label>
          </fieldset>
          {when === "later" ? (
            <Field id={`c-at-${id}`} label="Date and time" error={errors.scheduledAt} required>
              <Input name="at" type="datetime-local" />
            </Field>
          ) : null}
          <p className="text-xs text-muted-foreground">A campaign is sent once. Messages are queued in batches and then delivered by your SMS or email provider.</p>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Back
            </Button>
            <Button type="submit" loading={pending}>
              {when === "now" ? "Send now" : "Schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CancelCampaignButton({ id, name }: { id: string; name: string }) {
  return (
    <ActionDialog
      label="Cancel"
      triggerVariant="ghost"
      tone="danger"
      title="Cancel campaign"
      description={name}
      impact="A scheduled campaign will not be sent. One that is being sent stops after the current batch; messages already queued still go out."
      path={`/campaigns/${id}/cancel`}
      submitLabel="Cancel campaign"
      success="Campaign cancelled"
    />
  );
}
