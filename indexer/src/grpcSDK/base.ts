import {
  Args,
  ArrayTypes,
  CallSCParams,
  MAX_GAS_CALL,
  ReadSCData,
  ReadSCParams,
  bytesToArray,
  bytesToStr,
  strToBytes,
} from "@massalabs/massa-web3";
import { PublicServiceClient as MassaServiceClient } from "../../gen/ts/massa/api/v1/public.client";
import {
  ExecuteReadOnlyCallRequest,
  QueryStateRequest,
} from "../../gen/ts/massa/api/v1/public";
import { ExecutionStackElement } from "../../gen/ts/massa/model/v1/execution";
import {
  IBaseContract as _IBaseContract,
  ILBPair as _ILBPair,
  IMulticall as _IMulticall,
  IQuoter as _IQuoter,
  FeeParameters,
  parseUnits,
  Quote,
  Tx,
} from "@dusalabs/sdk";
import { transformEvent, transformEvent2 } from "../utils";
import logger from "../../../common/logger";
import { web3Client } from "../../../common/client";

type BaseCallData = Omit<
  CallSCParams,
  "fee" | "maxGas" | "target" | "func" | "parameter"
> & {
  targetFunction: string;
  parameter: number[] | Uint8Array;
};
type BaseCallDataWithGas = BaseCallData & {
  maxGas?: bigint;
};

export class IBaseContract {
  constructor(
    public address: string,
    protected client: MassaServiceClient
  ) {}

  protected async executeReadOnly(
    params: BaseCallDataWithGas,
    callerAddress: string = "AU12jWU88jCx8Pr5gptgM3EUfYuoA5g2jCauFRLZyWzEB7WtByTod" // address must have some coins (not used but required by the node)
  ) {
    const { targetFunction, parameter, maxGas } = params;
    const callStack: ExecutionStackElement[] = [
      {
        address: callerAddress,
        ownedAddresses: [],
        operationDatastore: [],
      },
    ];
    const req: ExecuteReadOnlyCallRequest = {
      call: {
        callerAddress: { value: callerAddress },
        callStack,
        maxGas: maxGas || MAX_GAS_CALL,
        fee: { mantissa: 1n, scale: 1 },
        target: {
          oneofKind: "functionCall",
          functionCall: {
            parameter: Uint8Array.from(
              parameter instanceof Args ? parameter.serialize() : parameter
            ),
            targetAddress: this.address,
            targetFunction,
          },
        },
      },
    };
    const res = await this.client
      .executeReadOnlyCall(req)
      .then((res) => res.response.output);
    if (!res) throw new Error("Unexpected response");

    return res;
  }

  protected async _extract(keys: string[]): Promise<(Uint8Array | null)[]> {
    const queries: QueryStateRequest["queries"] = keys.map((key) => ({
      requestItem: {
        addressDatastoreValueCandidate: {
          address: this.address,
          key: strToBytes(key),
        },
        oneofKind: "addressDatastoreValueCandidate",
      },
    }));
    const res = await this.client
      .queryState({ queries })
      .then((res) => res.response.responses.map((r) => r.response));

    return res.map((r) => {
      if (!r || r.oneofKind !== "result") return null;
      const { responseItem } = r.result;
      if (responseItem.oneofKind !== "bytes")
        throw new Error("Unexpected response type");

      return responseItem.bytes;
    });
  }

  public async extract(keys: string[]): Promise<(Uint8Array | null)[]> {
    return this._extract(keys).catch((e) => {
      logger.warn(e);
      return new _IBaseContract(this.address, web3Client).extract(keys);
    });
  }

  public async read(
    params: BaseCallDataWithGas,
    callerAddress?: string
  ): Promise<ReadSCData> {
    return this.executeReadOnly(params, callerAddress)
      .then(
        (res): ReadSCData => ({
          ...res,
          value: Uint8Array.from(res.callResult),
          info: {
            events: res.out?.events.map(transformEvent) || [],
            gasCost: Number(res.usedGas),
            // info: {gasCost: res.usedGas, }
          },
        })
      )
      .catch(async (e): Promise<ReadSCData> => {
        logger.warn([this.address, params.targetFunction].join());
        const res = await new _IBaseContract(this.address, web3Client).read(
          params
        );
        return { ...res };
      });
  }
}

