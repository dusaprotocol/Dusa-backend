export interface Role {
  name: string;
  id: string;
  boost: number;
}

export const roles: Role[] = [
  { name: "DUSA AMBASSADOR", id: "1110937453658918952", boost: 0.35 },
  { name: "LEGENDARY DUSER", id: "1023582914564341810", boost: 0.3 },
  { name: "OG DUSER", id: "1090289346084610150", boost: 0.2 },
  { name: "EARLY DUSER", id: "1119709035688632360", boost: 0.15 },
];

import { Liquidity, Swap, Token } from "@prisma/client";
import logger from "./logger";
import { isBuildnet } from "./config";
import { prisma } from "./db";
import {
  abs,
  adjustPrice,
  getPriceFromId,
  printAddress,
  printTA,
  toToken,
} from "./methods";

const explorerUrl = `https://massa-tools${
  isBuildnet ? "-buildnet" : ""
}-git-trpc-n1pus-projects.vercel.app`;
const portfolioUrl = `https://${isBuildnet ? "beta" : "app"}.dusa.io/portfolio`;

interface DiscordEmbed {
  title?: string;
  description?: string;
  timestamp?: Date;
  color?: number;
}

interface WebhookPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

/**
 * Post a message to a Discord webhook
 * @param webhook - Discord webhook URL
 * @param payload - Message payload (can contain content, embeds, etc.)
 * @returns Promise<boolean> - true if successful, false otherwise
 */
export const postWebhook = async (
  webhook: string,
  payload: WebhookPayload
): Promise<boolean> => {
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const json = await response.json();
      logger.error(`Discord webhook error: ${JSON.stringify(json)}`);
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`Error posting to Discord webhook: ${error}`);
    return false;
  }
};

export const sendDiscordAlert = async (op: Swap | Liquidity) => {
  const webhook = process.env.DISCORD_WEBHOOK_FEED;
  if (!webhook) return;

  const pool = await prisma.pool.findUnique({
    where: { address: op.poolAddress },
    include: { token0: true, token1: true },
  });
  if (!pool) return;
  const { token0, token1, version } = pool;

  const explorerPageUrl = explorerUrl + "/operation/" + op.txHash;
  const portfolioPageUrl = portfolioUrl + "/" + op.userAddress;

  const adjust = (id: number) => {
    const adjusted = adjustPrice(
      getPriceFromId(id, pool.binStep),
      token0.decimals,
      token1.decimals
    );
    return adjusted.toFixed(adjusted < 10 ? 4 : 2);
  };

  const isSwap = "swapForY" in op;
  // if (!isSwap || op.usdValue < 100) return;

  let title = "";
  let description = `Tx hash: [${printAddress(
    op.txHash
  )}](${explorerPageUrl})\nUser: [${printAddress(
    op.userAddress
  )}](${portfolioPageUrl})`;

  if (isSwap) {
    const tokenIn = op.swapForY ? token0 : token1;
    const tokenOut = op.swapForY ? token1 : token0;
    title += `\nSwap ${printTA(tokenIn, op.amountIn)} ${
      tokenIn.symbol
    } for ${printTA(tokenOut, op.amountOut)} ${tokenOut.symbol}`;
    if (op.startId !== op.endId)
      description += `\nPrice: ${adjust(op.startId)} -> ${adjust(op.endId)}`;
    else description += `\nPrice: ${adjust(op.startId)}`;
    description += ` ${pool.token0.symbol} per ${pool.token1.symbol}`;
    description += `\nVersion: ${version}`;
  } else {
    const amount0 = BigInt(op.amount0);
    const amount1 = BigInt(op.amount1);
    const isAdd = amount0 > 0n || amount1 > 0n;
    const { token0, token1 } = pool;
    title += `\n${isAdd ? "Add " : "Remove "}`;
    if (amount0 !== 0n)
      title += `${printTA(token0, abs(BigInt(op.amount0)))} ${token0.symbol}`;
    if (amount0 !== 0n && amount1 !== 0n) title += " and ";
    if (amount1 !== 0n)
      title += `${printTA(token1, abs(BigInt(op.amount1)))} ${token1.symbol}`;
    description += `\Price: [${adjust(op.lowerBound)} - ${adjust(
      op.upperBound
    )}] ${token0.symbol} per ${token1.symbol}`;
    description += `\nVersion: ${version}`;
  }
  title += ` ($${op.usdValue.toFixed(1)})`;

  const payload = {
    embeds: [{ title, description, timestamp: op.timestamp }],
  };

  await postWebhook(webhook, payload);
};
