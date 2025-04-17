interface TracingOptions {
    serviceName: string;
    traceDestinationUrl: string;
    ignoreStaticAssetDir?: string;
    ignoreHttpOptionsRequests?: boolean;
}
export declare function initializeTracing(options: TracingOptions): void;
export {};
