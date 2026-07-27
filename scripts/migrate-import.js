// One-time importer: loads the JSON produced by /api/_migrate/export into
// whatever database DATABASE_URL points at (here: Neon). All original ids are
// preserved so table QR codes and order links keep working.
//
// Usage:  DATABASE_URL="<neon-url>" node scripts/migrate-import.js <export.json>
import { readFileSync } from "fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/migrate-import.js <export.json>");
  process.exit(1);
}
const data = JSON.parse(readFileSync(file, "utf8"));

// Parents before children (foreign-key order). skipDuplicates makes it safe
// to run more than once.
const steps = [
  ["restaurants", (rows) => prisma.restaurant.createMany({ data: rows, skipDuplicates: true })],
  ["users", (rows) => prisma.user.createMany({ data: rows, skipDuplicates: true })],
  ["tables", (rows) => prisma.table.createMany({ data: rows, skipDuplicates: true })],
  ["categories", (rows) => prisma.menuCategory.createMany({ data: rows, skipDuplicates: true })],
  ["menuItems", (rows) => prisma.menuItem.createMany({ data: rows, skipDuplicates: true })],
  ["orders", (rows) => prisma.order.createMany({ data: rows, skipDuplicates: true })],
  ["orderItems", (rows) => prisma.orderItem.createMany({ data: rows, skipDuplicates: true })],
  ["payments", (rows) => prisma.payment.createMany({ data: rows, skipDuplicates: true })],
  ["serviceRequests", (rows) => prisma.serviceRequest.createMany({ data: rows, skipDuplicates: true })],
];

async function main() {
  for (const [key, fn] of steps) {
    const rows = data[key] || [];
    if (rows.length === 0) {
      console.log(`${key.padEnd(16)} 0 (skipped)`);
      continue;
    }
    const result = await fn(rows);
    console.log(`${key.padEnd(16)} ${result.count ?? rows.length} inserted`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("Import failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
