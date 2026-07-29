import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";

import { prisma } from "./prisma.js";
import { initSocket } from "./socket.js";
import authRoutes from "./routes/auth.js";
import menuRoutes from "./routes/menu.js";
import orderRoutes from "./routes/orders.js";
import tableRoutes from "./routes/tables.js";
import serviceRoutes from "./routes/serviceRequests.js";
import paymentRoutes from "./routes/payments.js";
import restaurantRoutes from "./routes/restaurant.js";
import reportRoutes from "./routes/reports.js";
import userRoutes from "./routes/users.js";

// FRONTEND_URL may be a comma-separated list (e.g. the Vercel URL + localhost).
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(cors({ origin: allowedOrigins }));
// Larger limit so image data URLs (menu photos, bank QR) fit in the body.
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/tables", tableRoutes);
app.use("/api/service-requests", serviceRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/restaurant", restaurantRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/users", userRoutes);

// Wrap Express in an HTTP server so Socket.io can share the same port.
const httpServer = createServer(app);
initSocket(httpServer, allowedOrigins);

// Safety net for columns added to the DB via `prisma db push` (no migration
// file). Idempotent — runs on boot and does nothing if the column already
// exists — so a deploy can add the column without a separate DB step.
async function ensureColumns() {
  const stmts = [
    'ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "logoUrl" TEXT',
    'ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "address" TEXT',
    'ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "phone" TEXT',
  ];
  for (const sql of stmts) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (e) {
      console.error("ensureColumns failed (continuing):", e.message);
    }
  }
}

const PORT = process.env.PORT || 4000;
ensureColumns().finally(() => {
  httpServer.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
});
