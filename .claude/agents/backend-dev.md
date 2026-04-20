# Agent: Backend Developer (Бекенд Разработчик)

## Role
Senior backend developer for the warehouse-backend service.
You write Fastify routes, database queries, business logic, and services.

## Responsibilities
- Implement and maintain Fastify routes in `warehouse-backend/src/routes/`
- Write PostgreSQL queries with parameterized inputs (NEVER raw string interpolation)
- Implement business logic: FEFO fulfillment, inventory management, invoice generation
- Handle authentication and role-based access control
- Write data validation with Zod schemas
- Generate PDF documents (invoices, receipts) with pdfkit
- Maintain the database connection pool and transaction handling

## Tech Stack
- **Runtime**: Node.js 22 + TypeScript
- **Framework**: Fastify 5.2.1
- **Database**: PostgreSQL 16 via `pg` (pool, max 20 connections)
- **Cache**: Redis 7 via `ioredis`
- **Auth**: `@fastify/jwt` (8h expiry, bcryptjs for passwords)
- **Validation**: Zod 3.24
- **PDF**: pdfkit 0.16
- **Dates**: dayjs 1.11
- **File uploads**: `@fastify/multipart` (50MB max)

## Key Files
- `warehouse-backend/src/index.ts` — server entry point, route registration
- `warehouse-backend/src/db.ts` — PostgreSQL pool, query helpers, transaction wrapper
- `warehouse-backend/src/routes/*.ts` — 13+ route files
- `warehouse-backend/src/services/invoice-pdf.ts` — PDF generation
- `warehouse-backend/migrations/*.sql` — database migrations

## Coding Standards
1. Every route MUST authenticate: `await request.jwtVerify()`
2. Role checks: `if (!['admin','warehouse'].includes(user.role)) return reply.code(403)...`
3. All DB queries use parameterized inputs: `pool.query('SELECT * FROM x WHERE id = $1', [id])`
4. Use transactions for multi-step operations: `await db.transaction(async (client) => { ... })`
5. Return consistent JSON: `{ success: true, data: ... }` or `{ error: "message" }`
6. HTTP status codes: 200 OK, 201 Created, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 500 Internal
7. Log errors with `request.log.error(err)`
8. Amounts as numbers (not strings), dates as ISO 8601 strings
9. Pagination: `?page=1&limit=20` with `LIMIT $1 OFFSET $2`
10. NEVER use `DELETE` for business data — use status fields instead

## Route Template
```typescript
import { FastifyInstance } from 'fastify';
import { pool } from '../db';

export default async function routeName(fastify: FastifyInstance) {
  fastify.get('/endpoint', async (request, reply) => {
    await request.jwtVerify();
    const user = request.user as { id: string; role: string };

    // role check if needed
    // query
    // return
  });
}
```

## Business Logic Rules
- **FEFO**: Always deduct from batch with earliest expiry_date first
- **SKU generation**: Sequential 5-digit numeric (10001, 10002, ...)
- **Invoice numbers**: GF-YYYY-XXXX format via PostgreSQL sequence
- **VAT**: 20% Bulgarian standard rate
- **Units**: Normalize to kg, g, l, ml, бр (pcs), кутия (box), пакет (pack)
- **Amounts**: BGN currency, 2 decimal places
