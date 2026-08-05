import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { emitToRestaurant } from "../socket.js";

// Order statuses that mean "the table still owes money".
const ACTIVE = ["PENDING", "PREPARING", "SERVED"];

function orderTotal(order) {
  return order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
}

// Split `total` across buckets in proportion to `weights` (integer kip; any
// rounding remainder is handed out one kip at a time). Used to spread a
// whole-bill discount back onto its individual orders.
function distribute(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  let assigned = out.reduce((s, x) => s + x, 0);
  let i = 0;
  while (assigned < total) {
    out[i % out.length] += 1;
    assigned += 1;
    i += 1;
  }
  return out;
}

const paymentLineSchema = z.object({
  method: z.string().min(1).max(30),
  amount: z.number().int().positive(),
  received: z.number().int().nonnegative().optional(),
  change: z.number().int().nonnegative().optional(),
});
const checkoutSchema = z.object({
  discount: z.number().int().nonnegative().optional(),
  payments: z.array(paymentLineSchema).optional(),
});
const moveSchema = z.object({
  toTableId: z.string().min(1),
});

const router = Router();

// PUBLIC: the customer page shows which table the QR belongs to (no login).
// Also carries the restaurant's bank QR so customers can pay by transfer.
router.get("/public/:restaurantId/:tableId", async (req, res) => {
  const { restaurantId, tableId } = req.params;
  const table = await prisma.table.findFirst({
    where: { id: tableId, restaurantId },
    include: { restaurant: { select: { name: true, bankQrUrl: true, logoUrl: true, theme: true } } },
  });
  if (!table) return res.status(404).json({ error: "Table not found" });
  res.json({
    number: table.number,
    restaurantName: table.restaurant.name,
    bankQrUrl: table.restaurant.bankQrUrl,
    logoUrl: table.restaurant.logoUrl,
    theme: table.restaurant.theme,
  });
});

router.use(requireAuth);

router.get("/", async (req, res) => {
  const tables = await prisma.table.findMany({
    where: { restaurantId: req.user.restaurantId },
    orderBy: { number: "asc" },
    include: {
      // Active orders = the table is occupied. Only ones without a payment
      // (not paid at the counter) count toward the amount due.
      orders: {
        where: { status: { in: ACTIVE } },
        select: {
          payments: { select: { id: true } },
          items: { select: { unitPrice: true, quantity: true } },
        },
      },
    },
  });

  // Flatten to a count + amount due, plus the QR URL.
  const withQr = tables.map(({ orders, ...t }) => ({
    ...t,
    activeOrders: orders.length,
    activeTotal: orders
      .filter((o) => o.payments.length === 0)
      .reduce((s, o) => s + orderTotal(o), 0),
    qrUrl: `${process.env.FRONTEND_URL}/order/${req.user.restaurantId}/${t.id}`,
  }));
  res.json(withQr);
});

// The table's bill: every active order with its items, plus the grand total.
router.get("/:id/bill", async (req, res) => {
  const table = await prisma.table.findFirst({
    where: { id: req.params.id, restaurantId: req.user.restaurantId },
  });
  if (!table) return res.status(404).json({ error: "Table not found" });

  // Only orders that still owe money — counter orders were paid up front.
  const orders = await prisma.order.findMany({
    where: { tableId: table.id, status: { in: ACTIVE }, payments: { none: {} } },
    orderBy: { createdAt: "asc" },
    include: { items: { include: { menuItem: true } }, table: true },
  });

  res.json({
    table: { id: table.id, number: table.number },
    orders,
    total: orders.reduce((s, o) => s + orderTotal(o), 0),
  });
});

