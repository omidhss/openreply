import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  calculateCtr,
  CLICK_ROW_SELECT,
  countUniqueClicksBy,
  normalizeTopKeywords,
} from "@/lib/tracking/analytics";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import {
  buildInitialCampaignLinks,
  syncCampaignLinks,
} from "@/lib/campaigns/links";
import { buildReportUrl, generateReportShareSlug } from "@/lib/reports/share";
import { parseRomeInput } from "@/lib/campaigns/rome-time";
import { campaignExpiry, campaignScheduleError, MAX_DURATION_MINUTES, pauseExpiredCampaigns } from "@/lib/campaigns/schedule";
import { createInstagramContext, type ProviderAccount } from "@/lib/instagram/context";
import { getActiveStories } from "@/lib/instagram/read-stories";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// This list is read-your-writes (created/imported campaigns must show up
// immediately), so never cache it at the route or CDN layer.
export const dynamic = "force-dynamic";

const triggerSchema = z.enum(["COMMENT", "DM_KEYWORD", "STORY_REPLY"]);
const romeDate = z.string().transform((value, ctx) => {
  const date = parseRomeInput(value);
  if (!date) {
    ctx.addIssue({ code: "custom", message: "Choose a valid, unambiguous date and time in Europe/Rome." });
    return z.NEVER;
  }
  return date;
}).nullish();
const duration = z.number().int().min(1).max(MAX_DURATION_MINUTES).nullish();
const cooldown = z.number().int().min(0).max(MAX_DURATION_MINUTES);

