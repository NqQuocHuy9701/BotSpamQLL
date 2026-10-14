import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../lib/config.js";

const KEYS = ["BOT_TOKEN", "SUPABASE_URL", "SUPABASE_KEY"] as const;

describe("loadConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
    }
    process.env.BOT_TOKEN = "token-value";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_KEY = "key-value";
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("returns a Config when all vars are present", () => {
    expect(loadConfig()).toEqual({
      botToken: "token-value",
      supabaseUrl: "https://example.supabase.co",
      supabaseKey: "key-value",
    });
  });

  it("throws naming BOT_TOKEN when it is missing", () => {
    delete process.env.BOT_TOKEN;
    expect(() => loadConfig()).toThrow(/BOT_TOKEN/);
  });

  it("throws naming SUPABASE_URL when it is missing", () => {
    delete process.env.SUPABASE_URL;
    expect(() => loadConfig()).toThrow(/SUPABASE_URL/);
  });

  it("throws naming SUPABASE_KEY when it is missing", () => {
    delete process.env.SUPABASE_KEY;
    expect(() => loadConfig()).toThrow(/SUPABASE_KEY/);
  });

  it("throws naming the FIRST missing var when several are empty", () => {
    process.env.BOT_TOKEN = "";
    process.env.SUPABASE_URL = "";
    expect(() => loadConfig()).toThrow(/BOT_TOKEN/);
  });
});
