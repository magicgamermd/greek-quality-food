// Групи на продукти и на партньори (по образец на Microinvest, 04.11.2026):
// списък с брой, нова група, преименуване, изтриване, сливане на цяла група
// в друга и масово местене на избрани продукти/партньори.
//
// Двата вида групи са еднакви — разликата е само в таблиците, затова
// маршрутите се правят от една функция. Имената на таблици/колони идват
// от константите долу, никога от заявката.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";
import {
  requirePermission,
  PERMISSIONS,
  type Permission,
} from "../lib/permissions.js";
import { cleanGroupName } from "../lib/product-groups.js";

export interface GroupKind {
  table: "product_groups" | "partner_groups";
  members: "products" | "partners";
  column: "product_group_id" | "partner_group_id";
  permission: Permission;
  /** Групата по доставчик съществува само при продуктите. */
  hasSupplier: boolean;
}

export const PRODUCT_GROUPS: GroupKind = {
  table: "product_groups",
  members: "products",
  column: "product_group_id",
  permission: PERMISSIONS.PRODUCTS_MANAGE,
  hasSupplier: true,
};

export const PARTNER_GROUPS: GroupKind = {
  table: "partner_groups",
  members: "partners",
  column: "partner_group_id",
  permission: PERMISSIONS.PARTNERS_MANAGE,
  hasSupplier: false,
};

const nameSchema = z
  .string({ required_error: "Въведете име на групата" })
  .transform(cleanGroupName)
  .pipe(
    z
      .string()
      .min(1, "Въведете име на групата")
      .max(120, "Името на групата е до 120 знака"),
  );

const groupBodySchema = z.object({ name: nameSchema });

const idSchema = z.coerce
  .number({ invalid_type_error: "Изберете група" })
  .int("Изберете група")
  .positive("Изберете група");

const moveSchema = z.object({
  ids: z
    .array(idSchema, { required_error: "Няма избрани редове" })
    .min(1, "Няма избрани редове")
    .max(5000, "Най-много 5000 наведнъж"),
  // null = „Без група“
  group_id: idSchema.nullable(),
});

const mergeSchema = z.object({
  target_id: idSchema,
});

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Невалидни данни";
}

function duplicateName(name: string) {
  return { error: `Група „${name}“ вече има` };
}

/** Име за сравнение: без значение главни/малки (и на кирилица). */
export function groupNameKey(name: string): string {
  return cleanGroupName(name).toLocaleLowerCase("bg");
}

/**
 * Група със същото име (без значение главни/малки). Проверява се тук, а
 * не само с уникалния индекс по lower(name): при база с колация „C“ (както
 * локалното копие) lower() не сваля кирилицата.
 */
async function sameNameGroup(
  table: GroupKind["table"],
  name: string,
  exceptId?: number,
): Promise<{ id: number; name: string } | null> {
  const { rows } = await query<{ id: number; name: string }>(
    `SELECT id, name FROM ${table}`,
  );
  const key = groupNameKey(name);
  return (
    rows.find((row) => row.id !== exceptId && groupNameKey(row.name) === key) ??
    null
  );
}

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

