import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Creates a demo restaurant so you can log in and see data right away.
// Login:  owner@demo.com  /  password123
async function main() {
  const passwordHash = await bcrypt.hash("password123", 10);

  const restaurant = await prisma.restaurant.create({
    data: {
      name: "Demo Restaurant",
      users: { create: { name: "Owner", email: "owner@demo.com", passwordHash, role: "OWNER" } },
      tables: { create: [{ number: 1 }, { number: 2 }, { number: 3 }] },
    },
    include: { tables: true },
  });

  const category = await prisma.menuCategory.create({
    data: { name: "Main dishes", restaurantId: restaurant.id },
  });

  // Prices are in whole kip (LAK has no subunit), so 12000 = 12,000 kip.
  await prisma.menuItem.createMany({
    data: [
      { name: "Pad Thai", price: 12000, categoryId: category.id, restaurantId: restaurant.id },
      { name: "Green Curry", price: 15000, categoryId: category.id, restaurantId: restaurant.id },
      { name: "Fried Rice", price: 10000, categoryId: category.id, restaurantId: restaurant.id },
    ],
  });

  console.log("Seeded! Restaurant id:", restaurant.id);
  console.log("Tables:", restaurant.tables.map((t) => `#${t.number} (${t.id})`).join(", "));
  console.log("Login with owner@demo.com / password123");
}

main().finally(() => prisma.$disconnect());
