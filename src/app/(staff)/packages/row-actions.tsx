"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { RowMenu, type MenuItem } from "@/components/ui/menu";
import { useMutation } from "@/components/use-mutation";
import type { Availability } from "@/lib/plans";

type Confirm = { title: string; body: string; label: string; tone: "primary" | "danger"; run: () => Promise<unknown> };

export function PlanRowActions({ id, name, availability, canWrite, canSync }: { id: string; name: string; availability: Availability; canWrite: boolean; canSync: boolean }) {
  const router = useRouter();
  const { mutate, pending } = useMutation<{ id: string; queued?: number }>();
  const [confirm, setConfirm] = React.useState<Confirm | null>(null);

  const setAvailability = (to: "LIVE" | "HIDDEN" | "OFF") =>
    mutate(`/packages/${id}`, { method: "PATCH", body: { availability: to } }, { success: to === "LIVE" ? "Plan is live" : to === "HIDDEN" ? "Plan hidden from customers" : "Plan turned off" });

  const items: MenuItem[] = [];
  if (availability !== "ARCHIVED") items.push({ label: canWrite ? "Edit plan" : "View plan", href: `/packages/${id}` });
  if (canWrite && availability !== "ARCHIVED") {
    items.push({
      label: "Duplicate",
      onSelect: () => void mutate(`/packages/${id}/duplicate`, { method: "POST" }, { success: "Copy created (Off)", refresh: false, onSuccess: (copy) => router.push(`/packages/${copy.id}`) }),
    });
    if (availability !== "LIVE") items.push({ label: "Make live", onSelect: () => void setAvailability("LIVE"), separated: true });
    if (availability !== "HIDDEN") items.push({ label: "Hide from customers", onSelect: () => void setAvailability("HIDDEN"), separated: availability === "LIVE" });
    if (availability !== "OFF") items.push({ label: "Turn off", onSelect: () => void setAvailability("OFF") });
  }
  if (canSync && availability !== "ARCHIVED") {
    items.push({
      label: "Push to routers",
      separated: true,
      onSelect: () =>
        setConfirm({
          title: "Push plan to routers",
          body: `Cloudlink creates or updates the router profile for ${name} (speed, burst and devices) on every router that uses it, then reads it back. Results appear under Network sessions → Operations.`,
          label: "Push now",
          tone: "primary",
          run: () => mutate(`/packages/${id}/sync`, { method: "POST" }, { success: "Profile push queued" }),
        }),
    });
  }
  if (canWrite && availability !== "ARCHIVED") {
    items.push({
      label: "Archive",
      tone: "danger",
      separated: true,
      onSelect: () =>
        setConfirm({
          title: "Archive plan",
          body: `${name} will no longer be sold or listed. Plans with live subscriptions cannot be archived. Records that refer to it keep working.`,
          label: "Archive",
          tone: "danger",
          run: () => mutate(`/packages/${id}`, { method: "PATCH", body: { status: "ARCHIVED" } }, { success: "Plan archived" }),
        }),
    });
  }
  if (canWrite && availability === "ARCHIVED") items.push({ label: "Restore (Off)", onSelect: () => void mutate(`/packages/${id}`, { method: "PATCH", body: { status: "INACTIVE" } }, { success: "Plan restored as Off" }) });

  return (
    <>
      <RowMenu items={items} label={`Actions for ${name}`} />
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        {confirm ? (
          <DialogContent title={confirm.title} description={name}>
            <p className="text-sm text-muted-foreground">{confirm.body}</p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={confirm.tone === "danger" ? "danger" : "primary"}
                loading={pending}
                onClick={async () => {
                  const done = await confirm.run();
                  if (done !== undefined) setConfirm(null);
                }}
              >
                {confirm.label}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
