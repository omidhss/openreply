export const CAMPAIGN_TIME_ZONE = "Europe/Rome";

const formatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: CAMPAIGN_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  hourCycle: "h23",
});

export function formatRomeInput(date: Date) {
  return formatter.format(date).replace(" ", "T");
}

// Rome uses UTC+01:00 or UTC+02:00 for modern dates. Round-trip both offsets
// so a skipped or repeated wall time is rejected instead of silently shifted.
export function parseRomeInput(value: string): Date | null {
  if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const utc = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(utc)) return null;
  const matches = [1, 2].map((hours) => new Date(utc - hours * 3_600_000))
    .filter((date) => formatRomeInput(date) === value);
  return matches.length === 1 ? matches[0] : null;
}
