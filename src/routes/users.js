import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

// Staff management is owner-only.
router.use(requireAuth, requireRole("OWNER"));

const createSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters").max(200),
  role: z.enum(["MANAGER", "STAFF"]).default("STAFF"),
});
const resetPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters").max(200),
});

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt,
});

// List everyone in this restaurant.
router.get("/", async (req, res) => {
  const users = await prisma.user.findMany({
    where: { restaurantId: req.user.restaurantId },
    orderBy: { createdAt: "asc" },
  });
  res.json(users.map(publicUser));
});

// Add a staff or manager account.
router.post("/", validate(createSchema), async (req, res) => {
  const { name, email, password, role } = req.body;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already in use" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role, restaurantId: req.user.restaurantId },
  });
  res.json(publicUser(user));
});

// Reset a staff member's password (owner does this when they forget theirs).
router.patch("/:id/password", validate(resetPasswordSchema), async (req, res) => {
  const { id } = req.params;
  const target = await prisma.user.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
  });
  if (!target) return res.status(404).json({ error: "User not found" });

  const passwordHash = await bcrypt.hash(req.body.password, 10);
  await prisma.user.update({ where: { id }, data: { passwordHash } });
  res.json({ ok: true });
});

// Remove a staff account (never yourself or another owner).
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (id === req.user.userId) {
    return res.status(400).json({ error: "You can't remove your own account" });
  }
  const target = await prisma.user.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
  });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "OWNER") return res.status(400).json({ error: "You can't remove an owner" });

  await prisma.user.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
