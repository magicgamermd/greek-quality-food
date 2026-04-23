import { describe, it, expect } from "vitest";
import {
  ACTOR_TOOLS,
  parseToolArgs,
  SendMessageArgsSchema,
  GoalAchievedArgsSchema,
  GiveUpArgsSchema,
} from "../src/actor/tools.js";

describe("ACTOR_TOOLS", () => {
  it("has exactly 5 tools", () => {
    expect(ACTOR_TOOLS).toHaveLength(5);
    const names = ACTOR_TOOLS.map((t) => t.name);
    expect(names).toContain("send_message");
    expect(names).toContain("read_latest_reply");
    expect(names).toContain("click_inline_button");
    expect(names).toContain("goal_achieved");
    expect(names).toContain("give_up");
  });
});

describe("parseToolArgs", () => {
  it("parses send_message args", () => {
    const parsed = parseToolArgs("send_message", { text: "hi" });
    expect(parsed).toEqual({ text: "hi" });
  });

  it("rejects send_message without text", () => {
    expect(() => parseToolArgs("send_message", {})).toThrow();
  });

  it("parses goal_achieved args", () => {
    const parsed = parseToolArgs("goal_achieved", { summary: "done" });
    expect(parsed).toEqual({ summary: "done" });
  });

  it("parses give_up args", () => {
    const parsed = parseToolArgs("give_up", { reason: "stuck" });
    expect(parsed).toEqual({ reason: "stuck" });
  });

  it("parses read_latest_reply with empty args", () => {
    const parsed = parseToolArgs("read_latest_reply", {});
    expect(parsed).toEqual({});
  });

  it("parses click_inline_button args", () => {
    const parsed = parseToolArgs("click_inline_button", {
      button_text: "Товарителница",
    });
    expect(parsed).toEqual({ button_text: "Товарителница" });
  });

  it("rejects click_inline_button without button_text", () => {
    expect(() => parseToolArgs("click_inline_button", {})).toThrow();
  });

  it("rejects click_inline_button with empty button_text", () => {
    expect(() =>
      parseToolArgs("click_inline_button", { button_text: "" }),
    ).toThrow();
  });

  it("throws on unknown tool", () => {
    expect(() => parseToolArgs("unknown", {})).toThrow(/unknown/);
  });
});
