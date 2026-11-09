import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/context";
import { getActiveStories } from "@/lib/instagram/read-stories";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("instagramAccountId");
  if (!id) return NextResponse.json({ success: false, error: "Select an Instagram account." }, { status: 400 });
  const account = await prisma.instagramAccount.findFirst({ where: { id, workspaceId, provider: "ZERNIO" } });
  if (!account) return NextResponse.json({ success: false, error: "Select a Zernio Instagram account." }, { status: 404 });

  try {
    const context = await createInstagramContext(account);
    if (context.provider === "ZERNIO") {
      return NextResponse.json({ success: true, data: await getActiveStories(context) });
    }
  } catch {
    // The provider error can contain connection details; keep them server-side.
  }
  return NextResponse.json({ success: false, error: "Could not load active Instagram Stories." }, { status: 502 });
}
