import { describe, it, expect } from "vitest";
import {
  allocateFefo,
  InsufficientStockError,
} from "../services/fefo-allocator";

// Фалшив pg client: връща подадените редове (вече сортирани, както SQL ги дава).
const mkClient = (rows: any[]) => ({ query: async () => ({ rows }) }) as any;
const TODAY = "2026-06-22";

describe("allocateFefo", () => {
  it("разпределя най-ранния срок първи", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.00",
        available: "10",
      },
      {
        batch_id: 2,
        batch_number: "B2",
        expiry_date: "2026-08-01",
        purchase_price: "1.00",
        available: "10",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, { today: TODAY });
    expect(res.allocations).toEqual([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        quantity: 5,
        unit_cost: 1,
      },
    ]);
  });

  it("разделя линия по няколко партиди", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.00",
        available: "3",
      },
      {
        batch_id: 2,
        batch_number: "B2",
        expiry_date: "2026-08-01",
        purchase_price: "2.00",
        available: "10",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, { today: TODAY });
    expect(res.allocations).toEqual([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        quantity: 3,
        unit_cost: 1,
      },
      {
        batch_id: 2,
        batch_number: "B2",
        expiry_date: "2026-08-01",
        quantity: 2,
        unit_cost: 2,
      },
    ]);
  });

  it("пропуска изтекли партиди и хвърля при недостиг", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "OLD",
        expiry_date: "2026-01-01",
        purchase_price: "1.00",
        available: "100",
      },
    ]);
    await expect(
      allocateFefo(client, 1, 1, 5, { today: TODAY }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it("откриваща партида (без срок) се ползва последна", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.50",
        available: "2",
      },
      {
        batch_id: 9,
        batch_number: "НАЧАЛНО",
        expiry_date: null,
        purchase_price: "1.00",
        available: "100",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, { today: TODAY });
    expect(res.allocations.map((a) => a.batch_id)).toEqual([1, 9]);
    expect(res.allocations[1].quantity).toBe(3);
  });

  it("предупреждава за изтичащи под прага", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "SOON",
        expiry_date: "2026-07-05",
        purchase_price: "1.00",
        available: "10",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 1, {
      today: TODAY,
      warnDays: 30,
    });
    expect(res.warnings.length).toBe(1);
  });

  it("спира при запълнено количество (без overflow)", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.00",
        available: "100",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, { today: TODAY });
    expect(res.allocations).toHaveLength(1);
    expect(res.allocations[0].quantity).toBe(5);
  });
});
