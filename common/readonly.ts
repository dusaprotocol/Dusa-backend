/**
 * Import this module FIRST in internet-facing services (API, indexer).
 *
 * Wallet keys (PRIV_KEY, PRIV_KEY_POKE) are only needed by the governance/rewards
 * scripts, which send transactions. A public-facing process should never hold them:
 * any bug or compromised dependency there could then drain the wallet. This marks the
 * process as read-only, so `common/client.ts` ignores PRIV_KEY even if the variable is
 * set (or later loaded from a .env file), and removes the keys from the environment.
 */
const WALLET_KEYS = ["PRIV_KEY", "PRIV_KEY_POKE"];

process.env.DUSA_READONLY = "true";
for (const key of WALLET_KEYS) {
  if (process.env[key]) {
    console.warn(
      `${key} is set for a read-only service: it is ignored, remove it from this service's environment`
    );
    delete process.env[key];
  }
}

export {};
