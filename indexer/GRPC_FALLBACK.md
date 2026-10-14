# gRPC Connection Fallback Mechanism

This document explains the automatic gRPC node fallback system implemented in the indexer.

## Overview

The indexer now includes an intelligent connection manager that automatically switches to backup gRPC nodes when the primary node experiences repeated failures. This ensures high availability and reduces downtime.

## How It Works

### Connection Manager

The `ConnectionManager` class (`src/connectionManager.ts`) manages multiple gRPC nodes and handles automatic failover:

1. **Failure Tracking**: Each node tracks its retry count and last failure timestamp
2. **Automatic Switching**: After 5 consecutive failures on a node, the system automatically switches to the next available node
3. **Recovery Detection**: When connections recover, retry counts are reset
4. **Time-based Reset**: Nodes that haven't failed in 5+ minutes get their retry counts reset

### Configuration

Add backup gRPC hosts to your `.env` file:

```env
GRPC_HOST="primary-node.massa.net"
GRPC_PORT=33037
GRPC_BACKUP_HOSTS="backup1-node.massa.net,backup2-node.massa.net"
```

**Note**: `GRPC_BACKUP_HOSTS` is optional and should be a comma-separated list of hostnames (without ports).

### Monitoring

Check the current connection status via the HTTP endpoint:

```bash
curl http://localhost:3001/connection-status
```

Response example:
```json
{
  "currentNode": "primary-node.massa.net",
  "currentNodeIndex": 0,
  "nodes": [
    {
      "host": "primary-node.massa.net",
      "retryCount": 0,
      "lastFailure": null
    },
    {
      "host": "backup-node.massa.net",
      "retryCount": 0,
      "lastFailure": null
    }
  ]
}
```

## Behavior

### Normal Operation

- All gRPC calls use the current active node
- Successful operations reset the retry counter
- The system stays on the primary node as long as it's working

### During Failures

1. **First 5 failures**: System waits 1 minute between retries on the same node
2. **After 5 failures**: Automatically switches to the next available backup node
3. **Immediate retry**: After switching nodes, subscriptions restart immediately without delay
4. **All nodes failing**: If all nodes fail, the system resets the current node's retry count and continues

### Recovery

- Once a node starts working again, its retry count is reset
- Nodes that haven't failed in 5+ minutes are considered "fresh" for failover selection
- The system doesn't automatically switch back to the primary node (manual restart required)

## Implementation Details

### Modified Files

1. **`src/connectionManager.ts`** (new): Core connection management logic
2. **`src/client.ts`**: Initializes the connection manager and exports managed client
3. **`src/grpc.ts`**: Updated to use managed client and mark successful operations
4. **`main.ts`**: Updated error handler to use connection manager's failover logic
5. **`.env.example`**: Added `GRPC_BACKUP_HOSTS` configuration

### Key Features

- **Zero-downtime failover**: Seamless switching to backup nodes
- **Intelligent retry**: Different behavior for same-node retries vs. failover
- **Health tracking**: Per-node failure statistics and timestamps
- **Automatic recovery**: Self-healing when nodes come back online
- **Monitoring**: HTTP endpoint for observing connection health

## Example Use Cases

### Single Backup Node

```env
GRPC_HOST="mainnet.massa.net"
GRPC_BACKUP_HOSTS="backup.massa.net"
```

### Multiple Backup Nodes

```env
GRPC_HOST="node1.massa.net"
GRPC_BACKUP_HOSTS="node2.massa.net,node3.massa.net,node4.massa.net"
```

### No Backup (Default Behavior)

```env
GRPC_HOST="mainnet.massa.net"
# GRPC_BACKUP_HOSTS not set - will retry on primary indefinitely
```

## Troubleshooting

### Check Current Node

```bash
curl http://localhost:3001/connection-status | jq '.currentNode'
```

### Monitor Retry Counts

```bash
watch -n 5 'curl -s http://localhost:3001/connection-status | jq'
```

### Logs

The connection manager logs all important events:

- Node initialization
- Connection failures with retry counts
- Node switching events
- Connection recovery

Look for log messages like:
- `Connection manager initialized with N node(s)`
- `Connection failure on <host> (retry X/5)`
- `Switching from <old-host> to <new-host>`
- `Connection recovered on <host>, resetting retry count`
