"use client";

/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { formatRomeInput } from "@/lib/campaigns/rome-time";
import type { InstagramStory } from "@/lib/instagram/read-stories";

function StoryTile({ story, index, selected, onSelect }: {
  story: InstagramStory;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const video = story.mediaType?.toUpperCase() === "VIDEO";
  const image = story.thumbnailUrl || (!video ? story.mediaUrl : null);
  const date = story.timestamp ? formatRomeInput(new Date(story.timestamp)).replace("T", " ") : "";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={t("Select Story {number}", { number: index + 1 })}
      className={`relative aspect-[9/16] overflow-hidden rounded-lg border-2 bg-surface ${selected ? "border-accent" : "border-border hover:border-border-hover"}`}>
      {!failed && image ? (
        <img src={image} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : !failed && video && story.mediaUrl ? (
        <video src={story.mediaUrl} preload="metadata" muted playsInline className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span className="flex h-full items-center justify-center p-2 text-xs text-muted">{t("Preview unavailable")}</span>
      )}
      <span className="absolute inset-x-0 bottom-0 bg-black/75 p-1 text-[10px] text-white">{index + 1}{date ? ` · ${date}` : ""}</span>
      {selected && <span className="absolute right-1 top-1 rounded-full bg-accent px-1.5 text-sm text-white" aria-hidden="true">✓</span>}
    </button>
  );
}

export default function StoryPicker({ stories, selectedId, onSelect }: {
  stories: InstagramStory[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t("Active Story")} className="grid max-h-80 grid-cols-3 content-start gap-2 overflow-y-auto rounded-lg border border-border p-2">
      {stories.map((story, index) => (
        <StoryTile
          key={`${story.id}:${story.thumbnailUrl ?? story.mediaUrl ?? ""}`}
          story={story}
          index={index}
          selected={selectedId === story.id}
          onSelect={() => onSelect(story.id)}
        />
      ))}
    </div>
  );
}
