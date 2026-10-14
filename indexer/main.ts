import "../common/readonly"; // must stay first: this service never holds wallet keys
import { timingSafeEqual } from "crypto";
import * as gRPC from "./src/grpc";
import cors from "cors";
import express from "express";
import logger from "../common/logger";
import { isAddressValid } from "../common/methods";
import { IBaseContract } from "./src/grpcSDK/base";
import { baseClient, connectionManager } from "./src/client";
import { ONE_MINUTE, wait } from "../common/utils";
import { applyRateLimits } from "./src/rateLimit";

const app = express();
app.use(cors());
applyRateLimits(app);
app.get("/", (req, res) => {
  res.send("Hello World!");
});
// Node hostnames and failure details are only returned with the STATUS_TOKEN
// (header `x-status-token`): they would help target the nodes. Anyone else gets the
// health summary without hosts.
const hasStatusToken = (provided: string | undefined) => {
  const expected = process.env.STATUS_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
app.get("/connection-status", (req, res) => {
  const status = connectionManager.getStatus();
  if (hasStatusToken(req.get("x-status-token"))) return res.json(status);
  res.json({
    currentNodeIndex: status.currentNodeIndex,
    nodes: status.nodes.map(({ retryCount, lastFailure }) => ({
      retryCount,
      lastFailure,
    })),
  });
});
app.get("/datastore-keys", async (req, res, next) => {
  const address = req.query.address as string;
  const prefix = req.query.prefix as string;
  if (!address || !prefix) {
    next("Missing query parameters");
    return;
  }
  if (!isAddressValid(address)) {
    next("Invalid address");
    return;
  }

  const result = await gRPC.getDatastoreKeys(address, prefix).catch((err) => {
    next(err.message);
  });
  if (!result) return;

  res.send(result);
});
const MAX_KEYS = 500;

app.get("/datastore-entries", async (req, res, next) => {
  const address = req.query.address as string;
  const stringifiedKeys = req.query.keys as string;

  if (!address || !stringifiedKeys) {
    next("Missing query parameters");
    return;
  }
  if (!isAddressValid(address)) {
    next("Invalid address");
    return;
  }

  const keys = stringifiedKeys.split(",");
  if (keys.length > MAX_KEYS) {
    next(`Too many keys (max ${MAX_KEYS})`);
    return;
  }
  const result = await new IBaseContract(address, baseClient)
    .extract(keys)
    .catch((err) => {
      console.log("err", err);
      next(err.message);
    });
  if (!result) return;

  res.send(result);
});
app.get("/bytecode-exports", async (req, res, next) => {
  const address = req.query.address as string;
  if (!address) {
    next("Missing query parameters");
    return;
  }

  if (!isAddressValid(address)) {
    next("Invalid address");
    return;
  }

  const result = await gRPC.getBytecodeExports(address).catch((err) => {
    next(err.message);
  });
  if (!result) return;

  res.send(result);
});
const port = parseInt(process.env.PORT || "3001");
app.listen(port, () => logger.info(`Server started on port ${port}`));

type RetryCallback = () => Promise<unknown>;

const handler = async (err: Error, callback: RetryCallback) => {
  logger.error(err);

  // Handle the failure and potentially switch nodes
  const switched = connectionManager.handleFailure();

  if (switched) {
    logger.info(
      "Switched to backup node, restarting subscriptions immediately"
    );
    // If we switched nodes, restart immediately with the new client
    callback().catch((e) => handler(e, callback));
  } else {
    // Wait before retrying on the same node
    await wait(ONE_MINUTE);
    logger.info("Retrying on current node");
    callback().catch((e) => handler(e, callback));
  }
};

gRPC.retrieveBlocks().catch((err) => logger.error(err));
gRPC
  .subscribeNewSlotExecutionOutputs()
  .catch((e) => handler(e, gRPC.subscribeNewSlotExecutionOutputs));
gRPC
  .subscribeNewFilledBlocks()
  .catch((e) => handler(e, gRPC.subscribeNewFilledBlocks));

// @ts-expect-error: Property 'toJSON' does not exist on type 'BigInt'
BigInt.prototype.toJSON = function (): string {
  return this.toString();
};
