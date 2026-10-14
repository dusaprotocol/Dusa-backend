import { bytesToStr, strToBytes } from "@massalabs/massa-web3";
import { Slot } from "../gen/ts/massa/model/v1/slot";
import { genesisTimestamp, ONE_PERIOD } from "../../common/utils";
import {
  ScExecutionEvent,
  ScExecutionEventStatus,
} from "../gen/ts/massa/model/v1/execution";
import {
  SCOutputEvent,
  Slot as ISlot,
} from "@massalabs/massa-web3/dist/esm/generated/client-types";

/**
 * Returns the approximate timestamp of a slot, based on the network's genesis timestamp
 * @param slot
 * @returns
 */
export const parseSlot = (slot: Slot | ISlot): number =>
  genesisTimestamp +
  Number(slot.period) * ONE_PERIOD +
  (slot.thread / 2) * 1000;

/**
 * Returns the timestamp at which the event was emitted
 * @param event
 * @returns
 */
export const getEventTimestamp = (event: SCOutputEvent | ScExecutionEvent) => {
  if (!event.context) return new Date();

  const slot =
    "slot" in event.context ? event.context.slot : event.context.originSlot;
  if (!slot) return new Date();

  return new Date(parseSlot(slot));
};

// transform gRPC event into JSON event
export const transformEvent = (event: ScExecutionEvent): SCOutputEvent => {
  if (!event.context) throw new Error("Missing context");
  return {
    data: bytesToStr(event.data),
    context: {
      block: event.context.blockId?.value,
      call_stack: event.context.callStack,
      index_in_slot: Number(event.context.indexInSlot),
      is_error: event.context.isFailure,
      is_final: event.context.status === ScExecutionEventStatus.FINAL,
      origin_operation_id: event.context.originOperationId?.value || undefined,
      read_only: false,
      slot: {
        period: Number(event.context.originSlot?.period),
        thread: Number(event.context.originSlot?.thread),
      },
    },
  };
};

// transform JSON event into gRPC event
export const transformEvent2 = (event: SCOutputEvent): ScExecutionEvent => {
  if (!event.context) throw new Error("Missing context");
  return {
    data: strToBytes(event.data),
    context: {
      blockId: event.context.block ? { value: event.context.block } : undefined,
      callStack: event.context.call_stack,
      indexInSlot: BigInt(event.context.index_in_slot),
      isFailure: event.context.is_error || false,
      status: event.context.is_final
        ? ScExecutionEventStatus.FINAL
        : ScExecutionEventStatus.CANDIDATE,
      originOperationId: event.context.origin_operation_id
        ? { value: event.context.origin_operation_id }
        : undefined,
      originSlot: {
        period: BigInt(event.context.slot.period),
        thread: event.context.slot.thread,
      },
    },
  };
};
