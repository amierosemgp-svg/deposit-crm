import { authErrorResponse, requireUser } from "@/lib/auth";

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ user });
  } catch (e) {
    return authErrorResponse(e) ?? Response.json({ error: "Server error" }, { status: 500 });
  }
}
