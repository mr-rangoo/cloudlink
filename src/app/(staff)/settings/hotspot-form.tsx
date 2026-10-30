"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ExternalLink, Maximize2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { Switch } from "@/components/ui/controls";
import { useMutation } from "@/components/use-mutation";
import { cn } from "@/lib/utils";
import { PORTAL_TEMPLATES, templateById, type PortalTemplate } from "@/lib/portal-templates";
import { PortalFrame } from "@/app/hotspot/[org]/frame";
import type { PortalPlan } from "@/app/hotspot/[org]/portal";

export interface HotspotSettingsValues {
  template: string;
  headline: string | null;
  instructions: string | null;
  supportPhone: string | null;
  whatsappPhone: string | null;
  showVouchers: boolean;
  showReconnect: boolean;
}

interface PreviewData {
  slug: string;
  orgName: string;
  logoUrl: string | null;
  currency: string;
  plans: PortalPlan[];
  fallbackHeadline: string | null;
  fallbackPhone: string | null;
  hours: string | null;
  mpesa: boolean;
}

const local = (digits: string | null) => (digits && /^254\d{9}$/.test(digits) ? `0${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}` : digits ? `+${digits}` : "");

/** A template rendered at phone width, shrunk to fit a thumbnail. Inert: nothing in a preview can be clicked or focused. */
function Phone({ template, data, values, scale }: { template: PortalTemplate; data: PreviewData; values: { headline: string; instructions: string; supportPhone: string; whatsappPhone: string; showVouchers: boolean; showReconnect: boolean }; scale: number }) {
  const steps = values.instructions
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const width = 390;
  return (
    <div className="overflow-hidden rounded-[28px] border-[6px] border-[#111827] bg-[#111827] shadow-(--shadow-card)" style={{ width: width * scale + 12, height: 760 * scale + 12 }} aria-hidden>
      <div inert className="pointer-events-none origin-top-left select-none" style={{ width, transform: `scale(${scale})` }}>
        <div className={cn("flex min-h-[760px] items-start justify-center px-4 py-8", template.page)}>
          <PortalFrame
            template={template}
            orgName={data.orgName}
            logoUrl={data.logoUrl}
            headline={values.headline.trim() || data.fallbackHeadline}
            steps={steps.length ? steps : null}
            support={{ phone: values.supportPhone.trim() || data.fallbackPhone, whatsapp: values.whatsappPhone.trim() ? "254700000000" : null, hours: data.hours }}
            portal={{ org: data.slug, currency: data.currency, plans: data.plans, routerId: null, mac: null, ip: null, loginUrl: null, dst: null, mpesa: data.mpesa, testMode: false, showVouchers: values.showVouchers, showReconnect: values.showReconnect, preview: true }}
          />
        </div>
      </div>
    </div>
  );
}

