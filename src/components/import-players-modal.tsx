"use client";

import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Upload,
  AlertCircle,
  Sparkles,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { COMPANIES } from "@/lib/mock-data";
import { useStore, type ImportedPlayerInput } from "@/lib/store";
import { BANKS, type BankName } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type ParsedRow = {
  rowIndex: number;
  raw: Record<string, string>;
  data?: ImportedPlayerInput;
  error?: string;
};

const REQUIRED_COLS = [
  "full_name",
  "username",
  "telegram_username",
  "company_id",
] as const;

const SAMPLE_CSV = `full_name,username,telegram_username,contact_number,wechat_id,company_id,bank_name,bank_account_number,bank_account_holder
Tan Hong Ming,thm_tan,@thm_tan,+60 12-555 0011,thmtan_wx,1,Maybank,5128 4471 9023,Tan Hong Ming
Nurul Aisyah,nurul_a,@nurul_a,+60 19-700 4422,,2,CIMB,7042 1188 5530,Nurul Aisyah
Vikram Pillai,vik_pillai,@vik_pillai,,vikpillai88,3,,,
Chloe Ng,chloe_ng,@chloeng,+60 16-880 9912,chloeng_wx,4,Public Bank,4-9112-7733-08,Chloe Ng
Mohd Hafiz,hafiz_m,@hafiz_m,+60 13-220 7766,,5,Hong Leong,381 5577 0023,Mohd Hafiz`;

function parseCSV(text: string): ParsedRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const validCompanyIds = new Set(COMPANIES.map((c) => c.company_id));

  return lines.slice(1).map((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => {
      raw[h] = cells[idx] ?? "";
    });

    const row: ParsedRow = { rowIndex: i + 2, raw };

    for (const col of REQUIRED_COLS) {
      if (!raw[col]) {
        row.error = `Missing "${col}"`;
        return row;
      }
    }

    const companyId = Number(raw.company_id);
    if (!validCompanyIds.has(companyId)) {
      row.error = `Unknown company_id "${raw.company_id}"`;
      return row;
    }

    let bankName: BankName | undefined;
    if (raw.bank_name) {
      const matched = BANKS.find(
        (b) => b.toLowerCase() === raw.bank_name.toLowerCase(),
      );
      if (!matched) {
        row.error = `Unknown bank_name "${raw.bank_name}"`;
        return row;
      }
      bankName = matched;
    }

    const acctNum = raw.bank_account_number?.trim();
    const bankAccounts =
      bankName && acctNum
        ? [
            {
              bank_name: bankName,
              account_number: acctNum,
              account_holder: raw.bank_account_holder || raw.full_name,
            },
          ]
        : undefined;

    row.data = {
      full_name: raw.full_name,
      username: raw.username,
      telegram_username: raw.telegram_username.startsWith("@")
        ? raw.telegram_username
        : `@${raw.telegram_username}`,
      contact_number: raw.contact_number || undefined,
      wechat_id: raw.wechat_id || undefined,
      company_id: companyId,
      bank_accounts: bankAccounts,
    };
    return row;
  });
}

