import { TelegramClient as GramTelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { Api } from "telegram";
import { readSession, writeSession } from "./session.js";
import { log } from "../logger.js";
import type { DocumentInfo, ButtonInfo } from "../types.js";

export type BotReply = {
  text: string;
  receivedAt: Date;
  messageId: number;
  document?: DocumentInfo;
  buttons?: ButtonInfo[];
};

export interface TelegramClientHandle {
  start(): Promise<void>;
  startInteractiveLogin(
    getPhone: () => Promise<string>,
    getCode: () => Promise<string>,
    getPassword: () => Promise<string | undefined>,
  ): Promise<void>;
  sendMessage(text: string): Promise<void>;
  waitForReply(opts?: { timeoutMs?: number }): Promise<BotReply>;
  clickButton(
    buttonText: string,
  ): Promise<{ messageId: number; callbackData: string }>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

type Config = {
  apiId: number;
  apiHash: string;
  phone: string;
  botUsername: string;
};

export function extractDocument(msg: Api.Message): DocumentInfo | undefined {
  const doc = msg.document;
  if (!doc) return undefined;
  const fileNameAttr = doc.attributes?.find(
    (a): a is Api.DocumentAttributeFilename =>
      a.className === "DocumentAttributeFilename",
  );
  return {
    fileName: fileNameAttr?.fileName ?? "unknown",
    mimeType: doc.mimeType ?? "application/octet-stream",
    size: Number(doc.size ?? 0),
  };
}

export function extractButtons(msg: Api.Message): ButtonInfo[] | undefined {
  const rm = msg.replyMarkup;
  if (!rm || rm.className !== "ReplyInlineMarkup") return undefined;
  const buttons: ButtonInfo[] = [];
  for (const row of rm.rows) {
    for (const btn of row.buttons) {
      if (btn.className === "KeyboardButtonCallback") {
        buttons.push({
          text: btn.text,
          callbackData: Buffer.from(btn.data).toString("utf-8"),
        });
      }
    }
  }
  return buttons.length > 0 ? buttons : undefined;
}

export function createTelegramClient(cfg: Config): TelegramClientHandle {
  const session = new StringSession(readSession());
  const gram = new GramTelegramClient(session, cfg.apiId, cfg.apiHash, {
    connectionRetries: 5,
  });

  let botEntity: Api.TypeInputPeer | null = null;
  const inbox: BotReply[] = [];
  let latestButtonsMessage: {
    messageId: number;
    buttons: ButtonInfo[];
  } | null = null;

  async function handleMessage(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    if (!msg) return;
    const senderId = msg.senderId?.toString();
    const botId =
      botEntity && "userId" in botEntity
        ? (botEntity as Api.InputPeerUser).userId.toString()
        : null;
    if (!senderId || !botId || senderId !== botId) return;

    const document = extractDocument(msg);
    const buttons = extractButtons(msg);
    const text = msg.message ?? "";
    if (!text && !document && !buttons) return;

    const reply: BotReply = {
      text,
      receivedAt: new Date(),
      messageId: msg.id,
      document,
      buttons,
    };
    inbox.push(reply);
    if (buttons && buttons.length > 0) {
      latestButtonsMessage = { messageId: msg.id, buttons };
    }
    log.debug("[tg] bot reply received", {
      len: text.length,
      hasDoc: !!document,
      buttonCount: buttons?.length ?? 0,
    });
  }

  async function sendMessage(text: string): Promise<void> {
    if (!botEntity) throw new Error("Bot entity not resolved");
    await gram.sendMessage(botEntity, { message: text });
    log.debug("[tg] sent", { len: text.length });
  }

  async function waitForReply(opts?: {
    timeoutMs?: number;
  }): Promise<BotReply> {
    const timeoutMs = opts?.timeoutMs ?? 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const msg = inbox.shift();
      if (msg) return msg;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for bot reply after ${timeoutMs}ms`);
  }

  async function clickButton(
    buttonText: string,
  ): Promise<{ messageId: number; callbackData: string }> {
    if (!botEntity) throw new Error("Bot entity not resolved");
    if (!latestButtonsMessage) {
      throw new Error("No recent bot message with inline buttons");
    }
    const exact = latestButtonsMessage.buttons.find(
      (b) => b.text === buttonText,
    );
    const match =
      exact ??
      latestButtonsMessage.buttons.find(
        (b) => b.text.toLowerCase() === buttonText.toLowerCase(),
      );
    if (!match) {
      const available = latestButtonsMessage.buttons
        .map((b) => `"${b.text}"`)
        .join(", ");
      throw new Error(
        `Button "${buttonText}" not found. Available: ${available}`,
      );
    }
    const { messageId } = latestButtonsMessage;
    await gram.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: botEntity,
        msgId: messageId,
        data: Buffer.from(match.callbackData, "utf-8"),
      }),
    );
    log.debug("[tg] clicked button", {
      messageId,
      text: match.text,
    });
    return { messageId, callbackData: match.callbackData };
  }

  async function reset(): Promise<void> {
    await sendMessage("/reset");
    try {
      await waitForReply({ timeoutMs: 5000 });
    } catch {
      // bot may or may not reply; don't fail
    }
    inbox.length = 0;
    latestButtonsMessage = null;
  }

  async function start(): Promise<void> {
    if (!readSession()) {
      throw new Error("No saved session. Run `npm run tester:login` first.");
    }
    await gram.connect();
    if (!(await gram.isUserAuthorized())) {
      throw new Error("Session exists but is not authorized. Re-run login.");
    }
    botEntity = await gram.getInputEntity(cfg.botUsername);
    gram.addEventHandler(handleMessage, new NewMessage({}));
    log.info("[tg] connected", { botUsername: cfg.botUsername });
  }

  async function startInteractiveLogin(
    getPhone: () => Promise<string>,
    getCode: () => Promise<string>,
    getPassword: () => Promise<string | undefined>,
  ): Promise<void> {
    await gram.start({
      phoneNumber: getPhone,
      phoneCode: getCode,
      password: async () => (await getPassword()) ?? "",
      onError: (err) => {
        log.error("[tg] login error", { error: String(err) });
      },
    });
    writeSession(gram.session.save() as unknown as string);
    log.info("[tg] session saved");
  }

  async function stop(): Promise<void> {
    await gram.disconnect();
    await gram.destroy();
  }

  return {
    start,
    startInteractiveLogin,
    sendMessage,
    waitForReply,
    clickButton,
    reset,
    stop,
  };
}
