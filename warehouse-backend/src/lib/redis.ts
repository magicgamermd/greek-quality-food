import { Redis } from "ioredis";

let client: Redis | null = null;
let connectPromise: Promise<Redis> | null = null;

export async function getRedis(): Promise<Redis> {
  if (client && client.status === "ready") return client;
  if (connectPromise) return connectPromise;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL is not configured. Cannot use Redis-backed features.",
    );
  }

  connectPromise = new Promise<Redis>((resolve, reject) => {
    const c = new Redis(url);
    c.on("error", (err: Error) => {
      console.error("[redis] client error:", err);
    });
    c.once("ready", () => {
      client = c;
      resolve(c);
    });
    c.once("error", (err: Error) => {
      connectPromise = null;
      reject(err);
    });
  });

  return connectPromise;
}

export async function closeRedis(): Promise<void> {
  if (client && client.status !== "end") {
    await client.quit();
  }
  client = null;
  connectPromise = null;
}
