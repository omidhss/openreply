import type { Automation, Prisma } from "@/app/generated/prisma/client";
import { isCampaignOpen, MINUTE_MS } from "@/lib/campaigns/schedule";
import { prisma } from "@/lib/db/client";

type LogInput = Pick<Prisma.DmLogUncheckedCreateInput,
  "automationId" | "commentId" | "commenterId" | "workspaceId" |
  "instagramAccountId" | "commentText" | "matchedKeyword">;

/** Serialize decisions for the same campaign and person across workers. */
export async function claimInboundDelivery(automation: Automation, log: LogInput, triggeredAt: number) {
  return prisma.$transaction(async (tx) => {
    const key = JSON.stringify([automation.id, log.instagramAccountId, log.commenterId]);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const campaign = await tx.automation.findUnique({ where: { id: automation.id } });
    const now = new Date();
    if (!campaign || campaign.trigger !== automation.trigger ||
      campaign.instagramAccountId !== automation.instagramAccountId ||
      campaign.enabledAt?.getTime() !== automation.enabledAt?.getTime() ||
      campaign.updatedAt.getTime() !== automation.updatedAt.getTime() ||
      !isCampaignOpen(campaign, triggeredAt, now.getTime())) return null;

    const where = { automationId_commentId: { automationId: automation.id, commentId: log.commentId } };
    const existing = await tx.dmLog.findUnique({ where });
    if (existing?.triggerStartedAt || existing?.dmDeliveryUnconfirmed || existing?.status === "SENT" ||
      existing?.status === "SKIPPED_PLAN_LIMIT" || existing?.status === "SKIPPED_DEDUP") return null;

    if (campaign.cooldownMinutes > 0) {
      const prior = await tx.dmLog.findFirst({
        where: {
          automationId: campaign.id, commenterId: log.commenterId,
          instagramAccountId: campaign.instagramAccountId,
          triggerStartedAt: { gt: new Date(now.getTime() - campaign.cooldownMinutes * MINUTE_MS) },
        },
        select: { id: true },
      });
      if (prior) {
        const skipped = { status: "SKIPPED_DEDUP", errorMessage: "Per-person cooldown is active" } as const;
        await tx.dmLog.upsert({ where, create: { ...log, ...skipped }, update: skipped });
        return null;
      }
    }

    const claim = { status: "PENDING", triggerStartedAt: now, errorMessage: null } as const;
    return tx.dmLog.upsert({ where, create: { ...log, ...claim }, update: claim, select: { id: true } });
  });
}
