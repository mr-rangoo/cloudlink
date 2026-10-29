"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Info } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { ChipToggleGroup, Segmented, Switch } from "@/components/ui/controls";
import { useMutation } from "@/components/use-mutation";
import {
  ALL_DAYS,
  AVAILABILITY_HINT,
  DAY_LABELS,
  DURATION_PRESETS,
  PLAN_TYPE_LABEL,
  durationKey,
  durationLabel,
  formatRatePair,
  minuteToHHMM,
  parseDurationKey,
  parseHHMM,
  parseRatePair,
  planTypeFields,
  type DurationUnit,
  type PlanType,
} from "@/lib/plans";

export interface PlanValues {
  id: string;
  name: string;
  description: string | null;
  planType: PlanType;
  availability: "LIVE" | "HIDDEN" | "OFF" | "ARCHIVED";
  highlight: string | null;
  price: string;
  taxRate: string;
  billingUnit: DurationUnit;
  billingCount: number;
  uploadKbps: number | null;
  downloadKbps: number | null;
  deviceLimit: number | null;
  dataQuotaMb: number | null;
  burstUploadKbps: number | null;
  burstDownloadKbps: number | null;
  burstThresholdUploadKbps: number | null;
  burstThresholdDownloadKbps: number | null;
  burstTimeSeconds: number | null;
  fupEnabled: boolean;
  fupThresholdMb: number | null;
  fupAction: string | null;
  fupUploadKbps: number | null;
  fupDownloadKbps: number | null;
  scheduleEnabled: boolean;
  scheduleStartMinute: number | null;
  scheduleEndMinute: number | null;
  scheduleDays: number | null;
  trialCooldownDays: number | null;
  routerIds: string[];
  networkProfile: string | null;
  sortOrder: number;
}

export interface RouterChoice {
  id: string;
  name: string;
  host: string;
  pppoeEnabled: boolean;
  hotspotEnabled: boolean;
}

const TYPES: PlanType[] = ["HOTSPOT", "PPPOE", "DATA", "TRIAL", "DEVICE", "STATIC_IP"];
const TYPE_HINT: Partial<Record<PlanType, string>> = {
  HOTSPOT: "Time-based access sold on the captive portal or as vouchers.",
  PPPOE: "Fixed-line customers with a PPPoE username and password.",
  DATA: "A data allowance that must be used within the duration.",
  TRIAL: "A short trial. Can be free; each phone or device can take it once per cool-down.",
  DEVICE: "For TVs and streaming devices that cannot open a login page: access by MAC address.",
  STATIC_IP: "Customers on a fixed address (no login).",
};
const MB_PER_GB = 1024;

function splitQuota(mb: number | null): { value: string; unit: "MB" | "GB" } {
  if (!mb) return { value: "", unit: "GB" };
  if (mb % MB_PER_GB === 0) return { value: String(mb / MB_PER_GB), unit: "GB" };
  return { value: String(mb), unit: "MB" };
}

function toMb(value: string, unit: "MB" | "GB"): number | null {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(unit === "GB" ? n * MB_PER_GB : n);
}

/** Which input shows a server error for a field path. */
const FIELD_OF: Record<string, string> = {
  uploadKbps: "rate",
  downloadKbps: "rate",
  kind: "planType",
  serviceType: "planType",
  billingUnit: "duration",
  billingCount: "duration",
  dataQuotaMb: "dataCap",
  deviceLimit: "devices",
  burstDownloadKbps: "burst",
  burstUploadKbps: "burst",
  burstThresholdDownloadKbps: "burst",
  burstThresholdUploadKbps: "burst",
  burstTimeSeconds: "burst",
  fupThresholdMb: "fupThreshold",
  fupAction: "fupAction",
  fupDownloadKbps: "fupRate",
  fupUploadKbps: "fupRate",
  scheduleStartMinute: "schedule",
  scheduleEndMinute: "schedule",
  scheduleDays: "schedule",
  routerIds: "routers",
};