export function HotspotSettingsForm({ initial, data }: { initial: HotspotSettingsValues; data: PreviewData }) {
  const { mutate, pending, errors, formError } = useMutation();
  const [template, setTemplate] = React.useState(templateById(initial.template).id);
  const [headline, setHeadline] = React.useState(initial.headline ?? "");
  const [instructions, setInstructions] = React.useState(initial.instructions ?? "");
  const [supportPhone, setSupportPhone] = React.useState(local(initial.supportPhone));
  const [whatsappPhone, setWhatsappPhone] = React.useState(local(initial.whatsappPhone));
  const [showVouchers, setShowVouchers] = React.useState(initial.showVouchers);
  const [showReconnect, setShowReconnect] = React.useState(initial.showReconnect);
  const [expanded, setExpanded] = React.useState<PortalTemplate | null>(null);
  const values = { headline, instructions, supportPhone, whatsappPhone, showVouchers, showReconnect };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await mutate(
      "/settings/hotspot",
      { method: "PUT", body: { template, headline: headline.trim() || null, instructions: instructions.trim() || null, supportPhone: supportPhone.trim() || null, whatsappPhone: whatsappPhone.trim() || null, showVouchers, showReconnect } },
      { success: "Captive portal saved" },
    );
  };

  return (
    <form onSubmit={save} className="space-y-5" noValidate>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-base">Portal template</CardTitle>
            <CardDescription className="text-sm">How the page your hotspot customers see looks. Previews use your live plans and branding.</CardDescription>
          </div>
          <Link href={`/hotspot/${data.slug}`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <ExternalLink /> Open portal
          </Link>
        </CardHeader>
        <CardContent>
          <div role="radiogroup" aria-label="Portal template" className="grid grid-cols-[repeat(auto-fill,minmax(205px,1fr))] gap-5">
            {PORTAL_TEMPLATES.map((t) => {
              const selected = t.id === template;
              return (
                <div key={t.id} className="flex flex-col items-center gap-2">
                  <div className={cn("relative rounded-[34px] p-1 transition-shadow", selected ? "ring-2 ring-accent" : "ring-1 ring-transparent hover:ring-border-strong")}>
                    <button type="button" role="radio" aria-checked={selected} aria-label={`${t.name}: ${t.summary}`} onClick={() => setTemplate(t.id)} className="block rounded-[30px] focus-visible:outline-2 focus-visible:outline-ring">
                      <Phone template={t} data={data} values={values} scale={0.48} />
                    </button>
                    {selected ? (
                      <span className="absolute left-3 top-3 flex size-6 items-center justify-center rounded-full bg-accent text-accent-foreground shadow" aria-hidden>
                        <Check className="size-3.5" />
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setExpanded(t)}
                      className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full bg-surface/90 text-foreground shadow hover:bg-surface"
                      aria-label={`Preview ${t.name} full size`}
                    >
                      <Maximize2 className="size-3.5" />
                    </button>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium">
                      {t.name}
                      {t.id === PORTAL_TEMPLATES[0]!.id ? <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">Default</span> : null}
                    </p>
                    <p className="max-w-[205px] text-xs text-muted-foreground">{t.summary}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="hs-headline" label="Headline" error={errors.headline} hint="The line under your name. Empty uses the portal welcome from Branding, or a short default.">
            <Input value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={160} placeholder="Pick a plan, pay with M-Pesa, and you are online." />
          </Field>
          <Field id="hs-steps" label="How to buy (one step per line)" error={errors.instructions} hint="Shown by templates with steps, such as Guided. Empty uses four default steps.">
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} maxLength={1500} placeholder={"Choose a plan below.\nEnter your M-Pesa number and tap Pay.\nEnter your M-Pesa PIN on your phone.\nWait a few seconds: you are connected automatically."} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="hs-phone" label="Support phone" error={errors.supportPhone} hint={data.fallbackPhone ? `Empty uses ${data.fallbackPhone} from Organization settings.` : "Shown at the bottom of the portal."}>
              <Input value={supportPhone} onChange={(e) => setSupportPhone(e.target.value)} type="tel" inputMode="tel" placeholder="0712 345 678" />
            </Field>
            <Field id="hs-wa" label="WhatsApp number" error={errors.whatsappPhone} hint="Optional. Customers can open a chat from the portal.">
              <Input value={whatsappPhone} onChange={(e) => setWhatsappPhone(e.target.value)} type="tel" inputMode="tel" placeholder="0712 345 678" />
            </Field>
          </div>
          <div className="space-y-3 rounded-md border border-border p-4">
            <Switch id="hs-vouchers" checked={showVouchers} onChange={setShowVouchers} label="Voucher tab" description="Let customers enter a printed voucher code." />
            <Switch id="hs-reconnect" checked={showReconnect} onChange={setShowReconnect} label="“Already paid?” tab" description="Let customers reconnect a new device with their M-Pesa confirmation code." />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          Save captive portal
        </Button>
      </div>

      <Dialog open={expanded !== null} onOpenChange={(o) => !o && setExpanded(null)}>
        {expanded ? (
          <DialogContent title={`${expanded.name} template`} description={expanded.summary}>
            <div className="flex justify-center">
              <Phone template={expanded} data={data} values={values} scale={0.82} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setExpanded(null)}>
                Close
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setTemplate(expanded.id);
                  setExpanded(null);
                }}
              >
                Use {expanded.name}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </form>
  );
}
