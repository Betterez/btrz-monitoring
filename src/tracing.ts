import assert from "node:assert";
import * as fs from "node:fs";
import { IncomingMessage } from "node:http";
import * as path from "node:path";
import process from "node:process";
import * as util from "node:util";
import chalk from "chalk";
import {escapeRegExp} from "lodash";
import {NodeSDK} from "@opentelemetry/sdk-node";
import {getNodeAutoInstrumentations} from "@opentelemetry/auto-instrumentations-node";
import {OTLPTraceExporter} from "@opentelemetry/exporter-trace-otlp-grpc";
import {resourceFromAttributes} from "@opentelemetry/resources";
import {ATTR_SERVICE_NAME} from "@opentelemetry/semantic-conventions";
import {BatchSpanProcessor, AlwaysOnSampler, TraceIdRatioBasedSampler} from "@opentelemetry/sdk-trace-base";

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
}

// This must be executed before any other code (including "require" / "import" statements) or the tracing
// instrumentation may not be installed
export function initializeTracing(options: TracingOptions) {
  const {
    enabled = true,
    serviceName,
    samplePercentage = 100,
    traceDestinationUrl,
    ignoreStaticAssetDir,
    ignoredHttpMethods = [],
    ignoredRoutes = [],
    enableFilesystemTracing = false
  } = options;

  assert(samplePercentage >= 0 && samplePercentage <= 100, "samplePercentage must be a number between 0 and 100");

  if (enabled === false || process.env.NODE_ENV === "test") {
    return;
  }

  const incomingHttpRequestUrlsToIgnore = [
    ...getRegularExpressionsMatchingAllContentsOfDirectory(ignoreStaticAssetDir),
    /^\/__webpack_hmr/ // Ignore requests made by webpack hot-reload tooling
  ];

  if (enableFilesystemTracing) {
    forcefullyEnableFilesystemTracing();
  }

  const traceExporter = new OTLPTraceExporter({
    url: traceDestinationUrl
  });

  const spanProcessor = new BatchSpanProcessor(traceExporter, {
    maxExportBatchSize: 4096,
    maxQueueSize: 8192
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName
    }),
    spanProcessors: [spanProcessor],
    sampler: samplePercentage === 100 ? new AlwaysOnSampler() : new TraceIdRatioBasedSampler(samplePercentage / 100),
    instrumentations: [getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": {
        enabled: true, // This setting is currently ignored due to a bug.  See setEnabledInstrumentations().
        requireParentSpan: true
      },
      "@opentelemetry/instrumentation-http": {
        ignoreIncomingRequestHook(req) {
          if (incomingHttpRequestUrlsToIgnore.some(regex => regex.test(req.url ?? ""))) {
            return true;
          } else if (ignoredHttpMethods.includes(req.method as HttpMethod)) {
            return true;
          } else if (routeIsExplicitlyIgnored(ignoredRoutes, req)) {
            return true;
          }
          return false;
        }
      }
    })]
  });

  sdk.start();

  process.on("SIGTERM", shutdown(sdk));
}

function routeIsExplicitlyIgnored(ignoredRoutes: HttpRoute[], req: IncomingMessage) {
  return ignoredRoutes.some((route) => {
    if (route.method !== req.method) {
      return false;
    }
    if (typeof route.url === "string") {
      return req.url === route.url;
    } else {
      return route.url.test(req.url ?? "");
    }
  });
}

function getRegularExpressionsMatchingAllContentsOfDirectory(directory?: string): RegExp[] {
  if (!directory) {
    return [];
  }

  const allContentsOfDirectory = fs.readdirSync(directory);

  const regularExpressions = allContentsOfDirectory.map((entry) => {
    const pathToEntry = path.join(directory, entry);
    const stats = fs.lstatSync(pathToEntry);

    if (stats.isDirectory()) {
      return new RegExp(`^\/${escapeRegExp(entry)}\/`);
    } else if (stats.isFile()) {
      return new RegExp(`^\/${escapeRegExp(entry)}$`);
    } else {
      return undefined;
    }
  }).filter(entry => entry !== undefined);

  return regularExpressions;
}

// Work around a bug in the open telemetry library where the "@opentelemetry/instrumentation-fs" instrumentation
// cannot be enabled via the instrumentation config.  Instead, it must be enabled by setting an environment variable.
// https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2515
function forcefullyEnableFilesystemTracing() {
  if (!process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS) {
    process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = [
      "amqplib",   "aws-lambda",       "aws-sdk",
      "bunyan",    "cassandra-driver", "connect",
      "cucumber",  "dataloader",       "dns",
      "express",   "fs",               "generic-pool",
      "graphql",   "grpc",             "hapi",
      "http",      "ioredis",          "kafkajs",
      "knex",      "koa",              "lru-memoizer",
      "memcached", "mongodb",          "mongoose",
      "mysql2",    "mysql",            "nestjs-core",
      "net",       "pg",               "pino",
      "redis",     "redis-4",          "restify",
      "router",    "socket.io",        "tedious",
      "undici",    "winston"
    ].join(",");
  }
}

function shutdown(sdk: NodeSDK) {
  return async () => {
    try {
      await sdk.shutdown();
      process.exit(0);
    } catch (error) {
      console.error(chalk.red("[btrz-monitoring] Error while stopping tracing"));
      console.error(chalk.red(util.inspect(error)));
      process.exit(1);
    }
  };
}
