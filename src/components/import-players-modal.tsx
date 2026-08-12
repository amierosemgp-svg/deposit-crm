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
  Building2,
  Sparkles,
  X,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/lib/store";
import type { PlayerBankAccount, PlayerGameAccount } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Parsed row data — company is assigned from the target company select. */
type RowData = {
  full_name: string;
  username: string;
  telegram_username?: string;
  contact_number?: string;
  wechat_id?: string;
  bank_accounts?: PlayerBankAccount[];
  game_accounts?: PlayerGameAccount[];
};

type ParsedRow = {
  rowIndex: number;
  raw: Record<string, string>;
  data?: RowData;
  error?: string;
};

/**
 * The player's code is labelled "Member Code" throughout the UI. Files written
 * against the older header still import, so a CSV prepared before the rename
 * doesn't silently fail.
 */
const CODE_COLS = ["member_code", "username"] as const;
const REQUIRED_COLS = ["full_name"] as const;

/**
 * A real CSV split: quoted fields, embedded commas, and "" for a literal quote.
 *
 * The naive `line.split(",")` this replaces shifted every column after the
 * first comma inside a name or phone number, so a handful of rows in any real
 * export imported silently wrong — an account number landing in the holder
 * field, and nothing to show it had happened.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  // Excel writes tabs into text-forced columns (phone, account number).
  return cells.map((c) => c.replace(/\t/g, "").trim());
}

const SAMPLE_CSV = `full_name,member_code,telegram_username,contact_number,wechat_id,bank_name,bank_account_number,bank_account_holder,game_accounts
Tan Hong Ming,thm_tan,@thm_tan,+60 12-555 0011,thmtan_wx,Maybank,5128 4471 9023,Tan Hong Ming,Mega888:0905310837
Nurul Aisyah,nurul_a,@nurul_a,+60 19-700 4422,,CIMB,7042 1188 5530,Nurul Aisyah,Mega888:0901141114|Pussy888:8812340
Vikram Pillai,vik_pillai,@vik_pillai,,vikpillai88,,,,
Chloe Ng,chloe_ng,@chloeng,+60 16-880 9912,chloeng_wx,Public Bank,4-9112-7733-08,Chloe Ng,XE88:5540221
Mohd Hafiz,hafiz_m,@hafiz_m,+60 13-220 7766,,Hong Leong,381 5577 0023,Mohd Hafiz,`;

function parseCSV(text: string, banks: string[], games: string[]): ParsedRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());

  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line);
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
    const memberCode = CODE_COLS.map((c) => raw[c]).find(Boolean);
    if (!memberCode) {
      row.error = 'Missing "member_code"';
      return row;
    }

    let bankName: string | undefined;
    if (raw.bank_name) {
      const matched = banks.find(
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

    // One cell carries every game the player holds: "Mega888:0905…|XE88:1234".
    // A column per game would need the header to change every time a provider
    // is added; 453 of these players hold more than one.
    let gameAccounts: PlayerGameAccount[] | undefined;
    if (raw.game_accounts) {
      gameAccounts = [];
      for (const pair of raw.game_accounts.split("|")) {
        if (!pair.trim()) continue;
        const idx = pair.indexOf(":");
        if (idx < 1) {
          row.error = `Bad game_accounts entry "${pair.trim()}" — expected Game:id`;
          return row;
        }
        const gameRaw = pair.slice(0, idx).trim();
        const id = pair.slice(idx + 1).trim();
        const game = games.find((g) => g.toLowerCase() === gameRaw.toLowerCase());
        if (!game) {
          row.error = `Unknown game "${gameRaw}"`;
          return row;
        }
        if (!id) {
          row.error = `Missing id for game "${gameRaw}"`;
          return row;
        }
        gameAccounts.push({ game_name: game, game_username: id });
      }
      if (gameAccounts.length === 0) gameAccounts = undefined;
    }

    row.data = {
      full_name: raw.full_name,
      username: memberCode,
      telegram_username: raw.telegram_username
        ? raw.telegram_username.startsWith("@")
          ? raw.telegram_username
          : `@${raw.telegram_username}`
        : undefined,
      contact_number: raw.contact_number || undefined,
      wechat_id: raw.wechat_id || undefined,
      bank_accounts: bankAccounts,
      game_accounts: gameAccounts,
    };
    return row;
  });
}

export function ImportPlayersModal({ open, onOpenChange }: Props) {
  const importPlayers = useStore((s) => s.importPlayers);
  const companiesFn = useStore((s) => s.companies);
  const banksFn = useStore((s) => s.banks);
  const gamesFn = useStore((s) => s.games);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const companies = companiesFn();
  const banks = banksFn();
  const games = gamesFn();

  const [companyId, setCompanyId] = useState("");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [phase, setPhase] = useState<"input" | "importing" | "done">("input");
  const [progress, setProgress] = useState(0);
  const [importedCount, setImportedCount] = useState(0);

  const parsed = useMemo(
    () => parseCSV(csvText, banks, games),
    [csvText, banks, games],
  );
  const validRows = parsed.filter((r) => r.data);
  const errorRows = parsed.filter((r) => r.error);
  const targetCompany = companies.find(
    (c) => String(c.company_id) === companyId,
  );

  function reset() {
    setCompanyId("");
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

  async function handleImport() {
    if (validRows.length === 0 || !targetCompany) return;
    setPhase("importing");
    setProgress(0);

    // Progress creeps toward 90% while the server call is in flight.
    const started = Date.now();
    const interval = setInterval(() => {
      const pct = Math.min(90, ((Date.now() - started) / 1400) * 90);
      setProgress(pct);
    }, 40);

    const rows = validRows.map((r) => ({
      ...r.data!,
      company_entity_id: targetCompany.company_id,
    }));
    const res = await importPlayers(rows);
    clearInterval(interval);

    if (!res.ok) {
      setPhase("input");
      setProgress(0);
      toast.error(res.error ?? "Import failed — no players were added");
      return;
    }

    setProgress(100);
    setImportedCount(rows.length);
    setPhase("done");
    toast.success(
      `Imported ${rows.length} player${rows.length === 1 ? "" : "s"} into ${targetCompany.company_name}`,
    );
  }

  function handleClose(o: boolean) {
    if (!o) {
      if (phase === "importing") return;
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
              Required: full_name, member_code · Optional: telegram_username,
              contact_number, wechat_id, bank_name, bank_account_number,
              bank_account_holder, game_accounts (Mega888:12345|XE88:67890) ·
              For multiple banks, use the Create Player form
            </p>
          </div>
        </div>

        {phase === "input" && (
          <div className="space-y-3 p-5">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                Target company <span className="text-rose-600 dark:text-rose-400">*</span>
              </Label>
              <Select
                value={companyId}
                onValueChange={(v) => setCompanyId(v ?? "")}
                items={companies.map((c) => ({
                  value: String(c.company_id),
                  label: c.company_name,
                }))}
              >
                <SelectTrigger className="h-8 w-full sm:max-w-xs">
                  <SelectValue placeholder="Select company for all imported players" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.company_id} value={String(c.company_id)}>
                      {c.company_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
              placeholder="full_name,member_code,telegram_username,contact_number,wechat_id,bank_name,bank_account_number,bank_account_holder,game_accounts&#10;Lim Ah Kow,lim_ak,@lim_ak,+60 12-345 6789,,Maybank,5128 4471 9023,Lim Ah Kow,Mega888:0905310837"
              spellCheck={false}
              className="w-full h-36 rounded-md border border-input bg-background px-3 py-2 text-[12px] font-mono outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 resize-none"
            />

            {parsed.length > 0 && (
              <div className="rounded-md border bg-card overflow-hidden">
                <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2 text-[11px]">
                  <span className="font-medium">
                    Preview · {validRows.length} valid
                    {errorRows.length > 0 && (
                      <span className="text-rose-600 dark:text-rose-400">
                        {" "}
                        · {errorRows.length} error
                        {errorRows.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {targetCompany && (
                      <span className="text-muted-foreground">
                        {" "}
                        · into {targetCompany.company_name}
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
                          Member Code
                        </th>
                        <th className="px-2 py-1.5 text-left font-medium">
                          Telegram
                        </th>
                        <th className="px-2 py-1.5 text-left font-medium">
                          Bank
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.map((row) => (
                        <tr
                          key={row.rowIndex}
                          className={cn(
                            "border-t",
                            row.error
                              ? "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300"
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
                                <span className="text-rose-500 dark:text-rose-400/70">
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
                                {row.data!.telegram_username ?? "—"}
                              </td>
                              <td className="px-2 py-1.5 text-muted-foreground">
                                {row.data!.bank_accounts?.[0]?.bank_name ?? "—"}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
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
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
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
                disabled={
                  validRows.length === 0 ||
                  !targetCompany ||
                  phase === "importing"
                }
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
