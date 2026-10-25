import { ShieldAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";

export function Forbidden({ what = "this page" }: { what?: string }) {
  return (
    <Card>
      <EmptyState icon={ShieldAlert} title="Access restricted" description={`Your role does not include permission to view ${what}. Ask an administrator if you need access.`} />
    </Card>
  );
}
