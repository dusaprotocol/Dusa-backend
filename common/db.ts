import { Prisma, PrismaClient } from "@prisma/client";
import logger from "./logger";

export const prisma = new PrismaClient({
  log: [],
});
let whitelistedPoolsCache: string[] | null = null;

export const getWhitelistedPools = async (): Promise<string[]> => {
  if (whitelistedPoolsCache !== null) {
    return whitelistedPoolsCache;
  }

  try {
    const pools = await prisma.pool.findMany({
      select: { address: true },
      where: { whitelisted: true },
    });
    whitelistedPoolsCache = pools.map((p) => p.address);
    return whitelistedPoolsCache;
  } catch (error) {
    logger.warn("Failed to fetch whitelisted pools:", error);
    return [];
  }
};

export const handlePrismaError = (err: Error) => {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return;

    logger.warn(err.message, err.code);
  }
};