function campaignError(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

async function validateStory(account: ProviderAccount, storyId: string) {
  try {
    const context = await createInstagramContext(account);
    if (context.provider !== "ZERNIO") return campaignError("Select a Zernio Instagram account.");
    const stories = await getActiveStories(context);
    return stories.some((story) => story.id === storyId)
      ? null
      : campaignError("Select an active Story from this Instagram account.");
  } catch {
    return campaignError("Could not verify the selected Instagram Story. Try again.", 502);
  }
}

const createAutomationSchema = z
  .object({
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    trigger: triggerSchema.default("COMMENT"),
    storyId: z.string().min(1).max(255).nullish(),
    cooldownMinutes: cooldown.default(0),
    scheduleStartsAt: romeDate,
    scheduleEndsAt: romeDate,
    durationMinutes: duration,
    postId: z.string().min(1).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmTriggerEnabled: z.boolean().optional().default(false),
    dmMessage: z.string().min(1).max(1000),
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(64).optional().nullable(),
    linkButtonLabel: z.string().max(20).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followReminderMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    // Minutes to wait before the follow-up. Capped at 24h so it stays inside
    // Instagram's messaging window.
    followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    // Empty string means "no tracked link"; a URL sets one.
    trackedDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    // Optional second tracked link, rendered as a second DM button.
    secondaryDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    secondaryButtonLabel: z.string().max(20).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
  })
  // A campaign must target a specific post, any post, or the next reel.
  .refine(
    (d) => d.trigger !== "COMMENT" || d.matchAnyPost || d.pendingNextReel || Boolean(d.postId),
    { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
  )
  // And it must match either specific words or any word.
  .refine((d) => (d.trigger !== "DM_KEYWORD" && d.matchAnyWord) || d.keywords.some((word) => word.trim()), {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      d.trigger !== "COMMENT" || !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  );

const updateAutomationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  instagramAccountId: z.string().min(1).optional(),
  trigger: triggerSchema.optional(),
  storyId: z.string().min(1).max(255).nullish(),
  cooldownMinutes: cooldown.optional(),
  scheduleStartsAt: romeDate,
  scheduleEndsAt: romeDate,
  durationMinutes: duration,
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  dmMessage: z.string().min(1).max(1000).optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followReminderMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
});

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const instagramAccountId =
    request.nextUrl.searchParams.get("instagramAccountId");
  const accountFilter =
    instagramAccountId && instagramAccountId !== "all"
      ? { instagramAccountId }
      : {};

  await pauseExpiredCampaigns(workspaceId);

  const automations = await prisma.automation.findMany({
    where: { workspaceId, ...accountFilter },
    include: {
      instagramAccount: {
        select: { username: true, instagramId: true },
      },
      _count: {
        select: { dmLogs: true },
      },
      trackedLinks: {
        select: {
          id: true,
          slug: true,
          label: true,
          destinationUrl: true,
          _count: { select: { clicks: true } },
        },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const automationsWithReports = await Promise.all(
    automations.map(async (automation) => {
      if (automation.reportShareSlug) return automation;

      const updated = await prisma.automation.update({
        where: { id: automation.id },
        data: { reportShareSlug: generateReportShareSlug() },
        select: { reportShareSlug: true },
      });

      return {
        ...automation,
        reportShareSlug: updated.reportShareSlug,
      };
    })
  );

  const [statusCounts, clickRows, keywordCounts] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["automationId", "status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.linkClick.findMany({
      where: { workspaceId },
      select: CLICK_ROW_SELECT,
    }),
    prisma.dmLog.groupBy({
      by: ["automationId", "matchedKeyword"],
      where: { workspaceId, matchedKeyword: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const analytics = new Map<
    string,
    {
      sent: number;
      skipped: number;
      failed: number;
      clicks: number;
      topKeywords: { keyword: string; count: number }[];
    }
  >();

  for (const automation of automationsWithReports) {
    analytics.set(automation.id, {
      sent: 0,
      skipped: 0,
      failed: 0,
      clicks: 0,
      topKeywords: [],
    });
  }

  for (const row of statusCounts) {
    const item = analytics.get(row.automationId);
    if (!item) continue;
    const count = row._count._all;
    if (row.status === "SENT") item.sent += count;
    if (row.status === "FAILED") item.failed += count;
    if (row.status.startsWith("SKIPPED_")) item.skipped += count;
  }

  const clickCounts = countUniqueClicksBy(clickRows, (row) => row.automationId);
  for (const [automationId, clicks] of clickCounts) {
    const item = analytics.get(automationId);
    if (item) item.clicks = clicks;
  }

  for (const automation of automationsWithReports) {
    const item = analytics.get(automation.id);
    if (!item) continue;
    item.topKeywords = normalizeTopKeywords(
      keywordCounts
        .filter((row) => row.automationId === automation.id)
        .map((row) => ({
          matchedKeyword: row.matchedKeyword,
          _count: row._count._all,
        })),
      3
    );
  }

  return NextResponse.json(
    {
    success: true,
    data: automationsWithReports.map((automation) => {
      const item = analytics.get(automation.id) ?? {
        sent: 0,
        skipped: 0,
        failed: 0,
        clicks: 0,
        topKeywords: [],
      };

      return {
        ...automation,
        trackedLinks: automation.trackedLinks.map((link) => ({
          ...link,
          trackedUrl: buildTrackedUrl(link.slug),
        })),
        reportUrl: automation.reportShareSlug
          ? buildReportUrl(automation.reportShareSlug)
          : null,
        analytics: {
          ...item,
          ctr: calculateCtr(item.clicks, item.sent),
        },
      };
    }),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can create campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const body = await request.json();
  const parsed = createAutomationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const requestedInstagramAccountId =
    parsed.data.instagramAccountId && parsed.data.instagramAccountId !== "all"
      ? parsed.data.instagramAccountId
      : null;

  const [workspace, instagramAccount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    requestedInstagramAccountId
      ? prisma.instagramAccount.findFirst({
          where: { id: requestedInstagramAccountId, workspaceId },
        })
      : prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { connectedAt: "desc" },
        }),
  ]);

  if (!workspace) {
    return NextResponse.json(
      { success: false, error: "Workspace not found" },
      { status: 404 }
    );
  }

  if (!instagramAccount) {
    return NextResponse.json(
      { success: false, error: "Connect Instagram before creating campaigns" },
      { status: 400 }
    );
  }

  const { trigger } = parsed.data;
  const isComment = trigger === "COMMENT";
  if (!isComment && instagramAccount.provider !== "ZERNIO")
    return campaignError("This trigger requires a Zernio Instagram account.");
  const storyId = trigger === "STORY_REPLY" ? parsed.data.storyId ?? null : null;
  if (storyId) {
    const error = await validateStory(instagramAccount, storyId);
    if (error) return error;
  }
  const schedule = {
    scheduleStartsAt: parsed.data.scheduleStartsAt ?? null,
    scheduleEndsAt: parsed.data.scheduleEndsAt ?? null,
    durationMinutes: parsed.data.durationMinutes ?? null,
  };
  const now = new Date();
  const scheduled = Boolean(schedule.scheduleStartsAt || schedule.scheduleEndsAt || schedule.durationMinutes);
  const enabledAt = parsed.data.isActive && (scheduled || !isComment) ? now : null;
  const expiresAt = enabledAt ? campaignExpiry(schedule, enabledAt) : null;
  const scheduleError = campaignScheduleError(schedule, expiresAt, now);
  if (scheduleError) return campaignError(scheduleError);

  const linkCreates = buildInitialCampaignLinks({
    workspaceId,
    primaryUrl: parsed.data.trackedDestinationUrl,
    secondaryUrl: parsed.data.secondaryDestinationUrl,
    secondaryLabel: parsed.data.secondaryButtonLabel,
  });

  const pendingNextReel = isComment && parsed.data.pendingNextReel;
  const matchAnyPost = isComment && parsed.data.matchAnyPost;
  const matchAnyWord = trigger !== "DM_KEYWORD" && parsed.data.matchAnyWord;
  const openingDmEnabled = isComment && parsed.data.openingDmEnabled;
  const publicReplyEnabled = isComment && parsed.data.publicReplyEnabled;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = isComment && !pendingNextReel && !matchAnyPost;
  const publicReplyList = (
    parsed.data.publicReplyMessages.length > 0
      ? parsed.data.publicReplyMessages
      : parsed.data.publicReplyMessage
        ? [parsed.data.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  const automation = await prisma.automation.create({
    data: {
      name: parsed.data.name,
      goal: parsed.data.goal,
      trigger, storyId,
      cooldownMinutes: isComment ? 0 : parsed.data.cooldownMinutes,
      ...schedule, enabledAt, expiresAt,
      // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
      postId: isSpecificPost ? parsed.data.postId : null,
      postUrl: isSpecificPost ? parsed.data.postUrl : null,
      pendingNextReel,
      matchAnyPost,
      keywords: matchAnyWord ? [] : parsed.data.keywords,
      matchAnyWord,
      dmTriggerEnabled: isComment && parsed.data.dmTriggerEnabled,
      dmMessage: parsed.data.dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled
        ? parsed.data.openingDmMessage || null
        : null,
      openingDmButtonLabel: openingDmEnabled
        ? parsed.data.openingDmButtonLabel || null
        : null,
      linkButtonLabel: parsed.data.linkButtonLabel || null,
      requireFollow: parsed.data.requireFollow,
      followPromptMessage: parsed.data.requireFollow
        ? parsed.data.followPromptMessage || null
        : null,
      followReminderMessage: parsed.data.requireFollow ? parsed.data.followReminderMessage?.trim() || null : null,
      followPromptButtonLabel: parsed.data.requireFollow
        ? parsed.data.followPromptButtonLabel || null
        : null,
      followUpEnabled: parsed.data.followUpEnabled,
      followUpMessage: parsed.data.followUpEnabled
        ? parsed.data.followUpMessage || null
        : null,
      followUpDelayMinutes: parsed.data.followUpEnabled
        ? parsed.data.followUpDelayMinutes
        : 0,
      publicReplyEnabled,
      publicReplyMessages: publicReplyEnabled
        ? publicReplyList
        : [],
      publicReplyMessage: publicReplyEnabled
        ? publicReplyList[0] ?? parsed.data.publicReplyMessage ?? null
        : null,
      isActive: parsed.data.isActive,
      wholeWordMatch: parsed.data.wholeWordMatch,
      workspaceId,
      instagramAccountId: instagramAccount.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0
        ? { trackedLinks: { create: linkCreates } }
        : {}),
    },
    include: {
      trackedLinks: true,
    },
  });

  return NextResponse.json(
    { success: true, data: automation },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can update campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "Missing campaign ID" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const parsed = updateAutomationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  const {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    ...automationData
  } = parsed.data;

  const trigger = automationData.trigger ?? existing.trigger ?? "COMMENT";
  const accountId = automationData.instagramAccountId ?? existing.instagramAccountId;
  const accountChanged = accountId !== existing.instagramAccountId;
  const storyId = trigger === "STORY_REPLY"
    ? (automationData.storyId === undefined ? existing.storyId ?? null : automationData.storyId)
    : null;
  const storyChanged = Boolean(storyId && (storyId !== existing.storyId || accountChanged));

  // Moving a campaign to another account: it must be one of this workspace's.
  if (accountChanged || trigger !== "COMMENT") {
    const account = await prisma.instagramAccount.findFirst({
      where: { id: accountId, workspaceId },
    });
    if (!account) {
      return NextResponse.json(
        { success: false, error: "Instagram account not found" },
        { status: 404 }
      );
    }
    if (trigger !== "COMMENT" && account.provider !== "ZERNIO")
      return campaignError("This trigger requires a Zernio Instagram account.");
    if (storyChanged && storyId) {
      const error = await validateStory(account, storyId);
      if (error) return error;
    }
  }

  if (trigger !== "COMMENT") {
    Object.assign(automationData, {
      postId: null, postUrl: null, pendingNextReel: false, matchAnyPost: false,
      dmTriggerEnabled: false, openingDmEnabled: false, publicReplyEnabled: false, storyId,
    });
    if (trigger === "DM_KEYWORD") automationData.matchAnyWord = false;
  } else if (automationData.trigger || automationData.storyId !== undefined || automationData.cooldownMinutes !== undefined) {
    automationData.storyId = null;
    automationData.cooldownMinutes = 0;
  }
  if (trigger !== "COMMENT" || automationData.trigger !== undefined) {
    const any = automationData.matchAnyWord ?? existing.matchAnyWord;
    const words = automationData.keywords ?? existing.keywords;
    if (!any && !words.some((word) => word.trim())) return campaignError("Add at least one keyword.");
    const postId = automationData.postId === undefined ? existing.postId : automationData.postId;
    if (trigger === "COMMENT" && !postId && !(automationData.matchAnyPost ?? existing.matchAnyPost) &&
      !(automationData.pendingNextReel ?? existing.pendingNextReel))
      return campaignError("Choose which post(s) trigger the campaign.");
  }

  const now = new Date();
  const wasExpired = Boolean(existing.expiresAt && existing.expiresAt <= now);
  const scheduleEdited = automationData.scheduleStartsAt !== undefined ||
    automationData.scheduleEndsAt !== undefined || automationData.durationMinutes !== undefined;
  const schedule = {
    scheduleStartsAt: automationData.scheduleStartsAt === undefined ? existing.scheduleStartsAt ?? null : automationData.scheduleStartsAt,
    scheduleEndsAt: automationData.scheduleEndsAt === undefined ? existing.scheduleEndsAt ?? null : automationData.scheduleEndsAt,
    durationMinutes: automationData.durationMinutes === undefined ? existing.durationMinutes ?? null : automationData.durationMinutes,
  };
  const scheduled = Boolean(schedule.scheduleStartsAt || schedule.scheduleEndsAt || schedule.durationMinutes);
  const reenable = automationData.isActive === true && (!existing.isActive || wasExpired);
  const nextActive = automationData.isActive ?? (existing.isActive && !wasExpired);
  const managed = Boolean(scheduled || existing.enabledAt || existing.expiresAt || trigger !== "COMMENT");
  const enabledAt = nextActive && managed
    ? reenable || !existing.enabledAt ? now : existing.enabledAt
    : null;
  const expiresAt = enabledAt ? campaignExpiry(schedule, enabledAt) : null;
  if (scheduleEdited || reenable) {
    const error = campaignScheduleError(schedule, expiresAt, now);
    if (error) return campaignError(error);
  }
  const lifecycleData = managed && (scheduleEdited || automationData.isActive !== undefined || wasExpired || !existing.enabledAt)
    ? { isActive: nextActive, enabledAt: enabledAt ?? existing.enabledAt, expiresAt: !nextActive && wasExpired ? existing.expiresAt : expiresAt }
    : {};

  // Keep dependent fields consistent: any-word clears keywords; a disabled
  // opening DM clears its message and button.
  if (automationData.matchAnyWord === true) automationData.keywords = [];
  if (automationData.openingDmEnabled === false) {
    automationData.openingDmMessage = null;
    automationData.openingDmButtonLabel = null;
  }
  if (automationData.requireFollow === false) {
    automationData.followPromptMessage = null;
    automationData.followReminderMessage = null;
    automationData.followPromptButtonLabel = null;
  }
  if (automationData.followUpEnabled === false) {
    automationData.followUpMessage = null;
    automationData.followUpDelayMinutes = 0;
  }
  // Any-post / next-reel campaigns carry no specific post.
  if (automationData.matchAnyPost === true || automationData.pendingNextReel === true) {
    automationData.postId = null;
    automationData.postUrl = null;
  }
  // Keep the public-reply variations list and the legacy single field in sync.
  if (automationData.publicReplyMessages !== undefined) {
    const list = automationData.publicReplyMessages
      .map((m) => m.trim())
      .filter(Boolean);
    automationData.publicReplyMessages = list;
    automationData.publicReplyMessage = list[0] ?? null;
  }
  if (automationData.publicReplyEnabled === false) {
    automationData.publicReplyMessages = [];
    automationData.publicReplyMessage = null;
  }

  // One transaction, so a save never lands half applied. Updating the campaign
  // first locks its row, which makes a second save of the same campaign wait
  // for this one before it reads the links.
  const updated = await prisma.$transaction(async (tx) => {
    const campaign = await tx.automation.update({
      where: { id: automationId, ...(managed ? { updatedAt: existing.updatedAt } : {}) },
      data: { ...automationData, ...lifecycleData },
    });

    await syncCampaignLinks(tx, {
      workspaceId,
      automationId,
      primaryUrl: trackedDestinationUrl,
      secondaryUrl: secondaryDestinationUrl,
      secondaryLabel: secondaryButtonLabel,
    });

    return campaign;
  }).catch((error: unknown) => {
    if (managed && typeof error === "object" && error && "code" in error && error.code === "P2025") return null;
    throw error;
  });

  if (!updated) return campaignError("The campaign changed. Reload it and try again.", 409);

  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can delete campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "Missing campaign ID" },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  await prisma.automation.delete({ where: { id: automationId } });

  return NextResponse.json({ success: true, data: { deleted: true } });
}
