"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ImageUp, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { useMutation } from "@/components/use-mutation";
import { contrast, LIGHT_SURFACE, resolveTheme, THEME_PRESETS, tokensFromBrand, presetById, type ThemeTokens } from "@/lib/themes";
import { cn } from "@/lib/utils";

interface Initial {
  themePreset: string;
  customAccent: string | null;
  defaultMode: "light" | "dark" | "system";
  logoUrl: string | null;
  portalWelcome: string | null;
  supportHours: string | null;
}

function Preview({ tokens, dark, name, logoUrl }: { tokens: ThemeTokens; dark: boolean; name: string; logoUrl: string | null }) {
  const surface = dark ? "#111b2c" : "#ffffff";
  const ink = dark ? "#e5ebf5" : "#0f172a";
  const muted = dark ? "#8d9bb5" : "#5b6b82";
  return (
    <div className="overflow-hidden rounded-lg border border-border" aria-hidden>
      <div className="flex h-36">
        <div className="flex w-24 flex-col gap-1.5 p-2" style={{ background: tokens.sidebar }}>
          <div className="flex items-center gap-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {logoUrl ? <img src={logoUrl} alt="" className="size-5 rounded bg-white object-contain" /> : <span className="size-5 rounded" style={{ background: tokens.accent }} />}
            <span className="truncate text-[10px] font-semibold text-white">{name}</span>
          </div>
          <span className="rounded px-1.5 py-1 text-[9px] text-white" style={{ background: tokens.sidebarActive }}>
            Dashboard
          </span>
          <span className="px-1.5 text-[9px]" style={{ color: "#c8d3e6" }}>
            Subscribers
          </span>
          <span className="px-1.5 text-[9px]" style={{ color: "#c8d3e6" }}>
            Invoices
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-2 p-3" style={{ background: dark ? "#0a111e" : "#f6f8fb" }}>
          <div className="rounded-md p-2" style={{ background: surface }}>
            <p className="text-[10px] font-semibold" style={{ color: ink }}>
              Amount due
            </p>
            <p className="text-[9px]" style={{ color: muted }}>
              <span style={{ color: tokens.accent }} className="underline">
                View invoice
              </span>
            </p>
          </div>
          <div className="flex gap-1.5">
            <span className="rounded px-2 py-1 text-[10px] font-medium" style={{ background: tokens.accent, color: tokens.accentForeground }}>
              Pay now
            </span>
            <span className="rounded px-2 py-1 text-[10px] font-medium" style={{ background: tokens.accentSoft, color: tokens.accent }}>
              Active
            </span>
          </div>
        </div>
      </div>
      <p className="border-t border-border px-2 py-1 text-center text-[10px] text-muted-foreground">{dark ? "Dark mode" : "Light mode"}</p>
    </div>
  );
}

export function BrandingForm({ initial, organizationName }: { initial: Initial; organizationName: string }) {
  const router = useRouter();
  const [preset, setPreset] = React.useState(initial.themePreset);
  const [useCustom, setUseCustom] = React.useState(Boolean(initial.customAccent));
  const [custom, setCustom] = React.useState(initial.customAccent ?? "#1d6fe8");
  const [uploading, setUploading] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const removeLogo = useMutation();
  const customOk = !useCustom || Boolean(tokensFromBrand(custom, presetById(preset)));
  const theme = resolveTheme(preset, useCustom && customOk ? custom : null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await mutate(
      "/settings/branding",
      {
        method: "PUT",
        body: {
          themePreset: preset,
          customAccent: useCustom ? custom : null,
          defaultMode: form.get("defaultMode"),
          portalWelcome: String(form.get("portalWelcome") ?? "").trim() || null,
          supportHours: String(form.get("supportHours") ?? "").trim() || null,
        },
      },
      { success: "Branding saved. Reload other open tabs to see it." },
    );
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/v1/settings/branding/logo", { method: "POST", body, credentials: "same-origin" });
      const json = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? "Upload failed");
      toast.success("Logo uploaded");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>Used in the staff app, the customer portal and the hotspot page. Every theme keeps text readable in light and dark mode.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <fieldset>
            <legend className="sr-only">Theme preset</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {THEME_PRESETS.map((p) => (
                <label key={p.id} className={cn("flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm", preset === p.id ? "border-accent ring-1 ring-accent" : "border-border hover:bg-surface-muted")}>
                  <input type="radio" name="themePreset" value={p.id} checked={preset === p.id} onChange={() => setPreset(p.id)} className="sr-only" />
                  <span className="flex shrink-0 overflow-hidden rounded" aria-hidden>
                    <span className="size-5" style={{ background: p.light.sidebar }} />
                    <span className="size-5" style={{ background: p.light.accent }} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {preset === p.id ? <Check className="size-4 text-accent" aria-hidden /> : null}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} /> Use our brand colour for buttons and links
            </label>
            {useCustom ? (
              <div className="flex flex-wrap items-center gap-3">
                <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Brand colour" className="h-9 w-14 cursor-pointer rounded border border-border bg-surface" />
                <Input value={custom} onChange={(e) => setCustom(e.target.value.toLowerCase())} className="w-32 font-mono" aria-label="Brand colour hex" maxLength={7} />
                <span className={cn("text-xs", customOk ? "text-muted-foreground" : "text-danger")}>
                  {customOk ? `Contrast on white ${contrast(custom, LIGHT_SURFACE).toFixed(1)}:1` : "Too light for readable text. Choose a darker shade."}
                </span>
              </div>
            ) : null}
            {errors.customAccent ? <p className="text-sm text-danger">{errors.customAccent}</p> : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Preview tokens={theme.light} dark={false} name={organizationName} logoUrl={initial.logoUrl} />
            <Preview tokens={theme.dark} dark name={organizationName} logoUrl={initial.logoUrl} />
          </div>

          <Field id="br-mode" label="Default appearance" hint="Staff and customers can still switch for themselves." error={errors.defaultMode}>
            <Select name="defaultMode" defaultValue={initial.defaultMode}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">Follow the device setting</option>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
          <CardDescription>PNG, JPEG or WebP, up to 512 KB. A square image works best.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <div className="flex size-16 items-center justify-center rounded-md border border-border bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {initial.logoUrl ? <img src={initial.logoUrl} alt="Current logo" className="max-h-14 max-w-14 object-contain" /> : <span className="text-xs text-muted-foreground">No logo</span>}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium shadow-sm hover:bg-surface-muted">
            <ImageUp className="size-4" aria-hidden /> {uploading ? "Uploading…" : initial.logoUrl ? "Replace logo" : "Upload logo"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
          {initial.logoUrl ? (
            <Button type="button" variant="ghost" loading={removeLogo.pending} onClick={() => removeLogo.mutate("/settings/branding/logo", { method: "DELETE" }, { success: "Logo removed" })}>
              <Trash2 /> Remove
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Customer portal</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field id="br-welcome" label="Welcome message" hint="Shown on the portal home page." error={errors.portalWelcome}>
            <Textarea name="portalWelcome" defaultValue={initial.portalWelcome ?? ""} maxLength={300} rows={2} />
          </Field>
          <Field id="br-hours" label="Support hours" hint="For example: Mon–Sat 8am–8pm, 0700 000 000" error={errors.supportHours}>
            <Input name="supportHours" defaultValue={initial.supportHours ?? ""} maxLength={120} />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={pending} disabled={!customOk}>
          Save branding
        </Button>
      </div>
    </form>
  );
}
