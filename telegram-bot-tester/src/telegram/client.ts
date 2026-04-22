import { TelegramClient as GramTelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { Api } from "telegram";
import { readSession, writeSession } from "./session.js";
import { log } from "../logger.js";

export interface TelegramClientHandle {
  start(): Promise<void>;
  startInteractiveLogin(
    getPhone: () => Promise<string>,
    getCode: () => Promise<string>,
    getPassword: () => Promise<string | undefined>,
  ): Promise<void>;
  sendMessage(text: string): Promise<void>;
  waitForReply(opts?: {
    timeoutMs?: number;
  }): Promise<{ text: string; receivedAt: Date; messageId: number }>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

type Config = {
  apiId: number;
  apiHash: string;
  phone: string;
  botUsername: string;
};

export function createTelegramClient(cfg: Config): TelegramClientHandle {
  const session = new StringSession(readSession());
  const gram = new GramTelegramClient(session, cfg.apiId, cfg.apiHash, {
    connectionRetries: 5,
  });

  let botEntity: Api.TypeInputPeer | null = null;
  const inbox: Array<{ text: string; receivedAt: Date; messageId: number }> =
    [];

  async function handleMessage(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    if (!msg || !msg.message) return;
    // Only accept messages from the target bot
    const senderId = msg.senderId?.toString();
    const botId =
      botEntity && "userId" in botEntity
        ? (botEntity as Api.InputPeerUser).userId.toString()
        : null;
    if (!senderId || !botId || senderId !== botId) return;
    inbox.push({
      text: msg.message,
      receivedAt: new Date(),
      messageId: msg.id,
    });
    log.debug("[tg] bot reply received", { len: msg.message.length });
  }

  async function sendMessage(text: string): Promise<void> {
    if (!botEntity) throw new Error("Bot entity not resolved");
    await gram.sendMessage(botEntity, { message: text });
    log.debug("[tg] sent", { len: text.length });
  }

  async function waitForReply(opts?: {
    timeoutMs?: number;
  }): Promise<{ text: string; receivedAt: Date; messageId: number }> {
    const timeoutMs = opts?.timeoutMs ?? 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const msg = inbox.shift();
      if (msg) return msg;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for bot reply after ${timeoutMs}ms`);
  }

  async function reset(): Promise<void> {
    await sendMessage("/reset");
    try {
      await waitForReply({ timeoutMs: 5000 });
    } catch {
      // bot may or may not reply; don't fail
    }
    inbox.length = 0;
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
    reset,
    stop,
  };
}
