import { SignJWT, importPKCS8 } from "jose";

/**
 * Read-only access to Google Sheets, as a service account.
 *
 * GOOGLE_SERVICE_ACCOUNT_JSON holds the whole key file Google hands out. The
 * account sees only the sheets someone has shared with its client_email, and
 * only as Viewer — that sharing IS the permission model, so there is nothing
 * to configure here beyond the key.
 *
 * No googleapis dependency: the token exchange is one signed JWT and the two
 * endpoints we call are plain GETs.
 */

type ServiceAccount = { client_email: string; private_key: string };

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  // Only for finding a month's file by name; reading goes through Sheets.
  "https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const sa = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }
  return sa as ServiceAccount;
}

export function googleClientEmail(): string | null {
  try {
    return serviceAccount().client_email;
  } catch {
    return null;
  }
}

async function accessToken(): Promise<string> {
  const sa = serviceAccount();
  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: SCOPES })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; error_description?: string; error?: string }
    | null;
  if (!body?.access_token) {
    throw new Error(`Google sign-in failed: ${body?.error_description ?? body?.error ?? res.status}`);
  }
  return body.access_token;
}

async function googleGet<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!res.ok || !body) {
    throw new Error(`Google ${res.status}: ${body?.error?.message ?? res.statusText}`);
  }
  return body;
}

export type DriveFile = { id: string; name: string; modifiedTime: string };

/** A session holding one token, for the handful of calls one run makes. */
export async function googleSheets() {
  const token = await accessToken();
  return {
    /**
     * Native Google Sheets visible to the service account whose name contains
     * every word given, newest first. An .xlsx sitting in Drive is not a Google
     * Sheet and is deliberately not returned — the Sheets API can't read it.
     */
    async findSpreadsheets(words: string[]): Promise<DriveFile[]> {
      const q = [
        "mimeType = 'application/vnd.google-apps.spreadsheet'",
        "trashed = false",
        ...words.map((w) => `name contains '${w.replace(/['\\]/g, "\\$&")}'`),
      ].join(" and ");
      const url =
        "https://www.googleapis.com/drive/v3/files?" +
        new URLSearchParams({
          q,
          fields: "files(id,name,modifiedTime)",
          orderBy: "modifiedTime desc",
          pageSize: "20",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
      const body = await googleGet<{ files?: DriveFile[] }>(token, url);
      return body.files ?? [];
    },

    /**
     * One tab as the grid of what each cell displays. Displayed text rather
     * than raw values on purpose: the date column mixes real dates and typed
     * text, and what's on screen is the one form both agree on.
     */
    async readTab(spreadsheetId: string, tab: string): Promise<string[][]> {
      const range = `'${tab.replace(/'/g, "''")}'`;
      const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
        `/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
      const body = await googleGet<{ values?: unknown[][] }>(token, url);
      return (body.values ?? []).map((row) => row.map((c) => (c == null ? "" : String(c))));
    },
  };
}
