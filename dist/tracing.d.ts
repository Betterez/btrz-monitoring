interface TracingOptions {
    enabled?: boolean;
    serviceName: string;
    traceDestinationUrl: string;
    ignoreStaticAssetDir?: string;
    ignoreHttpOptionsRequests?: boolean;
}
export declare function initializeTracing(options: TracingOptions): void;
export {};
