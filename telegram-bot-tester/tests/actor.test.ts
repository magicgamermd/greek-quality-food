import { describe, it, expect, vi } from "vitest";
import { runActor } from "../src/actor/actor.js";
import type { TelegramClientHandle } from "../src/telegram/client.js";
import type { Persona, Scenario } from "../src/types.js";

function stubTg(): TelegramClientHandle {
  const sent: string[] = [];
  const replies = ["Здравей! Как мога да помогна?", "Избери от менюто."];
  let idx = 0;
  return {
    start: vi.fn(),
    startInteractiveLogin: vi.fn(),
    sendMessage: vi.fn(async (t: string) => {
      sent.push(t);
    }),
    waitForReply: vi.fn(async () => {
      const text = replies[idx] ?? "…";
      idx++;
      return { text, receivedAt: new Date(), messageId: idx };
    }),
    clickButton: vi.fn(async () => ({ messageId: 1, callbackData: "x" })),
    reset: vi.fn(),
    stop: vi.fn(),
  };
}

const persona: Persona = {
  id: "p",
  name: "Тест",
  description: "…",
  style: { verbosity: "short", tone: "casual", typos: "never", emoji: "never" },
  example_utterances: ["hi"],
};

const scenario: Scenario = {
  id: "s",
  title: "s",
  category: "orders",
  persona: "p",
  goal: "Say hi",
  success_criteria: ["Bot replies"],
  forbidden_behaviors: [],
  max_turns: 5,
  tags: [],
};

function fakeAnthropic(
  sequence: Array<{
    stop_reason: string;
    content: unknown[];
    usage: { input_tokens: number; output_tokens: number };
  }>,
) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const r = sequence[i++];
        if (!r) throw new Error("sequence exhausted");
        return r;
      }),
    },
  } as unknown as import("@anthropic-ai/sdk").default;
}

