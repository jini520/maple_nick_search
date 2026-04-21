export const DEFAULT_TIME_ZONE = "Asia/Seoul";

/**
 * Returns today's date in YYYY-MM-DD.
 * Default timezone is Asia/Seoul (KST).
 */
export function getTodayDateString(timeZone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
