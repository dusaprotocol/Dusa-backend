# Dusa Backend

Indexer, API and scheduled jobs behind [Dusa Protocol](https://app.dusa.io), the Liquidity Book DEX
on [Massa](https://massa.net). It indexes the protocol's on-chain activity into a MySQL database and
serves the analytics, charts and account data used by the
[Dusa interface](https://github.com/dusaprotocol/Dusa-interface).

## Architecture

```
Massa node ──gRPC──▶ indexer ──▶ MySQL ◀── crons (aggregation, snapshots)
                                   │
                                   ▼
                     API (tRPC + REST) ──▶ interface, DefiLlama, CoinGecko, CMC
```

| Folder     | What it does                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `indexer/` | Streams new blocks and execution outputs from a Massa node (gRPC, with failover to backup nodes) and stores swaps, liquidity, DCA, limit orders, veDUSA and governance events. |
| `api/`     | tRPC API (`/trpc`), its REST version (`/api`, OpenAPI docs), TradingView UDF endpoints and CoinGecko / CoinMarketCap feeds. Reads the database only.                           |
| `crons/`   | Scheduled jobs: price/volume ticks (`poolTicks`), makers, portfolio snapshots and the points leaderboard.                                                                      |
| `scripts/` | Maintenance and governance scripts: weekly governance rewards, backfills, backups, seeds.                                                                                      |
| `common/`  | Shared config, database client, Massa client and helpers.                                                                                                                      |
| `prisma/`  | Database schema (MySQL).                                                                                                                                                       |

## Getting started

Requirements: Node.js 20+, [pnpm](https://pnpm.io) 8, and a MySQL 8 database.

```bash
cp .env.example .env    # then fill in the values (see below)
pnpm install            # also installs api/, indexer/ and scripts/
```

`pnpm install` runs `prisma db pull` against `DATABASE_URL`. For a new, empty database, create
the schema from `prisma/schema.prisma` instead:

```bash
pnpm install --ignore-scripts
(cd api && pnpm install --ignore-scripts)
(cd indexer && pnpm install)          # runs `buf generate`
(cd scripts && pnpm install --ignore-scripts)
npx prisma generate && npx prisma db push
```

Run the services:

| Command                                  | Description                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm start:indexer`                     | Indexer (HTTP port `PORT`, default 3001)                                             |
| `pnpm start:api`                         | API (HTTP port `PORT`, default 3001: use a different port when running both locally) |
| `cd crons && pnpm i && pnpm start:pools` | Price/volume ticks (also `start:makers`, `start:portfolio`, `start:leaderboard`)     |
| `pnpm test`                              | Unit tests (Vitest)                                                                  |
| `pnpm lint` / `pnpm prettier`            | Lint / formatting check                                                              |

**Use a local or dedicated test database for development and tests, never a production one.**
Some tests read and write data.

## Configuration

All settings come from environment variables, documented in [`.env.example`](.env.example).
The main ones:

| Variable                                      | Description                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                | MySQL connection string                                                                       |
| `CHAIN_ID`, `CHAIN_URL`                       | Massa network (`0` buildnet, `1` mainnet) and JSON-RPC endpoint                               |
| `GRPC_HOST`, `GRPC_PORT`, `GRPC_BACKUP_HOSTS` | Massa node(s) the indexer streams from                                                        |
| `PRIV_KEY`, `PRIV_KEY_POKE`                   | Wallet keys for the governance/rewards scripts only. The API and the indexer never load them. |
| `SYBIL_ADDRESSES`, `SPECIAL_USERS`            | Private address lists, kept out of the repository                                             |
| `RATE_LIMIT_MODE` and `RATE_LIMIT_*`          | Per-IP rate limits of the API and indexer (`log` by default, `enforce` to block)              |
| `STATUS_TOKEN`                                | Unlocks node hostnames on the indexer's `/connection-status`                                  |

## Working with the interface

The [interface](https://github.com/dusaprotocol/Dusa-interface) imports this API's tRPC types
directly from `../../../backend/api/src/trpc`. Clone both repositories side by side, with this one
in a folder named `backend`:

```
dusa/
├── backend/      # this repository
└── interface/    # Dusa-interface
```

## Security

Please report vulnerabilities privately to the Dusa team rather than in a public issue.

## License

[MIT](LICENSE). `api/src/middlewares.ts` adapts a Stack Overflow answer licensed under CC BY-SA 4.0
(link in the file).
