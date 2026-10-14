import {
  EventFilter,
  EventPoller,
  ON_MASSA_EVENT_DATA,
  ON_MASSA_EVENT_ERROR,
} from "@massalabs/massa-web3";
import { web3Client } from "./client";
import logger from "./logger";
import { SCOutputEvent } from "@massalabs/massa-web3/dist/esm/generated/client-types";

export interface IEventPollerResult {
  isError: boolean;
  events: SCOutputEvent[];
}

const nullFilters: EventFilter = {
  start: undefined,
  end: undefined,
  smartContractAddress: undefined,
  callerAddress: undefined,
  operationId: undefined,
  isFinal: undefined,
};

export const MASSA_EXEC_ERROR = "error"; // massa_execution_error
