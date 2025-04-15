interface TracingOptions {
    serviceName: string;
    traceDestinationUrl: string;
}
export declare function initializeTracing(options: TracingOptions): void;
export {};
