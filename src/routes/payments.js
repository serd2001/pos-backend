import { Router } from "express";
import Stripe from "stripe";
import { prisma } from "../prisma.js";
import { emitToRestaurant } from "../socket.js";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Helper: total of an order, calculated from saved data on the SERVER.
// Never trust an amount sent by the client — the customer could change it.
function orderTotal(order) {
  return order.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
}

// PUBLIC: customer scans the pay QR, we return what they owe.
router.get("/order/:orderId", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    include: { items: { include: { menuItem: true } }, table: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status === "PAID") return res.status(400).json({ error: "Already paid" });

  res.json({ order, total: orderTotal(order) });
});

// PUBLIC: create a Stripe PaymentIntent for the order.
router.post("/order/:orderId/intent", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const amount = orderTotal(order); // server-calculated amount, in whole kip
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "lak",
    metadata: { orderId: order.id },
  });

  res.json({ clientSecret: intent.client_secret, amount });
});

// Called after Stripe confirms payment succeeded.
// In production, use a Stripe webhook to confirm — this simplified version
// trusts the client for clarity. Add webhook verification before going live.
router.post("/order/:orderId/confirm", async (req, res) => {
  const { orderId } = req.params;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const amount = orderTotal(order);

  await prisma.$transaction([
    prisma.payment.create({ data: { orderId, amount, provider: "card" } }),
    prisma.order.update({ where: { id: orderId }, data: { status: "PAID" } }),
  ]);

  emitToRestaurant(order.restaurantId, "order:paid", { orderId, tableId: order.tableId });
  res.json({ ok: true });
});

export default router;
