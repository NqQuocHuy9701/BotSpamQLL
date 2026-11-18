import { describe, expect, it } from "vitest";
import { parseShadowPlan, plannerShadowEnabled } from "../lib/ai_planner.js";

const allowed = new Set(["tra_cuu_case", "xem_checkin", "tag_ctv"]);

describe("AI planner shadow output validation", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(plannerShadowEnabled({})).toBe(false);
    expect(plannerShadowEnabled({ AI_PLANNER_SHADOW: "TRUE" })).toBe(true);
    expect(plannerShadowEnabled({ AI_PLANNER_SHADOW: "1" })).toBe(false);
  });

  it("rejects malformed or incomplete output", () => {
    expect(parseShadowPlan("not json", allowed)).toBeNull();
    expect(parseShadowPlan("[]", allowed)).toBeNull();
    expect(parseShadowPlan('{"intent":"lookup"}', allowed)).toBeNull();
  });

  it("keeps only allowed tool names and bounds planner fields", () => {
    const raw = JSON.stringify({
      intent: "x".repeat(300),
      missing_data: ["a".repeat(150), "", "b", "c", "d", "e", "f"],
      steps: [
        { tool: "tra_cuu_case", purpose: "lookup" },
        { tool: "send_external_message", purpose: "must not be executable" },
        ...Array.from({ length: 8 }, () => ({ tool: "tag_ctv", purpose: "tag" })),
      ],
      risk: "unexpected",
    });
    const parsed = parseShadowPlan(raw, allowed);
    expect(parsed?.intent).toHaveLength(120);
    expect(parsed?.missingData).toHaveLength(5);
    expect(parsed?.missingData[0]).toHaveLength(100);
    expect(parsed?.steps).toHaveLength(6);
    expect(parsed?.steps[0].tool).toBe("tra_cuu_case");
    expect(parsed?.steps[1].tool).toBeNull();
    expect(parsed?.risk).toBe("unknown");
  });
});
