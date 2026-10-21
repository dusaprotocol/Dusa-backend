import logger from "../../common/logger";
import {
  NewSlotExecutionOutputsRequest,
  NewOperationsRequest,
  NewFilledBlocksRequest,
  GetScExecutionEventsRequest,
  SearchBlocksRequest,
  QueryStateRequest,
  OpExecutionStatusFinal,
  ExecutionQueryExecutionStatus,
} from "../gen/ts/massa/api/v1/public";
import { PublicServiceClient as MassaServiceClient } from "../gen/ts/massa/api/v1/public.client";
import { ExecutionOutputStatus } from "../gen/ts/massa/model/v1/execution";
import {
  handleNewFilledBlocks,
  handleNewOperations,
  handleNewSlotExecutionOutputs,
  processSignedOperation,
} from "./helpers";
import { DuplexStreamingCall } from "@protobuf-ts/runtime-rpc";
import { OpType } from "../gen/ts/massa/model/v1/operation";
import {
  ONE_HOUR,
  ONE_MINUTE,
  ONE_PERIOD,
  parseTimestamp,
  wait,
} from "../../common/utils";
import { MAX_GAS_CALL, byteToBool, bytesToStr } from "@massalabs/massa-web3";
import { IEventPollerResult, MASSA_EXEC_ERROR } from "../../common/eventPoller";
import { chunk } from "../../common/methods";
import {
  fetchEvents as fetchEventsJSONRPC,
  getDatastoreKeys as getDatastoreKeysJSONRPC,
} from "../../common/datastoreFetcher";
import { ROUTERS, routerSC } from "../../common/contracts";
import { baseClient, connectionManager } from "./client";
import { transformEvent } from "./utils";
import { OutputEvents } from "@massalabs/massa-web3/dist/esm/generated/client-types";
import { getOperation } from "../../scripts/src/backup";

// ███████╗████████╗██████╗ ███████╗ █████╗ ███╗   ███╗
// ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██╔══██╗████╗ ████║
// ███████╗   ██║   ██████╔╝█████╗  ███████║██╔████╔██║
// ╚════██║   ██║   ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║
// ███████║   ██║   ██║  ██║███████╗██║  ██║██║ ╚═╝ ██║

type ExtractFunctionKeys<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [P in keyof T]-?: T[P] extends (...args: any[]) => DuplexStreamingCall
    ? P
    : never;
}[keyof T];
type ClientActions = ExtractFunctionKeys<MassaServiceClient>;

const subscribe = async (
  client: MassaServiceClient,
  method: ClientActions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (message: any) => Promise<void>
) => {
  console.log("subscribe", method);
  const stream = client[method]();
  stream.requests.send(req).catch((err) => {
    logger.info("Error sending request");
  });

  logger.info(`${method}:${new Date().toString()}`);

  let messageCount = 0;
  for await (const message of stream.responses) {
    try {
      await handler(message);
      messageCount++;

      // Mark successful operation after first message and periodically thereafter
      if (messageCount === 1 || messageCount % 10 === 0) {
        connectionManager.markSuccess();
      }
    } catch (err: unknown) {
      if (!(err instanceof Error)) return;
      logger.warn(err.message);
      logger.warn(err.stack);
    }
  }

  // TODO: catch connection error
  // setTimeout(() => subscribe(client, method, req, handler), ONE_MINUTE);

  return stream;
};

export const subscribeNewSlotExecutionOutputs = async () => {
  // Always get the current client from connection manager
  const client = connectionManager.getClient();
  const req: NewSlotExecutionOutputsRequest = {
    filters: [
      {
        filter: {
          oneofKind: "status",
          status: ExecutionOutputStatus.FINAL,
        },
      },
    ],
  };

  return subscribe(
    client,
    "newSlotExecutionOutputs",
    req,
    handleNewSlotExecutionOutputs
  );
};

export const subscribeNewFilledBlocks = async () => {
  // Always get the current client from connection manager
  const client = connectionManager.getClient();
  const req: NewFilledBlocksRequest = {
    filters: [],
  };

  return subscribe(client, "newFilledBlocks", req, handleNewFilledBlocks);
};

// ███████╗████████╗██████╗ ███████╗ █████╗ ███╗   ███╗
// ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██╔══██╗████╗ ████║
// ███████╗   ██║   ██████╔╝█████╗  ███████║██╔████╔██║
// ╚════██║   ██║   ██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║
// ███████║   ██║   ██║  ██║███████╗██║  ██║██║ ╚═╝ ██║

const getFilledBlocks = async (blockIds: string[]) => {
  const blocks = await baseClient
    .getBlocks({ blockIds })
    .then((res) => res.response.wrappedBlocks);
  blocks.forEach(async ({ block }, i) => {
    const operationIds = block?.operations;
    if (!operationIds || !operationIds.length) return;

    const operations = await baseClient
      .getOperations({ operationIds })
      .then((res) => res.response.wrappedOperations);
    operations.forEach(async ({ operation }) => {
      const operationId = operation?.secureHash;
      if (!operationId) return;

      const blockId = block?.header?.secureHash;
      processSignedOperation(operation, i, blockId);
    });
  });
};

