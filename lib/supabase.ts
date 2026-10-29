// Supabase logger. Obtains a client and inserts one log row into the
// pre-existing bot_account_logs table. Never runs schema migrations.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  LogRecord,
  MappedItem,
  SendQueueRow,
  UserRecord,
} from "./types.js";

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

// Lists all known QLL as {username, full_name}, dropping rows with no username.
// Used to feed mapQllByUser so a registered full name maps to its username even
// when the derived-core rule would miss (e.g. username has a trailing number).
export async function listKnownUsers(
  client: SupabaseClient
): Promise<{
  ok: boolean;
  users: { username: string; full_name: string }[];
  error?: string;
}> {
  try {
    const { data, error } = await client
      .from("telegram_users_qll")
      .select("username, full_name");
    if (error) {
      return { ok: false, users: [], error: error.message };
    }
    const users = ((data as { username: string | null; full_name: string | null }[] | null) ?? [])
      .filter((r) => typeof r.username === "string" && r.username.trim() !== "")
      .map((r) => ({ username: r.username as string, full_name: r.full_name ?? "" }));
    return { ok: true, users };
  } catch (err) {
    return {
      ok: false,
      users: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Returns whether a username already exists in telegram_users_qll
// (case-insensitive), and the stored full_name if found. Used by /adduser to
// avoid creating a duplicate QLL row and to report "đã có".
export async function findUserByUsername(
  client: SupabaseClient,
  username: string
): Promise<{ ok: boolean; exists: boolean; fullName?: string; error?: string }> {
  const stripped = username.trim().replace(/^@/, "");
  try {
    const { data, error } = await client
      .from("telegram_users_qll")
      .select("username, full_name")
      .ilike("username", stripped)
      .limit(1);
    if (error) {
      return { ok: false, exists: false, error: error.message };
    }
    const row = (data as { full_name: string | null }[] | null)?.[0];
    if (row) {
      return { ok: true, exists: true, fullName: row.full_name ?? "" };
    }
    return { ok: true, exists: false };
  } catch (err) {
    return {
      ok: false,
      exists: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Slow drip-send queue (table: send_queue) -------------------------------
// Pre-created by the operator; the bot never migrates it:
//   send_queue ( id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//                admin_id bigint, chat_id bigint, message_text text,
//                sent boolean DEFAULT false, created_at timestamptz DEFAULT now(),
//                sent_at timestamptz )
// All helpers below are non-throwing like insertLog/upsertUser.

// Inserts many queue rows in one call. An empty rows array is a no-op success
// (no insert issued) so /ok with zero mapped items is safe.
export async function enqueueMessages(
  client: SupabaseClient,
  rows: {
    admin_id: number;
    chat_id: number;
    message_text: string;
    send_after?: string | null;
  }[]
): Promise<{ ok: boolean; error?: string }> {
  if (rows.length === 0) {
    return { ok: true };
  }
  try {
    const { error } = await client.from("send_queue").insert(rows);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Returns the oldest `limit` unsent rows (created_at ascending). On error
// returns an empty list so the cron simply does nothing this run.
export async function fetchNextUnsent(
  client: SupabaseClient,
  limit: number
): Promise<{ ok: boolean; rows: SendQueueRow[]; error?: string }> {
  try {
    // Due = not sent AND (no schedule OR the scheduled time has arrived).
    // Evaluated server-side against "now" so scheduled rows stay invisible
    // until their send_after instant passes.
    const { data, error } = await client
      .from("send_queue")
      .select("id, admin_id, chat_id, message_text")
      .eq("sent", false)
      .or("send_after.is.null,send_after.lte." + new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) {
      return { ok: false, rows: [], error: error.message };
    }
    const rows = (data as SendQueueRow[] | null) ?? [];
    return { ok: true, rows };
  } catch (err) {
    return {
      ok: false,
      rows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Marks a single queue row as sent, stamping sent_at with the current time.
export async function markSent(
  client: SupabaseClient,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await client
      .from("send_queue")
      .update({ sent: true, sent_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Atomically CLAIMS a queue row before sending: flips sent=false -> true only
// if it is still unsent, and reports whether THIS caller won the claim. This
// prevents double-sends when two overlapping cron runs both fetch the same
// row: only the winner (claimed=true) sends it; the loser skips. The .eq on
// both id AND sent=false makes the update a no-op for an already-claimed row.
export async function claimRow(
  client: SupabaseClient,
  id: string
): Promise<{ ok: boolean; claimed: boolean; error?: string }> {
  try {
    const { data, error } = await client
      .from("send_queue")
      .update({ sent: true, sent_at: new Date().toISOString() })
      .eq("id", id)
      .eq("sent", false)
      .select("id");
    if (error) {
      return { ok: false, claimed: false, error: error.message };
    }
    // data holds the rows actually updated; length 1 == we won the claim.
    const claimed = Array.isArray(data) && data.length === 1;
    return { ok: true, claimed };
  } catch (err) {
    return {
      ok: false,
      claimed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Reverts a claimed row back to unsent (used when the actual Telegram send
// FAILS after a successful claim), so the next cron run retries it.
export async function releaseRow(
  client: SupabaseClient,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await client
      .from("send_queue")
      .update({ sent: false, sent_at: null })
      .eq("id", id);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Deletes all UNSENT rows for one admin (sent=false), cancelling both a hẹn-giờ
// schedule and an in-progress drip. Already-sent rows are untouched. Returns
// the number of rows removed. Non-throwing.
export async function deleteUnsent(
  client: SupabaseClient,
  adminId: number
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    const { data, error } = await client
      .from("send_queue")
      .delete()
      .eq("admin_id", adminId)
      .eq("sent", false)
      .select("id");
    if (error) {
      return { ok: false, count: 0, error: error.message };
    }
    const count = Array.isArray(data) ? data.length : 0;
    return { ok: true, count };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Counts the remaining unsent rows, optionally scoped to one admin. A null
// count (nothing matched) is coalesced to 0. On error returns count 0.
export async function countUnsent(
  client: SupabaseClient,
  adminId?: number
): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    let query = client
      .from("send_queue")
      .select("id", { count: "exact", head: true })
      .eq("sent", false);
    if (adminId !== undefined) {
      query = query.eq("admin_id", adminId);
    }
    const { count, error } = await query;
    if (error) {
      return { ok: false, count: 0, error: error.message };
    }
    return { ok: true, count: count ?? 0 };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Derives a DETERMINISTIC NEGATIVE synthetic telegram_id from a username, used
// for manually-added QLL rows that have no real Telegram id. The username is
// normalized (leading '@' stripped, trimmed, lowercased) so the same person
// always maps to the same row (re-adding updates instead of duplicating). The
// value is a 32-bit FNV-1a hash forced strictly negative (≤ -1) so it never
// collides with Telegram's positive user ids — a later real auto-collection of
// the same person creates a separate positive-id row and both coexist.
export function manualUserId(username: string): number {
  const normalized = username.trim().replace(/^@/, "").toLowerCase();
  // FNV-1a 32-bit hash of the normalized string.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in uint32 range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  const positive = hash >>> 0; // force uint32 (0 .. 4294967295)
  return -(positive) - 1; // always ≤ -1, within JS safe-integer range
}

// Upserts one MANUALLY-added QLL into telegram_users_qll. Strips a leading '@'
// from the username, trims the full name, and uses a deterministic negative
// synthetic telegram_id (see manualUserId) so re-adding the same username
// updates the same row. chat_title is fixed to "manual" so these rows are
// distinguishable from auto-collected ones. Non-throwing like its neighbors.
export async function addUserManual(
  client: SupabaseClient,
  username: string,
  fullName: string,
  chatId: number
): Promise<{ ok: boolean; error?: string }> {
  const stripped = username.trim().replace(/^@/, "");
  const record: UserRecord = {
    telegram_id: manualUserId(stripped),
    username: stripped,
    full_name: fullName.trim(),
    chat_id: chatId,
    chat_title: "manual",
  };
  return upsertUser(client, record);
}

// Upserts one row into telegram_users_qll keyed by telegram_id, so each user
// is stored exactly once and re-seeing them updates their latest info. Resolves
// { ok: false, error } on failure instead of throwing. Never runs migrations.
export async function upsertUser(
  client: SupabaseClient,
  record: UserRecord
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Enforce one-row-per-username. If this username already exists (added
    // manually or previously auto-collected), UPDATE that row's info instead of
    // inserting a second row (which the DB's unique username index would reject
    // anyway). Only when the username is new do we insert a fresh row.
    const uname = (record.username ?? "").trim();
    if (uname !== "") {
      const { data: existing, error: findErr } = await client
        .from("telegram_users_qll")
        .select("telegram_id")
        .ilike("username", uname)
        .limit(1);
      if (!findErr && Array.isArray(existing) && existing.length === 1) {
        const { error: updErr } = await client
          .from("telegram_users_qll")
          .update({
            full_name: record.full_name,
            chat_id: record.chat_id,
            chat_title: record.chat_title,
            updated_at: new Date().toISOString(),
          })
          .ilike("username", uname);
        if (updErr) {
          return { ok: false, error: updErr.message };
        }
        return { ok: true };
      }
    }

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



// Sửa lại hàm insertQllCase trong file lib/supabase.ts thành thế này:
export async function insertQllCase(
  client: SupabaseClient, 
  record: { message_id: number; content: string; sender_name: string; shift_name: string; chat_id?: number }
): Promise<void> {
  await client.from("qll_tracking").insert({
    message_id: record.message_id,
    content: record.content,
    sender_name: record.sender_name,
    shift_name: record.shift_name,
    chat_id: -1002273179613, // 👈 Ép cứng chuẩn nhóm QLL Support ở đây
    handled: false
  });
}

export async function markCaseHandled(
  supabase: SupabaseClient,
  messageId: number
): Promise<void> {
  // Cập nhật cột 'handled' thành true trong bảng qll_tracking khi có reaction hoặc reply
  await supabase
    .from("qll_tracking")
    .update({ handled: true })
    .eq("message_id", messageId);
}

// Lấy danh sách miss và đánh dấu đã báo cáo
export async function getAndMarkMissedCases(client: SupabaseClient) {
  const { data } = await client.from("qll_tracking")
    .select("*")
    .eq("handled", false)
    .eq("reported", false)
    .gte("created_at", new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString());
  
  if (data && data.length > 0) {
    const ids = data.map((c: any) => c.message_id);
    await client.from("qll_tracking").update({ reported: true }).in("message_id", ids);
  }
  return data || [];
}
