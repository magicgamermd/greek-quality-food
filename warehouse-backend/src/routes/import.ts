import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as XLSX from "xlsx";
import { transaction } from "../db.js";
import {
  parseMicroinvestYesNo,
  parseProductActiveStatus,
} from "../utils/microinvest.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.role !== "admin") {
    throw Object.assign(new Error("Admin access required"), {
      statusCode: 403,
    });
  }
}

interface PartnerRow {
  Код: string | number;
  Фирма: string;
  "Фирма - име за печат": string;
  МОЛ: string;
  Град: string;
  Адрес: string;
  Телефон: string;
  Факс: string;
  ЕИК: string;
  "ДДС номер": string;
  "E-mail": string;
  "Банка име": string;
  "BIC код": string;
  IBAN: string;
  "Сметка за ДДС": string;
  Група: string;
  Тип: string;
  "Ценова група": string;
  "Отстъпка(%)": string | number;
  "Карта №": string;
  "Разплащане до": string | number;
}

interface ProductRow {
  Код: string;
  Стока: string;
  "Стока - име за печат": string;
  Мярка: string;
  "Мярка 2": string;
  Коефициент: number;
  Група: string;
  "ДДС група": string;
  "Доставна цена": number | string;
  "Цена на едро": number | string;
  "Цена на дребно": number | string;
  "Ценова група 1": number | string;
  "Ценова група 2": number | string;
  "Ценова група 3": number | string;
  "Ценова група 4": number | string;
  "Ценова група 5": number | string;
  "Ценова група 6": number | string;
  "Ценова група 7": number | string;
  "Ценова група 8": number | string;
  Описание: string;
  Състояние: string;
  "Често използван": string;
}

function normalizeCity(city: string | undefined | null): string | null {
  if (!city) return null;
  return (
    city
      .replace(/^гр\.\s*/i, "")
      .trim()
      .toUpperCase() || null
  );
}

function trim(val: any): string | null {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  return s || null;
}

