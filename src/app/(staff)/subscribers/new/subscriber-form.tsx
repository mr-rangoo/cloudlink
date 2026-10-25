"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";
import { ApiError } from "@/lib/api-client";

interface Props {
  packages: Array<{ id: string; label: string }>;
  branches: Array<{ id: string; name: string; code: string }>;
  defaultBranchId: string | null;
  branchRequired: boolean;
  canSubscribe: boolean;
}

export function SubscriberForm({ packages, branches, defaultBranchId, branchRequired, canSubscribe }: Props) {
  const router = useRouter();
  const [type, setType] = React.useState<"INDIVIDUAL" | "BUSINESS">("INDIVIDUAL");
  const [allowDuplicate, setAllowDuplicate] = React.useState(false);
  const [duplicateWarning, setDuplicateWarning] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const { mutate, pending, errors, formError } = useMutation<{ subscriber: { id: string; accountNumber: string } }>();

  React.useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    setDuplicateWarning(null);
    const result = await mutate(
      "/subscribers",
      {
        method: "POST",
        body: {
          type,
          firstName: v.firstName ?? null,
          lastName: v.lastName ?? null,
          companyName: v.companyName ?? null,
          phone: v.phone ?? "",
          altPhone: v.altPhone ?? null,
          email: v.email ?? null,
          idNumber: v.idNumber ?? null,
          notes: v.notes ?? null,
          branchId: v.branchId ?? null,
          address: v.line1 ? { line1: v.line1, area: v.area ?? null, town: v.town ?? null, county: v.county ?? null } : null,
          packageId: v.packageId ?? null,
          activateSubscription: v.activate === "on",
          allowDuplicateContact: allowDuplicate,
        },
      },
      {
        refresh: false,
        onError: (err) => {
          if (err instanceof ApiError && err.code === "CONFLICT") {
            setDuplicateWarning(err.message);
            return true;
          }
        },
      },
    );
    if (result) {
      setDirty(false);
      router.push(`/subscribers/${result.subscriber.id}?created=1`);
    }
  };

  return (
    <form onSubmit={onSubmit} onChange={() => setDirty(true)} className="space-y-5" noValidate>
      {formError && !duplicateWarning ? <Alert tone="danger">{formError}</Alert> : null}
      {duplicateWarning ? (
        <Alert tone="warning" title="Possible duplicate">
          <p>{duplicateWarning}</p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} />
            This is a different customer — create anyway (recorded in the audit log)
          </label>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-sm font-medium">Account type</legend>
            <div className="flex gap-2">
              {(["INDIVIDUAL", "BUSINESS"] as const).map((t) => (
                <label key={t} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${type === t ? "border-accent bg-accent-soft text-accent" : "border-border"}`}>
                  <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} className="sr-only" />
                  {t === "INDIVIDUAL" ? "Individual" : "Business"}
                </label>
              ))}
            </div>
          </fieldset>
          {type === "BUSINESS" ? (
            <Field id="companyName" label="Company name" error={errors.companyName} required className="sm:col-span-2">
              <Input name="companyName" autoComplete="organization" />
            </Field>
          ) : null}
          <Field id="firstName" label={type === "BUSINESS" ? "Contact first name" : "First name"} error={errors.firstName} required={type === "INDIVIDUAL"}>
            <Input name="firstName" autoComplete="given-name" />
          </Field>
          <Field id="lastName" label={type === "BUSINESS" ? "Contact last name" : "Last name"} error={errors.lastName}>
            <Input name="lastName" autoComplete="family-name" />
          </Field>
          <Field id="phone" label="Phone (M-Pesa)" error={errors.phone} required hint="e.g. 0712 345 678">
            <Input name="phone" type="tel" autoComplete="tel" inputMode="tel" />
          </Field>
          <Field id="altPhone" label="Alternative phone" error={errors.altPhone}>
            <Input name="altPhone" type="tel" inputMode="tel" />
          </Field>
          <Field id="email" label="Email" error={errors.email}>
            <Input name="email" type="email" autoComplete="email" />
          </Field>
          <Field id="idNumber" label={type === "BUSINESS" ? "KRA PIN" : "National ID"} error={errors.idNumber}>
            <Input name="idNumber" />
          </Field>
          <Field id="branchId" label="Branch" error={errors.branchId} required={branchRequired}>
            <Select name="branchId" defaultValue={defaultBranchId ?? ""}>
              {!branchRequired ? <option value="">No branch</option> : <option value="">Select a branch</option>}
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Installation address</CardTitle>
          <CardDescription>Optional. Used by technicians and on invoices.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="line1" label="Street / building" error={errors["address.line1"]} className="sm:col-span-2">
            <Input name="line1" autoComplete="street-address" />
          </Field>
          <Field id="area" label="Area / estate">
            <Input name="area" />
          </Field>
          <Field id="town" label="Town">
            <Input name="town" />
          </Field>
          <Field id="county" label="County">
            <Input name="county" />
          </Field>
        </CardContent>
      </Card>

      {canSubscribe ? (
        <Card>
          <CardHeader>
            <CardTitle>First subscription</CardTitle>
            <CardDescription>Optional. The package price and terms are copied onto the subscription.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field id="packageId" label="Package" error={errors.packageId} className="sm:col-span-2">
              <Select name="packageId" defaultValue="">
                <option value="">No subscription yet</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="activate" defaultChecked className="mt-0.5" />
              <span>
                Activate immediately
                <span className="block text-xs text-muted-foreground">Starts the first billing period now. Network provisioning is not yet connected (shown on the subscriber page).</span>
              </span>
            </label>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-4">
          <Field id="notes" label="Internal notes" error={errors.notes}>
            <Textarea name="notes" rows={3} maxLength={2000} />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Create subscriber
        </Button>
      </div>
    </form>
  );
}
