import { describe, expect, it } from "vitest";
import { createTask, getTask, taskStateEnabled, transitionTask } from "../lib/ai_tasks.js";

function fakeDb() {
  const rows = new Map<number, any>();
  const from = () => {
    const filters: Record<string, unknown> = {};
    let updateValue: any;
    const q: any = {
      insert: async (row: any) => {
        if (rows.has(row.admin_id)) return { error: { code: "23505" } };
        rows.set(row.admin_id, row.items);
        return { error: null };
      },
      select: () => q,
      update: (value: any) => ((updateValue = value), q),
      eq: (k: string, v: unknown) => ((filters[k] = v), q),
      maybeSingle: async () => {
        const item = rows.get(filters.admin_id as number);
        return item ? { data: { items: item }, error: null } : { data: null, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => {
        const id = filters.admin_id as number;
        const item = rows.get(id);
        if (!item || item.status !== filters["items->>status"]) {
          return resolve({ data: [], error: null });
        }
        rows.set(id, updateValue.items);
        return resolve({ data: [{ items: updateValue.items }], error: null });
      },
    };
    return q;
  };
  return { db: { from } as any, rows };
}

const NOW = new Date("2026-11-18T03:00:00Z");
const reasonOf = (result: { ok: true } | { ok: false; reason: string }) =>
  result.ok ? "unexpected_success" : result.reason;

describe("AI Task State (disabled by default, no side effects)", () => {
  it("keeps feature flag off unless explicitly enabled", () => {
    expect(taskStateEnabled({})).toBe(false);
    expect(taskStateEnabled({ AI_TASK_STATE_ENABLED: "true" })).toBe(true);
  });

  it("does not write when disabled", async () => {
    const { db, rows } = fakeDb();
    const result = await createTask(db, {
      ownerUserId: 10, chatId: 10, intent: "lookup", scope: "private", plan: ["read"],
    }, false, NOW);
    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(rows.size).toBe(0);
  });

  it("creates a task with bounded expiry and recovers it after reload", async () => {
    const { db } = fakeDb();
    const result = await createTask(db, {
      ownerUserId: 10, chatId: 10, intent: "lookup", scope: "private", plan: ["read"], ttlMs: 5_000,
    }, true, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Date.parse(result.task.expiresAt) - NOW.getTime()).toBe(30_000);
    expect((await getTask(db, result.task.taskId, 10, 10, true, NOW)).ok).toBe(true);
  });

  it("rejects a different owner, chat scope, and expired task", async () => {
    const { db } = fakeDb();
    const result = await createTask(db, {
      ownerUserId: 10, chatId: -1001, groupId: -1001, intent: "lookup", scope: "group", plan: ["read"], ttlMs: 30_000,
    }, true, NOW);
    if (!result.ok) throw new Error("task creation failed");
    expect(reasonOf(await getTask(db, result.task.taskId, 11, -1001, true, NOW))).toBe("not_found");
    expect(reasonOf(await getTask(db, result.task.taskId, 10, -1002, true, NOW))).toBe("not_found");
    expect(reasonOf(await getTask(db, result.task.taskId, 10, -1001, true, new Date(NOW.getTime() + 30_000)))).toBe("expired");
  });

  it("requires the owner admin and unchanged payload hash to approve", async () => {
    const { db } = fakeDb();
    const result = await createTask(db, {
      ownerUserId: 10, ownerAdminId: 10, chatId: 10, intent: "post", scope: "private",
      plan: ["preview", "send"], payloadHash: "hash-a", requiresApproval: true,
    }, true, NOW);
    if (!result.ok) throw new Error("task creation failed");
    expect(reasonOf(await transitionTask(db, result.task.taskId, 10, 10, "AWAITING_APPROVAL", "APPROVED", {
      payloadHash: "hash-b", approvalActorId: 10,
    }, true, NOW))).toBe("approval_mismatch");
    const approved = await transitionTask(db, result.task.taskId, 10, 10, "AWAITING_APPROVAL", "APPROVED", {
      payloadHash: "hash-a", approvalActorId: 10,
    }, true, NOW);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(reasonOf(await transitionTask(db, result.task.taskId, 11, 10, "APPROVED", "EXECUTING", {}, true, NOW))).toBe("not_found");
  });

  it("uses compare-and-set state transitions to reject duplicate claims", async () => {
    const { db } = fakeDb();
    const result = await createTask(db, {
      ownerUserId: 10, chatId: 10, intent: "lookup", scope: "private", plan: ["read"],
    }, true, NOW);
    if (!result.ok) throw new Error("task creation failed");
    expect((await transitionTask(db, result.task.taskId, 10, 10, "PENDING", "RUNNING", {}, true, NOW)).ok).toBe(true);
    expect(reasonOf(await transitionTask(db, result.task.taskId, 10, 10, "PENDING", "RUNNING", {}, true, NOW))).toBe("state_conflict");
  });
});