export default async function importRoutes(app: FastifyInstance) {
  // POST /import/partners — Upload DOSTAVCHICI.xlsx or PRODAJBI.xlsx
  app.post(
    "/partners",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      requireAdmin(request, reply);
      if (reply.sent) return;

      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: "No file uploaded" });
      }

      const buffer = await file.toBuffer();
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      // Partners XLSX: row 0 = empty, row 1 = title ("Справка партньори"), row 2 = headers
      const rows = XLSX.utils.sheet_to_json<PartnerRow>(sheet, { range: 2 });

      if (rows.length === 0) {
        return reply.status(400).send({ error: "No data rows found in file" });
      }

      const stats = {
        total_rows: rows.length,
        inserted: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
      };
      const errorDetails: { row: number; name: string; error: string }[] = [];

      await transaction(async (client) => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const name = trim(row["Фирма"]);
          if (!name) {
            stats.skipped++;
            continue;
          }

          try {
            const microinvestCode = trim(row["Код"]);
            const eik = trim(row["ЕИК"]);
            const vatNumber = trim(row["ДДС номер"]);
            const city = normalizeCity(row["Град"] as string);
            const address = trim(row["Адрес"]);
            const contactPerson = trim(row["МОЛ"]);
            const phone = trim(row["Телефон"]);
            const email = trim(row["E-mail"]);
            const grupa = trim(row["Група"]);
            const partnerType =
              grupa && grupa.toLowerCase().includes("доставчици")
                ? "supplier"
                : "customer";

            const printName = trim(row["Фирма - име за печат"]);
            const fax = trim(row["Факс"]);
            const bankName = trim(row["Банка име"]);
            const bic = trim(row["BIC код"]);
            const iban = trim(row["IBAN"]);
            const vatAccount = trim(row["Сметка за ДДС"]);
            const groupName = grupa;
            const clientType = trim(row["Тип"]);
            const priceGroup = trim(row["Ценова група"]);
            const discountRaw = row["Отстъпка(%)"];
            const discountPercent =
              discountRaw !== undefined && discountRaw !== null
                ? parseFloat(String(discountRaw)) || 0
                : 0;
            const cardNumber = trim(row["Карта №"]);
            const paymentDaysRaw = row["Разплащане до"];
            const paymentDays =
              paymentDaysRaw !== undefined && paymentDaysRaw !== null
                ? parseInt(String(paymentDaysRaw), 10) || 0
                : 0;

            // Match logic: 1) EIK, 2) microinvest_code, 3) exact name
            let existingId: number | null = null;

            if (eik) {
              const { rows: found } = await client.query(
                "SELECT id FROM partners WHERE eik = $1 LIMIT 1",
                [eik],
              );
              if (found.length > 0) existingId = found[0].id;
            }

            if (!existingId && microinvestCode) {
              const { rows: found } = await client.query(
                "SELECT id FROM partners WHERE microinvest_code = $1 LIMIT 1",
                [microinvestCode],
              );
              if (found.length > 0) existingId = found[0].id;
            }

            if (!existingId) {
              const { rows: found } = await client.query(
                "SELECT id FROM partners WHERE name = $1 LIMIT 1",
                [name],
              );
              if (found.length > 0) existingId = found[0].id;
            }

            if (existingId) {
              await client.query(
                `UPDATE partners SET
                microinvest_code = COALESCE($1, microinvest_code),
                city = COALESCE($2, city),
                address = COALESCE($3, address),
                eik = COALESCE($4, eik),
                vat_number = COALESCE($5, vat_number),
                contact_person = COALESCE($6, contact_person),
                phone = COALESCE($7, phone),
                email = COALESCE($8, email),
                partner_type = $9,
                print_name = COALESCE($11, print_name),
                fax = COALESCE($12, fax),
                bank_name = COALESCE($13, bank_name),
                bic = COALESCE($14, bic),
                iban = COALESCE($15, iban),
                vat_account = COALESCE($16, vat_account),
                group_name = COALESCE($17, group_name),
                client_type = COALESCE($18, client_type),
                price_group = COALESCE($19, price_group),
                discount_percent = $20,
                card_number = COALESCE($21, card_number),
                payment_days = $22,
                updated_at = NOW()
              WHERE id = $10`,
                [
                  microinvestCode,
                  city,
                  address,
                  eik,
                  vatNumber,
                  contactPerson,
                  phone,
                  email,
                  partnerType,
                  existingId,
                  printName,
                  fax,
                  bankName,
                  bic,
                  iban,
                  vatAccount,
                  groupName,
                  clientType,
                  priceGroup,
                  discountPercent,
                  cardNumber,
                  paymentDays,
                ],
              );
              stats.updated++;
            } else {
              await client.query(
                `INSERT INTO partners (name, microinvest_code, city, address, eik, vat_number, contact_person, phone, email, partner_type,
                  print_name, fax, bank_name, bic, iban, vat_account, group_name, client_type, price_group, discount_percent, card_number, payment_days)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                  $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
                [
                  name,
                  microinvestCode,
                  city,
                  address,
                  eik,
                  vatNumber,
                  contactPerson,
                  phone,
                  email,
                  partnerType,
                  printName,
                  fax,
                  bankName,
                  bic,
                  iban,
                  vatAccount,
                  groupName,
                  clientType,
                  priceGroup,
                  discountPercent,
                  cardNumber,
                  paymentDays,
                ],
              );
              stats.inserted++;
            }
          } catch (err: any) {
            stats.errors++;
            errorDetails.push({
              row: i + 2,
              name: name || "unknown",
              error: err.message,
            });
          }
        }

        // Log the import
        await client.query(
          `INSERT INTO import_logs (import_type, file_name, total_rows, inserted, updated, skipped, errors, error_details, imported_by)
         VALUES ('partners', $1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            file.filename,
            stats.total_rows,
            stats.inserted,
            stats.updated,
            stats.skipped,
            stats.errors,
            JSON.stringify(errorDetails),
            request.user.id,
          ],
        );
      });

      return {
        message: "Partner import completed",
        file: file.filename,
        ...stats,
        error_details: errorDetails.length > 0 ? errorDetails : undefined,
      };
    },
  );

  // POST /import/products — Upload STOKI.xlsx
  app.post(
    "/products",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      requireAdmin(request, reply);
      if (reply.sent) return;

      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: "No file uploaded" });
      }

      const buffer = await file.toBuffer();
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      // Products XLSX: row 0 = empty, row 1 = title ("Справка номенклатури стоки"), row 2 = headers
      const rows = XLSX.utils.sheet_to_json<ProductRow>(sheet, { range: 2 });

      if (rows.length === 0) {
        return reply.status(400).send({ error: "No data rows found in file" });
      }

      const stats = {
        total_rows: rows.length,
        inserted: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
      };
      const errorDetails: { row: number; name: string; error: string }[] = [];

      const unitMap: Record<string, string> = {
        "бр.": "pcs",
        "кг.": "kg",
        кг: "kg",
        кашон: "box",
        "л.": "l",
        л: "l",
      };

      await transaction(async (client) => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const nameBg = trim(row["Стока"]);
          if (!nameBg) {
            stats.skipped++;
            continue;
          }

          try {
            const code = trim(row["Код"]);
            const groupName = trim(row["Група"]);
            const rawUnit = trim(row["Мярка"]) || "бр.";
            const unit = unitMap[rawUnit] || rawUnit;
            const printName = trim(row["Стока - име за печат"]);
            const description = trim(row["Описание"]);
            const vatGroup = trim(row["ДДС група"]);
            const isActive = parseProductActiveStatus(row["Състояние"]);
            const isFrequentlyUsed = parseMicroinvestYesNo(
              row["Често използван"],
            );
            const parsePrice = (
              val: number | string | undefined | null,
            ): number | null => {
              if (val === undefined || val === null) return null;
              const n = parseFloat(String(val));
              return isNaN(n) ? null : n;
            };

            const purchasePrice = parsePrice(row["Доставна цена"]);
            const sellingPrice = parsePrice(row["Цена на едро"]);
            const retailPrice = parsePrice(row["Цена на дребно"]);
            const priceGroup1 = parsePrice(row["Ценова група 1"]);
            const priceGroup2 = parsePrice(row["Ценова група 2"]);
            const priceGroup3 = parsePrice(row["Ценова група 3"]);
            const priceGroup4 = parsePrice(row["Ценова група 4"]);
            const priceGroup5 = parsePrice(row["Ценова група 5"]);
            const priceGroup6 = parsePrice(row["Ценова група 6"]);
            const priceGroup7 = parsePrice(row["Ценова група 7"]);
            const priceGroup8 = parsePrice(row["Ценова група 8"]);

            // Match: 1) Код = SKU, 2) name ILIKE
            let existingId: number | null = null;

            if (code) {
              const { rows: found } = await client.query(
                "SELECT id FROM products WHERE sku = $1 LIMIT 1",
                [code],
              );
              if (found.length > 0) existingId = found[0].id;
            }

            if (!existingId && code) {
              const { rows: found } = await client.query(
                "SELECT id FROM products WHERE microinvest_code = $1 LIMIT 1",
                [code],
              );
              if (found.length > 0) existingId = found[0].id;
            }

            if (!existingId) {
              const { rows: found } = await client.query(
                "SELECT id FROM products WHERE name_bg ILIKE $1 LIMIT 1",
                [nameBg],
              );
              if (found.length > 0) existingId = found[0].id;
            }

            if (existingId) {
              await client.query(
                `UPDATE products SET
                microinvest_code = COALESCE($1, microinvest_code),
                group_name = COALESCE($2, group_name),
                unit = COALESCE($3, unit),
                print_name = COALESCE($4, print_name),
                description = COALESCE($5, description),
                vat_group = COALESCE($6, vat_group),
                is_active = COALESCE($7, is_active),
                is_frequently_used = COALESCE($8, is_frequently_used),
                purchase_price = COALESCE($9, purchase_price),
                selling_price = COALESCE($10, selling_price),
                retail_price = COALESCE($11, retail_price),
                price_group_1 = COALESCE($12, price_group_1),
                price_group_2 = COALESCE($13, price_group_2),
                price_group_3 = COALESCE($14, price_group_3),
                price_group_4 = COALESCE($15, price_group_4),
                price_group_5 = COALESCE($16, price_group_5),
                price_group_6 = COALESCE($17, price_group_6),
                price_group_7 = COALESCE($18, price_group_7),
                price_group_8 = COALESCE($19, price_group_8),
                updated_at = NOW()
              WHERE id = $20`,
                [
                  code,
                  groupName,
                  unit,
                  printName,
                  description,
                  vatGroup,
                  isActive,
                  isFrequentlyUsed,
                  purchasePrice,
                  sellingPrice,
                  retailPrice,
                  priceGroup1,
                  priceGroup2,
                  priceGroup3,
                  priceGroup4,
                  priceGroup5,
                  priceGroup6,
                  priceGroup7,
                  priceGroup8,
                  existingId,
                ],
              );
              stats.updated++;
            } else {
              await client.query(
                `INSERT INTO products (
                  name_bg, name_en, sku, microinvest_code, group_name, unit, print_name, description, vat_group, is_active, is_frequently_used,
                  purchase_price, selling_price, retail_price, price_group_1, price_group_2, price_group_3, price_group_4, price_group_5, price_group_6, price_group_7, price_group_8
                )
               VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                  $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
                )`,
                [
                  nameBg,
                  nameBg,
                  code || `MI-${Date.now()}-${i}`,
                  code,
                  groupName,
                  unit,
                  printName,
                  description,
                  vatGroup,
                  isActive ?? true,
                  isFrequentlyUsed ?? false,
                  purchasePrice,
                  sellingPrice,
                  retailPrice,
                  priceGroup1,
                  priceGroup2,
                  priceGroup3,
                  priceGroup4,
                  priceGroup5,
                  priceGroup6,
                  priceGroup7,
                  priceGroup8,
                ],
              );
              stats.inserted++;
            }
          } catch (err: any) {
            stats.errors++;
            errorDetails.push({
              row: i + 2,
              name: nameBg || "unknown",
              error: err.message,
            });
          }
        }

        // Log the import
        await client.query(
          `INSERT INTO import_logs (import_type, file_name, total_rows, inserted, updated, skipped, errors, error_details, imported_by)
         VALUES ('products', $1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            file.filename,
            stats.total_rows,
            stats.inserted,
            stats.updated,
            stats.skipped,
            stats.errors,
            JSON.stringify(errorDetails),
            request.user.id,
          ],
        );
      });

      return {
        message: "Product import completed",
        file: file.filename,
        ...stats,
        error_details: errorDetails.length > 0 ? errorDetails : undefined,
      };
    },
  );
}
