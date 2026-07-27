// Simple in-memory sliding-window rate limiter for public (unauthenticated)
// endpoints, so a prankster who has a table QR can't flood the kitchen.
// Keyed by the real client IP. Fine for a single instance; use Redis to scale out.
const hits = new Map(); // ip -> number[] (timestamps)

function clientIp(req) {
  // Behind Cloudflare, the real client IP arrives in cf-connecting-ip.
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

export function rateLimit({ windowMs = 60_000, max = 30 } = {}) {
  return (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: "Too many requests — please slow down" });
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}

// Periodically drop stale entries so the map can't grow forever.
const cleanup = setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [ip, arr] of hits) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length) hits.set(ip, kept);
    else hits.delete(ip);
  }
}, 5 * 60_000);
cleanup.unref?.();
