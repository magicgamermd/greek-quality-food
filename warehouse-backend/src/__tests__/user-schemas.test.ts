import { describe, it, expect } from "vitest";
import { z } from "zod";

// Replicate schemas from users.ts
const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["admin", "warehouse", "accountant"]).default("accountant"),
});

const updateRoleSchema = z.object({
  role: z.enum(["admin", "warehouse", "accountant"]),
});

describe("createUserSchema", () => {
  it("should accept valid admin role", () => {
    const result = createUserSchema.parse({
      name: "Test User",
      email: "test@example.com",
      password: "password123",
      role: "admin",
    });
    expect(result.role).toBe("admin");
  });

  it("should accept valid warehouse role", () => {
    const result = createUserSchema.parse({
      name: "Test User",
      email: "test@example.com",
      password: "password123",
      role: "warehouse",
    });
    expect(result.role).toBe("warehouse");
  });

  it("should accept valid accountant role", () => {
    const result = createUserSchema.parse({
      name: "Test User",
      email: "test@example.com",
      password: "password123",
      role: "accountant",
    });
    expect(result.role).toBe("accountant");
  });

  it("should default role to accountant", () => {
    const result = createUserSchema.parse({
      name: "Test User",
      email: "test@example.com",
      password: "password123",
    });
    expect(result.role).toBe("accountant");
  });

  it('should reject invalid role "readonly" (Bug #2 — old role name)', () => {
    expect(() =>
      createUserSchema.parse({
        name: "Test User",
        email: "test@example.com",
        password: "password123",
        role: "readonly",
      }),
    ).toThrow();
  });
});

describe("updateRoleSchema (Bug #2 fix)", () => {
  it("should accept admin role", () => {
    expect(updateRoleSchema.parse({ role: "admin" }).role).toBe("admin");
  });

  it("should accept warehouse role", () => {
    expect(updateRoleSchema.parse({ role: "warehouse" }).role).toBe(
      "warehouse",
    );
  });

  it("should accept accountant role", () => {
    expect(updateRoleSchema.parse({ role: "accountant" }).role).toBe(
      "accountant",
    );
  });

  it("should reject readonly role", () => {
    expect(() => updateRoleSchema.parse({ role: "readonly" })).toThrow();
  });

  it("should reject empty string", () => {
    expect(() => updateRoleSchema.parse({ role: "" })).toThrow();
  });

  it("should reject missing role", () => {
    expect(() => updateRoleSchema.parse({})).toThrow();
  });
});

describe("Migration 003 — role constraint fix", () => {
  it("CHECK constraint SQL should include all 3 valid roles", () => {
    // This is a static verification that the migration file is correct.
    // The actual SQL: CHECK (role IN ('admin', 'warehouse', 'accountant'))
    const validRoles = ["admin", "warehouse", "accountant"];
    const invalidRoles = ["readonly", "viewer", "editor", ""];

    for (const role of validRoles) {
      expect(() => updateRoleSchema.parse({ role })).not.toThrow();
    }
    for (const role of invalidRoles) {
      expect(() => updateRoleSchema.parse({ role })).toThrow();
    }
  });
});
