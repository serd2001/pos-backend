import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { emitToRestaurant } from "../socket.js";

const router = Router();

// Short in-memory cooldown so an accidental double-tap doesn't spam staff.
// Keyed per table AND per type, so a customer can still ask for water and then
// the bill back-to-back, and can re-call the same thing after a few seconds.
// (For production, use Redis so it works across multiple servers.)
const lastCall = new Map(); // key: `${tableId}:${type}` -> timestamp
const COOLDOWN_MS = 8_000;

// PUBLIC: customer taps "call staff" on their phone (no login).
router.post("/public", async (req, res) => {
  const { restaurantId, tableId, type } = req.body;

  const now = Date.now();
  const key = `${tableId}:${type}`;
  const previous = lastCall.get(key) || 0;
  if (now - previous < COOLDOWN_MS) {
    return res.status(429).json({ error: "Please wait a moment before calling again" });
  }
  lastCall.set(key, now);

  const request = await prisma.serviceRequest.create({
    data: { restaurantId, tableId, type }, // type: WAITER | BILL | WATER
    include: { table: true },
  });

  // Notify staff screens in real time.
  emitToRestaurant(restaurantId, "service:new", request);
  res.json({ ok: true });
});

// Staff: list open requests.
router.get("/", requireAuth, async (req, res) => {
  const requests = await prisma.serviceRequest.findMany({
    where: { restaurantId: req.user.restaurantId, handled: false },
    orderBy: { createdAt: "asc" },
    include: { table: true },
  });
  res.json(requests);
});

// Staff: mark a request as handled (clears it from the screen).
router.patch("/:id/handled", requireAuth, async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.serviceRequest.findFirst({
    where: { id, restaurantId: req.user.restaurantId },
  });
  if (!existing) return res.status(404).json({ error: "Request not found" });

  await prisma.serviceRequest.update({ where: { id }, data: { handled: true } });
  emitToRestaurant(req.user.restaurantId, "service:handled", { id });
  res.json({ ok: true });
});

export default router;
