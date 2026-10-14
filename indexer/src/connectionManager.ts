import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { grpcPort } from "../../common/config";
import { PublicServiceClient as MassaServiceClient } from "../gen/ts/massa/api/v1/public.client";
import { ChannelCredentials } from "@grpc/grpc-js";
import logger from "../../common/logger";

interface NodeConfig {
  host: string;
  retryCount: number;
  lastFailure?: Date;
}

const MAX_RETRIES_PER_NODE = 5;
const RESET_RETRY_INTERVAL = 5 * 60 * 1000; // 5 minutes

export class ConnectionManager {
  private nodes: NodeConfig[];
  private currentNodeIndex: number = 0;
  private client: MassaServiceClient | null = null;

  constructor(primaryHost: string, backupHosts: string[] = []) {
    this.nodes = [
      { host: primaryHost, retryCount: 0 },
      ...backupHosts.map((host) => ({ host, retryCount: 0 })),
    ];

    if (this.nodes.length === 0) {
      throw new Error("At least one gRPC host must be provided");
    }

    logger.info(
      `Connection manager initialized with ${this.nodes.length} node(s)`
    );
    this.nodes.forEach((node, i) => {
      logger.info(`  Node ${i}: ${node.host}`);
    });
  }

  /**
   * Get the current active gRPC client
   */
  getClient(): MassaServiceClient {
    if (!this.client) {
      this.client = this.createClient(this.getCurrentNode().host);
    }
    return this.client;
  }

  /**
   * Get the current node configuration
   */
  private getCurrentNode(): NodeConfig {
    return this.nodes[this.currentNodeIndex];
  }

  /**
   * Create a new gRPC client for the specified host
   */
  private createClient(host: string): MassaServiceClient {
    logger.info(`Creating gRPC client for host: ${host}:${grpcPort}`);
    return new MassaServiceClient(
      new GrpcTransport({
        host: `${host}:${grpcPort}`,
        channelCredentials: ChannelCredentials.createInsecure(),
      })
    );
  }

  /**
   * Handle a connection failure and potentially switch to backup node
   * Returns true if switched to a new node
   */
  handleFailure(): boolean {
    const currentNode = this.getCurrentNode();
    currentNode.retryCount++;
    currentNode.lastFailure = new Date();

    logger.warn(
      `Connection failure on ${currentNode.host} (retry ${currentNode.retryCount}/${MAX_RETRIES_PER_NODE})`
    );

    // Check if we should switch to another node
    if (currentNode.retryCount >= MAX_RETRIES_PER_NODE) {
      return this.switchToNextNode();
    }

    return false;
  }

  /**
   * Switch to the next available node
   * Returns true if switched successfully
   */
  private switchToNextNode(): boolean {
    const previousIndex = this.currentNodeIndex;
    const previousHost = this.nodes[previousIndex].host;

    // Try to find a node with fewer failures
    let bestNodeIndex = this.currentNodeIndex;
    let lowestRetryCount = this.nodes[this.currentNodeIndex].retryCount;

    for (let i = 0; i < this.nodes.length; i++) {
      if (i === this.currentNodeIndex) continue;

      const node = this.nodes[i];
      // Reset retry count if enough time has passed since last failure
      if (
        node.lastFailure &&
        Date.now() - node.lastFailure.getTime() > RESET_RETRY_INTERVAL
      ) {
        node.retryCount = 0;
        logger.info(`Reset retry count for node ${node.host}`);
      }

      if (node.retryCount < lowestRetryCount) {
        lowestRetryCount = node.retryCount;
        bestNodeIndex = i;
      }
    }

    // If we found a better node, switch to it
    if (bestNodeIndex !== this.currentNodeIndex) {
      this.currentNodeIndex = bestNodeIndex;
      const newHost = this.nodes[bestNodeIndex].host;
      logger.warn(`Switching from ${previousHost} to ${newHost}`);

      // Create a new client for the new node
      this.client = this.createClient(newHost);
      return true;
    }

    // All nodes are failing, reset the current node's retry count and continue
    logger.error(
      `All nodes have failed. Resetting retry count for ${previousHost} and continuing.`
    );
    this.nodes[this.currentNodeIndex].retryCount = 0;
    return false;
  }

  /**
   * Mark a successful operation to reset retry tracking
   */
  markSuccess(): void {
    const currentNode = this.getCurrentNode();
    if (currentNode.retryCount > 0) {
      logger.info(
        `Connection recovered on ${currentNode.host}, resetting retry count`
      );
      currentNode.retryCount = 0;
      currentNode.lastFailure = undefined;
    }
  }

  /**
   * Get current connection status for monitoring
   */
  getStatus() {
    return {
      currentNode: this.getCurrentNode().host,
      currentNodeIndex: this.currentNodeIndex,
      nodes: this.nodes.map((node) => ({
        host: node.host,
        retryCount: node.retryCount,
        lastFailure: node.lastFailure,
      })),
    };
  }
}
