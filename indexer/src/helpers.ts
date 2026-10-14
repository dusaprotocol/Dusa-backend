import {
  EventDecoder,
  isSwapMethod,
  decodeSwapTx,
  decodeLiquidityTx,
  isLiquidtyMethod,
  IMultisig,
  IBaseContract,
} from "@dusalabs/sdk";
import { Args, bytesToStr, strToBytes } from "@massalabs/massa-web3";
import {
  ADDRESSES,
  dcaSC,
  dcaSCV2,
  EOAs,
  FACTORIES,
  orderSC,
  PAIRS,
  ROUTERS,
  routerSC,
  v2FactorySC,
  v2RouterSC,
} from "../../common/contracts";
import { handlePrismaError, prisma } from "../../common/db";
import {
  getCallee,
  isLiquidityEvent,
  isLiquidityV2Event,
  isSwapEvent,
} from "../../common/methods";
import {
  fetchPairAddress,
  getDCAContracts,
  isDCAContract,
} from "../../common/datastoreFetcher";
import { decodeDcaTx, decodeOrderTx, decodeUpdateDcaTx } from "./decoder";
import {
  processSwap,
  processLiquidity,
  processInnerSwap,
  processDCAExecution,
  processOrderExecution,
  ProcessOptions,
} from "./socket";
import {
  NewFilledBlocksResponse,
  NewOperationsResponse,
  NewSlotExecutionOutputsResponse,
} from "../gen/ts/massa/api/v1/public";
import {
  createDCA,
  createPool,
  getPairAddress,
  getTokenY,
  updateDCA,
  updateDCAStatus,
} from "./db";
import { LedgerChange, Pool_version, Status } from "@prisma/client";
import { BytesMapFieldEntry } from "../gen/ts/massa/model/v1/commons";
import { SignedOperation } from "../gen/ts/massa/model/v1/operation";
import { LedgerChangeEntry } from "../gen/ts/massa/model/v1/execution";
import { CHAIN_ID, trackLiquidityTxs } from "../../common/config";
import { getEventTimestamp, transformEvent } from "./utils";
import * as gRPC from "./grpc";
import { web3Client } from "../../common/client";
import logger from "../../common/logger";
import { IEventPollerResult, MASSA_EXEC_ERROR } from "../../common/eventPoller";
import { ONE_MINUTE, wait } from "../../common/utils";

// Bounds for multisigs discovered through NEW_MULTISIG events (see the handler below)
const MULTISIG_MIN_OWNERS = 1; // builds before July 2024 allowed a single owner
const MULTISIG_MAX_OWNERS = 50;

export async function handleNewFilledBlocks(message: NewFilledBlocksResponse) {
  if (!message.filledBlock) return;

  const { header, operations } = message.filledBlock;
  const blockId = header?.secureHash;
  if (!blockId || !operations.length) return;

  const slot = header?.content?.slot;
  if (!slot) return;

  const indexedOperations = operations.filter(
    ({ operation }) => operation && needIndexing(operation)
  );
  if (!indexedOperations.length) return;

  await prisma.block
    .create({
      data: {
        id: blockId,
        period: Number(slot.period),
        thread: slot.thread,
      },
    })
    .catch(handlePrismaError);

  indexedOperations.forEach(async (op, i) => {
    op.operation && processSignedOperation(op.operation, i, blockId);
  });
}

