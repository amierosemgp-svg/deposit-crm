import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
  randomInt,
  type KeyObject,
} from "node:crypto";

/**
 * FlyPay's merchant API (Merchant Integration Guide v1.0.1).
 *
 * Every request is the same envelope: the real parameters as JSON, AES-encrypted
 * into `Data`, and signed (RSA SHA-1, our private key) into `Signature`. FlyPay
 * answers callbacks the same way, signed with its key. There is no endpoint that
 * lists transactions — the only reads are lookups by an id we chose — which is
 * why the CRM has to be the one asking for each payment.
 *
 * FlyPay only accepts calls from whitelisted server IPs, so these must run from
 * an egress address its tech team has on file.
 */

const API_BASE = process.env.FLYPAY_API_BASE ?? "https://mapi.flypay.site";

/** The keys and identity one merchant account signs with. */
export type FlyPayCredentials = {
  merchant_code: string;
  currency: string;
  aes_key: string;
  merchant_private_key: string;
  provider_public_key: string;
};

export type FlyPayMethod = "DNQR" | "OB" | "TNG";

export const FLYPAY_METHODS: Record<FlyPayMethod, string> = {
  DNQR: "DuitNow QR",
  OB: "Online Banking",
  TNG: "Touch 'n Go",
};

/** Deposit Status appendix: 6 and 7 are final, anything else is in flight. */
export const DEPOSIT_SUCCESS = 6;
export const DEPOSIT_FAILED = 7;

/** "Merchant Reference ID (or Payment Transaction ID) is not exist." */
const NOT_FOUND_CODES = new Set(["PMT10016", "PMT10022"]);

export class FlyPayError extends Error {
  constructor(
    message: string,
    /** FlyPay's own error codes (PMT…), when it gave any. */
    public codes: string[] = [],
    /** False when we never got an answer — the request may or may not have landed. */
    public answered = true,
  ) {
    super(message);
  }

  get notFound() {
    return this.codes.some((c) => NOT_FOUND_CODES.has(c));
  }
}

// ---------- AES (section 1.10) ----------

/** PBKDF2-SHA1 of the key, salted with itself, 1000 rounds → AES-256. */
function deriveAesKey(aesKey: string): Buffer {
  return pbkdf2Sync(aesKey, Buffer.from(aesKey, "utf8"), 1000, 32, "sha1");
}

/** AES-256-CBC, random IV prepended to the ciphertext, base64. */
export function aesEncrypt(plainText: string, aesKey: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", deriveAesKey(aesKey), iv);
  return Buffer.concat([iv, cipher.update(plainText, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

export function aesDecrypt(encryptedBase64: string, aesKey: string): string {
  const bytes = Buffer.from(encryptedBase64, "base64");
  const decipher = createDecipheriv("aes-256-cbc", deriveAesKey(aesKey), bytes.subarray(0, 16));
  return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString("utf8");
}

// ---------- RSA SHA-1 (section 1.13) ----------

/**
 * FlyPay trades keys as bare base64 DER (PKCS#8 private, X.509 public), but a
 * key pasted from an email is as likely to arrive as PEM. Accept either.
 */
function readPrivateKey(key: string): KeyObject {
  const k = key.trim();
  if (k.includes("-----BEGIN")) return createPrivateKey(k);
  const der = Buffer.from(k.replace(/\s+/g, ""), "base64");
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    return createPrivateKey({ key: der, format: "der", type: "pkcs1" });
  }
}

export function readPublicKey(key: string): KeyObject {
  const k = key.trim();
  if (k.includes("-----BEGIN")) return createPublicKey(k);
  const der = Buffer.from(k.replace(/\s+/g, ""), "base64");
  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return createPublicKey({ key: der, format: "der", type: "pkcs1" });
  }
}

export function signSha1(plainText: string, privateKey: string): string {
  return createSign("RSA-SHA1").update(plainText, "utf8").sign(readPrivateKey(privateKey), "base64");
}

export function verifySha1(plainText: string, signature: string, publicKey: string): boolean {
  try {
    return createVerify("RSA-SHA1")
      .update(plainText, "utf8")
      .verify(readPublicKey(publicKey), signature, "base64");
  } catch {
    return false;
  }
}

/** A fresh merchant key pair, both halves as bare base64 DER — FlyPay's format. */
export function generateMerchantKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "der", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  return {
    privateKey: privateKey.toString("base64"),
    publicKey: publicKey.toString("base64"),
  };
}

// ---------- Transport ----------

type Envelope<T> = {
  isSuccess?: boolean;
  successCode?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorList?: Array<Record<string, string>> | null;
  data?: T | null;
};

async function call<T>(
  creds: FlyPayCredentials,
  path: string,
  params: Record<string, unknown>,
): Promise<T> {
  const plain = JSON.stringify(params);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        MerchantCode: creds.merchant_code,
        Data: aesEncrypt(plain, creds.aes_key),
        Signature: signSha1(plain, creds.merchant_private_key),
        Version: 0,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new FlyPayError(
      `FlyPay didn't answer (${e instanceof Error ? e.message : "network error"})`,
      [],
      false,
    );
  }

  const body = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!body) {
    // A non-JSON 403 here is almost always the IP whitelist.
    throw new FlyPayError(`FlyPay answered HTTP ${res.status} with no JSON`, [], true);
  }
  if (!body.isSuccess || !body.data) {
    const list = (body.errorList ?? []).map((e) => ({
      code: e.errorCode ?? e.ErrorCode ?? "",
      text: e.errorDescription ?? e.ErrorDescription ?? "",
    }));
    const codes = [body.errorCode ?? "", ...list.map((e) => e.code)].filter(Boolean);
    const text =
      [body.errorMessage, ...list.map((e) => [e.code, e.text].filter(Boolean).join(" "))]
        .filter(Boolean)
        .join("; ") || `HTTP ${res.status}`;
    throw new FlyPayError(`FlyPay refused: ${text}`, codes);
  }
  return body.data;
}

