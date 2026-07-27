import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";

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
import migrateRoutes from "./routes/_migrate.js"; // TEMPORARY — remove after Neon migration

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
app.use("/api/_migrate", migrateRoutes); // TEMPORARY — remove after Neon migration

// Wrap Express in an HTTP server so Socket.io can share the same port.
const httpServer = createServer(app);
initSocket(httpServer, allowedOrigins);

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
