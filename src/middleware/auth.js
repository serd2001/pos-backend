import jwt from "jsonwebtoken";

// Protects staff/owner routes. Reads the token from the Authorization header,
// verifies it, and attaches { userId, restaurantId, role } to req.user.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Not logged in" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, restaurantId, role }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Optional: restrict a route to certain roles, e.g. requireRole("OWNER", "MANAGER")
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Not allowed" });
    }
    next();
  };
}
