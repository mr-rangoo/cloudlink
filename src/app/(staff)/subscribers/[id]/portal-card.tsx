"use client";

import * as React from "react";
import { Copy, KeyRound, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/feedback";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { useMutation } from "@/components/use-mutation";

interface Props {
  subscriberId: string;
  status: { status: string; lastLoginAt: string | null; activatedAt: string | null } | null;
  canManage: boolean;
  messagingMock: boolean;
}

export function PortalAccessCard({ subscriberId, status, canManage, messagingMock }: Props) {
  const { mutate, pending } = useMutation<{ link?: string; queued?: number; expiresInHours?: number }>();
  const [link, setLink] = React.useState<string | null>(null);
  const act = (action: "invite" | "link" | "enable" | "disable", success: string) =>
    mutate(`/subscribers/${subscriberId}/portal`, { method: "POST", body: { action } }, { success }).then((r) => {
      if (action === "link" && r?.link) setLink(r.link);
    });

  const state = status?.status ?? "NONE";
  const tone = state === "ACTIVE" ? "success" : state === "INVITED" ? "info" : state === "DISABLED" ? "danger" : "neutral";

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Customer portal</CardTitle>
          <CardDescription>Self-service invoices, receipts and support tickets</CardDescription>
        </div>
        <Badge tone={tone}>{state === "NONE" ? "Not set up" : state.toLowerCase()}</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status?.lastLoginAt ? <p className="text-muted-foreground">Last sign-in {new Date(status.lastLoginAt).toLocaleString("en-KE")}</p> : null}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {state !== "DISABLED" ? (
              <>
                <Button size="sm" variant="secondary" loading={pending} onClick={() => act("invite", "Invite queued")}>
                  <Send /> {state === "ACTIVE" ? "Send password reset" : "Send invite"}
                </Button>
                <Button size="sm" variant="secondary" loading={pending} onClick={() => act("link", "Setup link created")}>
                  <KeyRound /> Create setup link
                </Button>
              </>
            ) : null}
            {state !== "NONE" ? (
              state === "DISABLED" ? (
                <Button size="sm" variant="secondary" loading={pending} onClick={() => act("enable", "Portal access enabled")}>
                  Enable access
                </Button>
              ) : (
                <Button size="sm" variant="ghost" loading={pending} onClick={() => act("disable", "Portal access disabled")}>
                  Disable access
                </Button>
              )
            ) : null}
          </div>
        ) : null}
        {messagingMock ? <p className="text-xs text-warning">Messaging runs in mock mode: invites are recorded as simulated and not delivered. Use “Create setup link” to hand the link over directly.</p> : null}
      </CardContent>
      <Dialog open={link !== null} onOpenChange={(v) => !v && setLink(null)}>
        <DialogContent title="Portal setup link" description="Shown once. It expires in 72 hours and stops working after the customer sets a password.">
          <div className="space-y-3">
            <p className="break-all rounded-md border border-border bg-surface-muted p-3 font-mono text-xs">{link}</p>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link ?? "");
                    toast.success("Link copied");
                  } catch {
                    toast.error("Copy failed; select the link manually.");
                  }
                }}
              >
                <Copy /> Copy link
              </Button>
              <Button onClick={() => setLink(null)}>Done</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
