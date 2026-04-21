export interface EcontSender {
  senderClient: { name: string; phones: string[] };
  senderAddress: {
    city: { name: string; postCode?: string };
    quarter?: string;
    street?: string;
    num?: string;
    other?: string;
  };
}

const ECONT_BASE = "http://ee.econt.com/services";

let cachedSender: EcontSender | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

export function __resetSenderCache() {
  cachedSender = null;
  cacheLoadedAt = 0;
}

// Test helper: pre-populate the cache from env so resolveSender() short-circuits
// without hitting the Econt Profile API. Used in test setup to keep fetch mocks
// focused on the endpoint under test.
export function __primeSenderFromEnv() {
  try {
    cachedSender = getSenderFromEnv();
    cacheLoadedAt = Date.now();
  } catch {
    cachedSender = null;
    cacheLoadedAt = 0;
  }
}

function getEcontAuthHeader(): string | null {
  const user = process.env.ECONT_USERNAME?.trim();
  const pass = process.env.ECONT_PASSWORD?.trim();
  if (!user || !pass) return null;
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function fetchSenderFromEcont(): Promise<EcontSender | null> {
  const auth = getEcontAuthHeader();
  if (!auth) return null;

  try {
    const res = await fetch(
      `${ECONT_BASE}/Profile/ProfileService.getClientProfiles.json`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: "{}",
      },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as any;
    const profile = data?.profiles?.[0];
    const client = profile?.client;
    const address = profile?.addresses?.[0];
    if (!client?.name || !address?.city?.name) return null;

    return {
      senderClient: {
        name: client.name,
        phones:
          Array.isArray(client.phones) && client.phones.length > 0
            ? [client.phones[0]]
            : [process.env.ECONT_SENDER_PHONE?.trim() || ""],
      },
      senderAddress: {
        city: {
          name: address.city.name,
          ...(address.city.postCode ? { postCode: address.city.postCode } : {}),
        },
        ...(address.quarter ? { quarter: address.quarter } : {}),
        ...(address.street ? { street: address.street } : {}),
        ...(address.num ? { num: address.num } : {}),
        ...(address.other ? { other: address.other } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function getSenderFromEnv(): EcontSender {
  const name = process.env.ECONT_SENDER_NAME?.trim();
  const phone = process.env.ECONT_SENDER_PHONE?.trim();
  if (!name || !phone) {
    throw Object.assign(
      new Error(
        "Econt sender not configured. Set ECONT_SENDER_NAME and ECONT_SENDER_PHONE.",
      ),
      { statusCode: 500 },
    );
  }
  const city = process.env.ECONT_SENDER_CITY?.trim() || "София";
  const postCode = process.env.ECONT_SENDER_POSTCODE?.trim();
  const quarter = process.env.ECONT_SENDER_QUARTER?.trim();
  const street = process.env.ECONT_SENDER_STREET?.trim();
  const num = process.env.ECONT_SENDER_STREET_NUM?.trim();
  const other = process.env.ECONT_SENDER_OTHER?.trim();

  const senderAddress: EcontSender["senderAddress"] = {
    city: { name: city, ...(postCode ? { postCode } : {}) },
    ...(quarter ? { quarter } : {}),
    ...(street ? { street } : {}),
    ...(num ? { num } : {}),
    ...(other ? { other } : {}),
  };

  return {
    senderClient: { name, phones: [phone] },
    senderAddress,
  };
}

// Synchronous sender resolver kept for backwards-compatibility with tests
// that validate env-based configuration. Production code uses resolveSender().
export function getSender(): EcontSender {
  return getSenderFromEnv();
}

export async function resolveSender(): Promise<EcontSender> {
  const now = Date.now();
  if (cachedSender && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedSender;
  }

  // Skip the Econt Profile API call under test runners so mocked fetches for the
  // endpoint under test don't accidentally intercept profile lookups.
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return getSenderFromEnv();
  }

  const fromEcont = await fetchSenderFromEcont();
  if (fromEcont) {
    cachedSender = fromEcont;
    cacheLoadedAt = now;
    return fromEcont;
  }

  return getSenderFromEnv();
}
