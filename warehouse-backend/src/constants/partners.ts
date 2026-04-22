// Shared partner domain constants. Imported by routes and services that
// need to distinguish individual (walk-in) customers from legal entities.

export const PARTNER_TYPE_LEGAL = "legal_entity" as const;
export const PARTNER_TYPE_INDIVIDUAL = "individual" as const;
export const PARTNER_TYPE_SUPPLIER = "supplier" as const;

export type PartnerType =
  | typeof PARTNER_TYPE_LEGAL
  | typeof PARTNER_TYPE_INDIVIDUAL
  | typeof PARTNER_TYPE_SUPPLIER
  | "customer"; // legacy value — treated as legal_entity in business logic

export const ANONYMOUS_INDIVIDUAL_NAME =
  "Физическо лице — краен потребител" as const;

/**
 * A partner is considered an individual (physical person) if its partner_type
 * is explicitly "individual". Any other value (including legacy "customer"
 * and "supplier") is treated as a legal entity for validation/UI purposes.
 */
export function isIndividual(partnerType: string | null | undefined): boolean {
  return partnerType === PARTNER_TYPE_INDIVIDUAL;
}
