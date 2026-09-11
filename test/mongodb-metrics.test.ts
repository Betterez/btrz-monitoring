import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {afterEach, describe, it, mock} from "node:test";
import {register} from "@prometheus-io/client";
import {monitorMongoDbClient} from "../src/mongodb-metrics";
import {SimpleDao} from "../src/types/external.types";

// A minimal stand-in for the mongodb driver's MongoClient: it is an EventEmitter that exposes the
// same `s.options` shape the instrumentation reads, and relays connection pool (CMAP) events.
class FakeMongoClient extends EventEmitter {
  s: {options: {dbName: string; poolSize?: number; maxPoolSize?: number}};

  constructor(dbName: string, poolSize?: number) {
    super();
    this.s = {options: {dbName, poolSize}};
  }
}

function fakeSimpleDao(client: FakeMongoClient | undefined): SimpleDao {
  return {
    connect: async () => undefined,
    getCurrentClient: async () => client as any
  };
}

async function gaugeValue(name: string, database: string): Promise<number> {
  const metric = register.getSingleMetric(name);
  assert.ok(metric, `Expected metric "${name}" to be registered`);
  const {values} = await (metric as any).get();
  const match = values.find((entry: any) => entry.labels.database === database);
  return match ? match.value : 0;
}

async function counterValue(name: string, database: string, reason: string): Promise<number> {
  const metric = register.getSingleMetric(name);
  assert.ok(metric, `Expected metric "${name}" to be registered`);
  const {values} = await (metric as any).get();
  const match = values.find((entry: any) => entry.labels.database === database && entry.labels.reason === reason);
  return match ? match.value : 0;
}