// ---------- Calls ----------

/** Our id for a payment: short, unique, and recognisable on FlyPay's side. */
export function newMerchantTxnId(): string {
  return `FP${Date.now()}${randomInt(100, 1000)}`;
}

export type SubmitDepositResult = {
  transactionId: string;
  url: string;
  bankCode?: string | null;
  accountNumber?: string | null;
  accountHolderName?: string | null;
  referenceNo?: string | null;
  qrCode?: string | null;
  depositActualAmount?: number | null;
};

/** 1.1 Submit Deposit — opens a payment and returns FlyPay's cashier link. */
export function submitDeposit(
  creds: FlyPayCredentials,
  input: {
    merchantTxnId: string;
    clientId: string;
    amount: number;
    method: FlyPayMethod;
    notifyUrl: string;
    returnUrl: string;
    ipAddress: string;
    accountHolderName?: string;
  },
): Promise<SubmitDepositResult> {
  return call<SubmitDepositResult>(creds, "/api/Deposit/SubmitDeposit", {
    MerchantCode: creds.merchant_code,
    MerchantTransactionId: input.merchantTxnId,
    MerchantClientId: input.clientId,
    CurrencyCode: creds.currency,
    // Two decimals, as a string — the form the guide's own worked example encrypts.
    Amount: input.amount.toFixed(2),
    NotifyUrl: input.notifyUrl,
    ReturnUrl: input.returnUrl,
    IPAddress: input.ipAddress,
    PaymentMethodCode: input.method,
    // No SourceClientBankCode: the cashier page lets the player pick their bank.
    ...(input.accountHolderName ? { AccountHolderName: input.accountHolderName } : {}),
  });
}

export type DepositDetail = {
  transactionId?: string | null;
  merchantTransactionId: string;
  statusId: number;
  status: string;
  amount: number;
  netAmount?: number | null;
  paymentMethodCode?: string | null;
  bankReferenceNo?: string | null;
  uniqueReferenceNo?: string | null;
};

/** 1.3 Deposit Requery — where a payment stands now. */
export function getDepositDetail(
  creds: FlyPayCredentials,
  merchantTxnId: string,
): Promise<DepositDetail> {
  return call<DepositDetail>(creds, "/api/Deposit/GetDepositDetail", {
    MerchantCode: creds.merchant_code,
    MerchantTransactionId: merchantTxnId,
    CurrencyCode: creds.currency,
  });
}

export type MerchantBalance = {
  merchantCode: string;
  currencyCode: string;
  currentBalance: number;
  availableBalance: number;
};

/** 1.8 CheckBalance — what FlyPay says the merchant holds. */
export function checkBalance(creds: FlyPayCredentials): Promise<MerchantBalance> {
  return call<MerchantBalance>(creds, "/api/Merchant/CheckBalance", {
    MerchantCode: creds.merchant_code,
    CurrencyCode: creds.currency,
  });
}
