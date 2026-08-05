import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { emitToRestaurant } from "../socket.js";

const router = Router();

// Everything the staff screens need to render an order.
const orderInclude = {
  items: { include: { menuItem: true } },
  table: true,
  payments: true,
};

const cartItemSchema = z.object({
  menuItemId: z.string().min(1),
  quantity: z.number().int().positive().max(99).optional(),
  selected: z.array(z.any()).optional(),
});
// One line of a (possibly split) payment. `amount` is what this method covers;
// for cash, `received`/`change` record what was handed over and given back.
const paymentLineSchema = z.object({
  method: z.string().min(1).max(30),
  amount: z.number().int().positive(),
  received: z.number().int().nonnegative().optional(),
  change: z.number().int().nonnegative().optional(),
});
const publicOrderSchema = z.object({
  restaurantId: z.string().min(1),
  tableId: z.string().min(1),
  cart: z.array(cartItemSchema).min(1, "Your cart is empty"),
  note: z.string().max(500).optional(),
});
const staffOrderSchema = z.object({
  tableId: z.string().min(1),
  cart: z.array(cartItemSchema).min(1, "Your cart is empty"),
  note: z.string().max(500).optional(),
  discount: z.number().int().nonnegative().optional(),
  payments: z.array(paymentLineSchema).optional(),
});
const statusSchema = z.object({
  status: z.enum(["PENDING", "PREPARING", "SERVED", "PAID", "CANCELLED"]),
});
// Correcting a closed order: the client sends the desired quantity for each
// existing line (0 = remove it). We never re-price — we keep each line's
// locked-in unitPrice and only change quantities.
const correctSchema = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        quantity: z.number().int().min(0).max(99),
      })
    )
    .min(1, "Nothing to update"),
});

// Helper: build an order from a list of { menuItemId, quantity, selected }.
// Prices are read from the database (never trust prices sent by the client).
// `discount` (whole kip) and `payments` (split lines) are set when staff take
// payment up front at the counter — Payment rows are created with the order.
async function buildOrder({ restaurantId, tableId, source, cart, note, discount = 0, payments }) {
  const itemIds = cart.map((c) => c.menuItemId);
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, restaurantId },
  });

  const orderItems = cart.map((line) => {
    const item = menuItems.find((m) => m.id === line.menuItemId);
    if (!item) throw new Error("Menu item not found");

    // Price the chosen options: a "set" option (e.g. a size) replaces the base
    // price, an "add" option adds on top. Prices come from the request but the
    // base is the DB price, so a plain item can't be under-charged.
    let base = item.price;
    let add = 0;
    if (Array.isArray(line.selected)) {
      for (const opt of line.selected) {
        if (opt && opt.mode === "set") base = Math.max(0, Math.round(opt.price) || 0);
        else add += Math.max(0, Math.round(opt?.price) || 0);
      }
    }
    const unitPrice = base + add;

    return {
      menuItemId: item.id,
      quantity: line.quantity || 1,
      unitPrice,
      selected: line.selected ?? undefined,
    };
  });

  const total = orderItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const disc = Math.min(Math.max(0, Math.round(discount) || 0), total);
  const net = total - disc;

  // If payment lines were sent, they must add up to exactly what's due.
  let paymentsCreate;
  if (Array.isArray(payments) && payments.length > 0) {
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    if (paid !== net) throw new Error("Payments must add up to the amount due");
    paymentsCreate = {
      create: payments.map((p) => ({
        amount: p.amount,
        provider: String(p.method || "cash").toLowerCase(),
        received: p.received ?? null,
        change: p.change ?? null,
      })),
    };
  }

  return prisma.order.create({
    data: {
      restaurantId,
      tableId,
      source,
      note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null,
      discount: disc,
      items: { create: orderItems },
      payments: paymentsCreate,
    },
    include: orderInclude,
  });
}

