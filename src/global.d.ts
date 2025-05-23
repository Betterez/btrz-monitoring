import {InMemorySpanExporter, SimpleSpanProcessor} from "@opentelemetry/sdk-trace-base";

declare global {
  var __btrz_monitoring__spanExporterForTests: InMemorySpanExporter;
  var __btrz_monitoring__spanProcessorForTests: SimpleSpanProcessor;
}

export {};
