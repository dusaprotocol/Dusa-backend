# Critical Datastore Keys Archival

## Overview

A new archival system has been added to `crons/poolTicks.ts` that periodically snapshots critical blockchain datastore keys to the `LedgerChange` table. This ensures historical state is preserved for governance scripts, reward calculations, and transaction reindexing.

## What Gets Archived

### 1. **Voting Escrow Contract** (`votingEscrowSC`)
- **`tokenId`** - Total number of NFT locks
- **`idToOwner::{lockId}`** - Lock ownership mapping (all locks)
- **`locked::{lockId}`** - Lock details with amount and end time (all locks)

### 2. **Voter Contract** (`voterSC`)
- **`totalWeight`** - Global voting weight across all pools
- **`weights::{poolAddress}`** - Voting weight per pool (all V2 pairs)
- **`poolVote::{lockId}`** - Pools voted by each lock (all locks)
- **`votes::{lockId};?!{poolAddress}`** - Individual vote weights (all locks × all pools)
- **`bribes::{poolAddress};?!{epoch};?!{tokenAddress};?!{userAddress}`** - All active bribes

### 3. **Pool Contracts** (All V2 Pairs)
- **`PAIR_INFORMATION`** - Active bin, reserves, and protocol fees

### 4. **LP Keys** (Whitelisted Pools Only)
- **`total_supplies::{binId}`** - Total LP supply per bin (±10 bins from active)
- **`balances::{binId}:{userAddress}`** - User LP balances (±10 bins from active, batched by 100)

## How It Works

The archival system:
1. Runs every 5 minutes as part of the `poolTicks` cron job
2. Fetches current state from blockchain contracts
3. Stores keys and values in the `LedgerChange` table with timestamp
4. Creates/updates `Block` entries for tracking

## Usage

### Automatic Mode (Default)
The archival runs automatically with the pool ticks cron:

```bash
pnpm start:crons  # or cd crons && pnpm dev
```

### Standalone Mode
Run archival only (without pool ticks):

```bash
cd crons
npx tsx poolTicks.ts --archive-only
```

## Database Schema

Archived entries are stored in the `LedgerChange` table:

```prisma
model LedgerChange {
  address     String   // Contract address
  key         Bytes    // Full datastore key
  value       Bytes    // Datastore value
  blockId     String   // Block ID (period_thread)
  index       Int      // Unique index
  createdAt   DateTime // Snapshot timestamp
  key191Chars String   // Truncated key for indexing (first 191 chars)
}
```

## Why This Matters

### For Governance Scripts (`scripts/src/governance.ts`)
- Rewards distribution requires historical voting weights
- Protocol fees need to be tracked at epoch boundaries
- Bribes must be retrieved at specific timestamps

### For Reindexing Operations
- Recalculating swap values requires historical LP balances
- Maker rewards depend on bin-specific liquidity snapshots
- Historical state reconstruction for backfilling

### For Fallback Strategy
Scripts attempt to fetch historical data using:
1. `getLedgerEntries2(before timestamp)` - Latest entry before target
2. `getLedgerEntries3(after timestamp)` - Earliest entry after target
3. Current blockchain state (fallback)

This archival system ensures step 1 & 2 have data available.

## Performance Considerations

### Optimization Strategies
1. **Batching**: LP balances fetched in batches of 100 to avoid RPC overload
2. **Filtering**: Only whitelisted pools get LP key archival
3. **Bin Radius**: Limited to ±10 bins from active (21 bins total) per pool
4. **Skip Duplicates**: Database uses `skipDuplicates: true` to avoid conflicts

### Estimated Data Volume
For a typical epoch with:
- 100 locks
- 10 pools
- 5 whitelisted pools with 50 users each

**Total keys archived per run**:
- VotingEscrow: ~201 keys (1 tokenId + 100 owners + 100 locked)
- Voter: ~1,011 keys (1 totalWeight + 10 weights + 100 poolVote + 900 votes)
- Bribes: Variable (~0-100 depending on active bribes)
- Pool state: 10 keys (PAIR_INFORMATION)
- LP keys: ~5,250 keys (5 pools × [21 bins + 21 bins × 50 users])

**Total: ~6,500-7,000 keys every 5 minutes**

## Monitoring

Check logs for archival status:

```bash
# Look for these log messages:
✅ Successfully archived X critical datastore keys at block Y_Z
❌ Error archiving critical datastore keys: [error]
```

## Query Examples

### Get historical voting weight at specific time
```typescript
const entries = await getLedgerEntries2(
  voterSC,
  new Date('2024-01-01T00:00:00Z'),
  ['totalWeight']
);
const totalWeight = U256.fromBytes(new Uint8Array(entries[0].value));
```

### Get user LP balance in bin at specific time
```typescript
const key = `balances::8388608:AU12...`;
const entries = await getLedgerEntries2(
  poolAddress,
  new Date('2024-01-01T00:00:00Z'),
  [key]
);
const balance = U256.fromBytes(new Uint8Array(entries[0].value));
```

## Maintenance

### Database Cleanup
Old entries can be purged after a retention period:

```sql
-- Delete entries older than 90 days
DELETE FROM LedgerChange
WHERE createdAt < DATE_SUB(NOW(), INTERVAL 90 DAY);
```

### Monitoring Query
```sql
-- Check archival coverage by contract
SELECT
  address,
  COUNT(*) as total_keys,
  MAX(createdAt) as last_archived
FROM LedgerChange
GROUP BY address
ORDER BY last_archived DESC;
```

## Troubleshooting

### Issue: Missing historical data
**Solution**: Run standalone archival manually to create snapshot
```bash
cd crons && npx tsx poolTicks.ts --archive-only
```

### Issue: Database growing too large
**Solution**: Reduce retention period or adjust bin radius in code

### Issue: RPC rate limiting
**Solution**: Increase batch delays or reduce batch sizes in `archiveKeys()`

## Related Files

- **Implementation**: `crons/poolTicks.ts:254-442`
- **Queries**: `indexer/src/db.ts:479-544` (getLedgerEntries functions)
- **Usage**: `scripts/src/governance.ts:564-584` (fetchDatastoreEntry)
- **Schema**: `prisma/schema.prisma:390-402` (LedgerChange model)

## Future Improvements

- [ ] Add compression for large value blobs
- [ ] Implement selective archival based on activity
- [ ] Add metrics/alerting for archival failures
- [ ] Optimize bin radius based on pool volatility
- [ ] Add historical replay capability for testing
