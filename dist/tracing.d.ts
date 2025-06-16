import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SpanOptions } from "@opentelemetry/api";
import { BtrzLogger, SimpleDao } from "./types/external.types";
interface TracingInitOptions {
    enabled?: boolean;
    serviceName: string;
    samplePercentage?: number;
    traceDestinationUrl: string;
    ignoreStaticAssetDir?: string | string[];
    ignoredHttpMethods?: HttpMethod[];
    ignoredRoutes?: HttpRoute[];
    ignoredAwsSqsEvents?: AwsSqsEvent[];
    enableFilesystemTracing?: boolean;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "CONNECT" | "TRACE";
type HttpRoute = {
    method: HttpMethod;
    url: string | RegExp;
};
type AwsSqsEvent = "ReceiveMessage" | "ProcessMessage";
export declare function initializeTracing(options: TracingInitOptions): {
    shutdownTracing: () => Promise<void>;
};
type TraceableFunction<T extends unknown[], R> = (...args: T) => R;
type TraceableFunctionWithoutArgs<R> = () => R;
type TraceOptions = SpanOptions & {
    inheritAttributesFromParentTrace?: boolean;
};
export declare function trace<R>(fn: TraceableFunctionWithoutArgs<R>): R;
export declare function trace<R>(spanName: string, fn: TraceableFunctionWithoutArgs<R>): R;
export declare function trace<R>(options: TraceOptions, fn: TraceableFunctionWithoutArgs<R>): R;
export declare function trace<R>(spanName: string, options: TraceOptions, fn: TraceableFunctionWithoutArgs<R>): R;
export declare function withTracing<T extends unknown[], R>(fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export declare function withTracing<T extends unknown[], R>(spanName: string, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export declare function withTracing<T extends unknown[], R>(options: TraceOptions, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export declare function withTracing<T extends unknown[], R>(spanName: string, options: TraceOptions, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
/**
 * Warming-up the database connection is done to improve the legibility of traces. The first connection to the database will initiate a
 * polling process between the mongodb driver and the Mongo server. If the connection is not warmed up on server start, the first API which
 * uses the database will initiate the connection.  The trace data captured for that API call will also include the polling traffic between
 * the mongodb driver and the Mongo server.  This polling will continue until the server is shut down, and as a result, the trace will last
 * as long as this server is running, and will contain details about the polling traffic between the mongo client and server.  We do not
 * want to capture this polling traffic, and warming-up the database connection outside an API handler will prevent this.
**/
export declare function warmUpDatabaseConnectionForTracing(simpleDao: SimpleDao, logger: BtrzLogger): Promise<void>;
export declare function __enableTestMode(): {
    spanExporter: InMemorySpanExporter;
    spanProcessor: SimpleSpanProcessor;
};
export {};
