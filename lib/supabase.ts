// Supabase logger. Obtains a client and inserts one log row into the
// pre-existing bot_account_logs table. Never runs schema migrations.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { LogRecord, UserRecord } from "./types.js";

export function getClient(url: string, key: string): SupabaseClient {
  return createClient(url, key);
}

// Inserts exactly one row into bot_account_logs. Resolves { ok: false, error }
// on failure instead of throwing, so a logging failure never derails the
// Telegram-facing flow.
export async function insertLog(
  client: SupabaseClient,
  record: LogRecord
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await client.from("bot_account_logs").insert(record);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Upserts one row into telegram_users_qll keyed by telegram_id, so each user
// is stored exactly once and re-seeing them updates their latest info. Resolves
// { ok: false, error } on failure instead of throwing. Never runs migrations.
export async function upsertUser(
  client: SupabaseClient,
  record: UserRecord
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await client
      .from("telegram_users_qll")
      .upsert({ ...record, updated_at: new Date().toISOString() }, {
        onConflict: "telegram_id",
      });
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
