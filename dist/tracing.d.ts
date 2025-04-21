interface TracingOptions {
    enabled?: boolean;
    serviceName: string;
    samplePercentage?: number;
    traceDestinationUrl: string;
    ignoreStaticAssetDir?: string;
    ignoreHttpOptionsRequests?: boolean;
}
export declare function initializeTracing(options: TracingOptions): void;
export {};
