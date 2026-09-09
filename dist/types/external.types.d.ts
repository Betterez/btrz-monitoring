export interface SimpleDao {
    connect: () => Promise<void>;
    getCurrentClient: () => Promise<MongoDbClient | undefined>;
}
export interface BtrzLogger {
    debug: (msg: string, args?: any) => void;
    info: (msg: string, args?: any) => void;
    error: (msg: string, args?: any) => void;
    fatal: (msg: string, args?: any) => void;
}
/**
 * The payload published alongside MongoDB connection pool monitoring (CMAP) events.
 * Only the fields consumed by the instrumentation are described here.
 * See the mongodb driver's `lib/cmap/events.js` for the full shape.
 */
export interface MongoConnectionPoolEvent {
    options?: {
        maxPoolSize?: number;
        minPoolSize?: number;
    };
    reason?: string | Error;
}
export interface MongoDbClient {
    s: {
        options: {
            dbName: string;
            maxPoolSize?: number;
            poolSize?: number;
        };
    };
    topology?: {
        s?: {
            servers?: Map<string, {
                s?: {
                    pool?: {
                        options?: {
                            maxPoolSize?: number;
                        };
                    };
                };
            }>;
        };
    };
    on(event: string, listener: (event: MongoConnectionPoolEvent) => void): void;
}
