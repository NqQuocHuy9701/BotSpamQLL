// Supabase logger. Obtains a client and inserts one log row into the
// pre-existing bot_account_logs table. Never runs schema migrations.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { LogRecord, MappedItem, UserRecord } from "./types.js";

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

// --- Batch-announcement pending state (table: pending_batches) --------------
// The table is pre-created by the operator; the bot never migrates it:
//   pending_batches ( admin_id bigint PRIMARY KEY, items jsonb,
//                      created_at timestamptz DEFAULT now() )
// All helpers below are non-throwing like insertLog/upsertUser.

// Upserts the ready-to-send items for one admin, keyed by admin_id, so a fresh
// upload replaces any stale pending batch.
export async function savePendingBatch(
  client: SupabaseClient,
  adminId: number,
  items: MappedItem[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await client
      .from("pending_batches")
      .upsert({ admin_id: adminId, items }, { onConflict: "admin_id" });
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Loads the pending items for one admin. items is null when no row exists.
export async function loadPendingBatch(
  client: SupabaseClient,
  adminId: number
): Promise<{ ok: boolean; items: MappedItem[] | null; error?: string }> {
  try {
    const { data, error } = await client
      .from("pending_batches")
      .select("items")
      .eq("admin_id", adminId)
      .maybeSingle();
    if (error) {
      return { ok: false, items: null, error: error.message };
    }
    const items = (data?.items as MappedItem[] | undefined) ?? null;
    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      items: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Deletes the pending row for one admin (after a send or a cancel).
export async function deletePendingBatch(
  client: SupabaseClient,
  adminId: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await client
      .from("pending_batches")
      .delete()
      .eq("admin_id", adminId);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Lists all known usernames from telegram_users_qll, dropping null/empty
// values. Used at runtime to feed the pure QLL mapper.
export async function listUsernames(
  client: SupabaseClient
): Promise<{ ok: boolean; usernames: string[]; error?: string }> {
  try {
    const { data, error } = await client
      .from("telegram_users_qll")
      .select("username");
    if (error) {
      return { ok: false, usernames: [], error: error.message };
    }
    const usernames = ((data as { username: string | null }[] | null) ?? [])
      .map((r) => r.username)
      .filter((u): u is string => typeof u === "string" && u.trim() !== "");
    return { ok: true, usernames };
  } catch (err) {
    return {
      ok: false,
      usernames: [],
      error: err instanceof Error ? err.message : String(err),
    };
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
