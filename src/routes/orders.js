import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { emitToRestaurant } from "../socket.js";

const router = Router();

// Helper: build an order from a list of { menuItemId, quantity, selected }.
// Prices are read from the database (never trust prices sent by the client).
// `payment` ({ method }) is set when the customer paid up front at the counter —
// a Payment row is created together with the order.
async function buildOrder({ restaurantId, tableId, source, cart, note, payment }) {
  const itemIds = cart.map((c) => c.menuItemId);
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, restaurantId },
  });

  const orderItems = cart.map((line) => {
    const item = menuItems.find((m) => m.id === line.menuItemId);
    if (!item) throw new Error("Menu item not found");

    // Start with the base price, then add any chosen modifier prices.
    let unitPrice = item.price;
    if (Array.isArray(line.selected)) {
      for (const opt of line.selected) unitPrice += opt.price || 0;
    }

    return {
      menuItemId: item.id,
      quantity: line.quantity || 1,
      unitPrice,
      selected: line.selected ?? undefined,
    };
  });

  const total = orderItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);

  return prisma.order.create({
    data: {
      restaurantId,
      tableId,
      source,
      note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null,
      items: { create: orderItems },
      // Paid at the counter: record it now; the kitchen still cooks the order.
      payment: payment
        ? { create: { amount: total, provider: String(payment.method || "cash").toLowerCase() } }
        : undefined,
    },
    include: { items: { include: { menuItem: true } }, table: true, payment: true },
  });
}

// PUBLIC: customer places an order by scanning the QR (no login).
// The QR URL gives us restaurantId + tableId.
router.post("/public", async (req, res) => {
  const { restaurantId, tableId, cart, note } = req.body;
  try {
    const order = await buildOrder({ restaurantId, tableId, source: "QR", cart, note });
    // Push it live to the kitchen screen of THIS restaurant only.
    emitToRestaurant(restaurantId, "order:new", order);
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Fields safe to show a customer following their order.
const publicOrderSelect = {
  id: true,
  status: true,
  note: true,
  createdAt: true,
  payment: { select: { id: true, provider: true } },
  table: { select: { number: true } },
  items: {
    select: {
      id: true,
      quantity: true,
      unitPrice: true,
      menuItem: { select: { name: true } },
    },
  },
};

// PUBLIC: order history for this device (ids come from the customer's localStorage).
// Must be registered before /public/:orderId so "batch" isn't taken as an id.
router.get("/public/batch", async (req, res) => {
  const ids = String(req.query.ids || "").split(",").filter(Boolean).slice(0, 20);
  if (ids.length === 0) return res.json([]);
  const orders = await prisma.order.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: "desc" },
    select: publicOrderSelect,
  });
  res.json(orders);
});

// PUBLIC: a customer follows one order. Order ids are unguessable cuids,
// so knowing the id is treated as proof you placed it.
router.get("/public/:orderId", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    select: publicOrderSelect,
  });
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

// Staff creates an order from the POS terminal.
router.post("/", requireAuth, async (req, res) => {
  const { tableId, cart, note, payment } = req.body;
  try {
    const order = await buildOrder({
      restaurantId: req.user.restaurantId,
      tableId,
      source: "STAFF",
      cart,
      note,
      payment,
    });
    emitToRestaurant(req.user.restaurantId, "order:new", order);
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List orders for the staff screens.
// Default: active orders (kitchen / orders board). ?scope=done: the most
// recent closed orders (paid or cancelled), newest first.
router.get("/", requireAuth, async (req, res) => {
  const done = req.query.scope === "done";
  const orders = await prisma.order.findMany({
    where: {
      restaurantId: req.user.restaurantId,
      status: { in: done ? ["PAID", "CANCELLED"] : ["PENDING", "PREPARING", "SERVED"] },
    },
    orderBy: { createdAt: done ? "desc" : "asc" },
    ...(done ? { take: 100 } : {}),
    include: { items: { include: { menuItem: true } }, table: true, payment: true },
  });
  res.json(orders);
});

// Update an order's status (e.g. kitchen marks it PREPARING, then SERVED).
router.patch("/:id/status", requireAuth, async (req, res) => {
  const { id } = req.params;
  let { status } = req.body;

  const existing = await prisma.order.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
    include: { payment: true },
  });
  if (!existing) return res.status(404).json({ error: "Order not found" });

  // Counter orders are paid up front — once served, they're fully closed.
  if (status === "SERVED" && existing.payment) status = "PAID";

  const order = await prisma.order.update({
    where: { id },
    data: { status },
    include: { items: { include: { menuItem: true } }, table: true, payment: true },
  });

  emitToRestaurant(req.user.restaurantId, "order:updated", order);
  res.json(order);
});

export default router;