export function PlanForm({ initial, routers, currency, readOnly, canSync }: { initial?: PlanValues; routers: RouterChoice[]; currency: string; readOnly?: boolean; canSync?: boolean }) {
  const router = useRouter();
  const editing = Boolean(initial);
  const { mutate, pending, errors, formError, setErrors, setFormError } = useMutation<{ id: string }>();

  const [name, setName] = React.useState(initial?.name ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [planType, setPlanType] = React.useState<PlanType>(initial?.planType ?? "HOTSPOT");
  const [availability, setAvailability] = React.useState<"LIVE" | "HIDDEN" | "OFF">(initial && initial.availability !== "ARCHIVED" ? initial.availability : "LIVE");
  const [highlight, setHighlight] = React.useState(initial?.highlight ?? "");
  const [price, setPrice] = React.useState(initial ? initial.price : "");
  const [taxRate, setTaxRate] = React.useState(initial?.taxRate ?? "0");
  const initialKey = initial ? durationKey(initial.billingUnit, initial.billingCount) : "";
  const isPreset = DURATION_PRESETS.some((d) => durationKey(d.unit, d.count) === initialKey);
  const [duration, setDuration] = React.useState(initial ? (isPreset ? initialKey : "custom") : "");
  const [customUnit, setCustomUnit] = React.useState<DurationUnit>(initial?.billingUnit ?? "HOUR");
  const [customCount, setCustomCount] = React.useState(initial ? String(initial.billingCount) : "1");
  const [rate, setRate] = React.useState(formatRatePair(initial?.uploadKbps, initial?.downloadKbps));
  const [devices, setDevices] = React.useState(initial?.deviceLimit ? String(initial.deviceLimit) : "1");
  const q = splitQuota(initial?.dataQuotaMb ?? null);
  const [dataCap, setDataCap] = React.useState(q.value);
  const [dataUnit, setDataUnit] = React.useState<"MB" | "GB">(q.unit);
  const [burstLimit, setBurstLimit] = React.useState(formatRatePair(initial?.burstUploadKbps, initial?.burstDownloadKbps));
  const [burstThreshold, setBurstThreshold] = React.useState(formatRatePair(initial?.burstThresholdUploadKbps, initial?.burstThresholdDownloadKbps));
  const [burstTime, setBurstTime] = React.useState(initial?.burstTimeSeconds ? String(initial.burstTimeSeconds) : "");
  const [fupEnabled, setFupEnabled] = React.useState(initial?.fupEnabled ?? false);
  const fq = splitQuota(initial?.fupThresholdMb ?? null);
  const [fupThreshold, setFupThreshold] = React.useState(fq.value);
  const [fupUnit, setFupUnit] = React.useState<"MB" | "GB">(fq.unit);
  const [fupAction, setFupAction] = React.useState<"THROTTLE" | "DISCONNECT">(initial?.fupAction === "DISCONNECT" ? "DISCONNECT" : "THROTTLE");
  const [fupRate, setFupRate] = React.useState(formatRatePair(initial?.fupUploadKbps, initial?.fupDownloadKbps));
  const [scheduleEnabled, setScheduleEnabled] = React.useState(initial?.scheduleEnabled ?? false);
  const [scheduleStart, setScheduleStart] = React.useState(initial?.scheduleStartMinute != null ? minuteToHHMM(initial.scheduleStartMinute) : "23:00");
  const [scheduleEnd, setScheduleEnd] = React.useState(initial?.scheduleEndMinute != null ? minuteToHHMM(initial.scheduleEndMinute) : "06:00");
  const [scheduleDays, setScheduleDays] = React.useState(initial?.scheduleDays ?? ALL_DAYS);
  const [trialCooldown, setTrialCooldown] = React.useState(initial?.trialCooldownDays != null ? String(initial.trialCooldownDays) : "30");
  const [routerIds, setRouterIds] = React.useState<Set<string>>(new Set(initial?.routerIds ?? []));
  const [profile, setProfile] = React.useState(initial?.networkProfile ?? "");
  const [sortOrder, setSortOrder] = React.useState(String(initial?.sortOrder ?? 0));

  const { serviceType } = planTypeFields(planType);
  const usesRouters = serviceType === "PPPOE" || serviceType === "HOTSPOT";
  const eligibleRouters = routers.filter((r) => (serviceType === "PPPOE" ? r.pppoeEnabled : r.hotspotEnabled));
  const durationOptions = DURATION_PRESETS.filter((d) => d.unit !== "MINUTE" || serviceType === "HOTSPOT");
  const err = (field: string) => errors[field] ?? Object.entries(errors).find(([path]) => FIELD_OF[path] === field)?.[1];

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    const local: Record<string, string> = {};
    const pair = rate.trim() ? parseRatePair(rate) : null;
    if (rate.trim() && !pair) local.rate = "Use a rate such as 5M/5M (upload/download) or 512k/2M.";
    const bl = burstLimit.trim() ? parseRatePair(burstLimit) : null;
    const bt = burstThreshold.trim() ? parseRatePair(burstThreshold) : null;
    if ((burstLimit.trim() && !bl) || (burstThreshold.trim() && !bt)) local.burst = "Use rates such as 10M/10M.";
    const fr = fupEnabled && fupAction === "THROTTLE" ? parseRatePair(fupRate) : null;
    if (fupEnabled && fupAction === "THROTTLE" && !fr) local.fupRate = "Set the reduced speed, e.g. 1M/1M.";
    const start = parseHHMM(scheduleStart);
    const end = parseHHMM(scheduleEnd);
    if (scheduleEnabled && (start === null || end === null)) local.schedule = "Enter times as HH:MM.";
    if (scheduleEnabled && scheduleDays === 0) local.schedule = "Choose at least one day.";
    const d = duration === "custom" ? { unit: customUnit, count: Number(customCount) } : parseDurationKey(duration);
    if (!d || !Number.isInteger(d.count) || d.count < 1) local.duration = "Choose how long the plan lasts.";
    if (Object.keys(local).length) {
      setErrors(local);
      setFormError("Please correct the highlighted fields.");
      return;
    }
    const body = {
      name,
      description: description.trim() || null,
      ...planTypeFields(planType),
      availability,
      highlight: highlight || null,
      price: price.trim() || "0",
      taxRate: taxRate.trim() || "0",
      billingUnit: d!.unit,
      billingCount: d!.count,
      uploadKbps: pair?.upKbps ?? null,
      downloadKbps: pair?.downKbps ?? null,
      deviceLimit: devices.trim() ? Number(devices) : null,
      dataQuotaMb: toMb(dataCap, dataUnit),
      burstUploadKbps: bl?.upKbps ?? null,
      burstDownloadKbps: bl?.downKbps ?? null,
      burstThresholdUploadKbps: bt?.upKbps ?? null,
      burstThresholdDownloadKbps: bt?.downKbps ?? null,
      burstTimeSeconds: burstTime.trim() ? Number(burstTime) : null,
      fupEnabled,
      fupThresholdMb: fupEnabled ? toMb(fupThreshold, fupUnit) : null,
      fupAction: fupEnabled ? fupAction : null,
      fupUploadKbps: fr?.upKbps ?? null,
      fupDownloadKbps: fr?.downKbps ?? null,
      scheduleEnabled,
      scheduleStartMinute: scheduleEnabled ? start : null,
      scheduleEndMinute: scheduleEnabled ? end : null,
      scheduleDays: scheduleEnabled ? (scheduleDays === ALL_DAYS ? null : scheduleDays) : null,
      trialCooldownDays: planType === "TRIAL" && trialCooldown.trim() ? Number(trialCooldown) : null,
      routerIds: usesRouters ? [...routerIds].filter((id) => eligibleRouters.some((r) => r.id === id)) : [],
      networkProfile: profile.trim() || null,
      sortOrder: Number(sortOrder) || 0,
    };
    const saved = await mutate(editing ? `/packages/${initial!.id}` : "/packages", { method: editing ? "PATCH" : "POST", body }, { refresh: editing });
    if (saved) {
      toast.success(editing ? "Plan saved" : "Plan created", usesRouters && pair ? { description: "Its router profile is being pushed to the routers that use it." } : undefined);
      if (!editing) router.push(`/packages/${saved.id}`);
    }
  };

  const section = (title: string, description: string | null, children: React.ReactNode, extra?: React.ReactNode) => (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription className="text-sm">{description}</CardDescription> : null}
        </div>
        {extra}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      {readOnly ? <Alert tone="info">You can view this plan. Editing needs the “Create and edit packages” permission.</Alert> : null}
      <fieldset disabled={readOnly} className="space-y-5">
        {section(
          "Identity",
          null,
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="plan-name" label="Name" error={err("name")} required>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Home 10 Mbps" />
              </Field>
              <Field id="plan-type" label="Type" error={err("planType")} required hint={TYPE_HINT[planType]}>
                <Select value={planType} onChange={(e) => setPlanType(e.target.value as PlanType)}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PLAN_TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <p className="text-sm font-medium" id="plan-availability-label">
                  Availability
                </p>
                <Segmented
                  id="plan-availability"
                  label="Availability"
                  value={availability}
                  onChange={setAvailability}
                  options={[
                    { value: "LIVE", label: "Live" },
                    { value: "HIDDEN", label: "Hidden" },
                    { value: "OFF", label: "Off" },
                  ]}
                />
                <p className="text-xs text-muted-foreground">{AVAILABILITY_HINT[availability]}</p>
              </div>
              <Field id="plan-highlight" label="Label on the plan" hint="Shown next to the plan on the captive portal and customer portal.">
                <Select value={highlight} onChange={(e) => setHighlight(e.target.value)}>
                  <option value="">None</option>
                  <option value="POPULAR">Popular</option>
                  <option value="OFFER">On offer</option>
                </Select>
              </Field>
            </div>
            <Field id="plan-description" label="Description" error={err("description")} hint="Optional. Shown to customers where there is room.">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
            </Field>
          </>,
        )}

        {section(
          "Pricing",
          null,
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="plan-price" label={`Price (${currency})`} error={err("price")} required hint={planType === "TRIAL" ? "Trials may be free (0)." : "What the customer pays, excluding tax."}>
              <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0.00" />
            </Field>
            <Field id="plan-tax" label="Tax rate (%)" error={err("taxRate")} hint="16 for VAT, 0 if you do not charge it.">
              <Input value={taxRate} onChange={(e) => setTaxRate(e.target.value)} inputMode="decimal" />
            </Field>
            <Field id="plan-duration" label="Duration" error={err("duration")} required hint="How long the plan gives access once it starts.">
              <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
                <option value="" disabled>
                  Choose a duration…
                </option>
                {durationOptions.map((d) => (
                  <option key={durationKey(d.unit, d.count)} value={durationKey(d.unit, d.count)}>
                    {durationLabel(d.unit, d.count)}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </Select>
            </Field>
            {duration === "custom" ? (
              <div className="grid grid-cols-2 gap-3 sm:col-span-3 sm:max-w-md">
                <Field id="plan-duration-count" label="Length">
                  <Input value={customCount} onChange={(e) => setCustomCount(e.target.value)} inputMode="numeric" />
                </Field>
                <Field id="plan-duration-unit" label="Unit">
                  <Select value={customUnit} onChange={(e) => setCustomUnit(e.target.value as DurationUnit)}>
                    {(serviceType === "HOTSPOT" ? (["MINUTE", "HOUR", "DAY", "WEEK", "MONTH"] as const) : (["HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const)).map((u) => (
                      <option key={u} value={u}>
                        {durationLabel(u, 2).replace(/^2 /, "")}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : null}
            {planType === "TRIAL" ? (
              <Field id="plan-trial-cooldown" label="Trial cool-down (days)" error={err("trialCooldownDays")} hint="The same phone or device can take the trial again after this many days.">
                <Input value={trialCooldown} onChange={(e) => setTrialCooldown(e.target.value)} inputMode="numeric" />
              </Field>
            ) : null}
          </div>,
        )}

        {section(
          "Speed",
          usesRouters ? "Cloudlink keeps a matching profile on each router that uses this plan." : null,
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="plan-rate" label="Rate limit" error={err("rate")} hint="Upload first, then download: 2M/10M is 2 Mbps up and 10 Mbps down. Leave empty for no limit.">
              <Input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="5M/5M" className="font-mono" autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="plan-devices" label="Devices per account" error={err("devices")} hint={serviceType === "HOTSPOT" ? "How many devices can be online at once with one purchase." : "Simultaneous sessions allowed."}>
              <Input value={devices} onChange={(e) => setDevices(e.target.value)} inputMode="numeric" />
            </Field>
            {serviceType === "HOTSPOT" || planType === "PPPOE" ? (
              <div className="space-y-1.5 sm:col-span-2">
                <label htmlFor="plan-data" className="text-sm font-medium">
                  {planType === "DATA" ? "Data allowance" : "Data cap (optional)"}
                  {planType === "DATA" ? (
                    <span className="text-danger" aria-hidden>
                      {" "}
                      *
                    </span>
                  ) : null}
                </label>
                <div className="flex max-w-xs gap-2">
                  <Input id="plan-data" value={dataCap} onChange={(e) => setDataCap(e.target.value)} inputMode="decimal" placeholder={planType === "DATA" ? "1" : "Unlimited"} aria-invalid={err("dataCap") ? true : undefined} />
                  <Select value={dataUnit} onChange={(e) => setDataUnit(e.target.value as "MB" | "GB")} className="w-24" aria-label="Data unit">
                    <option value="MB">MB</option>
                    <option value="GB">GB</option>
                  </Select>
                </div>
                {err("dataCap") ? <p className="text-xs font-medium text-danger">{err("dataCap")}</p> : <p className="text-xs text-muted-foreground">{planType === "DATA" ? "Access ends when the allowance or the duration runs out, whichever comes first." : "Leave empty for unlimited data."}</p>}
              </div>
            ) : null}
          </div>,
        )}

        {usesRouters
          ? section(
              "Burst",
              "Optional. MikroTik burst lets a customer briefly go faster than the rate limit. Fill in all three, or leave all empty.",
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="plan-burst-limit" label="Burst limit" error={err("burst")} hint="Higher than the rate limit.">
                  <Input value={burstLimit} onChange={(e) => setBurstLimit(e.target.value)} placeholder="10M/10M" className="font-mono" spellCheck={false} />
                </Field>
                <Field id="plan-burst-threshold" label="Burst threshold" hint="Lower than the rate limit.">
                  <Input value={burstThreshold} onChange={(e) => setBurstThreshold(e.target.value)} placeholder="4M/4M" className="font-mono" spellCheck={false} />
                </Field>
                <Field id="plan-burst-time" label="Burst time (seconds)">
                  <Input value={burstTime} onChange={(e) => setBurstTime(e.target.value)} placeholder="30" inputMode="numeric" />
                </Field>
              </div>,
            )
          : null}

        {usesRouters
          ? section(
              "Fair use policy",
              null,
              <>
                <Switch id="plan-fup" checked={fupEnabled} onChange={setFupEnabled} label="Enforce a fair use policy" description="Act when a customer's data use in one period crosses the limit." />
                {fupEnabled ? (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <label htmlFor="plan-fup-threshold" className="text-sm font-medium">
                        Usage limit{" "}
                        <span className="text-danger" aria-hidden>
                          *
                        </span>
                      </label>
                      <div className="flex gap-2">
                        <Input id="plan-fup-threshold" value={fupThreshold} onChange={(e) => setFupThreshold(e.target.value)} inputMode="decimal" aria-invalid={err("fupThreshold") ? true : undefined} />
                        <Select value={fupUnit} onChange={(e) => setFupUnit(e.target.value as "MB" | "GB")} className="w-24" aria-label="Usage limit unit">
                          <option value="MB">MB</option>
                          <option value="GB">GB</option>
                        </Select>
                      </div>
                      {err("fupThreshold") ? <p className="text-xs font-medium text-danger">{err("fupThreshold")}</p> : null}
                    </div>
                    <Field id="plan-fup-action" label="Then" error={err("fupAction")}>
                      <Select value={fupAction} onChange={(e) => setFupAction(e.target.value as "THROTTLE" | "DISCONNECT")}>
                        <option value="THROTTLE">Reduce the speed</option>
                        <option value="DISCONNECT">Disconnect until the next period</option>
                      </Select>
                    </Field>
                    {fupAction === "THROTTLE" ? (
                      <Field id="plan-fup-rate" label="Reduced speed" error={err("fupRate")} hint="Upload/download, e.g. 1M/1M.">
                        <Input value={fupRate} onChange={(e) => setFupRate(e.target.value)} placeholder="1M/1M" className="font-mono" spellCheck={false} />
                      </Field>
                    ) : null}
                    <p className="flex gap-2 rounded-md border border-border bg-surface-muted/60 p-3 text-xs text-muted-foreground sm:col-span-3">
                      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      The policy is saved with the plan. Cloudlink applies it automatically once per-customer usage is collected from your routers, which is being added in an upcoming update.
                    </p>
                  </div>
                ) : null}
              </>,
            )
          : null}

        {section(
          "Schedule",
          null,
          <>
            <Switch id="plan-schedule" checked={scheduleEnabled} onChange={setScheduleEnabled} label="Only usable at certain times" description="For example a night plan available 23:00–06:00. New purchases and voucher logins are refused outside the window." />
            {scheduleEnabled ? (
              <div className="space-y-4">
                <div className="grid max-w-md grid-cols-2 gap-3">
                  <Field id="plan-schedule-start" label="From" error={err("schedule")}>
                    <Input type="time" value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} />
                  </Field>
                  <Field id="plan-schedule-end" label="Until">
                    <Input type="time" value={scheduleEnd} onChange={(e) => setScheduleEnd(e.target.value)} />
                  </Field>
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Starting on</p>
                  <ChipToggleGroup
                    label="Days the window starts on"
                    options={DAY_LABELS.map((label, i) => ({ value: i, label }))}
                    selected={(i) => (scheduleDays & (1 << i)) !== 0}
                    onToggle={(i) => setScheduleDays((d) => d ^ (1 << i))}
                  />
                </div>
              </div>
            ) : null}
          </>,
        )}

        {usesRouters
          ? section(
              "Router restriction",
              "Optional. Limit this plan to certain routers. Leave all unticked to allow it everywhere.",
              eligibleRouters.length === 0 ? (
                <p className="text-sm text-muted-foreground">No router has {serviceType === "PPPOE" ? "PPPoE" : "the hotspot"} enabled yet.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Routers this plan is limited to">
                  {eligibleRouters.map((r) => (
                    <label key={r.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-sm hover:bg-surface-muted has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40">
                      <span className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={routerIds.has(r.id)}
                          onChange={(e) =>
                            setRouterIds((s) => {
                              const n = new Set(s);
                              if (e.target.checked) n.add(r.id);
                              else n.delete(r.id);
                              return n;
                            })
                          }
                        />
                        <span className="font-medium">{r.name}</span>
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{r.host}</span>
                    </label>
                  ))}
                  {err("routers") ? <p className="text-xs font-medium text-danger sm:col-span-2">{err("routers")}</p> : null}
                </div>
              ),
            )
          : null}

        {section(
          "Advanced",
          null,
          <div className="grid gap-4 sm:grid-cols-2">
            {usesRouters ? (
              <Field id="plan-profile" label="Router profile name" error={err("networkProfile")} hint={editing ? "Renaming creates a new profile on the routers; the old one is left in place." : "Leave empty for a stable name based on the plan name."}>
                <Input value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="cl-home-10mbps" className="font-mono" spellCheck={false} autoComplete="off" />
              </Field>
            ) : null}
            <Field id="plan-sort" label="Display order" error={err("sortOrder")} hint="Lower numbers are listed first on the captive portal.">
              <Input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} inputMode="numeric" />
            </Field>
          </div>,
        )}
      </fieldset>

      <div className="sticky bottom-0 z-20 -mx-4 border-t border-border bg-surface/95 backdrop-blur sm:-mx-6 lg:-mx-8">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/packages" className={buttonVariants({ variant: "secondary" })}>
            {readOnly ? "Back to plans" : "Cancel"}
          </Link>
          {!readOnly ? (
            <div className="flex items-center gap-2">
              {editing && canSync ? <PushButton id={initial!.id} /> : null}
              <Button type="submit" loading={pending}>
                {editing ? "Save changes" : "Create plan"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function PushButton({ id }: { id: string }) {
  const { mutate, pending } = useMutation();
  return (
    <Button type="button" variant="secondary" loading={pending} onClick={() => void mutate(`/packages/${id}/sync`, { method: "POST" }, { success: "Profile push queued" })}>
      Push to routers
    </Button>
  );
}
