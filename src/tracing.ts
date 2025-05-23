import assert from "node:assert";
import * as fs from "node:fs";
import {IncomingMessage} from "node:http";
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
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler
} from "@opentelemetry/sdk-trace-base";
import {
  Attributes,
  Link,
  Span,
  SpanKind,
  SpanStatusCode,
  SpanOptions,
  trace as otlpTrace,
  TraceFlags
} from "@opentelemetry/api";
import {AwsSdkRequestHookInformation} from "@opentelemetry/instrumentation-aws-sdk/build/src/types";
import {ATTR_CODE_FUNCTION_NAME} from "@opentelemetry/semantic-conventions/incubating";

interface TracingInitOptions {
  enabled?: boolean;
  serviceName: string;
  samplePercentage?: number;
  traceDestinationUrl: string;
  ignoreStaticAssetDir?: string | string[];
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
export function initializeTracing(options: TracingInitOptions) {
  const {
    enabled = true,
    serviceName,
    samplePercentage = 100,
    traceDestinationUrl,
    ignoreStaticAssetDir = [],
    ignoredHttpMethods = [],
    ignoredRoutes = [],
    enableFilesystemTracing = false
  } = options;

  assert(samplePercentage >= 0 && samplePercentage <= 100, "samplePercentage must be a number between 0 and 100");

  if (enabled === false || process.env.NODE_ENV === "test") {
    return;
  }

  const staticAssetDirectoriesToIgnore = Array.isArray(ignoreStaticAssetDir) ? ignoreStaticAssetDir : [ignoreStaticAssetDir];
  const staticAssetUrlPatternsToIgnore = staticAssetDirectoriesToIgnore.map((directory) => {
    return getRegularExpressionsMatchingAllContentsOfDirectory(directory);
  }).flat();

  const incomingHttpRequestUrlPatternsToIgnore = [
    ...staticAssetUrlPatternsToIgnore,
    /^\/favicon\.ico$/,
    /^\/\.well-known/, // Ignore requests made by a Chrome dev tools feature
    /^\/__webpack_hmr/ // Ignore requests made by webpack hot-reload tooling
  ];

  if (enableFilesystemTracing) {
    forcefullyEnableFilesystemTracing();
  }

  const traceExporter = global.__btrz_monitoring__spanExporterForTests ||
    new OTLPTraceExporter({
      url: traceDestinationUrl
    });

  const spanProcessor = global.__btrz_monitoring__spanProcessorForTests ||
    new BatchSpanProcessor(traceExporter, {
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
          if (incomingHttpRequestUrlPatternsToIgnore.some(regex => regex.test(req.url ?? ""))) {
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

function getRegularExpressionsMatchingAllContentsOfDirectory(directory: string): RegExp[] {
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

type TraceableFunction<R> = () => R;
type TraceOptions = SpanOptions & { inheritAttributesFromParentTrace?: boolean };

export function trace<R>(fn: TraceableFunction<R>): R;
export function trace<R>(spanName: string, fn: TraceableFunction<R>): R;
export function trace<R>(spanName: string, traceOptions: TraceOptions, fn: TraceableFunction<R>): R;
export function trace<R>(arg1: string | TraceableFunction<R>, arg2?: TraceOptions | TraceableFunction<R>, arg3?: TraceableFunction<R>): R {
  const tracer = otlpTrace.getTracer("btrz-monitoring");

  let spanName: string;
  let traceOptions: TraceOptions;
  let functionToTrace: TraceableFunction<R>;

  if (typeof arg1 === "function") {
    functionToTrace = arg1;
    spanName = functionToTrace.name || "anonymous function";
    traceOptions = {};
  } else if (typeof arg2 === "function") {
    spanName = arg1;
    functionToTrace = arg2;
    traceOptions = {};
  } else {
    spanName = arg1;
    traceOptions = arg2 || {};
    functionToTrace = arg3!;
  }

  let result: R;
  let synchronousError: any;

  const { inheritAttributesFromParentTrace, ..._spanOptions } = traceOptions;
  const activeSpan = otlpTrace.getActiveSpan();
  let attributesToCopy: Attributes = {};
  let linksToCopy: Link[] = [];
  let spanKind = SpanKind.INTERNAL;

  if (inheritAttributesFromParentTrace && activeSpan) {
    attributesToCopy = (activeSpan as unknown as ReadableSpan).attributes;
    linksToCopy = (activeSpan as unknown as ReadableSpan).links;
    spanKind = (activeSpan as unknown as ReadableSpan).kind;
  }

  const spanOptions: SpanOptions = {
    ..._spanOptions,
    attributes: {
      [ATTR_CODE_FUNCTION_NAME]: functionToTrace.name || undefined,
      ...attributesToCopy,
      ...(_spanOptions.attributes || {})
    },
    links: [...(_spanOptions.links || []), ...linksToCopy],
    kind: _spanOptions.kind ?? spanKind,
  };

  tracer.startActiveSpan(spanName, spanOptions, (span) => {
    try {
      result = functionToTrace();
    } catch (error: any) {
      synchronousError = error;
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error?.message
      });
    }

    if (isPromiseLike(result)) {
      result
        .then((result) => {
          span.setStatus({
            code: SpanStatusCode.OK
          });
          span.end();
          return result;
        }, (_error) => {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: _error?.message
          });
          span.end();
          throw _error;
        });
    } else {
      if (!synchronousError) {
        span.setStatus({
          code: SpanStatusCode.OK
        });
      }
      span.end();
    }
  });

  if (synchronousError) {
    throw synchronousError;
  }

  return result!;
}

function isPromiseLike(value: any): value is PromiseLike<any> {
  return typeof value?.then === "function";
}

// Called by internal tests so that they can inspect the spans that are created by the tracing instrumentation.
export function __enableTestMode() {
  // Global variables are used here to avoid changing the span exporter / span processor when tests are running.
  // The OpenTelemetry library seems to internally keep a reference to the first span exporter and span processor that
  // is provided to it.  If the span exporter / span processor is changed, the OpenTelemetry code will not respect this
  // change and will continue to use the previous span exporter / span processor.  Using a global variable ensures that
  // the span exporter / span processor never changes, which can be difficult to avoid when tests are running in "watch"
  // mode.
  if (!global.__btrz_monitoring__spanExporterForTests) {
    global.__btrz_monitoring__spanExporterForTests = new InMemorySpanExporter();
  }
  if (!global.__btrz_monitoring__spanProcessorForTests) {
    global.__btrz_monitoring__spanProcessorForTests = new SimpleSpanProcessor(__btrz_monitoring__spanExporterForTests);
  }

  return {
    spanExporter: global.__btrz_monitoring__spanExporterForTests,
    spanProcessor: global.__btrz_monitoring__spanProcessorForTests
  };
}
