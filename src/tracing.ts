import process from "node:process";

import opentelemetry from "@opentelemetry/sdk-node";
import {getNodeAutoInstrumentations} from "@opentelemetry/auto-instrumentations-node";
import {OTLPTraceExporter} from "@opentelemetry/exporter-trace-otlp-proto";
import {resourceFromAttributes} from "@opentelemetry/resources";
import {ATTR_SERVICE_NAME} from "@opentelemetry/semantic-conventions";


interface TracingOptions {
  serviceName: string;
  traceDestinationUrl: string;
}

export function initializeTracing(options: TracingOptions) {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const {serviceName, traceDestinationUrl} = options;

  const traceExporter = new OTLPTraceExporter({
    url: traceDestinationUrl
  });
  const sdk = new opentelemetry.NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName
    }),
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  sdk.start();

  process.on("SIGTERM", async () => {
    try {
      await sdk.shutdown();
      console.log("[btrz-monitoring] Tracing stopped");
    } catch (error) {
      console.error("[btrz-monitoring] Error while stopping tracing", error);
    } finally {
      process.exit(0);
    }
  });
}
