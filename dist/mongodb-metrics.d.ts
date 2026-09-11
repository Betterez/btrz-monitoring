import { BtrzLogger, SimpleDao } from "./types/external.types";
interface MongoDBMonitoringOptions {
    name?: string;
}
export declare function monitorMongoDbClient(simpleDao: SimpleDao, logger: BtrzLogger, options?: MongoDBMonitoringOptions): Promise<void>;
export {};
