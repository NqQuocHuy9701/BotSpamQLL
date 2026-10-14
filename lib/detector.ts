// Sensitive-content detection for Telegram reply text.

// Normalize for comparison: NFD, strip combining marks (diacritics), lowercase.
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Returns true when the text contains a TK/MK keyword (case- and
// diacritic-insensitive, with colon variants) OR, after removing spaces,
// dashes, and dots, a continuous run of 8 or more digits.
export function isSensitive(text: string): boolean {
  const normalized = normalize(text);

  // Word-boundary-aware short tokens tk / mk (with optional colon/space),
  // so arbitrary words that merely contain those letters are not matched.
  if (/\b(tk|mk)\b/.test(normalized)) {
    return true;
  }

  // Full-phrase keywords (diacritics already stripped).
  if (normalized.includes("tai khoan") || normalized.includes("mat khau")) {
    return true;
  }

  // Numeric rule: strip spaces/dashes/dots, then look for 8+ digits in a row.
  const compact = text.replace(/[\s.\-]/g, "");
  if (/\d{8,}/.test(compact)) {
    return true;
  }

  return false;
}
