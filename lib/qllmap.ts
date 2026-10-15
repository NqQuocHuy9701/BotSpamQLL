// Pure QLL-name -> Telegram-username mapping. No I/O: the known-username list
// is injected so the hard-to-get-right normalization rule can be unit-tested
// without a database. See .agents/tasks/batch-plan.md for the full rule.

// normalize(s): NFD, strip combining diacritics, map đ/Đ -> d, lowercase, and
// remove every character outside [a-z0-9].
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks
    .replace(/[đĐ]/g, "d") // Vietnamese stroked-d is NOT a combining mark
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// nameToCore(fullName): a Vietnamese name is "<Họ> <Đệm...> <Tên> [<Số>]".
// The LAST token is a trailing number when it is all digits (may be absent);
// the token before it is the given name (Tên); every leading token is a
// family/middle word. core = normalize(Tên) + normalize(initials of each
// family/middle word) + number.
// Example: "Nguyễn Hải Hà 3" -> "ha" + "nh" + "3" = "hanh3".
export function nameToCore(fullName: string): string {
  const tokens = fullName.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return "";
  }

  let number = "";
  if (/^\d+$/.test(tokens[tokens.length - 1])) {
    number = tokens.pop() as string;
  }
  if (tokens.length === 0) {
    return number;
  }

  const given = tokens.pop() as string; // Tên
  const familyMiddle = tokens; // leading words (may be empty)
  const initials = familyMiddle.map((w) => w.charAt(0)).join("");

  return normalize(given) + normalize(initials) + number;
}

// usernameToCore(username): strip a leading role prefix (SA/OP/VH) and an
// optional following underscore, then normalize the remainder.
// Example: "SA_HaNH3" -> "hanh3", "SAAnhPTH5" -> "anhpth5".
export function usernameToCore(username: string): string {
  const stripped = username.replace(/^(sa|op|vh)_?/i, "");
  return normalize(stripped);
}

export type QllMatch =
  | { kind: "found"; username: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "notFound" };

// A known QLL as stored: its Telegram username plus the full name on record
// (from auto-collection or a manual /adduser).
export interface KnownUser {
  username: string;
  full_name: string;
}

// mapQllByUser(name, users): the preferred mapper when full names are known.
// It FIRST tries an exact normalized full-name match (so a manually-added QLL
// like "Nguyễn Khánh Uyên" -> @SA_Uyennk86 resolves even though the username
// carries a trailing number the name does not). Only if no full-name matches
// does it fall back to the derived-core rule (mapQll). This makes /adduser
// authoritative: whatever name you registered maps to its username verbatim.
export function mapQllByUser(name: string, users: KnownUser[]): QllMatch {
  const wanted = normalize(name);
  if (wanted !== "") {
    const byName = users.filter((u) => normalize(u.full_name) === wanted);
    if (byName.length === 1) {
      return { kind: "found", username: byName[0].username };
    }
    if (byName.length >= 2) {
      // Same registered name on multiple usernames: let the caller disambiguate
      // rather than guess.
      return { kind: "ambiguous", candidates: byName.map((u) => u.username) };
    }
  }
  // No exact full-name hit -> fall back to the derived-core rule.
  return mapQll(name, users.map((u) => u.username));
}

// mapQll(name, knownUsernames): compute the name's core and collect every known
// username whose core matches exactly. 0 -> notFound, 1 -> found, >=2 ->
// ambiguous. Exact-core equality only (no fuzzy matching, per spec).
export function mapQll(name: string, knownUsernames: string[]): QllMatch {
  const target = nameToCore(name);
  if (target === "") {
    return { kind: "notFound" };
  }

  const candidates = knownUsernames.filter(
    (u) => usernameToCore(u) === target
  );

  if (candidates.length === 0) {
    return { kind: "notFound" };
  }
  if (candidates.length === 1) {
    return { kind: "found", username: candidates[0] };
  }
  return { kind: "ambiguous", candidates };
}
