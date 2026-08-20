import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.schema.js';

const adapter = new PrismaPg(env.DATABASE_URL);

export const prisma = new PrismaClient({ adapter });
