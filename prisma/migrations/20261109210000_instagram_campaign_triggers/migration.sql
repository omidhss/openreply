CREATE TYPE "CampaignTrigger" AS ENUM ('COMMENT', 'DM_KEYWORD', 'STORY_REPLY');

ALTER TABLE "Automation"
  ADD COLUMN "trigger" "CampaignTrigger" NOT NULL DEFAULT 'COMMENT',
  ADD COLUMN "storyId" TEXT,
  ADD COLUMN "cooldownMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "enabledAt" TIMESTAMP(3),
  ADD COLUMN "scheduleStartsAt" TIMESTAMP(3),
  ADD COLUMN "scheduleEndsAt" TIMESTAMP(3),
  ADD COLUMN "durationMinutes" INTEGER,
  ADD COLUMN "expiresAt" TIMESTAMP(3);

ALTER TABLE "DmLog"
  ADD COLUMN "triggerStartedAt" TIMESTAMP(3),
  ADD COLUMN "followPromptSent" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Automation_isActive_expiresAt_idx" ON "Automation"("isActive", "expiresAt");
CREATE INDEX "DmLog_automationId_commenterId_triggerStartedAt_idx"
  ON "DmLog"("automationId", "commenterId", "triggerStartedAt");