export async function handleNewSlotExecutionOutputs(
  message: NewSlotExecutionOutputsResponse
) {
  const output = message.output?.executionOutput;
  if (!output) return;

  const { events, slot, blockId: block, stateChanges } = output;

  // TODO: fetch block to check if its final

  const period = Number(slot?.period) || 0;
  const thread = Number(slot?.thread) || 0;
  const blockId = block?.value || "";
  if (!stateChanges?.ledgerChanges.length) return;

  processLedgerChanges(stateChanges.ledgerChanges, blockId);

  events.forEach(async (event, i) => {
    try {
      if (!event.context) return;

      const eventData = bytesToStr(event.data);
      const { callStack, indexInSlot } = event.context;
      const emitterAddress = getCallee(callStack);
      if (eventData.includes(MASSA_EXEC_ERROR) || event.context.isFailure)
        return;

      if (eventData.startsWith("DEPOSIT:")) {
        prisma.event
          .create({
            data: {
              data: Buffer.from(eventData),
              emitterAddress,
              indexInSlot: Number(indexInSlot),
              operationId: blockId,
            },
          })
          .catch(handlePrismaError);
      }

      // swap
      if (eventData.includes("SWAP:") && PAIRS.includes(emitterAddress)) {
        // inner swap
        if (!ROUTERS.includes(callStack[1])) {
          await processInnerSwap({ event, callStack, blockId, i });
        }

        await wait(ONE_MINUTE);

        // check if the event is already indexed
        const res = await prisma.event.findMany({
          where: { operation: { blockId } },
        });
        if (res.length) return;

        prisma.event
          .create({
            data: {
              data: Buffer.from(eventData),
              emitterAddress,
              indexInSlot: Number(indexInSlot),
              operationId: blockId,
            },
          })
          .catch(handlePrismaError);
      }

      // multisig
      if (eventData.startsWith("NEW_MULTISIG")) {
        const address = eventData.split(":")[1];
        const owners = await new IMultisig(address, web3Client).owners();
        // Any contract can emit NEW_MULTISIG, and indexed multisigs are watched by the
        // indexer from its next start: skip contracts whose owner list is not plausible
        // for a real multisig (the official contract rejects duplicate owners).
        const uniqueOwners = new Set(owners);
        if (
          uniqueOwners.size !== owners.length ||
          owners.length < MULTISIG_MIN_OWNERS ||
          owners.length > MULTISIG_MAX_OWNERS
        ) {
          logger.warn(`Skipping multisig ${address}: ${owners.length} owners`);
          return;
        }
        await prisma.multisig
          .create({
            data: {
              address,
              owners: {
                connectOrCreate: owners.map((o) => ({
                  create: { address: o },
                  where: { address: o },
                })),
              },
            },
          })
          .catch(handlePrismaError);
      }
      if (eventData.startsWith("AddOwner")) {
        const newOwner = eventData.split(":")[1];
        await prisma.multisig.update({
          where: { address: emitterAddress },
          data: {
            owners: {
              connectOrCreate: {
                create: { address: newOwner },
                where: { address: newOwner },
              },
            },
          },
        });
      }
      if (eventData.startsWith("RemoveOwner")) {
        const oldOwner = eventData.split(":")[1];
        await prisma.multisig.update({
          where: { address: emitterAddress },
          data: {
            owners: {
              delete: { address: oldOwner },
            },
          },
        });
      }
      if (eventData.startsWith("ReplaceOwner")) {
        const [oldOwner, newOwner] = EventDecoder.extractParams(eventData);
        await prisma.multisig.update({
          where: { address: emitterAddress },
          data: {
            owners: {
              delete: { address: oldOwner },
              connectOrCreate: {
                create: { address: newOwner },
                where: { address: newOwner },
              },
            },
          },
        });
      }

      if (getDCAContracts().some((dca) => callStack.includes(dca))) {
        if (eventData.startsWith("DCA_EXECUTED:"))
          await processDCAExecution(eventData, { period, thread, blockId });
        if (
          eventData.startsWith("DCA_ERROR:") ||
          eventData.includes(
            "error: Interface generic error Load error: Provided gas"
          )
        ) {
          const id = parseInt(EventDecoder.extractParams(eventData)[0]);
          await prisma.dCA.update({
            where: { id },
            data: { status: "ERRORED_QUOTER" },
          });
        }
        if (eventData.startsWith("DCA_ERROR_TRANSFER:")) {
          const id = parseInt(EventDecoder.extractParams(eventData)[0]);
          await prisma.dCA.update({
            where: { id },
            data: { status: "ERRORED_TRANSFER" },
          });
        }
      } else if (orderSC.some((sc) => callStack.includes(sc))) {
        if (eventData.startsWith("LIMIT_ORDER_EXECUTED:")) {
          const loSC = orderSC.find((sc) => callStack.includes(sc));
          if (!loSC) return;
          await processOrderExecution(eventData, loSC, {
            thread,
            period,
            blockId,
          });
        }
      } else return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      const data = {
        event: transformEvent(event),
        stack: err.stack,
        name: err.name,
      };
      prisma.log
        .create({
          data: {
            data: Buffer.from(JSON.stringify(data)),
            message: Buffer.from(err.message),
          },
        })
        .catch(handlePrismaError);
    }
  });
}

