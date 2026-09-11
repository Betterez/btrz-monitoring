import { SimpleDao } from "./types/external.types";
interface MongoDBMonitoringOptions {
    name?: string;
}
export declare function monitorMongoDbClient(simpleDao: SimpleDao, options?: MongoDBMonitoringOptions): Promise<void>;
export {};
