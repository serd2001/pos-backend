// TEMPORARY migration endpoint — DELETE this file (and its mount in server.js)
// once the database has been moved to Neon.
//
// It dumps every table as JSON so the data can be re-imported into a new
// database. Because the owner's password isn't available to the migration
// script, it's guarded by a one-time random key instead of a login. The key
// is thrown away after the migration.
import { Router } from "express";
import { prisma } from "../prisma.js";

const MIGRATE_KEY = "f9641ee06496a3c3f7765c3fba9998dd812ee0c26d36bf27";

const router = Router();

router.get("/export", async (req, res) => {
  if (req.query.key !== MIGRATE_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const [
    restaurants,
    users,
    tables,
    categories,
    menuItems,
    orders,
    orderItems,
    payments,
    serviceRequests,
  ] = await Promise.all([
    prisma.restaurant.findMany(),
    prisma.user.findMany(),
    prisma.table.findMany(),
    prisma.menuCategory.findMany(),
    prisma.menuItem.findMany(),
    prisma.order.findMany(),
    prisma.orderItem.findMany(),
    prisma.payment.findMany(),
    prisma.serviceRequest.findMany(),
  ]);

  res.json({
    restaurants,
    users,
    tables,
    categories,
    menuItems,
    orders,
    orderItems,
    payments,
    serviceRequests,
  });
});

export default router;
