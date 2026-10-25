"use client";

import * as React from "react";
import Link from "next/link";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { useMutation } from "@/components/use-mutation";

interface Preview {
  jobId: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  errors: Array<{ row: number; field: string; message: string }>;
  unknownColumns: string[];
  sample: Array<{ row: number; name: string | null; phone: string; email: string | null }>;
  canCommit: boolean;
}

const MAX_BYTES = 2_000_000;

export function ImportWizard() {
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [committed, setCommitted] = React.useState<number | null>(null);
  const upload = useMutation<Preview>();
  const commit = useMutation<{ created: number }>();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setPreview(null);
    setCommitted(null);
    setFileError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) return setFileError("The file is larger than 2 MB.");
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return setFileError("Choose a .csv file.");
    const content = await file.text();
    const result = await upload.mutate("/subscribers/imports", { method: "POST", body: { fileName: file.name, content } }, { refresh: false });
    if (result) setPreview(result);
    e.target.value = "";
  };

  const onCommit = async () => {
    if (!preview) return;
    const result = await commit.mutate(`/subscribers/imports/${preview.jobId}/commit`, { method: "POST", body: {} }, { success: "Import committed" });
    if (result) {
      setCommitted(result.created);
      setPreview(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. Upload and validate</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border-strong px-6 py-10 text-center hover:border-accent hover:bg-accent-soft/40">
          <FileUp className="size-6 text-accent" aria-hidden />
          <span className="text-sm font-medium">{upload.pending ? "Validating…" : "Choose a CSV file"}</span>
          <span className="text-xs text-muted-foreground">Nothing is imported until you commit</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} disabled={upload.pending} />
        </label>
        {fileError ? <Alert tone="danger">{fileError}</Alert> : null}
        {upload.formError ? <Alert tone="danger">{upload.formError}</Alert> : null}
        {committed !== null ? (
          <Alert tone="success" title={`${committed} subscriber${committed === 1 ? "" : "s"} imported`}>
            <Link href="/subscribers" className="font-medium text-accent hover:underline">
              View subscribers
            </Link>
          </Alert>
        ) : null}

        {preview ? (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">2. Review</h3>
            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat label="Rows" value={preview.totalRows} />
              <Stat label="Ready" value={preview.validRows} tone="success" />
              <Stat label="With errors" value={preview.errorRows} tone={preview.errorRows ? "danger" : undefined} />
            </div>
            {preview.unknownColumns.length ? <Alert tone="warning">Ignored unknown columns: {preview.unknownColumns.join(", ")}</Alert> : null}
            {preview.errors.length ? (
              <div className="rounded-md border border-border">
                <Table>
                  <THead>
                    <tr>
                      <Th>Row</Th>
                      <Th>Field</Th>
                      <Th>Problem</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {preview.errors.map((err, i) => (
                      <Tr key={i}>
                        <Td label="Row" className="tabular">
                          {err.row}
                        </Td>
                        <Td label="Field" className="font-mono text-xs">
                          {err.field}
                        </Td>
                        <Td label="Problem">{err.message}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : (
              <div className="rounded-md border border-border">
                <Table>
                  <THead>
                    <tr>
                      <Th>Row</Th>
                      <Th>Name</Th>
                      <Th>Phone</Th>
                      <Th>Email</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {preview.sample.map((r) => (
                      <Tr key={r.row}>
                        <Td label="Row">{r.row}</Td>
                        <Td label="Name">{r.name}</Td>
                        <Td label="Phone">{r.phone}</Td>
                        <Td label="Email">{r.email ?? "—"}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
                {preview.validRows > preview.sample.length ? <p className="px-4 py-2 text-xs text-muted-foreground">Showing the first {preview.sample.length} of {preview.validRows} rows.</p> : null}
              </div>
            )}
            <h3 className="text-sm font-semibold">3. Commit</h3>
            {commit.formError ? <Alert tone="danger">{commit.formError}</Alert> : null}
            {preview.canCommit ? (
              <Button onClick={onCommit} loading={commit.pending}>
                Import {preview.validRows} subscriber{preview.validRows === 1 ? "" : "s"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Fix the rows listed above in your file and upload it again. Commit is disabled while any row has errors.</p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted/50 px-3 py-2">
      <p className={`tabular text-xl font-semibold ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : ""}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
