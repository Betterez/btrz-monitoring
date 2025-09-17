import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
declare global {
    var __btrz_monitoring__spanExporterForTests: InMemorySpanExporter;
    var __btrz_monitoring__spanProcessorForTests: SimpleSpanProcessor;
    var __btrz_monitoring__didInitializeTracing: boolean;
}
export {};
