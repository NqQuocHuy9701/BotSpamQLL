// Pure parser for the admin's /ok command, with optional "hẹn giờ" scheduling.
//
// The admin may schedule WHEN a confirmed batch starts sending, expressed in
// Vietnam wall-clock time (fixed UTC+7, no DST):
//   /ok            -> send now (unchanged)
//   /ok 21:00      -> start at 21:00 TODAY VN; if already past, roll to tomorrow
//   /ok 16/10 21:00-> 21:00 on 16 Oct (dd/mm) of the current VN year; if past,
//                     roll to next year
//
// No timezone library is used: VN→UTC is a fixed −7h shift computed with
// Date.UTC + millisecond arithmetic, which handles date/month/year rollover
// automatically. `now` is injectable so tests are fully deterministic.

// Vietnam is a fixed UTC+7 offset (no daylight saving).
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export type ParseResult =
  | { kind: "now" }
  | { kind: "at"; sendAfterIso: string }
  | { kind: "invalid"; reason: string };

// Friendly Vietnamese reason shown to the admin when the time/date is invalid.
const INVALID_REASON =
  "Giờ hẹn không hợp lệ. Dùng: /ok, hoặc /ok 21:00, hoặc /ok 16/10 21:00.";

// Converts a VN wall-clock (year, month 1-12, day, hour, minute) to the UTC
// instant it refers to, returned as an ISO string. VN is UTC+7, so the UTC
// instant is 7 hours BEFORE the same wall-clock read as UTC. Date.UTC plus the
// millisecond subtraction normalizes any date/month/year rollover.
function vnWallClockToUtcIso(
  year: number,
  month1to12: number,
  day: number,
  hour: number,
  minute: number
): string {
  const utcMs = Date.UTC(year, month1to12 - 1, day, hour, minute) - VN_OFFSET_MS;
  return new Date(utcMs).toISOString();
}

// Reads `now` as VN wall-clock parts. Shifting the instant forward by the VN
// offset and then reading the UTC getters yields VN local Y/M/D/h/m.
function vnPartsOf(now: Date): {
  year: number;
  month1to12: number;
  day: number;
} {
  const shifted = new Date(now.getTime() + VN_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month1to12: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

// Formats a UTC ISO instant as "HH:MM dd/mm" in VN time, for confirmations.
export function formatVnDateTime(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + VN_OFFSET_MS);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${hh}:${mm} ${dd}/${mo}`;
}

function isValidHourMinute(hour: number, minute: number): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

// Builds the next occurrence of HH:MM VN relative to `now`: today's VN date if
// that instant is still in the future, otherwise tomorrow VN.
function nextDailyOccurrenceIso(now: Date, hour: number, minute: number): string {
  const { year, month1to12, day } = vnPartsOf(now);
  let iso = vnWallClockToUtcIso(year, month1to12, day, hour, minute);
  if (new Date(iso).getTime() <= now.getTime()) {
    // Already passed today VN → same time tomorrow VN (Date.UTC rolls over).
    iso = vnWallClockToUtcIso(year, month1to12, day + 1, hour, minute);
  }
  return iso;
}

// Builds dd/mm HH:MM for the current VN year; if that instant already passed,
// uses next year.
function nextDatedOccurrenceIso(
  now: Date,
  day: number,
  month1to12: number,
  hour: number,
  minute: number
): string {
  const { year } = vnPartsOf(now);
  let iso = vnWallClockToUtcIso(year, month1to12, day, hour, minute);
  if (new Date(iso).getTime() <= now.getTime()) {
    iso = vnWallClockToUtcIso(year + 1, month1to12, day, hour, minute);
  }
  return iso;
}

// Parses the admin's /ok command. `now` is injectable for deterministic tests.
export function parseOkCommand(
  text: string,
  now: Date = new Date()
): ParseResult {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Must start with the /ok command token.
  if (lower !== "/ok" && !lower.startsWith("/ok ")) {
    // Caller only routes here on a /ok prefix, but stay defensive: a bare
    // "/oksomething" (no space) is not a valid /ok command.
    if (!lower.startsWith("/ok")) {
      return { kind: "invalid", reason: INVALID_REASON };
    }
  }

  // The argument is everything after the leading "/ok", whitespace-collapsed.
  const arg = trimmed.slice(3).replace(/\s+/g, " ").trim();
  if (arg === "") {
    return { kind: "now" };
  }

  // HH:MM form.
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(arg);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (!isValidHourMinute(hour, minute)) {
      return { kind: "invalid", reason: INVALID_REASON };
    }
    return { kind: "at", sendAfterIso: nextDailyOccurrenceIso(now, hour, minute) };
  }

  // dd/mm HH:MM form.
  const dateMatch = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(arg);
  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const hour = Number(dateMatch[3]);
    const minute = Number(dateMatch[4]);
    if (
      day < 1 ||
      day > 31 ||
      month < 1 ||
      month > 12 ||
      !isValidHourMinute(hour, minute)
    ) {
      return { kind: "invalid", reason: INVALID_REASON };
    }
    return {
      kind: "at",
      sendAfterIso: nextDatedOccurrenceIso(now, day, month, hour, minute),
    };
  }

  return { kind: "invalid", reason: INVALID_REASON };
}
