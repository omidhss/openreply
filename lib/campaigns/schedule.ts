import type { Automation, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

type CampaignWindow = Pick<Automation, "isActive" | "enabledAt" | "scheduleStartsAt" | "expiresAt">;
type Schedule = Pick<Automation, "scheduleStartsAt" | "scheduleEndsAt" | "durationMinutes">;

export const MINUTE_MS = 60_000;
export const MAX_DURATION_MINUTES = 365 * 24 * 60;

export function activeCampaignWindow(now = new Date()): Prisma.AutomationWhereInput {
  return {
    isActive: true,
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      { OR: [{ scheduleStartsAt: null }, { scheduleStartsAt: { lte: now } }] },
    ],
  };
}

export function isCampaignOpen(campaign: CampaignWindow, triggeredAt?: number, now = Date.now()) {
  return campaign.isActive &&
    (!campaign.expiresAt || campaign.expiresAt.getTime() > now) &&
    (!campaign.scheduleStartsAt || campaign.scheduleStartsAt.getTime() <= Math.min(triggeredAt ?? now, now)) &&
    (triggeredAt === undefined || !campaign.enabledAt || campaign.enabledAt.getTime() <= triggeredAt);
}

export async function pauseExpiredCampaigns(workspaceId?: string, now = new Date()) {
  return prisma.automation.updateMany({
    where: { ...(workspaceId ? { workspaceId } : {}), isActive: true, expiresAt: { lte: now } },
    data: { isActive: false },
  });
}

export function campaignExpiry(schedule: Schedule, enabledAt: Date) {
  return schedule.durationMinutes === null
    ? schedule.scheduleEndsAt
    : new Date(enabledAt.getTime() + schedule.durationMinutes * MINUTE_MS);
}

export function campaignScheduleError(schedule: Schedule, expiresAt: Date | null, now: Date) {
  if (schedule.durationMinutes !== null && (schedule.scheduleEndsAt || schedule.scheduleStartsAt))
    return "Choose a duration or a fixed schedule.";
  if (schedule.scheduleStartsAt && schedule.scheduleEndsAt && schedule.scheduleStartsAt >= schedule.scheduleEndsAt)
    return "The campaign must end after it starts.";
  if (expiresAt && expiresAt <= now) return "Set a future end time before enabling the campaign.";
  return null;
}

// Check again immediately before starting a provider send. Jobs can spend time
// resolving recipients, waiting in Redis, checking follows, or reserving quota.
export async function canStartCampaignSend(
  snapshot: Pick<Automation, "id" | "enabledAt" | "updatedAt">,
  triggeredAt: number | undefined,
) {
  const current = await prisma.automation.findUnique({
    where: { id: snapshot.id },
    select: { isActive: true, enabledAt: true, scheduleStartsAt: true, expiresAt: true, updatedAt: true },
  });
  return current && current.enabledAt?.getTime() === snapshot.enabledAt?.getTime() &&
    (!snapshot.enabledAt || current.updatedAt.getTime() === snapshot.updatedAt.getTime()) &&
    isCampaignOpen(current, triggeredAt);
}
