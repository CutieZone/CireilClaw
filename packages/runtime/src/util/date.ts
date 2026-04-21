import { loadSystem } from "$/config/index.js";

function formatRelativeTime(ms: number): string {
  const diffSec = Math.floor(ms / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (Math.abs(diffSec) < 10) {
    return "just now";
  }

  if (diffSec > 0) {
    if (diffDay > 0) {
      return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
    }
    if (diffHour > 0) {
      return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
    }
    if (diffMin > 0) {
      return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
    }
    return `${diffSec} second${diffSec === 1 ? "" : "s"} ago`;
  }

  // Future dates
  const absSec = Math.abs(diffSec);
  const absMin = Math.abs(diffMin);
  const absHour = Math.abs(diffHour);
  const absDay = Math.abs(diffDay);

  if (absDay > 0) {
    return `in ${absDay} day${absDay === 1 ? "" : "s"}`;
  }
  if (absHour > 0) {
    return `in ${absHour} hour${absHour === 1 ? "" : "s"}`;
  }
  if (absMin > 0) {
    return `in ${absMin} minute${absMin === 1 ? "" : "s"}`;
  }
  return `in ${absSec} second${absSec === 1 ? "" : "s"}`;
}

/**
 * Format a date as ISO 8601 with timezone offset and a relative time hint.
 * If timezone is configured in system.toml, uses that timezone.
 * Otherwise uses system local time.
 * @param date The date to format (defaults to now)
 * @param now Reference date for calculating relative time (defaults to now)
 * @returns ISO 8601 string with timezone offset and relative hint (e.g. "2026-03-12T14:30:00-05:00 (Thursday, EST) [2 hours ago]")
 */
async function formatDate(date: Date = new Date(), now: Date = new Date()): Promise<string> {
  const systemCfg = await loadSystem();
  const { timezone } = systemCfg;

  let absolute: string | undefined = undefined;

  if (timezone === undefined) {
    // Use local time if no timezone specified
    const offset = -date.getTimezoneOffset();
    const offsetSign = offset >= 0 ? "+" : "-";
    const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, "0");

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");

    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
    }).format(date);
    const tzAbbr =
      new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value ?? "";

    absolute = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${offsetHours}:${offsetMinutes} (${weekday}, ${tzAbbr})`;
  } else {
    // Format the date-time in the target timezone
    const formatted = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric",
    }).format(date);

    // Get the timezone offset and short abbreviation for the target timezone at this specific time
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    }).formatToParts(date);

    const shortParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(date);

    const offsetPart = parts.find((part) => part.type === "timeZoneName");
    const offset = offsetPart?.value ?? "GMT";
    const tzAbbr = shortParts.find((part) => part.type === "timeZoneName")?.value ?? "";

    // Convert "GMT-05:00" or "GMT+08:00" to "-05:00" or "+08:00"
    const tzOffset = offset.replace("GMT", "");

    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
    }).format(date);

    // Replace the comma with T, append the offset, then weekday and tz abbreviation
    absolute = `${formatted.replace(", ", "T")}${tzOffset} (${weekday}, ${tzAbbr})`;
  }

  const relative = formatRelativeTime(now.getTime() - date.getTime());

  return `${absolute} [${relative}]`;
}

export { formatDate, formatRelativeTime };
