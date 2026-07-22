import { PrismaClient } from "@prisma/client";

// One shared database client for the whole app.
export const prisma = new PrismaClient();
