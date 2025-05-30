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
    ignoredAwsSqsEvents?: AwsSqsEvent[];
    enableFilesystemTracing?: boolean;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "CONNECT" | "TRACE";
type AwsSqsEvent = "ReceiveMessage" | "ProcessMessage";
type HttpRoute = {
    method: HttpMethod;
    url: string | RegExp;
};
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
export declare function __enableTestMode(): {
    spanExporter: InMemorySpanExporter;
    spanProcessor: SimpleSpanProcessor;
};
export {};