export async function handleNewOperations(message: NewOperationsResponse) {
  if (!message.signedOperation) return;
  if (!needIndexing(message.signedOperation)) return;
  processSignedOperation(message.signedOperation);
}

export type ProcessSignedOperationOptions = ProcessOptions &
  Pick<IEventPollerResult, "events">;

export const processSignedOperation = async (
  signedOperation: SignedOperation,
  indexInBlock: number = 0,
  blockId: string = "",
  opts?: ProcessSignedOperationOptions
) => {
  const {
    secureHash: txHash,
    contentCreatorAddress: userAddress,
    content: operation,
  } = signedOperation;
  const opType = operation?.op?.type;
  if (opType?.oneofKind !== "callSc" || !needIndexing(signedOperation)) return;

  if (opts) logger.info("reprocessing operation: " + txHash);
  const { targetAddress, targetFunction, parameter, coins, maxGas } =
    opType.callSc;
  // TODO: check if the operation errored (not necessarily through events)
  const status = await gRPC.getOperationStatus(txHash);
  const { isError, events } = opts
    ? {
        ...opts,
        isError: opts.events.some((e) => e.data.includes(MASSA_EXEC_ERROR)),
      }
    : await gRPC.fetchEvents(txHash, targetAddress);

  !opts &&
    prisma.operation
      .create({
        data: {
          data: Buffer.from(parameter),
          targetAddress,
          targetFunction,
          callerAddress: userAddress,
          value: coins?.mantissa || 0,
          id: txHash,
          indexInBlock,
          blockId,
          maxGas,
          events: {
            createMany: {
              data: events.map((event) => ({
                data: Buffer.from(strToBytes(event.data)),
                emitterAddress: getCallee(event.context.call_stack),
                indexInSlot: event.context.index_in_slot,
              })),
            },
          },
        },
      })
      .catch(handlePrismaError);
  if (isError || !status) return;

  try {
    // PERIPHERY CONTRACTS

    if (isDCAContract(targetAddress)) {
      switch (targetFunction) {
        case "startDCA": {
          const event = events.find((e) => e.data.startsWith("DCA_ADDED:"));
          if (!event) return;

          const dca = decodeDcaTx(parameter);

          const id = EventDecoder.decodeDCA(event.data).id;
          if (!dca || !id) return;

          await createDCA({
            ...dca,
            userAddress,
            txHash,
            id,
            status: Status.ACTIVE,
          });
          break;
        }
        case "stopDCA": {
          const id = Number(new Args(parameter).nextU64());
          await updateDCAStatus(id, Status.STOPPED);
          break;
        }
        case "updateDCA":
          const event = events.find((e) => e.data.startsWith("DCA_UPDATED:"));
          if (!event) return;

          const dca = decodeUpdateDcaTx(parameter);
          if (!dca) return;

          await updateDCA(dca.id, dca);
          break;
        default:
          break;
      }
    } else if (orderSC.includes(targetAddress)) {
      switch (targetFunction) {
        case "addLimitOrder":
        case "addLimitOrderMas": {
          const order = decodeOrderTx(
            parameter,
            targetFunction,
            coins?.mantissa || 0n
          );

          const event = events.find((e) =>
            e.data.startsWith("NEW_LIMIT_ORDER:")
          )?.data;
          if (!event) return;

          const { id } = EventDecoder.decodeLimitOrder(event);
          if (!id) return;

          const limitOrderContract = new IBaseContract(
            targetAddress,
            web3Client
          );
          let poolAddress: string;
          try {
            const pairData = await limitOrderContract.extract(["PAIR"]);
            poolAddress = pairData[0] ? bytesToStr(pairData[0]) : "";
          } catch (err) {
            logger.error(
              "Failed to get pair address from limit order contract:",
              err
            );
            return;
          }

          // Calculate timestamp from events
          const timestamp = events.length
            ? getEventTimestamp(events[0])
            : new Date();

          await prisma.order
            .create({
              data: {
                ...order,
                poolAddress,
                limitOrderAddress: targetAddress,
                id,
                userAddress,
                txHash,
                status: "ACTIVE",
                timestamp,
              },
            })
            .catch(handlePrismaError);
          break;
        }
        case "cancelOrder":
        case "cancelOrderMas":
          const event = events.find((e) =>
            e.data.startsWith("LIMIT_ORDER_CANCELED:")
          )?.data;
          if (!event) return;

          const { id } = EventDecoder.decodeLimitOrder(event);
          if (!id) return;

          await prisma.order.update({
            where: {
              id_limitOrderAddress: {
                id,
                limitOrderAddress: targetAddress,
              },
            },
            data: {
              status: "CANCELED",
              timestamp: getEventTimestamp(events[0]),
            },
          });
          break;
        case "claimOrder":
        case "claimOrderMas":
          const claimEvent = events.find((e) =>
            e.data.startsWith("ORDER_CLAIMED:")
          )?.data;
          if (!claimEvent) return;

          const { id: claimId, amount: _amount } =
            EventDecoder.decodeLimitOrderClaim(claimEvent);
          if (!claimId) return;

          await prisma.order.update({
            where: {
              id_limitOrderAddress: {
                id: claimId,
                limitOrderAddress: targetAddress,
              },
            },
            data: {
              status: "CLAIMED",
              timestamp: getEventTimestamp(events[0]),
            },
          });
          break;
        default:
          break;
      }
    } else if (FACTORIES.includes(targetAddress)) {
      if (targetFunction !== "createLBPair") return;

      const event = events.find((e) => e.data.startsWith("CREATE_LBPAIR:"));
      if (!event) return;

      const params = EventDecoder.decodeCreateLBPair(event.data);
      const version: Pool_version =
        params.binStep === 0
          ? "V0"
          : targetAddress === v2FactorySC
            ? "V2"
            : "V1";
      await createPool(params, version);
    }

    // ROUTER CONTRACT
    else if (ROUTERS.includes(targetAddress)) {
      const timestamp = events.length
        ? getEventTimestamp(events[0])
        : new Date();

      if (isSwapMethod(targetFunction)) {
        const isRouterV2 = targetAddress !== routerSC;
        const swapParams = decodeSwapTx(
          targetFunction,
          parameter,
          coins?.mantissa || 0n,
          isRouterV2
        );

        const tokenIn = swapParams.path[0];
        const tokenOut = swapParams.path[swapParams.path.length - 1];
        let usdValue = 0;
        let feesUsdValue = 0;
        let amountIn = 0n;
        let amountOut = 0n;

        for (let i = 0; i < swapParams.path.length - 1; i++) {
          // console.log("Processing inner swap", i);
          const tokenInAddress = swapParams.path[i];
          const tokenOutAddress = swapParams.path[i + 1];
          const binStep = Number(swapParams.binSteps[i]);

          // TODO: improve this
          const pools = await prisma.pool.findMany({
            where: {
              OR: [
                {
                  token0Address: tokenInAddress,
                  token1Address: tokenOutAddress,
                  binStep,
                },
                {
                  token0Address: tokenOutAddress,
                  token1Address: tokenInAddress,
                  binStep,
                },
              ],
            },
          });
          const eventEmitters = events.map((e) =>
            getCallee(e.context.call_stack)
          );
          const pool = pools.find((p) => eventEmitters.includes(p.address));
          if (!pool) {
            console.log("Pool not found for swap:", {
              txHash,
              userAddress,
              tokenInAddress,
              tokenOutAddress,
              binStep,
              eventEmitters,
              events,
            });
          }
          const poolAddress =
            pool?.address ||
            (await fetchPairAddress(
              tokenInAddress,
              tokenOutAddress,
              binStep
            ).catch((err) => {
              return fetchPairAddress(
                tokenInAddress,
                tokenOutAddress,
                binStep,
                false
              );
            }));
          const version: Pool_version =
            binStep === 0 ? "V0" : pool?.version || "V2";

          const swapEvents = events.filter((e) => isSwapEvent(e, poolAddress));
          if (!swapEvents.length) return;

          const tokenYAddress = await getTokenY(poolAddress);
          const swapDetails = await processSwap({
            txHash,
            indexInSlot: i,
            userAddress,
            timestamp,
            poolAddress,
            version,
            tokenInAddress,
            tokenOutAddress,
            tokenYAddress,
            binStep,
            swapEvents: swapEvents.map((e) => e.data),
            swapParams,
            opts,
          });
          usdValue += swapDetails.swapValue.volume; // if (i === 0) usdValue = swapDetails.swapValue.volume;
          feesUsdValue += swapDetails.swapValue.fees;
          if (i === 0) amountIn = swapDetails.swapPayload.amountIn;
          if (i === swapParams.path.length - 2)
            amountOut = swapDetails.swapPayload.amountOut;
        }

        if (!usdValue) return;
        prisma.fullSwap
          .create({
            data: {
              amountIn: amountIn.toString(),
              amountOut: amountOut.toString(),
              usdValue,
              feesUsdValue,
              timestamp,
              userAddress,
              txHash,
              feesIn: "0",
              tokenIn,
              tokenOut,
            },
          })
          .catch(handlePrismaError);
      } else if (isLiquidtyMethod(targetFunction) && trackLiquidityTxs) {
        const liquidityParams = decodeLiquidityTx(
          targetFunction,
          parameter,
          CHAIN_ID
        );
        const { token0, token1, binStep } = liquidityParams;
        const version: Pool_version =
          binStep === 0 ? "V0" : targetAddress === v2RouterSC ? "V2" : "V1";

        const poolAddress = await getPairAddress(
          token0,
          token1,
          binStep,
          version
        );
        if (!poolAddress) return;

        const tokenYAddress = await getTokenY(poolAddress);

        const liqEvents = events.filter((e) => {
          const isV1Event = isLiquidityEvent(e, poolAddress);
          const isV2Event = isLiquidityV2Event(e, poolAddress);

          return isV1Event || isV2Event;
        });

        if (!liqEvents.length) return;

        await processLiquidity({
          txHash,
          userAddress,
          timestamp,
          poolAddress,
          version,
          token0Address: token0,
          token1Address: token1,
          tokenYAddress,
          liqEvents: liqEvents.map((e) => e.data),
          feeEvent: events.find((e) => e.data.startsWith("COMPOSITION_FEE:"))
            ?.data,
          opts,
        });
      } else throw new Error("Unknown router method:" + targetFunction);
    } else if (!ADDRESSES.includes(targetAddress))
      throw new Error(`Unknown: ${targetAddress}: ${targetFunction}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    const data = { events, signedOperation, stack: err.stack, name: err.name };
    prisma.log
      .create({
        data: {
          data: Buffer.from(JSON.stringify(data)),
          message: Buffer.from(err.message),
        },
      })
      .catch(handlePrismaError);
  }
};

/**
 * Returns true if the datastore entry should be indexed (filtering out some keys)
 * @param entry
 * @returns
 */
const needIndexing2 = (key: Uint8Array<ArrayBufferLike>) =>
  // !bytesToStr(key).startsWith("BALANCE") &&
  !bytesToStr(key).startsWith("ALLOWANCE") &&
  !bytesToStr(key).startsWith("oracle::") &&
  !bytesToStr(key).startsWith("status");

/**
 * Returns true if the operation should be indexed (filtering out some contracts)
 * @param op
 * @returns
 */
const needIndexing = (op: SignedOperation) => {
  const opType = op.content?.op?.type;
  if (opType?.oneofKind !== "callSc") return false;
  return (
    EOAs.includes(op.contentCreatorAddress) ||
    ADDRESSES.includes(opType.callSc.targetAddress)
  );
};

const processLedgerChanges = async (
  ledgerChanges: LedgerChangeEntry[],
  blockId: string
) => {
  const filteredChanges = ledgerChanges.filter((change) => {
    if (!ADDRESSES.includes(change.address) || !change.value?.entry)
      return false;
    const entry = change.value.entry;
    // if (entry.oneofKind === "createdEntry") console.log(entry.createdEntry);
    return (
      entry.oneofKind === "updatedEntry" && entry.updatedEntry.datastore.length
    );
  });

  // erc20 balance changes tracking
  const isBalanceEntry = (entry: BytesMapFieldEntry) =>
    Buffer.from(entry.key).toString().startsWith("BALANCE");
  const decodeBalanceEntry = (entry: BytesMapFieldEntry) => {
    const key = Buffer.from(entry.key).toString();
    const address = key.split("BALANCE")[1];
    const value = new Args(entry.value).nextU256();
    // console.log(entry.value, value);
    return { address, value };
  };
  filteredChanges.forEach(async (change, i) => {
    const entry = change.value?.entry;
    if (!entry) return;

    const datastore =
      entry.oneofKind === "updatedEntry"
        ? entry.updatedEntry.datastore
        : entry.oneofKind === "createdEntry"
          ? entry.createdEntry.datastore
          : [];
    datastore.forEach(async (datastoreEntry, j) => {
      if (!("change" in datastoreEntry)) return;

      if (datastoreEntry.change.oneofKind !== "set") return;
      if (!isBalanceEntry(datastoreEntry.change.set)) return;
      const { address, value } = decodeBalanceEntry(datastoreEntry.change.set);
      if (address.startsWith("AS1")) return;
      const balance = value.toString();
      const tokenAddress = change.address;
      // console.log({ tokenAddress, address, balance });
      const timestamp = new Date();

      await prisma.balanceChange
        .create({
          data: {
            userAddress: address,
            tokenAddress,
            balance,
            timestamp,
            indexInSlot: i * 1000 + j, // arbitrary value to avoid unique constraint
            blockHash: blockId,
          },
        })
        .catch(handlePrismaError);
    });
  });

  const data = filteredChanges.flatMap((change, i) => {
    const entry = change.value?.entry;
    if (!entry) return [];

    const gen = (
      entry: BytesMapFieldEntry,
      j: number
    ): Omit<LedgerChange, "createdAt"> => ({
      address: change.address,
      key: Buffer.from(entry.key),
      value: Buffer.from(entry.value),
      index: i * 1000 + j, // arbitrary value to avoid unique constraint
      blockId,
      key191Chars: bytesToStr(entry.key).slice(0, 191),
    });

    if (entry.oneofKind === "updatedEntry") {
      return entry.updatedEntry.datastore.flatMap((datastore, j) =>
        datastore.change.oneofKind === "set" &&
        needIndexing2(datastore.change.set.key)
          ? gen(datastore.change.set, j)
          : []
      );
    }
    return [];
  });
  if (!data.length) return;

  prisma.ledgerChange
    .createMany({
      data,
    })
    .catch(handlePrismaError);
};
