import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const itemCreateSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  categoryId: z.string().min(1, "Category is required"),
  description: z.string().max(1000).nullable().optional(),
  price: z.number().int().nonnegative("Price must be 0 or more"),
  cost: z.number().int().nonnegative().optional(),
  imageUrl: z.string().max(4_000_000).nullable().optional(),
  available: z.boolean().optional(),
  modifiers: z.any().optional(),
});
// PATCH allows any subset; unknown keys are stripped by zod (so a client can't
// slip in fields like restaurantId).
const itemUpdateSchema = itemCreateSchema.partial();

// PUBLIC: the customer's phone loads the menu for a restaurant (no login).
// Only available items are returned.
router.get("/public/:restaurantId", async (req, res) => {
  const { restaurantId } = req.params;
  const categories = await prisma.menuCategory.findMany({
    where: { restaurantId },
    orderBy: { sortOrder: "asc" },
    include: {
      items: { where: { available: true } },
    },
  });
  res.json(categories);
});

// PUBLIC: the customer's "Popular" section — the best-selling available items,
// ranked by total quantity ordered (cancelled orders excluded).
router.get("/public/:restaurantId/popular", async (req, res) => {
  const { restaurantId } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 10);

  const grouped = await prisma.orderItem.groupBy({
    by: ["menuItemId"],
    where: {
      order: { restaurantId, status: { not: "CANCELLED" } },
      menuItem: { restaurantId, available: true },
    },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });

  const ids = grouped.map((g) => g.menuItemId);
  if (ids.length === 0) return res.json([]);

  const items = await prisma.menuItem.findMany({
    where: { id: { in: ids }, restaurantId, available: true },
  });
  // Keep them in popularity order (groupBy order is lost by findMany).
  const byId = new Map(items.map((i) => [i.id, i]));
  res.json(ids.map((id) => byId.get(id)).filter(Boolean));
});

// Everything below needs a logged-in staff/owner account.
router.use(requireAuth);

// List the full menu (including unavailable items) for the owner dashboard.
router.get("/", async (req, res) => {
  const categories = await prisma.menuCategory.findMany({
    where: { restaurantId: req.user.restaurantId },
    orderBy: { sortOrder: "asc" },
    include: { items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
  res.json(categories);
});

router.post("/categories", async (req, res) => {
  const { name, sortOrder } = req.body;
  const category = await prisma.menuCategory.create({
    data: { name, sortOrder: sortOrder ?? 0, restaurantId: req.user.restaurantId },
  });
  res.json(category);
});

router.patch("/categories/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.menuCategory.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
  });
  if (!existing) return res.status(404).json({ error: "Category not found" });

  const { name, sortOrder } = req.body;
  const category = await prisma.menuCategory.update({
    where: { id },
    data: { name, sortOrder },
  });
  res.json(category);
});

router.delete("/categories/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.menuCategory.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
    include: { items: { select: { id: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Category not found" });
  if (existing.items.length > 0) {
    return res.status(400).json({ error: "Move or delete the category's items first" });
  }

  await prisma.menuCategory.delete({ where: { id } });
  res.json({ ok: true });
});

router.post("/items", validate(itemCreateSchema), async (req, res) => {
  const { name, description, price, cost, categoryId, modifiers, imageUrl, available } = req.body;
  const item = await prisma.menuItem.create({
    data: {
      name,
      description,
      price, // in whole kip
      cost: cost ?? 0,
      imageUrl: imageUrl ?? null,
      available: available ?? true,
      categoryId,
      modifiers: modifiers ?? undefined,
      restaurantId: req.user.restaurantId,
    },
  });
  res.json(item);
});

router.patch("/items/:id", validate(itemUpdateSchema), async (req, res) => {
  const { id } = req.params;
  // Make sure the item belongs to this restaurant before updating.
  const existing = await prisma.menuItem.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
  });
  if (!existing) return res.status(404).json({ error: "Item not found" });

  const item = await prisma.menuItem.update({ where: { id }, data: req.body });
  res.json(item);
});

router.delete("/items/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.menuItem.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
  });
  if (!existing) return res.status(404).json({ error: "Item not found" });

  try {
    await prisma.menuItem.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    // P2003 = the item appears on past orders, so it can't be hard-deleted.
    if (e.code === "P2003") {
      return res.status(409).json({
        error: "This item is part of existing orders — mark it unavailable instead",
      });
    }
    throw e;
  }
});

export default router;
