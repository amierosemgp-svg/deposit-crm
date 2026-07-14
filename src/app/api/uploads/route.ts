import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/**
 * POST /api/uploads — receipt / payout-proof uploads (multipart form, field "file").
 * Stores in Supabase Storage when configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY),
 * otherwise falls back to the local public/uploads directory (dev).
 */
export async function POST(request: Request) {
  try {
    await requireWriteUser();

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return jsonError("Send a multipart form with a `file` field");
    if (file.size > MAX_BYTES) return jsonError("File too large (max 5MB)", 413);
    if (!ALLOWED.includes(file.type)) {
      return jsonError(`Unsupported type ${file.type} (jpeg/png/webp/pdf)`, 415);
    }

    const ext = file.type === "application/pdf" ? "pdf" : file.type.split("/")[1];
    const key = `receipts/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && serviceKey) {
      const res = await fetch(
        `${supabaseUrl}/storage/v1/object/receipts/${key}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": file.type,
            "x-upsert": "false",
          },
          body: bytes,
        },
      );
      if (!res.ok) {
        console.error("Supabase upload failed:", await res.text());
        return jsonError("Upload failed", 502);
      }
      // Private bucket — serve via signed URL
      const signed = await fetch(
        `${supabaseUrl}/storage/v1/object/sign/receipts/${key}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 365 }),
        },
      ).then((r) => r.json());
      return Response.json(
        { url: `${supabaseUrl}/storage/v1${signed.signedURL}` },
        { status: 201 },
      );
    }

    // Local dev fallback
    const dir = path.join(process.cwd(), "public", "uploads", path.dirname(key));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(process.cwd(), "public", "uploads", key), bytes);
    const origin = new URL(request.url).origin;
    return Response.json({ url: `${origin}/uploads/${key}` }, { status: 201 });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}
