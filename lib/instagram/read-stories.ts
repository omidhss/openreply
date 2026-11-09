import { z } from "zod";
import { zernioRequest } from "@/lib/zernio/client";
import type { ZernioContext } from "./context";

const storySchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))).nullish(),
  mediaType: z.string().nullish(),
  mediaUrl: z.url({ protocol: /^https$/ }).nullish(),
  thumbnailUrl: z.url({ protocol: /^https$/ }).nullish(),
});

export type InstagramStory = z.infer<typeof storySchema>;

export async function getActiveStories(context: ZernioContext) {
  const response = await zernioRequest<unknown>({
    apiKey: context.apiKey,
    path: `/accounts/${encodeURIComponent(context.accountId)}/instagram/stories`,
  });
  return z.object({ data: z.array(storySchema) }).parse(response).data;
}

/** Look up the exact webhook message when its Story context was omitted. */
export async function getStoryReplyForMessage(context: ZernioContext, conversationId: string, messageId: string) {
  const query = new URLSearchParams({ accountId: context.accountId, limit: "20", sortOrder: "desc" });
  const { messages } = await zernioRequest<{
    messages: { id: string; isStoryMention?: boolean; storyReply?: { storyId?: string } | null }[];
  }>({
    apiKey: context.apiKey,
    path: `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
  });
  const message = messages.find((item) => item.id === messageId);
  if (!message?.storyReply || message.isStoryMention) return null;
  return { storyId: message.storyReply.storyId || null };
}
