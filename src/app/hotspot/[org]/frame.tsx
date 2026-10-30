"use client";

import * as React from "react";
import { MessageCircle, Phone, Wifi } from "lucide-react";
import { BrandMark } from "@/components/brand";
import { cn } from "@/lib/utils";
import { DEFAULT_STEPS, type PortalTemplate } from "@/lib/portal-templates";
import { HotspotPortal, type PortalProps } from "./portal";

export interface FrameProps {
  template: PortalTemplate;
  orgName: string;
  logoUrl: string | null;
  headline: string | null;
  steps: string[] | null;
  support: { phone: string | null; whatsapp: string | null; hours: string | null };
  portal: PortalProps;
}

const DEFAULT_HEADLINE = "Pick a plan, pay with M-Pesa, and you are online.";

function Mark({ logoUrl, className }: { logoUrl: string | null; className?: string }) {
  if (logoUrl) return <BrandMark logoUrl={logoUrl} className={cn("size-11", className)} />;
  return (
    <div className={cn("flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent", className)}>
      <Wifi className="size-5" aria-hidden />
    </div>
  );
}

/** One captive-portal page in a given template. Also used, inert, for the previews in Settings. */
export function PortalFrame({ template: t, orgName, logoUrl, headline, steps, support, portal }: FrameProps) {
  const line = headline ?? DEFAULT_HEADLINE;
  const titleClass = cn("font-semibold leading-tight", t.serif && "font-serif");
  const header =
    t.header === "band" ? (
      <header className="-mx-5 -mt-5 flex items-center gap-3 bg-accent px-5 py-5 text-accent-foreground sm:-mx-6 sm:-mt-6 sm:px-6">
        <Mark logoUrl={logoUrl} className="bg-white/15 text-accent-foreground" />
        <div className="min-w-0">
          <h1 className={cn(titleClass, "truncate text-lg")}>{orgName}</h1>
          <p className="text-sm opacity-90">{line}</p>
        </div>
      </header>
    ) : t.header === "hero" ? (
      <header className="space-y-2 pt-2">
        <div className="flex items-center gap-2">
          <Mark logoUrl={logoUrl} className="size-8" />
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{orgName}</p>
        </div>
        <h1 className={cn(titleClass, "text-3xl font-bold tracking-tight")}>{headline ?? "Fast WiFi, one tap away."}</h1>
        {headline ? null : <p className="text-sm text-muted-foreground">Choose a plan and pay with M-Pesa.</p>}
      </header>
    ) : t.header === "center" ? (
      <header className="flex flex-col items-center gap-2 text-center">
        <Mark logoUrl={logoUrl} />
        <h1 className={cn(titleClass, "text-xl")}>{orgName}</h1>
        <p className="text-sm text-muted-foreground">{line}</p>
      </header>
    ) : (
      <header className="flex items-center gap-3">
        <Mark logoUrl={logoUrl} />
        <div className="min-w-0">
          <h1 className={cn(titleClass, "truncate text-lg")}>{orgName}</h1>
          <p className="text-sm text-muted-foreground">{line}</p>
        </div>
      </header>
    );

  const howTo = t.steps ? (steps?.length ? steps : DEFAULT_STEPS) : null;

  return (
    // text-foreground here, not only on <body>: dark templates redefine the tokens on this subtree.
    <div className={cn("w-full max-w-md space-y-6 p-5 text-foreground sm:p-6", t.card)}>
      {header}
      {howTo ? (
        <section aria-label="How to buy" className="rounded-xl border border-border bg-surface-muted/50 p-4">
          <h2 className={cn("mb-2 text-sm font-semibold", t.serif && "font-serif")}>How to buy</h2>
          <ol className="space-y-1.5 text-sm">
            {howTo.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">{i + 1}</span>
                <span className="text-muted-foreground">{s}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <HotspotPortal {...portal} layout={t.plans} voucherFirst={t.voucherFirst} />
      {support.phone || support.whatsapp ? (
        <footer className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-border pt-4 text-sm text-muted-foreground">
          <span>Need help?</span>
          {support.phone ? (
            <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href={`tel:${support.phone.replace(/\s+/g, "")}`}>
              <Phone className="size-3.5" aria-hidden /> {support.phone}
            </a>
          ) : null}
          {support.whatsapp ? (
            <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href={`https://wa.me/${support.whatsapp}`} rel="noreferrer noopener" target="_blank">
              <MessageCircle className="size-3.5" aria-hidden /> WhatsApp
            </a>
          ) : null}
          {support.hours ? <span className="w-full text-center text-xs">{support.hours}</span> : null}
        </footer>
      ) : null}
    </div>
  );
}
