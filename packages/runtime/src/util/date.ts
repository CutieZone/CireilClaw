import { loadSystem } from "$/config/index.js";

/**
 * Format a date as ISO 8601 with timezone offset.
 * If timezone is configured in system.toml, uses that timezone.
 * Otherwise uses system local time.
 * @param date The date to format (defaults to now)
 * @returns ISO 8601 string with timezone offset (e.g. "2026-03-12T14:30:00-05:00")
 */
export async function formatDate(date: Date = new Date()): Promise<string> {
  const systemCfg = await loadSystem();
  const { timezone } = systemCfg;

  if (timezone !== undefined) {
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
    return `${formatted.replace(", ", "T")}${tzOffset} (${weekday}, ${tzAbbr})`;
  }

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

  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date);
  const tzAbbr =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "";

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${offsetHours}:${offsetMinutes} (${weekday}, ${tzAbbr})`;
}
