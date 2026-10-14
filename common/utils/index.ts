import { Args, DeserializedResult, Serializable } from "@massalabs/massa-web3";

export * from "./date";

export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Address implements Serializable<Address> {
  constructor(public value: string = "") {}

  serialize(): Uint8Array {
    const args = new Args().addString(this.value).serialize();
    return Uint8Array.from(args);
  }

  deserialize(
    buffer: Uint8Array,
    offset?: number
  ): DeserializedResult<Address> {
    const args = new Args(buffer, offset);
    this.value = args.nextString();
    return { instance: this, offset: args.offset };
  }
}
