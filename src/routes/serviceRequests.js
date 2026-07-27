import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { emitToRestaurant } from "../socket.js";

const router = Router();

const serviceSchema = z.object({
  restaurantId: z.string().min(1),
  tableId: z.string().min(1),
  type: z.enum(["WAITER", "BILL", "WATER"]),
});

// PUBLIC: customer taps "call staff" on their phone (no login).
// Rate-limited per IP so the button can't be scripted to flood the kitchen.
router.post("/public", rateLimit({ max: 20 }), validate(serviceSchema), async (req, res) => {
  const { restaurantId, tableId, type } = req.body;

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
