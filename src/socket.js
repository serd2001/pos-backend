import { Server } from "socket.io";

let io;

// Call this once, after the HTTP server is created.
export function initSocket(httpServer, frontendUrl) {
  io = new Server(httpServer, {
    cors: { origin: frontendUrl, methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    // A screen (kitchen, staff dashboard) joins its restaurant's "room"
    // so it only receives events for that restaurant — never another's.
    socket.on("join", (restaurantId) => {
      socket.join(`restaurant:${restaurantId}`);
    });
  });

  return io;
}

// Send an event to every screen belonging to one restaurant.
export function emitToRestaurant(restaurantId, event, payload) {
  if (!io) return;
  io.to(`restaurant:${restaurantId}`).emit(event, payload);
}
