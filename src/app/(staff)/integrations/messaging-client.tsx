"use client";

import * as React from "react";
import { CheckCircle2, Coins, KeyRound, Mail, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";
import { formatMoney } from "@/lib/utils";

interface SmsCurrent {
  provider: string;
  username: string;
  senderId: string;
  accountSid: string;
  from: string;
  enabled: boolean;
  credentialsSet: boolean;
}

export function SmsSettingsDialog({ current }: { current: SmsCurrent }) {
  const [open, setOpen] = React.useState(false);
  const [provider, setProvider] = React.useState(current.provider);
  const { mutate, pending, errors, formError } = useMutation();
  const keepSecret = current.credentialsSet && provider === current.provider;
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body =
      provider === "africastalking"
        ? { provider, username: v.username ?? "", senderId: v.senderId ?? "", enabled: v.enabled === "on", ...(v.apiKey ? { apiKey: v.apiKey } : {}) }
        : { provider, accountSid: v.accountSid ?? "", from: v.from ?? "", enabled: v.enabled === "on", ...(v.authToken ? { authToken: v.authToken } : {}) };
    const ok = await mutate("/integrations/messaging/sms", { method: "PUT", body }, { success: "SMS provider saved" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <KeyRound /> {current.credentialsSet ? "Change SMS provider" : "Set up SMS"}
        </Button>
      </DialogTrigger>
      <DialogContent title="SMS provider" description="Messages to subscribers (invoices, receipts, reminders, vouchers) are sent through this account." wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id="sms-provider" label="Provider">
            <Select name="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="africastalking">Africa&apos;s Talking</option>
              <option value="twilio">Twilio</option>
            </Select>
          </Field>
          {provider === "africastalking" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="sms-user" label="Username" hint="Your Africa's Talking app username (“sandbox” for testing)." error={errors.username} required>
                <Input name="username" defaultValue={current.provider === "africastalking" ? current.username : ""} autoComplete="off" spellCheck={false} />
              </Field>
              <Field id="sms-sender" label="Sender ID (optional)" hint="Approved alphanumeric sender, up to 11 characters." error={errors.senderId}>
                <Input name="senderId" defaultValue={current.provider === "africastalking" ? current.senderId : ""} maxLength={11} autoComplete="off" />
              </Field>
              <Field id="sms-key" label="API key" hint={keepSecret ? "Leave empty to keep the saved key." : undefined} error={errors.apiKey} required={!keepSecret} className="sm:col-span-2">
                <Input name="apiKey" type="password" autoComplete="new-password" placeholder={keepSecret ? "••••••••" : ""} />
              </Field>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="sms-sid" label="Account SID" error={errors.accountSid} required>
                <Input name="accountSid" defaultValue={current.provider === "twilio" ? current.accountSid : ""} placeholder="AC…" autoComplete="off" spellCheck={false} />
              </Field>
              <Field id="sms-from" label="From" hint="A Twilio number (+…), a messaging service SID (MG…) or a sender ID." error={errors.from} required>
                <Input name="from" defaultValue={current.provider === "twilio" ? current.from : ""} autoComplete="off" spellCheck={false} />
              </Field>
              <Field id="sms-token" label="Auth token" hint={keepSecret ? "Leave empty to keep the saved token." : undefined} error={errors.authToken} required={!keepSecret} className="sm:col-span-2">
                <Input name="authToken" type="password" autoComplete="new-password" placeholder={keepSecret ? "••••••••" : ""} />
              </Field>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked={current.enabled} /> Use this provider for this organization&apos;s SMS
          </label>
          <p className="text-xs text-muted-foreground">Saving new credentials or a new sender resets verification: send a test and confirm it arrived.</p>
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

interface EmailCurrent {
  host: string;
  port: number;
  security: string;
  username: string;
  fromAddress: string;
  fromName: string;
  enabled: boolean;
  passwordSet: boolean;
}

export function EmailSettingsDialog({ current }: { current: EmailCurrent }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = { host: v.host ?? "", port: v.port ?? "", security: v.security, username: v.username ?? "", fromAddress: v.fromAddress ?? "", fromName: v.fromName ?? "", enabled: v.enabled === "on", ...(v.password ? { password: v.password } : {}) };
    const ok = await mutate("/integrations/messaging/email", { method: "PUT", body }, { success: "Email server saved" });
    if (ok) setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Mail /> {current.host ? "Change email server" : "Set up email"}
        </Button>
      </DialogTrigger>
      <DialogContent title="Email (SMTP) server" description="Invoices, receipts and portal invites are emailed through this server." wide>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="smtp-host" label="Server" error={errors.host} required>
              <Input name="host" defaultValue={current.host} placeholder="smtp.example.com" autoComplete="off" spellCheck={false} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="smtp-port" label="Port" error={errors.port} required>
                <Input name="port" inputMode="numeric" defaultValue={current.port} />
              </Field>
              <Field id="smtp-security" label="Encryption" error={errors.security}>
                <Select name="security" defaultValue={current.security}>
                  <option value="starttls">STARTTLS (587)</option>
                  <option value="ssl">SSL/TLS (465)</option>
                  <option value="none">None (testing only)</option>
                </Select>
              </Field>
            </div>
            <Field id="smtp-user" label="Username" hint="Leave empty if the server does not need a login." error={errors.username}>
              <Input name="username" defaultValue={current.username} autoComplete="off" spellCheck={false} />
            </Field>
            <Field id="smtp-pass" label="Password" hint={current.passwordSet ? "Leave empty to keep the saved password." : undefined} error={errors.password}>
              <Input name="password" type="password" autoComplete="new-password" placeholder={current.passwordSet ? "••••••••" : ""} />
            </Field>
            <Field id="smtp-from" label="From address" error={errors.fromAddress} required>
              <Input name="fromAddress" type="email" defaultValue={current.fromAddress} placeholder="billing@yourisp.co.ke" />
            </Field>
            <Field id="smtp-name" label="From name (optional)" error={errors.fromName}>
              <Input name="fromName" defaultValue={current.fromName} placeholder="Your ISP" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked={current.enabled} /> Use this server for this organization&apos;s email
          </label>
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

export function TestMessageDialog({ channel }: { channel: "SMS" | "EMAIL" }) {
  const [open, setOpen] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation<{ accepted: boolean; simulated: boolean; error: string | null }>();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const r = await mutate("/integrations/messaging/test", { method: "POST", body: { channel, to: v.to ?? "" } });
    if (r) {
      if (r.accepted) toast.success(r.simulated ? "Simulated: the mock adapter did not send anything." : "Accepted by the provider. Check it arrived, then mark it received.");
      else toast.error(`Not accepted: ${r.error ?? "unknown error"}`);
      setOpen(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Send /> Send test {channel === "SMS" ? "SMS" : "email"}
        </Button>
      </DialogTrigger>
      <DialogContent title={`Send a test ${channel === "SMS" ? "SMS" : "email"}`} description="Sent immediately through the provider in use. Use your own number or address.">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <Field id={`test-to-${channel}`} label={channel === "SMS" ? "Phone number" : "Email address"} error={errors.to} required>
            <Input name="to" type={channel === "SMS" ? "tel" : "email"} placeholder={channel === "SMS" ? "0712 345 678" : "you@example.com"} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmReceivedButton({ channel }: { channel: "SMS" | "EMAIL" }) {
  const { mutate, pending } = useMutation();
  return (
    <Button variant="secondary" loading={pending} onClick={() => mutate("/integrations/messaging/confirm", { method: "POST", body: { channel } }, { success: "Marked as received: provider verified" })}>
      <CheckCircle2 /> I received the test
    </Button>
  );
}

export function BalanceButton() {
  const { mutate, pending } = useMutation<{ amount: string; currency: string }>();
  return (
    <Button variant="secondary" loading={pending} onClick={() => mutate("/integrations/messaging/balance", { method: "POST" }, { onSuccess: (b) => toast.success(`SMS balance: ${formatMoney(b.amount, b.currency)}`) })}>
      <Coins /> Check SMS balance
    </Button>
  );
}