export function ImportPlayersModal({ open, onOpenChange }: Props) {
  const importPlayers = useStore((s) => s.importPlayers);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [phase, setPhase] = useState<"input" | "importing" | "done">("input");
  const [progress, setProgress] = useState(0);
  const [importedCount, setImportedCount] = useState(0);

  const parsed = useMemo(() => parseCSV(csvText), [csvText]);
  const validRows = parsed.filter((r) => r.data);
  const errorRows = parsed.filter((r) => r.error);

  function reset() {
    setCsvText("");
    setFileName(null);
    setPhase("input");
    setProgress(0);
    setImportedCount(0);
  }

  function handleFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  function handleImport() {
    if (validRows.length === 0) return;
    setPhase("importing");
    setProgress(0);

    const TOTAL_MS = 1400;
    const started = Date.now();
    const interval = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - started) / TOTAL_MS) * 100);
      setProgress(pct);
      if (pct >= 100) clearInterval(interval);
    }, 40);

    setTimeout(() => {
      const created = importPlayers(validRows.map((r) => r.data!));
      setImportedCount(created.length);
      setPhase("done");
      toast.success(
        `Imported ${created.length} player${created.length === 1 ? "" : "s"}`,
      );
    }, TOTAL_MS);
  }

  function handleClose(o: boolean) {
    if (!o) {
      onOpenChange(false);
      setTimeout(reset, 200);
    } else {
      onOpenChange(true);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">Import players</DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Upload className="h-4.5 w-4.5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold leading-tight">
              Import players
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Required: full_name, username, telegram_username, company_id ·
              Optional: contact_number, wechat_id, bank_name,
              bank_account_number, bank_account_holder · For multiple banks or
              game accounts, use the Create Player form
            </p>
          </div>
        </div>

        {phase === "input" && (
          <div className="space-y-3 p-5">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="cursor-pointer"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Choose CSV file
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCsvText(SAMPLE_CSV);
                  setFileName("sample-players.csv");
                }}
                className="cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Use sample CSV
              </Button>
              {fileName && (
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-[11px]">
                  {fileName}
                  <button
                    onClick={() => {
                      setCsvText("");
                      setFileName(null);
                    }}
                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label="Clear file"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>

            <textarea
              value={csvText}
              onChange={(e) => {
                setCsvText(e.target.value);
                if (fileName) setFileName(null);
              }}
              placeholder="full_name,username,telegram_username,contact_number,wechat_id,company_id,bank_name,bank_account_number,bank_account_holder&#10;Lim Ah Kow,lim_ak,@lim_ak,+60 12-345 6789,,1,Maybank,5128 4471 9023,Lim Ah Kow"
              spellCheck={false}
              className="w-full h-36 rounded-md border border-input bg-background px-3 py-2 text-[12px] font-mono outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 resize-none"
            />

            {parsed.length > 0 && (
              <div className="rounded-md border bg-card overflow-hidden">
                <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2 text-[11px]">
                  <span className="font-medium">
                    Preview · {validRows.length} valid
                    {errorRows.length > 0 && (
                      <span className="text-rose-600">
                        {" "}
                        · {errorRows.length} error
                        {errorRows.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    Showing first {Math.min(parsed.length, 5)} of {parsed.length}
                  </span>
                </div>
                <div className="max-h-48 overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-muted/20 text-muted-foreground sticky top-0">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-medium w-8">
                          #
                        </th>
                        <th className="px-2 py-1.5 text-left font-medium">
                          Name
                        </th>
                        <th className="px-2 py-1.5 text-left font-medium">
                          Username
                        </th>
                        <th className="px-2 py-1.5 text-left font-medium">
                          Telegram
                        </th>
                        <th className="px-2 py-1.5 text-left font-medium">
                          Company
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.map((row) => {
                        const company = COMPANIES.find(
                          (c) => c.company_id === row.data?.company_id,
                        );
                        return (
                          <tr
                            key={row.rowIndex}
                            className={cn(
                              "border-t",
                              row.error
                                ? "bg-rose-50/60 text-rose-700"
                                : "hover:bg-muted/20",
                            )}
                          >
                            <td className="px-2 py-1.5 text-muted-foreground tabular-nums">
                              {row.rowIndex}
                            </td>
                            {row.error ? (
                              <td colSpan={4} className="px-2 py-1.5">
                                <span className="inline-flex items-center gap-1">
                                  <AlertCircle className="h-3 w-3" />
                                  {row.error}
                                  <span className="text-rose-500/70">
                                    · {Object.values(row.raw).join(", ")}
                                  </span>
                                </span>
                              </td>
                            ) : (
                              <>
                                <td className="px-2 py-1.5">
                                  {row.data!.full_name}
                                </td>
                                <td className="px-2 py-1.5">
                                  @{row.data!.username}
                                </td>
                                <td className="px-2 py-1.5 text-muted-foreground">
                                  {row.data!.telegram_username}
                                </td>
                                <td className="px-2 py-1.5 text-muted-foreground">
                                  {company?.company_name ?? "—"}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {phase === "importing" && (
          <div className="space-y-5 p-8 text-center">
            <div className="relative mx-auto h-16 w-16">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
                className="absolute inset-0 rounded-full border-4 border-primary/10 border-t-primary"
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <Upload className="h-6 w-6 text-primary" />
              </div>
            </div>
            <div>
              <h3 className="text-base font-semibold">
                Importing {validRows.length} player
                {validRows.length === 1 ? "" : "s"}…
              </h3>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Validating and adding to your CRM
              </p>
            </div>
            <div className="mx-auto max-w-sm">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ ease: "easeOut" }}
                  className="h-full bg-gradient-to-r from-primary to-primary/70"
                />
              </div>
              <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                <span>
                  <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                  Writing to CRM
                </span>
                <span className="font-mono">{Math.round(progress)}%</span>
              </div>
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="space-y-4 p-8 text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", damping: 12, stiffness: 220 }}
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600"
            >
              <CheckCircle2 className="h-8 w-8" />
            </motion.div>
            <div>
              <h3 className="text-lg font-semibold">
                {importedCount} player{importedCount === 1 ? "" : "s"} imported
              </h3>
              <p className="mt-1 text-[12px] text-muted-foreground">
                They&apos;re now visible in the players list
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
          {phase === "done" ? (
            <Button onClick={() => handleClose(false)} className="cursor-pointer">
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => handleClose(false)}
                disabled={phase === "importing"}
                className="cursor-pointer"
              >
                Cancel
              </Button>
              <Button
                onClick={handleImport}
                disabled={validRows.length === 0 || phase === "importing"}
                className="cursor-pointer"
              >
                <Upload className="h-3.5 w-3.5" />
                Import {validRows.length > 0 ? validRows.length : ""} player
                {validRows.length === 1 ? "" : "s"}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