export function groupRoutes(kind: GroupKind) {
  const { table, members, column } = kind;
  const managePreHandler = [jwtVerify, requirePermission(kind.permission)];

  return async function routes(app: FastifyInstance) {
    // GET / — групите с броя членове + общо и без група
    app.get(
      "/",
      { preHandler: jwtVerify },
      async (_request: FastifyRequest, reply: FastifyReply) => {
        const { rows } = await query(
          `SELECT g.id, g.name,
                  ${kind.hasSupplier ? "g.supplier_id," : "NULL::int AS supplier_id,"}
                  COUNT(m.id)::int AS member_count
             FROM ${table} g
             LEFT JOIN ${members} m ON m.${column} = g.id
            GROUP BY g.id`,
        );
        rows.sort((a, b) =>
          String(a.name).localeCompare(String(b.name), "bg", {
            sensitivity: "base",
            numeric: true,
          }),
        );
        const {
          rows: [totals],
        } = await query(
          `SELECT COUNT(*)::int AS total_count,
                  COUNT(*) FILTER (WHERE ${column} IS NULL)::int AS ungrouped_count
             FROM ${members}`,
        );
        return reply.send({
          data: rows,
          total_count: totals?.total_count ?? 0,
          ungrouped_count: totals?.ungrouped_count ?? 0,
        });
      },
    );

    // POST / — нова група
    app.post(
      "/",
      { preHandler: managePreHandler },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = groupBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({ error: firstIssue(parsed.error) });
        }
        const { name } = parsed.data;
        const existing = await sameNameGroup(table, name);
        if (existing) {
          return reply.status(409).send(duplicateName(existing.name));
        }
        try {
          const { rows } = await query(
            `INSERT INTO ${table} (name) VALUES ($1)
             RETURNING id, name, ${kind.hasSupplier ? "supplier_id" : "NULL::int AS supplier_id"}, 0 AS member_count`,
            [name],
          );
          return reply.status(201).send({ data: rows[0] });
        } catch (error: any) {
          if (error?.code === "23505") {
            return reply.status(409).send(duplicateName(name));
          }
          throw error;
        }
      },
    );

    // PUT /:id — преименуване
    app.put(
      "/:id",
      { preHandler: managePreHandler },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const id = idSchema.safeParse((request.params as any)?.id);
        if (!id.success) {
          return reply.status(404).send({ error: "Групата не е намерена" });
        }
        const parsed = groupBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({ error: firstIssue(parsed.error) });
        }
        const { name } = parsed.data;
        const existing = await sameNameGroup(table, name, id.data);
        if (existing) {
          return reply.status(409).send(duplicateName(existing.name));
        }
        try {
          const { rows } = await query(
            `UPDATE ${table} SET name = $1, updated_at = NOW()
              WHERE id = $2
              RETURNING id, name`,
            [name, id.data],
          );
          if (!rows[0]) {
            return reply.status(404).send({ error: "Групата не е намерена" });
          }
          return reply.send({ data: rows[0] });
        } catch (error: any) {
          if (error?.code === "23505") {
            return reply.status(409).send(duplicateName(name));
          }
          throw error;
        }
      },
    );

    // DELETE /:id — групата изчезва, членовете ѝ остават без група
    app.delete(
      "/:id",
      { preHandler: managePreHandler },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const id = idSchema.safeParse((request.params as any)?.id);
        if (!id.success) {
          return reply.status(404).send({ error: "Групата не е намерена" });
        }
        const result = await transaction(async (client) => {
          const released = await client.query(
            `UPDATE ${members} SET ${column} = NULL, updated_at = NOW()
              WHERE ${column} = $1`,
            [id.data],
          );
          const deleted = await client.query(
            `DELETE FROM ${table} WHERE id = $1 RETURNING id`,
            [id.data],
          );
          return {
            found: (deleted.rowCount ?? 0) > 0,
            released: released.rowCount ?? 0,
          };
        });
        if (!result.found) {
          return reply.status(404).send({ error: "Групата не е намерена" });
        }
        return reply.send({
          data: { id: id.data, released: result.released },
        });
      },
    );

    // POST /:id/merge — цялата група отива в друга, празната се изтрива
    app.post(
      "/:id/merge",
      { preHandler: managePreHandler },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const id = idSchema.safeParse((request.params as any)?.id);
        if (!id.success) {
          return reply.status(404).send({ error: "Групата не е намерена" });
        }
        const parsed = mergeSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({ error: firstIssue(parsed.error) });
        }
        const targetId = parsed.data.target_id;
        if (targetId === id.data) {
          return reply
            .status(400)
            .send({ error: "Изберете друга група, не същата" });
        }
        const result = await transaction(async (client) => {
          const { rows: found } = await client.query(
            `SELECT id FROM ${table} WHERE id = ANY($1::int[]) FOR UPDATE`,
            [[id.data, targetId]],
          );
          if (found.length < 2) return null;
          const moved = await client.query(
            `UPDATE ${members} SET ${column} = $1, updated_at = NOW()
              WHERE ${column} = $2`,
            [targetId, id.data],
          );
          await client.query(`DELETE FROM ${table} WHERE id = $1`, [id.data]);
          return { moved: moved.rowCount ?? 0 };
        });
        if (!result) {
          return reply.status(404).send({ error: "Групата не е намерена" });
        }
        return reply.send({
          data: { moved: result.moved, target_id: targetId },
        });
      },
    );

    // POST /move — избраните редове в група (group_id: null = без група)
    app.post(
      "/move",
      { preHandler: managePreHandler },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const parsed = moveSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply.status(400).send({ error: firstIssue(parsed.error) });
        }
        const { ids, group_id: groupId } = parsed.data;
        if (groupId !== null) {
          const { rows } = await query(
            `SELECT id FROM ${table} WHERE id = $1`,
            [groupId],
          );
          if (!rows[0]) {
            return reply.status(404).send({ error: "Групата не е намерена" });
          }
        }
        const moved = await query(
          `UPDATE ${members} SET ${column} = $1::int, updated_at = NOW()
            WHERE id = ANY($2::int[])
              AND ${column} IS DISTINCT FROM $1::int`,
          [groupId, ids],
        );
        return reply.send({ data: { moved: moved.rowCount ?? 0 } });
      },
    );
  };
}