describe("runActor", () => {
  it("loops send_message → goal_achieved and returns result", async () => {
    const tg = stubTg();
    const anthropic = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_message",
            input: { text: "Здравей" },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "goal_achieved",
            input: { summary: "bot replied" },
          },
        ],
        usage: { input_tokens: 120, output_tokens: 8 },
      },
    ]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    expect(result.endedBy).toBe("goal_achieved");
    expect(result.endReason).toBe("bot replied");
    expect(result.turnsUsed).toBe(1);
    expect(
      result.transcript.some(
        (t) => t.kind === "sent_to_bot" && t.text === "Здравей",
      ),
    ).toBe(true);
    expect(result.transcript.some((t) => t.kind === "bot_reply")).toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(tg.sendMessage).toHaveBeenCalledWith("Здравей");
  });

  it("hits max_turns when actor keeps sending", async () => {
    const tg = stubTg();
    const sendOnce = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "t",
          name: "send_message",
          input: { text: "x" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const anthropic = fakeAnthropic([sendOnce, sendOnce, sendOnce]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 2,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    expect(result.endedBy).toBe("max_turns");
    expect(result.turnsUsed).toBe(2);
  });

  it("handles give_up", async () => {
    const tg = stubTg();
    const anthropic = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t",
            name: "give_up",
            input: { reason: "stuck" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    expect(result.endedBy).toBe("give_up");
    expect(result.endReason).toBe("stuck");
  });

  it("handles click_inline_button and waits for bot reply", async () => {
    const tg: TelegramClientHandle = {
      start: vi.fn(),
      startInteractiveLogin: vi.fn(),
      sendMessage: vi.fn(),
      waitForReply: vi.fn(async () => ({
        text: "Товарителницата е готова",
        receivedAt: new Date(),
        messageId: 99,
        document: {
          fileName: "tovaritelnica-42.pdf",
          mimeType: "application/pdf",
          size: 12345,
        },
      })),
      clickButton: vi.fn(async () => ({
        messageId: 42,
        callbackData: "waybill_42",
      })),
      reset: vi.fn(),
      stop: vi.fn(),
    };
    const anthropic = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "c1",
            name: "click_inline_button",
            input: { button_text: "Товарителница" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "g1",
            name: "goal_achieved",
            input: { summary: "клик сработи" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    expect(result.endedBy).toBe("goal_achieved");
    expect(tg.clickButton).toHaveBeenCalledWith("Товарителница");
    const clickedTurn = result.transcript.find(
      (t) => t.kind === "clicked_button",
    );
    expect(clickedTurn).toBeDefined();
    if (clickedTurn && clickedTurn.kind === "clicked_button") {
      expect(clickedTurn.buttonText).toBe("Товарителница");
      expect(clickedTurn.callbackData).toBe("waybill_42");
      expect(clickedTurn.messageId).toBe(42);
    }
    const replyTurn = result.transcript.find((t) => t.kind === "bot_reply");
    expect(replyTurn).toBeDefined();
    if (replyTurn && replyTurn.kind === "bot_reply") {
      expect(replyTurn.document?.fileName).toBe("tovaritelnica-42.pdf");
    }
  });

  it("reports click_inline_button failures as error turns", async () => {
    const tg: TelegramClientHandle = {
      start: vi.fn(),
      startInteractiveLogin: vi.fn(),
      sendMessage: vi.fn(),
      waitForReply: vi.fn(),
      clickButton: vi.fn(async () => {
        throw new Error('Button "XYZ" not found. Available: "Товарителница"');
      }),
      reset: vi.fn(),
      stop: vi.fn(),
    };
    const anthropic = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "c1",
            name: "click_inline_button",
            input: { button_text: "XYZ" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "gu",
            name: "give_up",
            input: { reason: "button mismatch" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    expect(result.endedBy).toBe("give_up");
    const errorTurn = result.transcript.find((t) => t.kind === "error");
    expect(errorTurn).toBeDefined();
    expect(
      errorTurn &&
        "error" in errorTurn &&
        errorTurn.error.includes("click_inline_button failed"),
    ).toBe(true);
    expect(tg.waitForReply).not.toHaveBeenCalled();
  });

  it("propagates document and buttons from send_message reply into transcript", async () => {
    const tg: TelegramClientHandle = {
      start: vi.fn(),
      startInteractiveLogin: vi.fn(),
      sendMessage: vi.fn(),
      waitForReply: vi.fn(async () => ({
        text: "Фактура №42 е готова",
        receivedAt: new Date(),
        messageId: 7,
        document: {
          fileName: "faktura-42.pdf",
          mimeType: "application/pdf",
          size: 20480,
        },
        buttons: [
          { text: "Товарителница", callbackData: "waybill_42" },
          { text: "Изпрати имейл", callbackData: "email_ask_42" },
        ],
      })),
      clickButton: vi.fn(async () => ({ messageId: 7, callbackData: "x" })),
      reset: vi.fn(),
      stop: vi.fn(),
    };
    const anthropic = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "s1",
            name: "send_message",
            input: { text: "Фактура" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "g1",
            name: "goal_achieved",
            input: { summary: "ok" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    const replyTurn = result.transcript.find((t) => t.kind === "bot_reply");
    expect(replyTurn).toBeDefined();
    if (replyTurn && replyTurn.kind === "bot_reply") {
      expect(replyTurn.document?.fileName).toBe("faktura-42.pdf");
      expect(replyTurn.buttons).toHaveLength(2);
      expect(replyTurn.buttons?.[0].text).toBe("Товарителница");
    }
  });

  it("reports send_message failures as error turns, not timeouts", async () => {
    const sent: string[] = [];
    const tg: TelegramClientHandle = {
      start: vi.fn(),
      startInteractiveLogin: vi.fn(),
      sendMessage: vi.fn(async (t: string) => {
        sent.push(t);
        throw new Error("network down");
      }),
      waitForReply: vi.fn(async () => {
        throw new Error("should not be called");
      }),
      clickButton: vi.fn(async () => ({ messageId: 1, callbackData: "x" })),
      reset: vi.fn(),
      stop: vi.fn(),
    };
    const anthropic = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t",
            name: "send_message",
            input: { text: "hi" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "give_up",
            input: { reason: "send failed" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    const errorTurn = result.transcript.find((t) => t.kind === "error");
    expect(errorTurn).toBeDefined();
    expect(
      errorTurn &&
        "error" in errorTurn &&
        errorTurn.error.includes("send_message failed"),
    ).toBe(true);
    expect(result.transcript.some((t) => t.kind === "timeout")).toBe(false);
    expect(tg.waitForReply).not.toHaveBeenCalled();
  });
});
