import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { emitToRestaurant } from "../socket.js";

// Order statuses that mean "the table still owes money".
const ACTIVE = ["PENDING", "PREPARING", "SERVED"];

function orderTotal(order) {
  return order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
}

const router = Router();

// PUBLIC: the customer page shows which table the QR belongs to (no login).
// Also carries the restaurant's bank QR so customers can pay by transfer.
router.get("/public/:restaurantId/:tableId", async (req, res) => {
  const { restaurantId, tableId } = req.params;
  const table = await prisma.table.findFirst({
    where: { id: tableId, restaurantId },
    include: { restaurant: { select: { name: true, bankQrUrl: true } } },
  });
  if (!table) return res.status(404).json({ error: "Table not found" });
  res.json({
    number: table.number,
    restaurantName: table.restaurant.name,
    bankQrUrl: table.restaurant.bankQrUrl,
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
          payment: { select: { id: true } },
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
      .filter((o) => !o.payment)
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
    where: { tableId: table.id, status: { in: ACTIVE }, payment: null },
    orderBy: { createdAt: "asc" },
    include: { items: { include: { menuItem: true } }, table: true },
  });

  res.json({
    table: { id: table.id, number: table.number },
    orders,
    total: orders.reduce((s, o) => s + orderTotal(o), 0),
  });
});

// Close the table: mark ALL its active orders paid in one transaction.
router.post("/:id/checkout", async (req, res) => {
  const table = await prisma.table.findFirst({
    where: { id: req.params.id, restaurantId: req.user.restaurantId },
  });
  if (!table) return res.status(404).json({ error: "Table not found" });

  const orders = await prisma.order.findMany({
    where: { tableId: table.id, status: { in: ACTIVE } },
    include: { items: { include: { menuItem: true } }, table: true },
  });
  if (orders.length === 0) return res.json({ count: 0, total: 0 });

  await prisma.$transaction(
    orders.map((o) =>
      prisma.order.update({ where: { id: o.id }, data: { status: "PAID" } })
    )
  );

  // Tell every live screen (kitchen, orders board, the customer's phone).
  for (const o of orders) {
    emitToRestaurant(req.user.restaurantId, "order:updated", { ...o, status: "PAID" });
  }

  res.json({ count: orders.length, total: orders.reduce((s, o) => s + orderTotal(o), 0) });
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
