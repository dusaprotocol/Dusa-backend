import { Account, Web3Provider } from "@massalabs/massa-web3";
import { CHAIN_URL } from "./config";

// Read-only services (see ./readonly.ts) never load the wallet: they get a throwaway
// account, which is enough for reads. Only the scripts that send transactions use PRIV_KEY.
const privKey =
  process.env.DUSA_READONLY === "true" ? undefined : process.env.PRIV_KEY;
const baseAccount = privKey
  ? await Account.fromPrivateKey(privKey)
  : await Account.generate();
export const web3Client = Web3Provider.fromRPCUrl(CHAIN_URL, baseAccount);
