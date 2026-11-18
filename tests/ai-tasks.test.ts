import { describe, expect, it } from "vitest";
import { appendTaskStep, awaitTaskInput, clearActiveTaskLink, createTask, finishTaskStep, getActiveTaskLink, getTask, resumeTaskWithTools, saveActiveTaskLink, taskStateEnabled, transitionTask } from "../lib/ai_tasks.js";

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
        const matches = item && Object.entries(filters).every(([key, value]) => {
          if (key === "admin_id") return id === value;
          if (key.startsWith("items->>")) return item[key.slice("items->>".length)] === value;
          return false;
        });
        if (!matches) {
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

  it("deduplicates a retried update by request key without replacing its task", async () => {
    const { db, rows } = fakeDb();
    const input = {
      ownerUserId: 10, ownerAdminId: 10, chatId: 10, intent: "planner_tool_plan", scope: "private_admin_chat",
      plan: ["tool:tra_cuu_case"], requestKey: "telegram:10:55:10",
    };
    const first = await createTask(db, input, true, NOW);
    const retry = await createTask(db, { ...input, plan: ["tool:tag_ctv"] }, true, new Date(NOW.getTime() + 1_000));
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.task.taskId).toBe(first.task.taskId);
    expect(retry.task.plan).toEqual(["tool:tra_cuu_case"]);
    expect(rows.size).toBe(1);
  });

  it("keeps planner drafts non-executable until a later validated state transition", async () => {
    const { db } = fakeDb();
    const created = await createTask(db, {
      ownerUserId: 10, ownerAdminId: 10, chatId: 10, intent: "planner_tool_plan", scope: "private_admin_chat",
      plan: ["tool:tag_ctv"], draft: true,
    }, true, NOW);
    if (!created.ok) throw new Error("draft creation failed");
    expect(created.task.status).toBe("DRAFT");
    expect(reasonOf(await transitionTask(db, created.task.taskId, 10, 10, "DRAFT", "RUNNING", {}, true, NOW)))
      .toBe("invalid_transition");
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

  it("records only allowlisted, owner-scoped tool outcomes with monotonic CAS revisions", async () => {
    const { db } = fakeDb();
    const created = await createTask(db, {
      ownerUserId: 10, ownerAdminId: 10, chatId: 10, intent: "workflow", scope: "private", plan: ["tool:lookup"],
    }, true, NOW);
    if (!created.ok) throw new Error("task creation failed");
    expect((await transitionTask(db, created.task.taskId, 10, 10, "PENDING", "RUNNING", {}, true, NOW)).ok).toBe(true);
    expect(reasonOf(await appendTaskStep(db, created.task.taskId, 11, 10, "lookup", new Set(["lookup"]), true, NOW))).toBe("not_found");
    expect(reasonOf(await appendTaskStep(db, created.task.taskId, 10, 10, "send_message", new Set(["lookup"]), true, NOW))).toBe("tool_not_allowed");
    expect((await appendTaskStep(db, created.task.taskId, 10, 10, "lookup", new Set(["lookup"]), true, NOW)).ok).toBe(true);
    const reloaded = await getTask(db, created.task.taskId, 10, 10, true, NOW);
    if (!reloaded.ok) throw new Error("task reload failed");
    expect(reloaded.task.stepStatuses).toEqual(["PENDING", "PENDING"]);
    expect(reloaded.task.updatedAt).not.toBe(created.task.updatedAt);
    expect((await finishTaskStep(db, created.task.taskId, 10, 10, 0, "COMPLETED", true, NOW)).ok).toBe(true);
    expect(reasonOf(await finishTaskStep(db, created.task.taskId, 10, 10, 0, "COMPLETED", true, NOW))).toBe("state_conflict");
  });

  it("resumes a clarification after reload only for the same owner and chat", async () => {
    const { db } = fakeDb();
    const created = await createTask(db, {
      ownerUserId: 10, ownerAdminId: 10, chatId: 10, intent: "lookup", scope: "private_admin_chat", plan: ["tool:tra_cuu_case"],
    }, true, NOW);
    if (!created.ok) throw new Error("task creation failed");
    expect((await transitionTask(db, created.task.taskId, 10, 10, "PENDING", "RUNNING", {}, true, NOW)).ok).toBe(true);
    const awaiting = await awaitTaskInput(db, created.task.taskId, 10, 10, 0, true, NOW);
    expect(awaiting.ok).toBe(true);
    expect((await saveActiveTaskLink(db, created.task.taskId, 10, 10, 0, true, NOW)).ok).toBe(true);

    expect((await getActiveTaskLink(db, 11, 10, true, NOW)).ok).toBe(false);
    expect((await getActiveTaskLink(db, 10, 11, true, NOW)).ok).toBe(false);
    expect((await getActiveTaskLink(db, 10, 10, true, new Date(NOW.getTime() + 10 * 60_000))).ok).toBe(false);
    const reloaded = await getActiveTaskLink(db, 10, 10, true, NOW);
    expect(reloaded).toEqual({ ok: true, link: { taskId: created.task.taskId, pendingStepIndex: 0 } });

    const resumed = await resumeTaskWithTools(db, created.task.taskId, 10, 10, 0, ["tra_cuu_case"], new Set(["tra_cuu_case"]), true, new Date(NOW.getTime() + 60_000));
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.stepIndexes).toEqual([0]);
    expect((await finishTaskStep(db, created.task.taskId, 10, 10, 0, "COMPLETED", true, new Date(NOW.getTime() + 61_000))).ok).toBe(true);
    expect((await transitionTask(db, created.task.taskId, 10, 10, "RUNNING", "COMPLETED", {}, true, new Date(NOW.getTime() + 62_000))).ok).toBe(true);
    expect(await clearActiveTaskLink(db, created.task.taskId, 10, 10, true)).toBe(true);
    expect((await getActiveTaskLink(db, 10, 10, true, new Date(NOW.getTime() + 62_000))).ok).toBe(false);
  });
});
