import { createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { QueueEvents, type Worker } from "bullmq";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/app/generated/prisma/client";

const state = vi.hoisted(() => ({ db: undefined as unknown as PrismaClient, workspaceId: "" }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: () => true,
  getCurrentWorkspaceContext: async () => ({ role: "OWNER", workspaceId: state.workspaceId }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: async () => state.workspaceId }));

import { PATCH, POST as createCampaign } from "@/app/api/automations/route";
import { GET as listStories } from "@/app/api/instagram/stories/route";
import { POST as webhook } from "@/app/api/zernio/webhook/[workspaceId]/route";
import { pauseExpiredCampaigns } from "@/lib/campaigns/schedule";
import { formatRomeInput, parseRomeInput } from "@/lib/campaigns/rome-time";
import { encryptToken } from "@/lib/meta/oauth";
import { getDMQueue, getRedisConnection, type DmQueueJob } from "@/lib/queue/client";
import { createDMWorker } from "@/lib/queue/dm-worker";

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const suffix = randomBytes(5).toString("hex");
const schema = `instagram_campaigns_${suffix}`;
const igId = `ig_${suffix}`;
const webhookSecret = "test-webhook-only";
let accountId: string;
let sql: Client;
let connected = false;
let worker: Worker<DmQueueJob>;
let events: QueueEvents;
let follows: boolean | null = null;
let beforeFollowCheck: (() => Promise<unknown>) | undefined;
const sent: { message: string; buttons?: { payload?: string }[] }[] = [];

function request(method: string, body: unknown, id?: string) {
  return new NextRequest(`http://localhost/api/automations${id ? `?id=${id}` : ""}`, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function campaign(overrides: Record<string, unknown>) {
  const res = await createCampaign(request("POST", {
    instagramAccountId: accountId, name: "Campaign test", keywords: ["offer"],
    dmMessage: "Your offer", trigger: "DM_KEYWORD", ...overrides,
  }));
  const result = await res.json();
  expect(res.status, JSON.stringify(result)).toBe(201);
  return result.data as { id: string; expiresAt: string | null; enabledAt: string | null };
}

async function receive(mid: string, { text = "offer", metadata, sender = "person", createdAt = new Date() }: {
  text?: string | null; metadata?: Record<string, unknown>; sender?: string; createdAt?: Date;
} = {}) {
  const raw = JSON.stringify({
    id: `${suffix}_${mid}`, event: "message.received", account: { id: "zernio-test", platform: "instagram" },
    conversation: { participantId: sender },
    message: { platformMessageId: mid, conversationId: `inbox-${sender}`, direction: "incoming", text, sender: { id: sender }, sentAt: createdAt },
    metadata: metadata ?? null,
  });
  const res = await webhook(new Request("http://localhost/api/zernio/webhook/test", {
    method: "POST", body: raw, headers: { "x-zernio-signature": createHmac("sha256", webhookSecret).update(raw).digest("hex") },
  }), { params: Promise.resolve({ workspaceId: state.workspaceId }) });
  expect(res.status).toBe(200);
  const id = metadata?.postbackPayload ? `postback_${igId}_${sender}_${mid}` : `message_${igId}_${Buffer.from(mid).toString("base64url")}`;
  return getDMQueue().getJob(id);
}

async function finish(job: Awaited<ReturnType<typeof receive>>) {
  expect(job).toBeDefined();
  await job!.waitUntilFinished(events, 10_000);
}

describe("Europe/Rome campaign times", () => {
  it("round-trips winter and summer and rejects ambiguous or nonexistent times", () => {
    expect(parseRomeInput("2026-11-09T10:00")?.toISOString()).toBe("2026-11-09T09:00:00.000Z");
    const summer = parseRomeInput("2026-07-09T10:00");
    expect(summer?.toISOString()).toBe("2026-07-09T08:00:00.000Z");
    expect(formatRomeInput(summer!)).toBe("2026-07-09T10:00");
    expect(parseRomeInput("2026-03-29T02:30")).toBeNull();
    expect(parseRomeInput("2026-10-25T02:30")).toBeNull();
    expect(parseRomeInput("2026-02-30T10:00")).toBeNull();
  });
});

describe.skipIf(!dbUrl || !redisUrl)("Zernio automation through PostgreSQL and Redis", () => {
  beforeAll(async () => {
    vi.stubEnv("REDIS_URL", redisUrl);
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
    sql = new Client({ connectionString: dbUrl });
    await sql.connect();
    connected = true;
    await sql.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    const root = path.resolve(__dirname, "../prisma/migrations");
    for (const migration of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      await sql.query(readFileSync(path.join(root, migration.name, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }, { schema }) });
    const owner = await state.db.user.create({ data: {} });
    const workspace = await state.db.workspace.create({ data: { name: "Isolated triggers", ownerId: owner.id } });
    state.workspaceId = workspace.id;
    const account = await state.db.instagramAccount.create({ data: {
      workspaceId: workspace.id, provider: "ZERNIO", accessToken: "", instagramId: igId,
      zernioAccountId: "zernio-test", username: "test_account",
    } });
    accountId = account.id;
    await state.db.zernioConnection.create({ data: {
      workspaceId: workspace.id, apiKey: encryptToken("fake-key"), webhookId: "test-webhook", webhookSecret: encryptToken(webhookSecret),
    } });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const target = new URL(url);
      expect(target.origin).toBe("https://zernio.com");
      if (target.pathname.endsWith("/instagram/stories")) return Response.json({ data: [
        { id: "story-1", mediaType: "IMAGE", timestamp: "2026-11-09T10:00:00Z" },
        { id: "story-2", mediaType: null, timestamp: null, mediaUrl: null },
      ] });
      if (target.pathname.includes("/follow-status/")) {
        await beforeFollowCheck?.();
        return Response.json({ isFollower: follows });
      }
      expect(target.pathname).toMatch(/^\/api\/v1\/inbox\/conversations\/inbox-[^/]+\/messages$/);
      if (init?.method === "GET") return Response.json({ messages: [
        { id: "lookup-story", storyReply: { storyId: "story-1" } },
        { id: "unrelated-message", storyReply: { storyId: "another-story" } },
      ] });
      expect(init?.method).toBe("POST");
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ messageId: `out-${sent.length}` });
    }));
    events = new QueueEvents("dm-processing", { connection: getRedisConnection() });
    await events.waitUntilReady();
    worker = createDMWorker();
    await worker.waitUntilReady();
  }, 30_000);

  afterAll(async () => {
    try {
      await worker?.close();
      await events?.close();
      if (events) {
        await getDMQueue().close();
        getRedisConnection().disconnect();
      }
      await state.db?.$disconnect();
      if (connected) {
        await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await sql.end();
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("lets one signed Story reply trigger both campaign types, with independent cooldowns", async () => {
    const dm = await campaign({ dmMessage: "DM reply", cooldownMinutes: 30 });
    const story = await campaign({ trigger: "STORY_REPLY", storyId: "story-1", dmMessage: "Story reply" });
    const list = await listStories(new NextRequest(`http://localhost/api/instagram/stories?instagramAccountId=${accountId}`));
    expect((await list.json()).data[0].id).toBe("story-1");
    const metadata = { storyReply: { storyId: "story-1", storyUrl: "https://example.com/story" } };
    const first = await receive("one", { metadata });
    await finish(first);
    expect(sent.map((s) => s.message).sort()).toEqual(["DM reply", "Story reply"]);
    await first!.remove();
    await finish(await receive("one", { metadata }));
    expect(sent).toHaveLength(2);

    await Promise.all(["two", "three"].map(async (mid) => finish(await receive(mid, { metadata: { storyReply: { storyId: "other" } } }))));
    expect(sent).toHaveLength(2);
    const logs = await state.db.dmLog.findMany({ where: { automationId: dm.id, status: "SKIPPED_DEDUP" } });
    expect(logs).toHaveLength(2);
    expect(await state.db.dmLog.count({ where: { automationId: story.id } })).toBe(1);

    await Promise.all(["four", "five"].map(async (mid) => finish(await receive(mid, { sender: "second-person" }))));
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.message).toBe("DM reply");
    await finish(await receive("lookup-story"));
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)?.message).toBe("Story reply");
    await state.db.automation.updateMany({ data: { isActive: false } });
  });

  it("requires an actual verified follow on the matching person's Story prompt", async () => {
    sent.length = 0;
    const gated = await campaign({ trigger: "STORY_REPLY", matchAnyWord: true, keywords: [],
      requireFollow: true, dmMessage: "Protected reply", followPromptMessage: "Please follow", cooldownMinutes: 10 });
    follows = null;
    await finish(await receive("gated", { text: "hello", metadata: { storyReply: true } }));
    expect(sent.map((s) => s.message)).toEqual(["Please follow"]);
    const payload = sent[0].buttons?.[0]?.payload;
    expect(payload).toMatch(new RegExp(`^followcheck:${gated.id}:`));
    const tap = { postbackPayload: payload };
    await finish(await receive("tap-wrong-user", { text: null, metadata: tap, sender: "other-person" }));
    await finish(await receive("tap-unknown", { text: null, metadata: tap }));
    follows = false;
    await finish(await receive("tap-not-following", { text: null, metadata: tap }));
    expect(sent).toHaveLength(1);
    follows = true;
    await finish(await receive("tap-verified", { text: null, metadata: tap }));
    await finish(await receive("tap-replayed", { text: null, metadata: tap }));
    expect(sent.map((s) => s.message)).toEqual(["Please follow", "Protected reply"]);
    expect(await receive("empty", { text: null, metadata: { storyReply: true } })).toBeUndefined();
    await finish(await receive("mention", { metadata: { isStoryMention: true, storyReply: true } }));
    expect(sent).toHaveLength(2);
    await state.db.automation.updateMany({ data: { isActive: false } });
  });

  it("pauses at expiration, discards queued work from the old run and requires explicit re-enable", async () => {
    sent.length = 0;
    const scheduled = await campaign({ durationMinutes: 10, isActive: false,
      followUpEnabled: true, followUpMessage: "Delayed follow-up", followUpDelayMinutes: 60 });
    expect(scheduled.expiresAt).toBeNull();
    const enable = async () => {
      const res = await PATCH(request("PATCH", { isActive: true }, scheduled.id));
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(Date.parse(data.expiresAt) - Date.parse(data.enabledAt)).toBe(10 * 60_000);
    };
    await enable();
    await worker.pause();
    const queued = await receive("queued-before-expiry");
    await state.db.automation.update({ where: { id: scheduled.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await pauseExpiredCampaigns(state.workspaceId)).count).toBe(1);
    const edited = await PATCH(request("PATCH", { durationMinutes: 20, name: "Still paused" }, scheduled.id));
    expect((await edited.json()).data.isActive).toBe(false);
    await PATCH(request("PATCH", { durationMinutes: 10 }, scheduled.id));
    await enable();
    worker.resume();
    await finish(queued);
    expect(sent).toHaveLength(0);
    await finish(await receive("new-run"));
    expect(sent).toHaveLength(1);

    await PATCH(request("PATCH", { requireFollow: true }, scheduled.id));
    beforeFollowCheck = () => state.db.automation.update({ where: { id: scheduled.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    try {
      await finish(await receive("expiry-during-lookup"));
      expect(sent).toHaveLength(1);
    } finally {
      beforeFollowCheck = undefined;
    }
    const followUp = (await getDMQueue().getDelayed()).find((job) => job.id?.startsWith(`followup_${scheduled.id}_`));
    expect(followUp).toBeDefined();
    await followUp!.promote();
    await finish(followUp);
    expect(sent).toHaveLength(1);
  });

  it("honors a fixed Rome start time and refuses to enable a fixed end in the past", async () => {
    sent.length = 0;
    const starts = formatRomeInput(new Date(Date.now() + 10 * 60_000));
    const ends = formatRomeInput(new Date(Date.now() + 20 * 60_000));
    const future = await campaign({ scheduleStartsAt: starts, scheduleEndsAt: ends });
    expect(future.expiresAt).toBe(parseRomeInput(ends)?.toISOString());
    await finish(await receive("before-fixed-start"));
    expect(sent).toHaveLength(0);

    const elapsed = await campaign({ isActive: false,
      scheduleEndsAt: formatRomeInput(new Date(Date.now() - 10 * 60_000)) });
    expect((await PATCH(request("PATCH", { isActive: true }, elapsed.id))).status).toBe(400);
  });
});
