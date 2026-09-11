"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitorMongoDbClient = monitorMongoDbClient;
const client_1 = __importDefault(require("@prometheus-io/client"));
const monitoredMongoDbClients = new WeakSet();
const DEFAULT_MAX_POOL_SIZE = 100;
/**
 * These metrics are module-level singletons for two reasons:
 *   1. prom-client registers every metric on the default `register`, and a metric name may only
 *      be registered once per process.  The `metrics.ts` ClusterRegistry aggregates the default
 *      registry of every worker, so simply registering here is enough for cluster aggregation.
 *   2. A single process may monitor more than one MongoDB client (e.g. multiple databases).  The
 *      `database` label keeps those series distinct while sharing a single metric definition.
 *
 * In cluster mode, prom-client aggregates each of these gauges/counters across workers using the
 * default "sum" aggregator.  That is what we want: pool utilization and queuing for the whole
 * service are the sums of the per-worker pools.  Compute utilization downstream (in Prometheus)
 * as `mongodb_client_connection_pool_checked_out_connections / mongodb_client_connection_pool_max_size`.
 */
const poolSize = new client_1.default.Gauge({
    name: "mongodb_client_connection_pool_size",
    help: "Number of connections currently open in the MongoDB driver connection pool " +
        "(in-use plus available/idle connections).",
    labelNames: ["database"]
});
const checkedOutConnections = new client_1.default.Gauge({
    name: "mongodb_client_connection_pool_checked_out_connections",
    help: "Number of MongoDB driver connections currently checked out of the pool (in active use). " +
        "This is the numerator of connection pool utilization.",
    labelNames: ["database"]
});
const maxPoolSize = new client_1.default.Gauge({
    name: "mongodb_client_connection_pool_max_size",
    help: "Configured maximum number of connections the MongoDB driver connection pool may hold. " +
        "This is the denominator of connection pool utilization.",
    labelNames: ["database"]
});
const waitQueueSize = new client_1.default.Gauge({
    name: "mongodb_client_connection_pool_wait_queue_size",
    help: "Number of operations currently waiting to check out a connection from the MongoDB driver connection pool. " +
        "A sustained non-zero value indicates the pool is saturated and requests are queuing.",
    labelNames: ["database"]
});
const checkOutFailuresTotal = new client_1.default.Counter({
    name: "mongodb_client_connection_pool_check_out_failures_total",
    help: "Total number of failed attempts to check out a connection from the MongoDB driver connection pool, " +
        "labelled by reason. Possible reasons: 'timeout' (pool exhausted, waited longer than waitQueueTimeoutMS), " +
        "'poolClosed', 'connectionError' (a generic error indicating that a new connection could not be established), " +
        "or 'unknown'.",
    labelNames: ["database", "reason"]
});
/**
 * The `reason` on a `connectionCheckOutFailed` event is NOT a bounded string.  The mongodb driver
 * emits a fixed string for pool-level failures ('timeout', 'poolClosed'), but emits the raw Error
 * object when it fails to establish a new connection.
 * An Error's message is high-cardinality (hostnames, ports, error
 * codes, ...), so using it as a metric label would cause unbounded series growth.
 * We therefore collapse every non-string reason into a single 'connectionError' bucket, keeping
 * the label set finite.  Driver string reasons are safe: they are a small, fixed set of literals.
**/
function normalizeCheckOutFailureReason(reason) {
    if (typeof reason === "string" && reason.length > 0) {
        return reason;
    }
    if (reason instanceof Error) {
        return "connectionError";
    }
    return "unknown";
}
/**
 * Best-effort read of the connection pool's configured maximum size.
 *
 * The `connectionPoolCreated` event carries this value, but the pool is normally created during
 * connection warm-up (before monitoring is attached), so that event has usually already fired.
 * We therefore read the value directly from the live topology, falling back to the client options
 * and finally to the driver default.
 */
function readConfiguredMaxPoolSize(db) {
    try {
        const servers = db.topology?.s?.servers;
        if (servers && typeof servers.values === "function") {
            for (const server of servers.values()) {
                const size = server?.s?.pool?.options?.maxPoolSize;
                if (typeof size === "number") {
                    return size;
                }
            }
        }
    }
    catch {
        // Reading driver internals is best-effort; fall through to the option-based value below.
    }
    const optionMax = db.s.options.maxPoolSize ?? db.s.options.poolSize;
    return typeof optionMax === "number" ? optionMax : DEFAULT_MAX_POOL_SIZE;
}
async function monitorMongoDbClient(simpleDao, logger, options = {}) {
    let db;
    try {
        db = await simpleDao.getCurrentClient();
    }
    catch (error) {
        logger.error("Error retrieving MongoDb client", error);
        return;
    }
    if (!db) {
        logger.error("SimpleDao did not return a MongoDB client");
        return;
    }
    if (monitoredMongoDbClients.has(db)) {
        logger.error("Tried to monitor a MongoDB client that is already being monitored");
        return;
    }
    monitoredMongoDbClients.add(db);
    const database = options.name ?? db.s.options.dbName;
    // Publish the pool capacity, and ensure the utilization/queue series exist immediately with a
    // value of 0 so that dashboards render before the first connection event is observed.
    maxPoolSize.set({ database }, readConfiguredMaxPoolSize(db));
    poolSize.inc({ database }, 0);
    checkedOutConnections.inc({ database }, 0);
    waitQueueSize.inc({ database }, 0);
    // Keep the reported capacity accurate if a new pool is created later (e.g. after a reconnect).
    db.on("connectionPoolCreated", (event) => {
        const size = event.options?.maxPoolSize;
        if (typeof size === "number") {
            maxPoolSize.set({ database }, size);
        }
    });
    // Total open connections in the pool.
    db.on("connectionCreated", () => poolSize.inc({ database }));
    db.on("connectionClosed", () => poolSize.dec({ database }));
    // Connection pool utilization: a connection is "checked out" while an operation is using it, and
    // "checked in" when the operation releases it back to the pool.
    db.on("connectionCheckedOut", () => {
        // Every checkout is preceded by a `connectionCheckOutStarted`; the request has now left the
        // wait queue (successfully).
        waitQueueSize.dec({ database });
        checkedOutConnections.inc({ database });
    });
    db.on("connectionCheckedIn", () => checkedOutConnections.dec({ database }));
    // Queuing: `connectionCheckOutStarted` fires when an operation begins waiting for a connection.
    // It leaves the queue on either `connectionCheckedOut` (success, handled above) or
    // `connectionCheckOutFailed` (failure, e.g. a wait-queue timeout when the pool is exhausted).
    db.on("connectionCheckOutStarted", () => waitQueueSize.inc({ database }));
    db.on("connectionCheckOutFailed", (event) => {
        waitQueueSize.dec({ database });
        checkOutFailuresTotal.inc({ database, reason: normalizeCheckOutFailureReason(event.reason) });
    });
    logger.info(`Monitoring MongoDB connection pool for database "${database}"`);
}
//# sourceMappingURL=mongodb-metrics.js.map