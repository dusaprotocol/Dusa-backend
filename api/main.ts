import "../common/readonly"; // must stay first: this service never holds wallet keys
import express from "express";
import cors from "cors";
import { appRouter, expressMiddleware } from "./src/trpc";
import {
  getBars,
  getConfig,
  getServerTime,
  resolveSymbol,
  searchSymbols,
} from "./src/tradingview";
import * as CG from "./src/coingecko";
import * as CMC from "./src/coinmarketcap";
import apicache from "apicache";
import { expressHandler } from "trpc-playground/handlers/express";
import { validateRequest } from "zod-express-middleware";
import { z } from "zod";
import logger from "../common/logger";
import {
  generateOpenApiDocument,
  createOpenApiExpressMiddleware,
} from "trpc-openapi";
import swaggerUi from "swagger-ui-express";
import { IERC20 } from "@dusalabs/sdk";
import { DUSA } from "../common/contracts";
import { web3Client } from "../common/client";
import { Args } from "@massalabs/massa-web3";
import { EXCL_DUSA_CIRCULATING } from "../common/config";
import { applyRateLimits } from "./src/rateLimit";

const cache = apicache.options({
  headers: { "cache-control": "no-cache" },
  statusCodes: { include: [200] },
}).middleware;

const trpcApiEndpoint = "/trpc";
const playgroundEndpoint = "/trpc-playground";
const openApiEndpoint = "/api";

const app = express();
app.use(cors());
applyRateLimits(app);
app.use(trpcApiEndpoint, expressMiddleware);
// @ts-expect-error
app.use(openApiEndpoint, createOpenApiExpressMiddleware({ router: appRouter }));

// Playground (dev only)
process.env.NODE_ENV === "development" &&
  app.use(
    playgroundEndpoint,
    await expressHandler({
      trpcApiEndpoint,
      playgroundEndpoint,
      router: appRouter,
    })
  );

// Health check
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// ========================================
//               TRADING VIEW            //
// ========================================

app.get("/config", (req, res) => {
  const config = getConfig();
  res.send(config);
});
app.get(
  "/symbols",
  cache("1 day"),
  validateRequest({
    query: z.object({
      symbol: z.string().startsWith("AS1"),
    }),
  }),
  async (req, res) => {
    // console.log("symbols", req.query.symbol);
    const symbolInfo = await resolveSymbol(req.query.symbol);
    res.send(symbolInfo);
  }
);
app.get("/search", (req, res) => {
  const searchResults = searchSymbols();
  res.send(searchResults);
});
const MAX_BARS = 5000;

app.get(
  "/history",
  cache("1 minutes"),
  validateRequest({
    query: z.object({
      symbol: z.string(),
      resolution: z.string(),
      from: z.string(),
      to: z.string(),
      countback: z.string(),
    }),
  }),
  async (req, res) => {
    const { resolution, symbol, from, to, countback } = req.query;
    // const address = symbol.split(":")[0];
    // const includeEmptyCandles = symbol.split(":")[1] !== "false";
    const params = {
      // symbol: address,
      symbol,
      resolution,
      from: Number(from),
      to: Number(to),
      // bounded so a single request cannot ask for an unbounded number of bars
      countback: Math.max(0, Math.min(Number(countback), MAX_BARS)),
      // includeEmptyCandles,
    };
    const history = await getBars(params);
    res.send(history);
  }
);
app.get("/time", (req, res) => {
  const time = getServerTime();
  res.send(time.toString()); // express doesnt allow sending numbers (could be interpreted as status code)
});

// ========================================
//                $DUSA                  //
// ========================================

const getTotalSupply = async () => {
  return new IERC20(DUSA.address, web3Client).totalSupply();
};

app.get("/token/total-supply", cache("5 minutes"), async (req, res) => {
  const totalSupply = await getTotalSupply();
  res.send(totalSupply.toString());
});

app.get("/token/circulating-supply", cache("5 minutes"), async (req, res) => {
  const totalSupply = await getTotalSupply();
  const t = new IERC20(DUSA.address, web3Client);
  const keys = EXCL_DUSA_CIRCULATING.map((address) => "BALANCE" + address);
  const balances = await t
    .extract(keys)
    .then((entries) =>
      entries.map((entry) => (entry.length ? new Args(entry).nextU256() : 0n))
    );
  const circulatingSupply =
    totalSupply - balances.reduce((acc, balance) => acc + balance, 0n);
  res.send(circulatingSupply.toString());
});

// ========================================
//                COINGECKO              //
// ========================================

app.get("/tickers", cache("5 minutes"), async (req, res) => {
  const tickers = await CG.getTickers();
  res.send(tickers);
});

// ========================================
//              COINMARKETCAP            //
// ========================================

app.get("/cmc/tickers", cache("5 minutes"), async (req, res) => {
  const tickers = await CMC.getTickers();
  res.send(tickers);
});

// ========================================
//                  MAIN                 //
// ========================================

app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    logger.error(err.message);
    res.status(500).send("Something went wrong");
  }
);

const port = parseInt(process.env.PORT || "3001");
app.listen(port);
logger.info("Listening on port " + port);

// ========================================
//                  MISC                 //
// ========================================

const baseUrl =
  process.env.NODE_ENV === "development"
    ? `http://localhost:${port}${openApiEndpoint}`
    : `https://api-mainnet-dusa.up.railway.app${openApiEndpoint}`;
const openApiDocument = generateOpenApiDocument(appRouter, {
  title: "Dusa Protocol API",
  version: "1.0.0",
  baseUrl,
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

// @ts-expect-error: Property 'toJSON' does not exist on type 'BigInt'
BigInt.prototype.toJSON = function (): string {
  return this.toString();
};

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  process.exit(1);
});
