import { z } from "zod";

const EIK_REGEX = /^\d{9}$|^\d{13}$/;

// Base schema — all fields optional here; create/update add their own requirements.
const basePartnerObject = z.object({
  name: z.string().min(1),
  microinvest_code: z.string().optional(),
  eik: z.string().optional(),
  vat_number: z.string().optional(),
  address: z.string().optional(),
  contact_person: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  price_list_id: z.number().int().optional().nullable(),
  city: z.string().optional(),
  print_name: z.string().optional(),
  client_type: z.string().optional(),
  price_group: z.string().optional(),
  discount_percent: z.union([z.string(), z.number()]).optional(),
  bank_name: z.string().optional(),
  bic: z.string().optional(),
  iban: z.string().optional(),
  category: z.string().optional().nullable(),
  partner_type: z
    .enum(["legal_entity", "individual", "customer", "supplier"])
    .optional(),
});

type PartnerBaseShape = z.infer<typeof basePartnerObject>;

function validatePartnerTypeRules(
  data: Partial<PartnerBaseShape>,
  ctx: z.RefinementCtx,
): void {
  const type = data.partner_type ?? "legal_entity";
  const eik = data.eik;
  const hasEik = typeof eik === "string" && eik.length > 0;

  if (type === "individual") {
    if (hasEik) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eik"],
        message: "Физическо лице не може да има ЕИК",
      });
    }
    return;
  }

  // legal_entity / customer / supplier — EIK optional, but if present
  // must be 9 or 13 digits. UI enforces required-ness.
  if (hasEik && !EIK_REGEX.test(eik as string)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eik"],
      message: "ЕИК трябва да е 9 или 13 цифри",
    });
  }
}

// Create: partner_type defaults to "legal_entity" (so the handler always
// gets a concrete value to persist).
export const partnerCreateSchema = basePartnerObject
  .extend({
    partner_type: z
      .enum(["legal_entity", "individual", "customer", "supplier"])
      .default("legal_entity"),
  })
  .superRefine(validatePartnerTypeRules);

// Update: all fields optional; no default — absence means "don't change".
export const partnerUpdateSchema = basePartnerObject
  .partial()
  .superRefine(validatePartnerTypeRules);

export type PartnerCreateInput = z.infer<typeof partnerCreateSchema>;
export type PartnerUpdateInput = z.infer<typeof partnerUpdateSchema>;
