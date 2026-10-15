// Reads and validates the required environment variables.

export interface Config {
  botToken: string;
  supabaseUrl: string;
  supabaseKey: string;
  // Master switch for the credential relay flow (delete + inbox + reply).
  // Defaults to FALSE so the bot never mutates the group unless RELAY_ENABLED
  // is explicitly set to "true". While false the bot only passively collects
  // users into telegram_users_qll.
  relayEnabled: boolean;
}

// Throws an Error naming the FIRST missing/empty variable.
export function loadConfig(): Config {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    throw new Error("Missing required environment variable: BOT_TOKEN");
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("Missing required environment variable: SUPABASE_URL");
  }

  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseKey) {
    throw new Error("Missing required environment variable: SUPABASE_KEY");
  }

  // Relay is OFF unless RELAY_ENABLED is exactly "true" (case-insensitive,
  // trimmed). Any other value — including unset — keeps the relay disabled.
  const relayEnabled =
    (process.env.RELAY_ENABLED ?? "").trim().toLowerCase() === "true";

  return { botToken, supabaseUrl, supabaseKey, relayEnabled };
}
