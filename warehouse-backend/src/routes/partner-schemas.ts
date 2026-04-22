import { z } from "zod";

const EIK_REGEX = /^\d{9}$|^\d{13}$/;

// Base schema shared by create and update. All partner fields are optional
// at this layer except for the ones that `z.refine` enforces per partner_type.
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
    .optional()
    .default("legal_entity"),
});

function refineByPartnerType<T extends z.AnyZodObject>(schema: T) {
  return schema.superRefine((data, ctx) => {
    const type = (data as any).partner_type ?? "legal_entity";
    const eik = (data as any).eik;
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

    // legal_entity / customer / supplier — if an EIK is provided it must
    // be 9 or 13 digits. Empty/missing EIK is tolerated at the schema
    // level (some legacy partners have no EIK); UI enforces required-ness.
    if (hasEik && !EIK_REGEX.test(eik)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eik"],
        message: "ЕИК трябва да е 9 или 13 цифри",
      });
    }
  });
}

export const partnerCreateSchema = refineByPartnerType(basePartnerObject);
export const partnerUpdateSchema = refineByPartnerType(
  basePartnerObject.partial(),
);

export type PartnerCreateInput = z.infer<typeof partnerCreateSchema>;
export type PartnerUpdateInput = z.infer<typeof partnerUpdateSchema>;
