interface MetricsInitOptions {
    serviceName: string;
    metricsPort: number;
}
export declare function publishMetrics(options: MetricsInitOptions): void;
export {};
