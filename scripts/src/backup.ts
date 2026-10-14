import { Args, ArrayTypes, strToBytes } from "@massalabs/massa-web3";
import { v2RouterSC, voterSC } from "../../common/contracts";
import { prisma } from "../../common/db";
import {
  Address,
  getHourlyTick,
  ONE_DAY,
  ONE_HOUR,
  ONE_WEEK,
} from "../../common/utils";
import { SWAP_ROUTER_METHODS } from "@dusalabs/sdk";

type GetOperationsResponse = {
  operationsNodes: [];
  operationsCreated?: Operation[];
  operationsReceived?: Operation[];
  nextCursorCreated: string;
  nextCursorReceived: string;
};

export type Operation = {
  hash: string;
  block_time: string;
  status: string;
  type: string;
  from: string;
  to: string;
  value: string;
  transaction_fee: string;
  op_exec_status: boolean;
};

export type OperationWithDetails = {
  id: string;
  in_blocks: string[];
  thread: number;
  in_pool: boolean;
  is_operation_final: boolean;
  op_exec_status: boolean;
  timestamp: string;
  operation: {
    content_creator_address: string;
    content_creator_pub_key: string;
    signature: string;
    id: string;
    content: {
      expire_period: number;
      fee: string;
      op: {
        Transaction: null;
        RollBuy: null;
        RollSell: null;
        ExecuteSC: null;
        CallSC: {
          target_addr: string;
          coins: string;
          param: string;
          max_gas: string;
          target_func: string;
        };
      };
    };
  };
};

const api = "https://explorer-api.massa.net";

export async function* getOperationsGenerator(
  address: string,
  opts?: {
    until?: Date | number | string;
    beyond?: Date | number | string;
  }
): AsyncGenerator<Operation, void, void> {
  let nextCursorCreated: string | undefined;
  let nextCursorReceived: string | undefined;
  let hasNext = true;
  let count = 0;
  while (hasNext) {
    count++;

    const {
      operationsCreated,
      operationsReceived,
      nextCursorCreated: ncc,
      nextCursorReceived: ncr,
    } = await getOperations(address, nextCursorCreated, nextCursorReceived);
    const received = operationsReceived || [];
    const created = operationsCreated || [];
    if (!received.length && !created.length) {
      console.log("no operations found");
      hasNext = false;
      continue;
    }
    nextCursorCreated = ncc;
    nextCursorReceived = ncr;

    for (const op of [...received, ...created]) {
      const blockTime = Number(op.block_time);
      if (opts?.until && blockTime < new Date(opts.until).getTime()) {
        hasNext = false;
        break;
      }
      if (opts?.beyond && blockTime > new Date(opts.beyond).getTime()) {
        continue;
      }
      yield op;
    }
  }
  console.log("done", count);
}

export const getOperations = async (
  address: string,
  nextCursorCreated?: string,
  nextCursorReceived?: string
): Promise<GetOperationsResponse> => {
  const endpoint = "address";
  const path = "operations";
  let queryParams = "from=true&to=true"; // inbound and outbound
  if (nextCursorCreated) queryParams += `&cursorCreated=${nextCursorCreated}`;
  if (nextCursorReceived)
    queryParams += `&cursorReceived=${nextCursorReceived}`;
  const url = `${api}/${endpoint}/${address}/${path}?${queryParams}`;
  return fetch(url).then((res) => res.json());
};

export const getOperation = async (
  operationId: string
): Promise<OperationWithDetails> => {
  const endpoint = "operation";
  const url = `${api}/${endpoint}/${operationId}`;
  return fetch(url).then((res) => res.json());
};

const idk = async () => {
  let count = 0;
  const address = voterSC;
  const until = Date.now() - ONE_WEEK;
  const beyond = Date.now();
  const generator = getOperationsGenerator(address, { until, beyond });
  for await (const operation of generator) {
    const hash = operation.hash.split("_")[0];
    if (!operation.op_exec_status) continue;

    // console.time("db");
    const existingEntry = await prisma.operation.findUnique({
      where: { id: hash },
    });
    // console.timeEnd("db");
    if (existingEntry) continue;

    // console.time("getOperation");
    const op = await getOperation(hash);
    // console.timeEnd("getOperation");
    const callSC = op.operation.content.op.CallSC;
    if (callSC.target_func !== "vote") continue;

    const caller = op.operation.content_creator_address;
    console.log(caller);
    // TODO: fetch

    // console.log(hash);
    count++;
  }
  console.log({ count });
};

(async () => {
  // await idk();
})();
