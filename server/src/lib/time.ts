/** The current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** "YYYY-MM-DD" in `timeZone`. */
export function formatDate(iso: string, timeZone: string): string {
  return formatMeetupTime(iso, timeZone).slice(0, 10);
}

/** "YYYY-MM-DD HH:mm" in `timeZone`. */
export function formatMeetupTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}
