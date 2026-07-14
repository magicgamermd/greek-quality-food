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

  it("DATE колона (JS Date от pg) → ISO срок, не 'Tue Mar 31' боклук", async () => {
    // Регресия (прод): node-postgres връща DATE като JS Date на локална
    // полунощ. String(date).slice(0,10) даваше "Tue Mar 31" → грешни
    // срокове на търговския документ (FEFO preview) при първи печат.
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "АВТО-4-24",
        expiry_date: new Date(2027, 2, 31), // 31.03.2027 локално
        purchase_price: "9.25",
        available: "16.635",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, { today: TODAY });
    expect(res.allocations[0].expiry_date).toBe("2027-03-31");
  });

  it("ИЗТЕКЛА партида като JS Date СЕ пропуска (счупеното string сравнение)", async () => {
    // Преди: "Tue Mar 31" < "2026-06-22" е false (буква > цифра) → изтекли
    // партиди се разпределяха. С нормализация датата се сравнява коректно.
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "СТАРА",
        expiry_date: new Date(2026, 0, 15), // 15.01.2026 — изтекла
        purchase_price: "1.00",
        available: "10",
      },
      {
        batch_id: 2,
        batch_number: "ПРЯСНА",
        expiry_date: new Date(2026, 11, 1), // 01.12.2026
        purchase_price: "1.00",
        available: "10",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, { today: TODAY });
    expect(res.allocations).toHaveLength(1);
    expect(res.allocations[0].batch_id).toBe(2);
  });

  it("изтичаща скоро партида като JS Date вдига предупреждение с ISO дата", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: new Date(2026, 6, 1), // 01.07.2026 — до 30 дни от TODAY
        purchase_price: "1.00",
        available: "10",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, { today: TODAY });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("2026-07-01");
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

  it("shortfall=0 при пълно покритие", async () => {
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
    expect(res.shortfall).toBe(0);
  });

  it("allowShortfall: частично покритие връща allocations + shortfall (не хвърля)", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.00",
        available: "3",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 10, {
      today: TODAY,
      allowShortfall: true,
    });
    expect(res.allocations).toHaveLength(1);
    expect(res.allocations[0].quantity).toBe(3);
    expect(res.shortfall).toBe(7);
  });

  it("allowShortfall: при нулева наличност връща празни allocations + пълен shortfall", async () => {
    const client = mkClient([]);
    const res = await allocateFefo(client, 1, 1, 8, {
      today: TODAY,
      allowShortfall: true,
    });
    expect(res.allocations).toHaveLength(0);
    expect(res.shortfall).toBe(8);
  });

  it("allowShortfall НЕ заобикаля изтекли партиди (изтеклите остават пропуснати)", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "OLD",
        expiry_date: "2026-01-01",
        purchase_price: "1.00",
        available: "100",
      },
    ]);
    const res = await allocateFefo(client, 1, 1, 5, {
      today: TODAY,
      allowShortfall: true,
    });
    // Изтеклата партида е пропусната → нищо не е разпределено, всичко е shortfall.
    expect(res.allocations).toHaveLength(0);
    expect(res.shortfall).toBe(5);
  });

  it("без allowShortfall при недостиг хвърля (back-compat)", async () => {
    const client = mkClient([
      {
        batch_id: 1,
        batch_number: "B1",
        expiry_date: "2026-07-01",
        purchase_price: "1.00",
        available: "3",
      },
    ]);
    await expect(
      allocateFefo(client, 1, 1, 10, { today: TODAY }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });
});
