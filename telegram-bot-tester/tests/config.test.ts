import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, PRICING_USD_PER_MTOK } from "../src/config.js";

describe("loadConfig", () => {
  beforeEach(() => {
    // Point mergeDotenv() at a non-existent path so tests are isolated from
    // any real telegram-bot-tester/.env a developer may have on disk.
    process.env.TESTER_DOTENV_PATH =
      "/tmp/nonexistent-tester-env-do-not-create";
    delete process.env.TG_API_ID;
    delete process.env.TG_API_HASH;
    delete process.env.TG_PHONE;
    delete process.env.TG_BOT_USERNAME;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ACTOR_MODEL;
    delete process.env.JUDGE_MODEL;
    delete process.env.MAX_TURNS;
    delete process.env.PER_TURN_TIMEOUT_MS;
    delete process.env.SCENARIO_TIMEOUT_MS;
    delete process.env.COST_CAP_USD;
  });

  it("fails with missing required vars", () => {
    expect(() => loadConfig()).toThrow(/TG_API_ID/);
  });

  it("loads minimal valid config", () => {
    process.env.TG_API_ID = "12345";
    process.env.TG_API_HASH = "abc123";
    process.env.TG_PHONE = "+359888000000";
    process.env.TG_BOT_USERNAME = "mertm_sklad_bot";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = loadConfig();
    expect(cfg.tg.apiId).toBe(12345);
    expect(cfg.tg.botUsername).toBe("mertm_sklad_bot");
    expect(cfg.maxTurns).toBe(12); // default
    expect(cfg.actorModel).toContain("haiku");
  });

  it("respects MAX_TURNS override", () => {
    process.env.TG_API_ID = "12345";
    process.env.TG_API_HASH = "abc";
    process.env.TG_PHONE = "+359";
    process.env.TG_BOT_USERNAME = "b";
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.MAX_TURNS = "20";
    const cfg = loadConfig();
    expect(cfg.maxTurns).toBe(20);
  });

  it("rejects non-integer MAX_TURNS", () => {
    process.env.TG_API_ID = "12345";
    process.env.TG_API_HASH = "abc";
    process.env.TG_PHONE = "+359";
    process.env.TG_BOT_USERNAME = "b";
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.MAX_TURNS = "not-a-number";
    expect(() => loadConfig()).toThrow(/MAX_TURNS/);
  });

  it("strips leading @ from TG_BOT_USERNAME", () => {
    process.env.TG_API_ID = "12345";
    process.env.TG_API_HASH = "abc";
    process.env.TG_PHONE = "+359";
    process.env.TG_BOT_USERNAME = "@mertm_sklad_bot";
    process.env.ANTHROPIC_API_KEY = "k";
    const cfg = loadConfig();
    expect(cfg.tg.botUsername).toBe("mertm_sklad_bot");
  });
});

describe("PRICING_USD_PER_MTOK", () => {
  it("has Haiku and Sonnet entries", () => {
    expect(PRICING_USD_PER_MTOK["claude-haiku-4-5-20251001"]).toBeDefined();
    expect(PRICING_USD_PER_MTOK["claude-sonnet-4-6"]).toBeDefined();
  });

  it("Haiku is cheaper than Sonnet", () => {
    const h = PRICING_USD_PER_MTOK["claude-haiku-4-5-20251001"];
    const s = PRICING_USD_PER_MTOK["claude-sonnet-4-6"];
    expect(h.input).toBeLessThan(s.input);
    expect(h.output).toBeLessThan(s.output);
  });
});
