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
  // Present on `connectionPoolCreated`
  options?: {
    maxPoolSize?: number;
    minPoolSize?: number;
  };
  // Present on `connectionCheckOutFailed` and `connectionClosed`.  Usually a short string
  // (e.g. "timeout", "poolClosed"), but the driver also emits the raw Error object when a new
  // connection could not be established, so this is deliberately widened.
  reason?: string | Error;
}

export interface MongoDbClient {
  s: {
    options: {
      dbName: string;
      // The driver stores the resolved max pool size under `poolSize` (legacy alias) and,
      // when explicitly provided, `maxPoolSize`.  Both are optional depending on driver version.
      maxPoolSize?: number;
      poolSize?: number;
    }
  };
  // The live topology.  Used to read the actual configured pool size from the connection pool,
  // because the `connectionPoolCreated` event has usually already fired (during connection
  // warm-up) before this client is handed to the monitoring code.
  topology?: {
    s?: {
      servers?: Map<string, {
        s?: {
          pool?: {
            options?: {
              maxPoolSize?: number;
            }
          }
        }
      }>;
    }
  };
  // The MongoClient is an EventEmitter which relays connection pool (CMAP) events.
  on(event: string, listener: (event: MongoConnectionPoolEvent) => void): void;
}