const getBlockIds = async (from: number, to: number): Promise<string[]> => {
  const req: SearchBlocksRequest = {
    filters: [
      {
        filter: {
          oneofKind: "slotRange",
          slotRange: {
            startSlot: parseTimestamp(from),
            endSlot: parseTimestamp(to),
          },
        },
      },
    ],
  };

  const blocks = await baseClient
    .searchBlocks(req)
    .then((res) => res.response.blockInfos);

  return blocks.map(({ blockId }) => blockId);
};

export const retrieveBlocks = async () => {
  const to = Date.now();
  const from = to - ONE_HOUR / 4;
  const blockIds = await getBlockIds(from, to);
  const chunks = chunk(blockIds, MAX_BLOCKS_PER_REQUEST);
  for (const chunk of chunks) {
    await getFilledBlocks(chunk);
  }
};

const MAX_BLOCKS_PER_REQUEST = 50;

// The node caps a datastore keys query at its max_datastore_keys_query (500 by
// default), and the gRPC query of the generated client has no pagination: page
// through JSON-RPC instead (massa-web3 reads the node limit from get_status)
export const getDatastoreKeys = (
  address: string,
  prefix: string
): Promise<string[]> => getDatastoreKeysJSONRPC(address, prefix);

export const getBytecodeExports = async (address: string): Promise<string> => {
  const req: QueryStateRequest = {
    queries: [
      {
        requestItem: {
          addressBytecodeCandidate: {
            address,
          },
          oneofKind: "addressBytecodeCandidate",
        },
      },
    ],
  };
  const res = await baseClient
    .queryState(req)
    .then((res) => res.response.responses[0].response);

  if (!res || res.oneofKind !== "result")
    throw new Error("Unexpected response");

  const { responseItem } = res.result;
  if (responseItem.oneofKind !== "bytes")
    throw new Error("Unexpected response type");

  return bytesToStr(responseItem.bytes);
};

const getEvents = async (txId: string): Promise<OutputEvents> => {
  const req: GetScExecutionEventsRequest = {
    filters: [
      {
        filter: { oneofKind: "originalOperationId", originalOperationId: txId },
      },
    ],
  };
  const events = await baseClient
    .getScExecutionEvents(req)
    .then((res) => res.response.events);

  return events.filter((e) => e.context !== undefined).map(transformEvent);
};

export const getOperationStatus = async (
  txId: string,
  retries = 3
): Promise<boolean> => {
  if (retries === 0) {
    try {
      const r = await getOperation(txId);
      return r.op_exec_status;
    } catch (e) {
      logger.error(e);
      return false;
    }
  }

  const req: QueryStateRequest = {
    queries: [
      {
        requestItem: {
          oneofKind: "opExecutionStatusFinal",
          opExecutionStatusFinal: { operationId: txId },
        },
      },
    ],
  };
  const res = await baseClient
    .queryState(req)
    .then((res) => res.response.responses[0].response);

  if (!res || res.oneofKind !== "result")
    throw new Error("Unexpected response");

  const { responseItem } = res.result;
  if (responseItem.oneofKind !== "executionStatus")
    throw new Error("Unexpected response type");

  if (
    responseItem.executionStatus ===
    ExecutionQueryExecutionStatus.ALREADY_EXECUTED_WITH_FAILURE
  )
    return false;

  if (
    responseItem.executionStatus ===
    ExecutionQueryExecutionStatus.ALREADY_EXECUTED_WITH_SUCCESS
  )
    return true;

  // UNSPECIFIED or EXECUTABLE_OR_EXPIRED
  await wait(ONE_PERIOD);
  return getOperationStatus(txId, retries - 1);
};

export const fetchEvents = async (
  txId: string,
  targetAddress?: string,
  retries = 3
): Promise<IEventPollerResult> => {
  try {
    const events = await getEvents(txId);

    if (events.length === 0 && retries > 0) {
      // retry after 30 sec
      await wait(ONE_MINUTE / 2);
      return fetchEvents(txId, targetAddress, retries - 1);
    }
    // last resort
    if (events.length === 0 && targetAddress && ROUTERS.includes(targetAddress))
      return fetchEventsJSONRPC(txId, 10_000);

    const errorEvents: OutputEvents = events.filter((e) =>
      e.data.includes(MASSA_EXEC_ERROR)
    );
    if (errorEvents.length > 0) return { isError: true, events: errorEvents };

    return { isError: false, events };
  } catch (err) {
    logger.error(err);
    return { isError: true, events: [] };
  }
};
