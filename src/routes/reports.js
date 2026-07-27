import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// Start-of-day N days ago (0 = today), in server local time.
function startOfDaysAgo(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

const RANGES = { today: 0, "7d": 6, "30d": 29 };

// Sales summary for the Reports screen.
// NOTE: POS checkout doesn't mark orders PAID yet, so "sales" here means every
// order placed in the range except cancelled ones — the best signal we have.
// Revenue is net of any discount applied at checkout.
router.get("/summary", async (req, res) => {
  const range = RANGES[req.query.range] !== undefined ? req.query.range : "7d";
  const since = startOfDaysAgo(RANGES[range]);

  const orders = await prisma.order.findMany({
    where: {
      restaurantId: req.user.restaurantId,
      status: { not: "CANCELLED" },
      createdAt: { gte: since },
    },
    include: { items: { include: { menuItem: true } } },
  });

  let gross = 0;
  let discountTotal = 0;
  let itemsSold = 0;
  const byItem = new Map(); // menuItemId -> { name, qty, revenue }

  for (const order of orders) {
    discountTotal += order.discount || 0;
    for (const line of order.items) {
      const lineTotal = line.unitPrice * line.quantity;
      gross += lineTotal;
      itemsSold += line.quantity;

      const key = line.menuItemId;
      const name = line.menuItem?.name ?? "—";
      const agg = byItem.get(key) ?? { name, qty: 0, revenue: 0 };
      agg.qty += line.quantity;
      agg.revenue += lineTotal;
      byItem.set(key, agg);
    }
  }

  const revenue = gross - discountTotal; // net of discounts
  const orderCount = orders.length;
  const topItems = [...byItem.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8);

  res.json({
    range,
    since,
    revenue,
    discountTotal,
    orderCount,
    itemsSold,
    avgOrder: orderCount ? Math.round(revenue / orderCount) : 0,
    topItems,
  });
});

// End-of-day cash-up: money actually collected in the period, broken down by
// payment method, with the cash total to reconcile the drawer at close.
router.get("/cashup", async (req, res) => {
  const range = RANGES[req.query.range] !== undefined ? req.query.range : "today";
  const since = startOfDaysAgo(RANGES[range]);

  const payments = await prisma.payment.findMany({
    where: {
      paidAt: { gte: since },
      order: { restaurantId: req.user.restaurantId },
    },
    select: { amount: true, provider: true },
  });

  const byMethod = {};
  let total = 0;
  for (const p of payments) {
    const method = (p.provider || "cash").toLowerCase();
    byMethod[method] = (byMethod[method] || 0) + p.amount;
    total += p.amount;
  }

  res.json({
    range,
    since,
    total,
    count: payments.length,
    cash: byMethod.cash || 0,
    byMethod, // { cash, transfer, bank_qr, card, ... }
  });
});

export default router;
