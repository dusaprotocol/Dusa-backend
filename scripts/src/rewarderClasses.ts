import { Args, DeserializedResult, Serializable } from "@massalabs/massa-web3";

class Bytes32 implements Serializable<Bytes32> {
  private serialized: Uint8Array = new Uint8Array(32);

  serialize(): Uint8Array {
    return this.serialized;
  }

  deserialize(buffer: Uint8Array, offset: number): DeserializedResult<Bytes32> {
    const args = new Args(buffer, offset);

    this.serialized = args.nextUint8Array();
    return {
      instance: this,
      offset: args.getOffset(),
    };
  }
}

/**
 * @dev The structures are ordered in alphabetical order, don't change the order.
 */
class Market implements Serializable<Market> {
  constructor(
    public address: string = "",
    public epoch: bigint = 0n,
    public start: bigint = 0n,
    public duration: bigint = 0n,
    public length: number = 0,
    public rewards: Reward[] = []
  ) {}

  serialize(): Uint8Array {
    const args = new Args()
      .addU64(this.duration)
      .addU64(this.epoch)
      .addString(this.address)
      .addUint8Array(new Uint8Array(0))
      .addU64(this.start)
      .addSerializableObjectArray(this.rewards)
      .serialize();
    return Uint8Array.from(args);
  }

  deserialize(buffer: Uint8Array, offset: number): DeserializedResult<Market> {
    const args = new Args(buffer, offset);

    this.duration = args.nextU64();
    this.epoch = args.nextU64();
    this.address = args.nextString();
    this.start = args.nextU64();
    this.rewards = args.nextSerializableObjectArray(Reward);
    return {
      instance: this,
      offset: args.getOffset(),
    };
  }
}

/**
 * @dev The structures are ordered in alphabetical order, don't change the order.
 */
class Reward implements Serializable<Reward> {
  constructor(
    public address: string = "",
    public totalRewards: bigint = 0n,
    public length: number = 0,
    public users: User[] = []
  ) {}

  serialize(): Uint8Array {
    const args = new Args()
      .addString(this.address)
      .addU256(this.totalRewards)
      .addSerializableObjectArray(this.users)
      .serialize();
    return Uint8Array.from(args);
  }

  deserialize(buffer: Uint8Array, offset: number): DeserializedResult<Reward> {
    const args = new Args(buffer, offset);

    this.address = args.nextString();
    this.totalRewards = args.nextU256();
    this.users = args.nextSerializableObjectArray(User);
    return {
      instance: this,
      offset: args.getOffset(),
    };
  }
}

/**
 * @dev The structures are ordered in alphabetical order, don't change the order.
 */
class User implements Serializable<User> {
  constructor(
    public amount: bigint = 0n,
    public address: string = ""
  ) {}

  serialize(): Uint8Array {
    const args = new Args()
      .addU256(this.amount)
      .addSerializableObjectArray(new Array<Bytes32>())
      .addString(this.address)
      .serialize();
    return Uint8Array.from(args);
  }

  deserialize(buffer: Uint8Array, offset: number): DeserializedResult<User> {
    const args = new Args(buffer, offset);

    this.amount = args.nextU256();
    this.address = args.nextString();
    return {
      instance: this,
      offset: args.getOffset(),
    };
  }
}

export class DataRoot implements Serializable<DataRoot> {
  constructor(
    public length: number = 0,
    public markets: Market[] = []
  ) {}

  serialize(): Uint8Array {
    const args = new Args()
      .addSerializableObjectArray(this.markets)
      .serialize();
    return Uint8Array.from(args);
  }

  deserialize(
    buffer: Uint8Array,
    offset: number
  ): DeserializedResult<DataRoot> {
    const args = new Args(buffer, offset);

    this.markets = args.nextSerializableObjectArray(Market);
    this.length = this.markets.length;
    return {
      instance: this,
      offset: args.getOffset(),
    };
  }
}

export function convertJsonToDataRoot(jsonString: string): DataRoot {
  const jsonObject = JSON.parse(jsonString) as DataRoot;

  const data = new DataRoot();

  for (let i = 0; i < jsonObject.markets.length; i++) {
    const market = jsonObject.markets[i];
    const rewards = market.rewards;
    market.rewards = [];
    for (let j = 0; j < rewards.length; j++) {
      const reward = rewards[j];
      const users = reward.users;
      reward.users = [];
      for (let k = 0; k < users.length; k++) {
        const user = users[k];
        reward.users.push(new User(BigInt(user.amount), user.address));
      }
      market.rewards.push(
        new Reward(
          reward.address,
          BigInt(reward.totalRewards),
          reward.users.length,
          reward.users
        )
      );
    }
    data.markets.push(
      new Market(
        market.address,
        BigInt(market.epoch),
        BigInt(market.start),
        BigInt(market.duration),
        market.rewards.length,
        market.rewards
      )
    );
  }

  data.length = data.markets.length;

  return data;
}