describe("monitorMongoDbClient()", () => {
  // Use a unique database name per test so the shared (global) prometheus registry does not leak
  // state between tests.
  let dbCounter = 0;
  function uniqueDatabaseName() {
    dbCounter += 1;
    return `test-db-${dbCounter}`;
  }

  afterEach(() => {
    mock.restoreAll();
  });

  it("should log an error and do nothing when no MongoDB client is available", async () => {
    const logStub = mock.method(console, "log", () => undefined);

    await monitorMongoDbClient(fakeSimpleDao(undefined));

    assert.equal(logStub.mock.calls[0].arguments[0].includes("Unable to get current MongoDB client"), true);
  });

  it("should log the error and do nothing when retrieving the MongoDB client rejects", async () => {
    const retrievalError = new Error("Could not connect to MongoDB");
    const failingSimpleDao: SimpleDao = {
      connect: async () => undefined,
      getCurrentClient: async () => {
        throw retrievalError;
      }
    };
    const logStub = mock.method(console, "log", () => undefined);

    // A rejection from getCurrentClient() must not propagate out of monitorMongoDbClient().
    await assert.doesNotReject(() => monitorMongoDbClient(failingSimpleDao));

    const loggedMessages = logStub.mock.calls.map((call) => String(call.arguments[0]));
    // The underlying error is logged...
    assert.equal(loggedMessages.some((message) => message.includes("Could not connect to MongoDB")), true);
    // ...and then it falls through to the graceful "unable to get client" path and returns.
    assert.equal(loggedMessages.some((message) => message.includes("Unable to get current MongoDB client")), true);
  });

  it("should not monitor the same MongoDB client twice", async () => {
    const client = new FakeMongoClient(uniqueDatabaseName());
    const logStub = mock.method(console, "log", () => undefined);

    await monitorMongoDbClient(fakeSimpleDao(client));
    await monitorMongoDbClient(fakeSimpleDao(client));

    const warned = logStub.mock.calls.some((call) =>
      String(call.arguments[0]).includes("already being monitored"));
    assert.equal(warned, true);
  });

  it("should label metrics with the database name from the client options by default", async () => {
    const dbName = uniqueDatabaseName();
    const client = new FakeMongoClient(dbName, 25);
    mock.method(console, "log", () => undefined);

    await monitorMongoDbClient(fakeSimpleDao(client));

    assert.equal(await gaugeValue("mongodb_client_connection_pool_max_size", dbName), 25);
  });

  it("should override the database label with the provided options.name", async () => {
    const dbName = uniqueDatabaseName();
    const overrideName = uniqueDatabaseName();
    const client = new FakeMongoClient(dbName, 25);
    mock.method(console, "log", () => undefined);

    await monitorMongoDbClient(fakeSimpleDao(client), {name: overrideName});

    // Metrics are labelled with the override name...
    assert.equal(await gaugeValue("mongodb_client_connection_pool_max_size", overrideName), 25);
    client.emit("connectionCreated", {});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_size", overrideName), 1);

    // ...and not with the underlying client's dbName.
    assert.equal(await gaugeValue("mongodb_client_connection_pool_max_size", dbName), 0);
    assert.equal(await gaugeValue("mongodb_client_connection_pool_size", dbName), 0);
  });

  it("should publish the configured maximum pool size", async () => {
    const database = uniqueDatabaseName();
    const client = new FakeMongoClient(database, 25);
    mock.method(console, "log", () => undefined);

    await monitorMongoDbClient(fakeSimpleDao(client));

    assert.equal(await gaugeValue("mongodb_client_connection_pool_max_size", database), 25);
  });

  it("should default the maximum pool size to the driver default when it is not configured", async () => {
    const database = uniqueDatabaseName();
    const client = new FakeMongoClient(database);
    mock.method(console, "log", () => undefined);

    await monitorMongoDbClient(fakeSimpleDao(client));

    assert.equal(await gaugeValue("mongodb_client_connection_pool_max_size", database), 100);
  });

  it("should track the number of open connections in the pool", async () => {
    const database = uniqueDatabaseName();
    const client = new FakeMongoClient(database);
    mock.method(console, "log", () => undefined);
    await monitorMongoDbClient(fakeSimpleDao(client));

    client.emit("connectionCreated", {});
    client.emit("connectionCreated", {});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_size", database), 2);

    client.emit("connectionClosed", {reason: "idle"});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_size", database), 1);
  });

  it("should track the number of connections currently checked out (in use)", async () => {
    const database = uniqueDatabaseName();
    const client = new FakeMongoClient(database);
    mock.method(console, "log", () => undefined);
    await monitorMongoDbClient(fakeSimpleDao(client));

    // A normal checkout: started -> checked out.
    client.emit("connectionCheckOutStarted", {});
    client.emit("connectionCheckedOut", {});
    client.emit("connectionCheckOutStarted", {});
    client.emit("connectionCheckedOut", {});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_checked_out_connections", database), 2);

    client.emit("connectionCheckedIn", {});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_checked_out_connections", database), 1);
  });

  it("should track operations waiting in the connection pool wait queue", async () => {
    const database = uniqueDatabaseName();
    const client = new FakeMongoClient(database);
    mock.method(console, "log", () => undefined);
    await monitorMongoDbClient(fakeSimpleDao(client));

    // Two operations begin waiting for a connection.
    client.emit("connectionCheckOutStarted", {});
    client.emit("connectionCheckOutStarted", {});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_wait_queue_size", database), 2);

    // One succeeds in checking out a connection; the other is still waiting.
    client.emit("connectionCheckedOut", {});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_wait_queue_size", database), 1);

    // The last one fails (e.g. wait queue timeout); the queue drains back to empty.
    client.emit("connectionCheckOutFailed", {reason: "timeout"});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_wait_queue_size", database), 0);
  });

  it("should count connection checkout failures by reason", async () => {
    const database = uniqueDatabaseName();
    const client = new FakeMongoClient(database);
    mock.method(console, "log", () => undefined);
    await monitorMongoDbClient(fakeSimpleDao(client));

    client.emit("connectionCheckOutStarted", {});
    client.emit("connectionCheckOutFailed", {reason: "timeout"});
    client.emit("connectionCheckOutStarted", {});
    client.emit("connectionCheckOutFailed", {reason: "timeout"});
    client.emit("connectionCheckOutStarted", {});
    client.emit("connectionCheckOutFailed", {reason: "poolClosed"});

    assert.equal(await counterValue("mongodb_client_connection_pool_check_out_failures_total", database, "timeout"), 2);
    assert.equal(await counterValue("mongodb_client_connection_pool_check_out_failures_total", database, "poolClosed"), 1);
  });

  it("should bucket high-cardinality Error reasons into a single bounded label to protect against series growth", async () => {
    const database = uniqueDatabaseName();
    const client = new FakeMongoClient(database);
    mock.method(console, "log", () => undefined);
    await monitorMongoDbClient(fakeSimpleDao(client));

    // The driver emits the raw Error object as the reason when a new connection cannot be
    // established.  Each Error has a distinct, high-cardinality message; they must all collapse
    // into a single "connectionError" label.
    client.emit("connectionCheckOutStarted", {});
    client.emit("connectionCheckOutFailed", {reason: new Error("connect ECONNREFUSED 10.0.0.1:27017")});
    client.emit("connectionCheckOutStarted", {});
    client.emit("connectionCheckOutFailed", {reason: new Error("connect ETIMEDOUT 10.0.0.2:27017")});

    assert.equal(await counterValue("mongodb_client_connection_pool_check_out_failures_total", database, "connectionError"), 2);

    // No series should have been created from either raw Error message.
    const metric = register.getSingleMetric("mongodb_client_connection_pool_check_out_failures_total");
    const {values} = await (metric as any).get();
    const reasonsForDatabase = values
      .filter((entry: any) => entry.labels.database === database)
      .map((entry: any) => entry.labels.reason);
    assert.deepEqual(reasonsForDatabase, ["connectionError"]);
  });

  it("should update the maximum pool size when a new connection pool is created", async () => {
    const database = uniqueDatabaseName();
    const client = new FakeMongoClient(database, 10);
    mock.method(console, "log", () => undefined);
    await monitorMongoDbClient(fakeSimpleDao(client));

    assert.equal(await gaugeValue("mongodb_client_connection_pool_max_size", database), 10);

    client.emit("connectionPoolCreated", {options: {maxPoolSize: 50}});
    assert.equal(await gaugeValue("mongodb_client_connection_pool_max_size", database), 50);
  });
});