// PUBLIC: customer places an order by scanning the QR (no login).
// The QR URL gives us restaurantId + tableId.
router.post("/public", rateLimit({ max: 30 }), validate(publicOrderSchema), async (req, res) => {
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
  payments: { select: { id: true, provider: true } },
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

// PUBLIC: how far this order is from being cooked — its place in the kitchen
// queue. "ahead" = orders for the same restaurant still waiting/cooking that
// came in earlier. Only meaningful while the order itself is PENDING/PREPARING.
router.get("/public/:orderId/queue", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    select: { status: true, createdAt: true, restaurantId: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  if (order.status !== "PENDING" && order.status !== "PREPARING") {
    return res.json({ status: order.status, ahead: 0, position: 0 });
  }

  const ahead = await prisma.order.count({
    where: {
      restaurantId: order.restaurantId,
      status: { in: ["PENDING", "PREPARING"] },
      createdAt: { lt: order.createdAt },
    },
  });
  res.json({ status: order.status, ahead, position: ahead + 1 });
});

// Staff creates an order from the POS terminal.
router.post("/", requireAuth, validate(staffOrderSchema), async (req, res) => {
  const { tableId, cart, note, discount, payments } = req.body;
  try {
    const order = await buildOrder({
      restaurantId: req.user.restaurantId,
      tableId,
      source: "STAFF",
      cart,
      note,
      discount,
      payments,
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
    include: orderInclude,
  });
  res.json(orders);
});

// Update an order's status (e.g. kitchen marks it PREPARING, then SERVED).
router.patch("/:id/status", requireAuth, validate(statusSchema), async (req, res) => {
  const { id } = req.params;
  let { status } = req.body;

  const existing = await prisma.order.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
    include: { payments: true },
  });
  if (!existing) return res.status(404).json({ error: "Order not found" });

  // Counter orders are paid up front — once served, they're fully closed.
  if (status === "SERVED" && existing.payments.length > 0) status = "PAID";

  const order = await prisma.order.update({
    where: { id },
    data: { status },
    include: orderInclude,
  });

  emitToRestaurant(req.user.restaurantId, "order:updated", order);
  res.json(order);
});

// Correct a closed order (owner only). Used when staff notice a mistake after
// the customer paid — e.g. an item that wasn't theirs. Reports recompute from
// the fixed lines; a single recorded payment is kept in sync with the new total.
router.patch(
  "/:id/items",
  requireAuth,
  requireRole("OWNER"),
  validate(correctSchema),
  async (req, res) => {
    const { id } = req.params;
    const { items } = req.body;

    const existing = await prisma.order.findFirst({
      where: { id, restaurantId: req.user.restaurantId },
      include: { items: true, payments: true },
    });
    if (!existing) return res.status(404).json({ error: "Order not found" });

    // Requested quantities keyed by order-item id. Any line not mentioned keeps
    // its current quantity; ids that don't belong to this order are ignored.
    const requested = new Map(items.map((l) => [l.orderItemId, l.quantity]));
    const deletes = [];
    const updates = [];
    let newTotal = 0;
    for (const it of existing.items) {
      const qty = requested.has(it.id) ? requested.get(it.id) : it.quantity;
      if (qty <= 0) {
        deletes.push(it.id);
        continue;
      }
      if (qty !== it.quantity) updates.push({ id: it.id, quantity: qty });
      newTotal += it.unitPrice * qty;
    }

    // An order must keep at least one item — removing everything is a cancel.
    if (existing.items.length - deletes.length <= 0) {
      return res
        .status(400)
        .json({ error: "An order must keep at least one item — cancel it instead" });
    }

    // Keep a single payment in sync with the corrected (discounted) total.
    // Split payments are left alone — the owner refunds the difference by hand.
    const newNet = Math.max(0, newTotal - (existing.discount || 0));

    await prisma.$transaction([
      ...deletes.map((itemId) => prisma.orderItem.delete({ where: { id: itemId } })),
      ...updates.map((u) =>
        prisma.orderItem.update({ where: { id: u.id }, data: { quantity: u.quantity } })
      ),
      ...(existing.payments.length === 1
        ? [prisma.payment.update({ where: { id: existing.payments[0].id }, data: { amount: newNet } })]
        : []),
    ]);

    const order = await prisma.order.findUnique({ where: { id }, include: orderInclude });

    emitToRestaurant(req.user.restaurantId, "order:updated", order);
    res.json(order);
  }
);

export default router;
