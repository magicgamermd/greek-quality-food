import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSender } from "../routes/econt-sender.js";

const KEYS = [
  "ECONT_SENDER_NAME",
  "ECONT_SENDER_PHONE",
  "ECONT_SENDER_CITY",
  "ECONT_SENDER_POSTCODE",
  "ECONT_SENDER_QUARTER",
  "ECONT_SENDER_STREET",
  "ECONT_SENDER_STREET_NUM",
  "ECONT_SENDER_OTHER",
] as const;

describe("getSender", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws 500 when name is missing", () => {
    process.env.ECONT_SENDER_PHONE = "0888111222";
    expect(() => getSender()).toThrow(/sender not configured/i);
  });

  it("throws 500 when phone is missing", () => {
    process.env.ECONT_SENDER_NAME = "MERT-M";
    expect(() => getSender()).toThrow(/sender not configured/i);
  });

  it("returns a SENDER object for office-style config", () => {
    process.env.ECONT_SENDER_NAME = "MERT-M ЕООД";
    process.env.ECONT_SENDER_PHONE = "0888111222";
    process.env.ECONT_SENDER_CITY = "София";
    process.env.ECONT_SENDER_POSTCODE = "1000";
    process.env.ECONT_SENDER_QUARTER = "Център";
    process.env.ECONT_SENDER_OTHER = "бл.1";

    const sender = getSender();

    expect(sender.senderClient).toEqual({
      name: "MERT-M ЕООД",
      phones: ["0888111222"],
    });
    expect(sender.senderAddress.city).toEqual({
      name: "София",
      postCode: "1000",
    });
    expect(sender.senderAddress.quarter).toBe("Център");
    expect(sender.senderAddress.other).toBe("бл.1");
  });

  it("returns a SENDER object for street-style config", () => {
    process.env.ECONT_SENDER_NAME = "MERT-M ЕООД";
    process.env.ECONT_SENDER_PHONE = "0888111222";
    process.env.ECONT_SENDER_CITY = "Пловдив";
    process.env.ECONT_SENDER_STREET = "ул. Тест";
    process.env.ECONT_SENDER_STREET_NUM = "15";

    const sender = getSender();

    expect(sender.senderAddress.street).toBe("ул. Тест");
    expect(sender.senderAddress.num).toBe("15");
  });

  it("defaults city to София when not set", () => {
    process.env.ECONT_SENDER_NAME = "X";
    process.env.ECONT_SENDER_PHONE = "0888";
    const sender = getSender();
    expect(sender.senderAddress.city.name).toBe("София");
  });
});
