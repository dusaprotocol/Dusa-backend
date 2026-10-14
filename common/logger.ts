import { createLogger, transports } from "winston";

const logger = createLogger({
  transports: [new transports.Console({ level: "silly" })],
});
export default logger;
