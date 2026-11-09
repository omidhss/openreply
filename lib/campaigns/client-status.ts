import { useEffect, useState } from "react";

export function useCampaignTime() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function campaignStatus(campaign: { isActive: boolean; expiresAt?: string | null; scheduleStartsAt?: string | null }, now: number) {
  if (campaign.expiresAt && Date.parse(campaign.expiresAt) <= now) return "Expired";
  if (!campaign.isActive) return "Paused";
  if (campaign.scheduleStartsAt && Date.parse(campaign.scheduleStartsAt) > now) return "Scheduled";
  return "Active";
}
