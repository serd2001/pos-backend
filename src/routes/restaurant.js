import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// The current user's restaurant (name + bank QR + logo) for the Settings screen.
router.get("/", async (req, res) => {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: req.user.restaurantId },
    select: {
      id: true, name: true, bankQrUrl: true, logoUrl: true,
      address: true, phone: true, theme: true, createdAt: true,
    },
  });
  if (!restaurant) return res.status(404).json({ error: "Restaurant not found" });
  res.json(restaurant);
});

// Update the restaurant profile. Only the fields sent are changed.
router.patch("/", async (req, res) => {
  const { name, bankQrUrl, logoUrl, address, phone, theme } = req.body;
  const data = {};
  if (typeof name === "string" && name.trim()) data.name = name.trim();
  if (bankQrUrl !== undefined) data.bankQrUrl = bankQrUrl; // null clears it
  if (logoUrl !== undefined) data.logoUrl = logoUrl; // null clears it
  if (address !== undefined) data.address = typeof address === "string" ? address.trim() || null : null;
  if (phone !== undefined) data.phone = typeof phone === "string" ? phone.trim() || null : null;
  if (typeof theme === "string") data.theme = theme.slice(0, 20);

  const restaurant = await prisma.restaurant.update({
    where: { id: req.user.restaurantId },
    data,
    select: { id: true, name: true, bankQrUrl: true, logoUrl: true, address: true, phone: true, theme: true },
  });
  res.json(restaurant);
});

export default router;
