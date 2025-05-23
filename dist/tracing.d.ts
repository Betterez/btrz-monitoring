import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SpanOptions } from "@opentelemetry/api";
interface TracingInitOptions {
    enabled?: boolean;
    serviceName: string;
    samplePercentage?: number;
    traceDestinationUrl: string;
    ignoreStaticAssetDir?: string | string[];
    ignoredHttpMethods?: HttpMethod[];
    ignoredRoutes?: HttpRoute[];
    enableFilesystemTracing?: boolean;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "CONNECT" | "TRACE";
type HttpRoute = {
    method: HttpMethod;
    url: string | RegExp;
};
export declare function initializeTracing(options: TracingInitOptions): void;
type TraceableFunction<R> = () => R;
type TraceOptions = SpanOptions & {
    inheritAttributesFromParentTrace?: boolean;
};
export declare function trace<R>(fn: TraceableFunction<R>): R;
export declare function trace<R>(spanName: string, fn: TraceableFunction<R>): R;
export declare function trace<R>(spanName: string, traceOptions: TraceOptions, fn: TraceableFunction<R>): R;
export declare function __enableTestMode(): {
    spanExporter: InMemorySpanExporter;
    spanProcessor: SimpleSpanProcessor;
};
export {};
