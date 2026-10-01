import nodemailer from "nodemailer";

/**
 * Sending email over SMTP — the daily tally's delivery route.
 *
 * Any SMTP server will do. With a Gmail account that means an app password
 * (Google Account → Security → 2-Step Verification → App passwords), not the
 * account password:
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_USER=someone@gmail.com
 *   SMTP_PASS=<16-letter app password>
 *   EMAIL_FROM="Players Console <someone@gmail.com>"   # optional, defaults to SMTP_USER
 *
 * Soft-failing like telegram.ts: a mail server being down comes back as
 * { ok: false, error }, never a throw — the caller decides what to say.
 */

export type EmailResult = { ok: true } | { ok: false; error: string };

export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendEmail(msg: {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Uint8Array; contentType?: string }[];
}): Promise<EmailResult> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return { ok: false, error: "Email is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)" };
  }
  const port = Number(SMTP_PORT ?? 465);
  try {
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      // 465 is TLS from the first byte; 587 and the rest upgrade with STARTTLS.
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 15000,
      socketTimeout: 30000,
    });
    await transport.sendMail({
      from: EMAIL_FROM || SMTP_USER,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content),
        contentType: a.contentType,
      })),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not send the email" };
  }
}
