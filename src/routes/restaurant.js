import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// The current user's restaurant (name + bank QR) for the Settings screen.
router.get("/", async (req, res) => {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: req.user.restaurantId },
    select: { id: true, name: true, bankQrUrl: true, createdAt: true },
  });
  if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });
  res.json(restaurant);
});

// Update the restaurant profile. Only the fields sent are changed.
router.patch("/", async (req, res) => {
  const { name, bankQrUrl } = req.body;
  const data = {};
  if (typeof name === "string" && name.trim()) data.name = name.trim();
  if (bankQrUrl !== undefined) data.bankQrUrl = bankQrUrl; // null clears it

  const restaurant = await prisma.restaurant.update({
    where: { id: req.user.restaurantId },
    data,
    select: { id: true, name: true, bankQrUrl: true },
  });
  res.json(restaurant);
});

export default router;
