import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  partnerCreateSchema,
  partnerUpdateSchema,
} from "../routes/partner-schemas.js";

describe("partnerCreateSchema", () => {
  it("requires name for every partner type", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "individual",
      name: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts individual partner with only name", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "individual",
      name: "Иван Петров",
    });
    expect(result.success).toBe(true);
  });

  it("accepts individual partner with empty eik", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "individual",
      name: "Иван Петров",
      eik: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects individual partner if eik has a non-empty value", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "individual",
      name: "Иван Петров",
      eik: "123456789",
    });
    expect(result.success).toBe(false);
  });

  it("accepts legal_entity partner with valid 9-digit eik", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "legal_entity",
      name: "Техно ООД",
      eik: "123456789",
    });
    expect(result.success).toBe(true);
  });

  it("accepts legal_entity partner with valid 13-digit eik", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "legal_entity",
      name: "Техно ООД",
      eik: "1234567890123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects legal_entity partner with invalid eik format", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "legal_entity",
      name: "Техно ООД",
      eik: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("accepts legacy partner_type 'customer' as legal_entity-like", () => {
    const result = partnerCreateSchema.safeParse({
      partner_type: "customer",
      name: "Стара фирма",
      eik: "123456789",
    });
    expect(result.success).toBe(true);
  });

  it("defaults partner_type to 'legal_entity' when missing", () => {
    const result = partnerCreateSchema.safeParse({
      name: "No-type partner",
      eik: "123456789",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.partner_type).toBe("legal_entity");
    }
  });
});

describe("partnerUpdateSchema", () => {
  it("allows partial updates including switching type", () => {
    const result = partnerUpdateSchema.safeParse({
      partner_type: "individual",
      eik: "",
      vat_number: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects update that sets individual with non-empty eik", () => {
    const result = partnerUpdateSchema.safeParse({
      partner_type: "individual",
      eik: "123456789",
    });
    expect(result.success).toBe(false);
  });
});
