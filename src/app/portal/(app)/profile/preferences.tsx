"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useMutation } from "@/components/use-mutation";

type Pref = { category: "billing" | "service" | "support" | "marketing"; channel: "SMS" | "EMAIL"; enabled: boolean };

const LABEL: Record<Pref["category"], string> = {
  billing: "Invoices and payment confirmations",
  service: "Service reminders and notices (e.g. expiry, maintenance)",
  support: "Support ticket updates",
  marketing: "Offers and promotions (only if you tick this)",
};

export function PreferencesForm({ initial, hasEmail }: { initial: Pref[]; hasEmail: boolean }) {
  const [prefs, setPrefs] = React.useState(initial);
  const { mutate, pending } = useMutation();
  const toggle = (p: Pref) => setPrefs((all) => all.map((x) => (x.category === p.category && x.channel === p.channel ? { ...x, enabled: !x.enabled } : x)));
  const channels: Array<Pref["channel"]> = hasEmail ? ["SMS", "EMAIL"] : ["SMS"];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void mutate("/customer/preferences", { method: "PUT", body: { preferences: prefs } }, { success: "Preferences saved" });
      }}
      className="space-y-3"
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 font-medium">Message type</th>
            {channels.map((c) => (
              <th key={c} className="py-1 text-center font-medium">
                {c === "SMS" ? "SMS" : "Email"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(["billing", "service", "support", "marketing"] as const).map((cat) => (
            <tr key={cat} className="border-t border-border">
              <td className="py-2">{LABEL[cat]}</td>
              {channels.map((ch) => {
                const p = prefs.find((x) => x.category === cat && x.channel === ch)!;
                return (
                  <td key={ch} className="py-2 text-center">
                    <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} aria-label={`${LABEL[cat]} by ${ch === "SMS" ? "SMS" : "email"}`} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Button type="submit" variant="secondary" loading={pending}>
        Save preferences
      </Button>
    </form>
  );
}
