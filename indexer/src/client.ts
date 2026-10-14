import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { grpcDefaultHost, grpcPort } from "../../common/config";
import { PublicServiceClient as MassaServiceClient } from "../gen/ts/massa/api/v1/public.client";
import { ChannelCredentials } from "@grpc/grpc-js";
import { ConnectionManager } from "./connectionManager";

export const createClient = (host: string = grpcDefaultHost) =>
  new MassaServiceClient(
    new GrpcTransport({
      host: `${host}:${grpcPort}`,
      channelCredentials: ChannelCredentials.createInsecure(),
    })
  );

// Parse backup hosts from environment variable (comma-separated list)
const backupHosts = process.env.GRPC_BACKUP_HOSTS
  ? process.env.GRPC_BACKUP_HOSTS.split(",").map((h) => h.trim())
  : [];

// Initialize connection manager with primary and backup hosts
export const connectionManager = new ConnectionManager(
  grpcDefaultHost,
  backupHosts
);

// Export baseClient as a Proxy that resolves to the current active client
// on every method access, so callers automatically follow node switches.
export const baseClient = new Proxy({} as MassaServiceClient, {
  get(_target, prop, receiver) {
    const client = connectionManager.getClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
