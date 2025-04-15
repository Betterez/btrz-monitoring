import process from "node:process";
import * as util from "node:util";
import chalk from "chalk";
import {NodeSDK} from "@opentelemetry/sdk-node";
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
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName
    }),
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  sdk.start();

  const shutdown = async () => {
    try {
      await sdk.shutdown();
      process.exit(0);
    } catch (error) {
      console.error(chalk.red("[btrz-monitoring] Error while stopping tracing"));
      console.error(chalk.red(util.inspect(error)));
      process.exit(1);
    }
  }

  process.on("SIGTERM", shutdown);
}