export class ILBPair extends IBaseContract {
  async getSupplies(ids: number[]) {
    const keys = ids.map((id) => `total_supplies::${id}`);
    const res = await this.extract(keys);
    return res.map((r) => {
      if (!r || !r.length) return 0n;
      return new Args(r).nextU256();
    });
  }

  balanceOfBatch: _ILBPair["balanceOfBatch"] = async (accounts, ids) => {
    return this.read({
      targetFunction: "balanceOfBatch",
      parameter: new Args()
        .addArray(accounts, ArrayTypes.STRING)
        .addArray(ids.map(BigInt), ArrayTypes.U64)
        .serialize(),
    }).then((res) => bytesToArray(res.value, ArrayTypes.U256));
  };

  getTokens: _ILBPair["getTokens"] = async () => {
    return this.extract(["TOKEN_X", "TOKEN_Y"]).then((r) => {
      if (!r[0]?.length || !r[1]?.length) throw new Error("Tokens not found");
      return [bytesToStr(r[0]), bytesToStr(r[1])];
    });
  };

  async feeParameters(): Promise<FeeParameters> {
    return this.extract(["FEES_PARAMETERS"]).then((res) => {
      if (!res[0]?.length) throw new Error("Fee parameters not found");
      const args = new Args(res[0]);
      return {
        binStep: Number(args.nextU32()),
        baseFactor: Number(args.nextU32()),
        filterPeriod: Number(args.nextU32()),
        decayPeriod: Number(args.nextU32()),
        reductionFactor: Number(args.nextU32()),
        variableFeeControl: Number(args.nextU32()),
        protocolShare: Number(args.nextU32()),
        maxVolatilityAccumulated: Number(args.nextU32()),
        volatilityAccumulated: Number(args.nextU32()),
        volatilityReference: Number(args.nextU32()),
        indexRef: Number(args.nextU32()),
        time: args.nextU64(),
      };
    });
  }

  getUserBinIds: _ILBPair["getUserBinIds"] = async (user) => {
    return this.read({
      targetFunction: "getUserBins",
      parameter: new Args().addString(user).serialize(),
    }).then((res) =>
      new Args(res.value)
        .nextArray<number>(ArrayTypes.U32)
        .sort((a, b) => a - b)
    );
  };
}

export class IMulticall extends IBaseContract {
  async aggregateMulticall(data: Tx[]) {
    return this.read({
      targetFunction: "multicall",
      parameter: new Args().addSerializableObjectArray(data).serialize(),
    });
  }
}

export class IQuoter extends IBaseContract {
  async findBestPathFromAmountIn(
    route: string[],
    amountIn: string,
    checkLegacy: boolean = true
  ): Promise<Quote> {
    return this.findBestPath(route, amountIn, true, checkLegacy);
  }

  async findBestPathFromAmountOut(
    route: string[],
    amountOut: string,
    checkLegacy: boolean = true
  ): Promise<Quote> {
    return this.findBestPath(route, amountOut, false, checkLegacy);
  }

  private async findBestPath(
    route: string[],
    amount: string,
    isExactIn: boolean,
    checkLegacy: boolean
  ): Promise<Quote> {
    return this.read({
      targetFunction: isExactIn
        ? "findBestPathFromAmountIn"
        : "findBestPathFromAmountOut",
      parameter: new Args()
        .addArray(route, ArrayTypes.STRING)
        .addU256(BigInt(amount))
        .addBool(checkLegacy)
        .serialize(),
    }).then((result) => new Quote().deserialize(result.value).instance);
  }
}

// const jelly = new IBaseContract(JELLY.address, baseClient);

// jelly
//   .read({ targetFunction: "name", parameter: new Args() })
//   .then((r) => console.log(bytesToStr(r.value)));
// jelly
//   .extract(["NAME", "SYMBOL"])
//   .then((res) => res.map((r) => r && console.log(bytesToStr(r))));
