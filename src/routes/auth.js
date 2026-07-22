import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// Sign up = create a new restaurant (tenant) + its first owner account.
router.post("/signup", async (req, res) => {
  const { restaurantName, name, email, password } = req.body;
  if (!restaurantName || !email || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already in use" });

  const passwordHash = await bcrypt.hash(password, 10);

  // Create the restaurant and its owner together.
  const restaurant = await prisma.restaurant.create({
    data: {
      name: restaurantName,
      users: {
        create: { name: name || "Owner", email, passwordHash, role: "OWNER" },
      },
    },
    include: { users: true },
  });

  const user = restaurant.users[0];
  const token = signToken(user);
  res.json({ token, user: publicUser(user), restaurant: { id: restaurant.id, name: restaurant.name } });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Wrong email or password" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Wrong email or password" });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// The logged-in user's own account details (for the Settings screen).
router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(publicUser(user));
});

function signToken(user) {
  return jwt.sign(
    { userId: user.id, restaurantId: user.restaurantId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export default router;
