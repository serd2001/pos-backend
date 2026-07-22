import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

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

router.post("/items", async (req, res) => {
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

router.patch("/items/:id", async (req, res) => {
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
