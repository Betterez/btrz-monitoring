interface TracingOptions {
    enabled?: boolean;
    serviceName: string;
    samplePercentage?: number;
    traceDestinationUrl: string;
    ignoreStaticAssetDir?: string;
    ignoredHttpMethods?: HttpMethod[];
    ignoredRoutes?: HttpRoute[];
    enableFilesystemTracing?: boolean;
}
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "CONNECT" | "TRACE";
type HttpRoute = {
    method: HttpMethod;
    url: string | RegExp;
};
export declare function initializeTracing(options: TracingOptions): void;
export {};
