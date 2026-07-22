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

  let revenue = 0;
  let itemsSold = 0;
  const byItem = new Map(); // menuItemId -> { name, qty, revenue }

  for (const order of orders) {
    for (const line of order.items) {
      const lineTotal = line.unitPrice * line.quantity;
      revenue += lineTotal;
      itemsSold += line.quantity;

      const key = line.menuItemId;
      const name = line.menuItem?.name ?? "—";
      const agg = byItem.get(key) ?? { name, qty: 0, revenue: 0 };
      agg.qty += line.quantity;
      agg.revenue += lineTotal;
      byItem.set(key, agg);
    }
  }

  const orderCount = orders.length;
  const topItems = [...byItem.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8);

  res.json({
    range,
    since,
    revenue,
    orderCount,
    itemsSold,
    avgOrder: orderCount ? Math.round(revenue / orderCount) : 0,
    topItems,
  });
});

export default router;
