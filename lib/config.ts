// Reads and validates the required environment variables.

export interface Config {
  botToken: string;
  supabaseUrl: string;
  supabaseKey: string;
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

  return { botToken, supabaseUrl, supabaseKey };
}
