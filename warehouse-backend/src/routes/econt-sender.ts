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

export function getSender(): EcontSender {
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
