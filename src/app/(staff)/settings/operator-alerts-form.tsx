"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { useMutation } from "@/components/use-mutation";

interface Recipient {
  channel: "SMS" | "EMAIL";
  to: string;
  label: string;
}

/** Who is told about problems (SMS or email), which events, and when the daily summary goes out. */
export function OperatorAlertsForm({ initial, events }: { initial: { recipients: Array<{ channel: "SMS" | "EMAIL"; to: string; label?: string | null }>; events: string[]; digestHour: number }; events: Array<{ key: string; label: string }> }) {
  const [recipients, setRecipients] = React.useState<Recipient[]>(initial.recipients.map((r) => ({ channel: r.channel, to: r.to, label: r.label ?? "" })));
  const [chosen, setChosen] = React.useState<string[]>(initial.events);
  const [hour, setHour] = React.useState(initial.digestHour);
  const { mutate, pending, formError } = useMutation();
  const update = (i: number, patch: Partial<Recipient>) => setRecipients((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Operator alerts</CardTitle>
        <CardDescription>Text or email the people on duty when something needs attention. Messages go through this organization&apos;s SMS and email providers.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate("/settings/operator-alerts", { method: "PUT", body: { recipients: recipients.filter((r) => r.to.trim()).map((r) => ({ channel: r.channel, to: r.to, label: r.label || null })), events: chosen, digestHour: hour } }, { success: "Operator alerts saved" });
          }}
        >
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Who to tell</legend>
            {recipients.length === 0 ? <p className="text-sm text-muted-foreground">Nobody yet. Add a phone number or email address.</p> : null}
            {recipients.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr_auto]">
                <Select aria-label={`Recipient ${i + 1} channel`} value={r.channel} onChange={(e) => update(i, { channel: e.target.value as Recipient["channel"] })}>
                  <option value="SMS">SMS</option>
                  <option value="EMAIL">Email</option>
                </Select>
                <Input aria-label={`Recipient ${i + 1} ${r.channel === "SMS" ? "phone" : "email"}`} value={r.to} onChange={(e) => update(i, { to: e.target.value })} placeholder={r.channel === "SMS" ? "0712 345 678" : "noc@yourisp.co.ke"} />
                <Input aria-label={`Recipient ${i + 1} name`} value={r.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Name or role (optional)" />
                <Button type="button" variant="ghost" aria-label={`Remove recipient ${i + 1}`} onClick={() => setRecipients((all) => all.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            {recipients.length < 10 ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => setRecipients((all) => [...all, { channel: "SMS", to: "", label: "" }])}>
                <Plus /> Add recipient
              </Button>
            ) : null}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What to tell them</legend>
            {events.map((ev) => (
              <label key={ev.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={chosen.includes(ev.key)} onChange={(e) => setChosen((all) => (e.target.checked ? [...all, ev.key] : all.filter((k) => k !== ev.key)))} />
                {ev.label}
              </label>
            ))}
            <label className="flex flex-wrap items-center gap-2 pl-6 text-sm text-muted-foreground">
              Daily summary at
              <Select aria-label="Daily summary hour" value={String(hour)} onChange={(e) => setHour(Number(e.target.value))} className="h-8 w-28">
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
              (organization time): yesterday&apos;s collections, new subscribers, plans ending tomorrow, routers offline, open tickets.
            </label>
          </fieldset>
          <Button type="submit" loading={pending}>
            Save operator alerts
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
