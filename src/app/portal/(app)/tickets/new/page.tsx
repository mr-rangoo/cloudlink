"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { formValues, useMutation } from "@/components/use-mutation";

export default function NewPortalTicket() {
  const router = useRouter();
  const { mutate, pending, errors, formError } = useMutation<{ id: string }>();
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const res = await mutate("/customer/tickets", { method: "POST", body: { subject: v.subject, description: v.description, category: v.category } }, { success: "Request sent", refresh: false });
    if (res) router.push(`/portal/tickets/${res.id}`);
  };
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">New support request</h1>
      <Card>
        <CardContent className="pt-4">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {formError ? <Alert tone="danger">{formError}</Alert> : null}
            <Field id="cat" label="What is it about?">
              <Select name="category" defaultValue="CONNECTIVITY">
                <option value="CONNECTIVITY">Internet not working / slow</option>
                <option value="BILLING">Bill or payment</option>
                <option value="EQUIPMENT">Router or equipment</option>
                <option value="INSTALLATION">Installation or relocation</option>
                <option value="ACCOUNT">My account</option>
                <option value="OTHER">Something else</option>
              </Select>
            </Field>
            <Field id="subject" label="Subject" error={errors.subject} required>
              <Input name="subject" maxLength={160} />
            </Field>
            <Field id="description" label="Describe the problem" error={errors.description} required hint="Include when it started and what you have tried">
              <Textarea name="description" rows={5} maxLength={5000} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button type="submit" loading={pending}>
                Send request
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