// Close the table: mark ALL its active unpaid orders paid in one transaction,
// applying an optional whole-bill discount and recording the (possibly split)
// payment lines so the end-of-day cash-up is accurate.
router.post("/:id/checkout", validate(checkoutSchema), async (req, res) => {
  const table = await prisma.table.findFirst({
    where: { id: req.params.id, restaurantId: req.user.restaurantId },
  });
  if (!table) return res.status(404).json({ error: "Table not found" });

  const orders = await prisma.order.findMany({
    where: { tableId: table.id, status: { in: ACTIVE }, payments: { none: {} } },
    orderBy: { createdAt: "asc" },
    include: { items: true },
  });
  if (orders.length === 0) return res.json({ count: 0, total: 0 });

  const billTotal = orders.reduce((s, o) => s + orderTotal(o), 0);
  const disc = Math.min(Math.max(0, Math.round(req.body.discount) || 0), billTotal);
  const net = billTotal - disc;

  const payments = req.body.payments;
  if (Array.isArray(payments) && payments.length > 0) {
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    if (paid !== net) {
      return res.status(400).json({ error: "Payments must add up to the amount due" });
    }
  }

  // Spread the discount back onto each order by its share of the bill.
  const discByOrder = distribute(disc, orders.map((o) => orderTotal(o)));

  const tx = orders.map((o, i) =>
    prisma.order.update({
      where: { id: o.id },
      data: { status: "PAID", discount: discByOrder[i] },
    })
  );
  // Attach the payment lines to the first order (reports total them globally).
  if (Array.isArray(payments) && payments.length > 0) {
    for (const p of payments) {
      tx.push(
        prisma.payment.create({
          data: {
            orderId: orders[0].id,
            amount: p.amount,
            provider: String(p.method || "cash").toLowerCase(),
            received: p.received ?? null,
            change: p.change ?? null,
          },
        })
      );
    }
  }

  await prisma.$transaction(tx);

  // Tell every live screen (kitchen, orders board, the customer's phone).
  const updated = await prisma.order.findMany({
    where: { id: { in: orders.map((o) => o.id) } },
    include: { items: { include: { menuItem: true } }, table: true, payments: true },
  });
  for (const o of updated) emitToRestaurant(req.user.restaurantId, "order:updated", o);

  res.json({ count: orders.length, total: billTotal, discount: disc, net });
});

// Move a table's open orders to another table. Covers two real cases:
//   - customer changes table  -> destination is empty
//   - customers mix tables     -> destination already has orders (bills combine)
router.post("/:id/move", validate(moveSchema), async (req, res) => {
  const { id } = req.params;
  const { toTableId } = req.body;
  if (id === toTableId) return res.status(400).json({ error: "Pick a different table" });

  const [from, to] = await Promise.all([
    prisma.table.findFirst({ where: { id, restaurantId: req.user.restaurantId } }),
    prisma.table.findFirst({ where: { id: toTableId, restaurantId: req.user.restaurantId } }),
  ]);
  if (!from || !to) return res.status(404).json({ error: "Table not found" });

  // Only unpaid, still-open orders move (paid ones are already closed).
  const orders = await prisma.order.findMany({
    where: { tableId: id, status: { in: ACTIVE }, payments: { none: {} } },
    select: { id: true },
  });
  if (orders.length === 0) {
    return res.status(400).json({ error: "This table has no open orders to move" });
  }
  const orderIds = orders.map((o) => o.id);

  await prisma.order.updateMany({ where: { id: { in: orderIds } }, data: { tableId: toTableId } });

  // The customers left the old table, so clear any calls still waiting there.
  const calls = await prisma.serviceRequest.findMany({
    where: { tableId: id, handled: false },
    select: { id: true },
  });
  if (calls.length > 0) {
    await prisma.serviceRequest.updateMany({
      where: { id: { in: calls.map((c) => c.id) } },
      data: { handled: true },
    });
    for (const c of calls) emitToRestaurant(req.user.restaurantId, "service:handled", { id: c.id });
  }

  // Refresh every live screen with the moved orders (now on the new table).
  const moved = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    include: { items: { include: { menuItem: true } }, table: true, payments: true },
  });
  for (const o of moved) emitToRestaurant(req.user.restaurantId, "order:updated", o);

  res.json({ count: moved.length, toTableId });
});

router.post("/", async (req, res) => {
  const { number } = req.body;
  const table = await prisma.table.create({
    data: { number, restaurantId: req.user.restaurantId },
  });
  res.json(table);
});

router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.table.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
    include: { orders: { select: { id: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Table not found" });
  if (existing.orders.length > 0) {
    return res.status(409).json({ error: "This table has orders — it can't be deleted" });
  }

  await prisma.table.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
