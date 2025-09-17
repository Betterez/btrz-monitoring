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
import * as semanticConventions from "@opentelemetry/semantic-conventions";
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";
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
  AttributeValue,
  Link,
  Span,
  SpanKind,
  SpanStatusCode,
  SpanOptions,
  trace as otlpTrace,
  TraceFlags,
} from "@opentelemetry/api";
import {
  AwsSdkRequestHookInformation,
  AwsSdkSqsProcessHookInformation
} from "@opentelemetry/instrumentation-aws-sdk";

import {BtrzLogger, SimpleDao} from "./types/external.types";

interface TracingInitOptions {
  enabled?: boolean;
  serviceName: string;
  samplePercentage?: number;
  traceDestinationUrl: string;
  ignoreStaticAssetDir?: string | string[];
  ignoredHttpMethods?: HttpMethod[];
  ignoredRoutes?: HttpRoute[];
  ignoredAwsSqsEvents?: AwsSqsEvent[];
  enableFilesystemTracing?: boolean;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "CONNECT" | "TRACE";
type HttpRoute = {
  method: HttpMethod;
  url: string | RegExp;
}

type AwsSqsEvent = "ReceiveMessage" | "ProcessMessage";

// NonRecordingSpan is an OpenTelemetry type that is not currently exported.  Fake it for our own use.
type NonRecordingSpan = {};

export const monitoringAttributes = {
  ATTR_BTRZ_ACCOUNT_ID: "btrz.account.id",
  ATTR_BTRZ_PROVIDER_ID: "btrz.provider.id",
  ...semanticConventions
} as const;

let __activeOtlpSdkInstance: NodeSDK | null = null;

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
    ignoredAwsSqsEvents = [],
    enableFilesystemTracing = false
  } = options;

  assert(samplePercentage >= 0 && samplePercentage <= 100, "samplePercentage must be a number between 0 and 100");

  if (enabled === false || process.env.NODE_ENV === "test") {
    return {
      shutdownTracing: async () => {}
    };
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
      },
      "@opentelemetry/instrumentation-aws-sdk": {
        suppressInternalInstrumentation: true,
        preRequestHook(span: Span, request: AwsSdkRequestHookInformation) {
          if ((ignoredAwsSqsEvents as string[]).includes(request.request.commandName)) {
            span.spanContext().traceFlags = TraceFlags.NONE;
          }
        },
        sqsProcessHook(span: Span, sqsProcessInfo: AwsSdkSqsProcessHookInformation) {
          if (ignoredAwsSqsEvents.includes("ProcessMessage")) {
            span.spanContext().traceFlags = TraceFlags.NONE;
          }
        }
      },
      "@opentelemetry/instrumentation-express": {
        requestHook(span, info) {
          if (info.request.account?.accountId) {
            span.setAttribute(monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID, info.request.account.accountId);
          } else if (info.request.session?.account?._id) {
            span.setAttribute(monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID, info.request.session.account._id);
          }

          if (info.request.session?.networkContext?.providerIds) {
            span.setAttribute(monitoringAttributes.ATTR_BTRZ_PROVIDER_ID, info.request.session.networkContext.providerIds);
          }
        }
      }
    })]
  });

  __activeOtlpSdkInstance = sdk;
  sdk.start();

  process.on("SIGTERM", async () => {
    try {
      await shutdownTracing(sdk)();
      process.exit(0);
    } catch (error) {
      process.exit(1);
    }
  });

  return {
    shutdownTracing: shutdownTracing(sdk)
  };
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

function shutdownTracing(sdk: NodeSDK) {
  return async () => {
    try {
      console.log(chalk.yellow("[btrz-monitoring] Stopping tracing..."));
      await sdk.shutdown();
      console.log(chalk.yellow("[btrz-monitoring] Tracing stopped"));
    } catch (error) {
      console.error(chalk.red("[btrz-monitoring] Error while stopping tracing"));
      console.error(chalk.red(util.inspect(error)));
    } finally {
      __activeOtlpSdkInstance = null;
    }
  }
}

type TraceableFunction<T extends unknown[], R> = (...args: T) => R;
type TraceableFunctionWithoutArgs<R> = () => R;
type TraceOptions = SpanOptions & { inheritAttributesFromParentTrace?: boolean };

export function trace<R>(fn: TraceableFunctionWithoutArgs<R>): R;
export function trace<R>(spanName: string, fn: TraceableFunctionWithoutArgs<R>): R;
export function trace<R>(options: TraceOptions, fn: TraceableFunctionWithoutArgs<R>): R;
export function trace<R>(spanName: string, options: TraceOptions, fn: TraceableFunctionWithoutArgs<R>): R;
export function trace<R>(arg1: string | TraceOptions | TraceableFunctionWithoutArgs<R>, arg2?: TraceOptions | TraceableFunctionWithoutArgs<R>, arg3?: TraceableFunctionWithoutArgs<R>): R {
  const tracer = otlpTrace.getTracer("btrz-monitoring");

  const {
    spanNameFromArgs,
    traceOptions,
    functionToTrace
  } = extractArguments(arg1, arg2, arg3);
  const spanName = spanNameFromArgs || functionToTrace.name || getNameOfCallingFunction() || "unnamed trace";

  let result: R;

  const { inheritAttributesFromParentTrace, ..._spanOptions } = traceOptions;
  const activeSpan: NonRecordingSpan | ReadableSpan | undefined = otlpTrace.getActiveSpan();
  let attributesToCopy: Attributes = {};
  let linksToCopy: Link[] = [];
  let spanKind = SpanKind.INTERNAL;

  if (inheritAttributesFromParentTrace && activeSpan) {
    attributesToCopy = getSpanAttributes(activeSpan);
    linksToCopy = getSpanLinks(activeSpan);
    spanKind = getSpanKind(activeSpan);
  }

  const spanOptions: SpanOptions = {
    ..._spanOptions,
    attributes: {
      [ATTR_CODE_FUNCTION_NAME]: functionToTrace.name || getNameOfCallingFunction() || undefined,
      ...attributesToCopy,
      ...(_spanOptions.attributes || {})
    },
    links: [...(_spanOptions.links || []), ...linksToCopy],
    kind: _spanOptions.kind ?? spanKind,
  };

  tracer.startActiveSpan(spanName, spanOptions, (span) => {
    try {
      result = functionToTrace();
    } catch (synchronousError: any) {
      attachErrorToSpan(synchronousError, span);
      span.end();
      throw synchronousError;
    }

    if (isPromiseLike(result)) {
      result = Promise.resolve(result)
        .then((result) => {
          span.setStatus({
            code: SpanStatusCode.OK
          });
          span.end();
          return result;
        }, (_error) => {
          attachErrorToSpan(_error, span);
          span.end();
          throw _error;
        }) as R;
    } else {
      span.setStatus({
        code: SpanStatusCode.OK
      });
      span.end();
    }
  });

  return result!;
}

export function withTracing<T extends unknown[], R>(fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export function withTracing<T extends unknown[], R>(spanName: string, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export function withTracing<T extends unknown[], R>(options: TraceOptions, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export function withTracing<T extends unknown[], R>(spanName: string, options: TraceOptions, fn: TraceableFunction<T, R>): TraceableFunction<T, R>;
export function withTracing<T extends unknown[], R>(arg1: string | TraceOptions | TraceableFunction<T, R>, arg2?: TraceOptions | TraceableFunction<T, R>, arg3? : TraceableFunction<T, R>): TraceableFunction<T, R> {
  const {
    spanNameFromArgs,
    traceOptions,
    functionToTrace
  } = extractArguments(arg1, arg2, arg3);
  const spanName = spanNameFromArgs || simplifyFunctionName(functionToTrace.name) || getNameOfCallingFunction() || "unnamed trace";

  const wrapperFunction = (...args: T) => {
    const traceExecutor = () => functionToTrace(...args);
    Object.defineProperty(traceExecutor, "name", {value: functionToTrace.name});

    return trace(spanName, traceOptions, traceExecutor);
  };

  Object.defineProperty(wrapperFunction, "length", {value: functionToTrace.length});
  Object.defineProperty(wrapperFunction, "name", {value: functionToTrace.name});
  return wrapperFunction;
}

function extractArguments<T extends unknown[], R>(
  arg1: string | TraceOptions | TraceableFunction<T, R>,
  arg2?: TraceOptions | TraceableFunction<T, R>,
  arg3? : TraceableFunction<T, R>
) {
  let spanNameFromArgs: string | undefined;
  let traceOptions: TraceOptions;
  let functionToTrace: TraceableFunction<T, R>;

  if (typeof arg1 === "function") {
    functionToTrace = arg1;
    spanNameFromArgs = undefined;
    traceOptions = {};
  } else if (typeof arg1 === "string" && typeof arg2 === "function") {
    spanNameFromArgs = arg1;
    functionToTrace = arg2;
    traceOptions = {};
  } else if (typeof arg1 === "object" && typeof arg2 === "function") {
    traceOptions = arg1;
    functionToTrace = arg2;
    spanNameFromArgs = undefined;
  } else {
    spanNameFromArgs = arg1 as string;
    traceOptions = arg2 as TraceOptions || {};
    functionToTrace = arg3!;
  }

  return {
    spanNameFromArgs,
    traceOptions,
    functionToTrace
  };
}

function attachErrorToSpan(error: any, span: Span) {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error?.message
  });
  span.setAttributes({
    [ATTR_EXCEPTION_MESSAGE]: error?.message,
    [ATTR_EXCEPTION_STACKTRACE]: error?.stack
  });
}

function getSpanAttributes(span?: NonRecordingSpan | ReadableSpan): Attributes {
  if (!span || !(span as any).attributes) {
    return {};
  }
  return (span as ReadableSpan).attributes;
}

function getSpanLinks(span?: NonRecordingSpan | ReadableSpan): Link[] {
  if (!span || !(span as any).links) {
    return [];
  }
  return (span as ReadableSpan).links;
}

function getSpanKind(span?: NonRecordingSpan | ReadableSpan): SpanKind {
  if (!span || !(span as any).kind) {
    return SpanKind.INTERNAL;
  }
  return (span as ReadableSpan).kind;
}

function isPromiseLike(value: any): value is PromiseLike<any> {
  return typeof value?.then === "function";
}

// Adapted from https://devimalplanet.com/javascript-how-to-get-the-caller-parent-functions-name
function getNameOfCallingFunction() {
    const e = new Error();
    // matches this function, the caller and the parent
    const allMatches = e.stack?.match(/(\w+)@|at(.*) [(\/\\]/g) ?? [];
    // match parent function name
    const parentMatches = allMatches[2]?.match(/(\w+)@|at(.*) [(\/\\]/) ?? [];
    // return only name
    return simplifyFunctionName(parentMatches[1] || parentMatches[2]);
}

function simplifyFunctionName(functionName?: string) {
  return (functionName || "")
    .trim()
    .replace(/^bound /, "");
}

export function getActiveSpan(): Span | undefined {
  return otlpTrace.getActiveSpan();
}

export function setAttributeOnSpan(
  span: Span | undefined,
  key: typeof monitoringAttributes[keyof typeof monitoringAttributes],
  value: AttributeValue
) {
  span?.setAttribute(key as string,  value);
}

export function setAttributeOnActiveSpan(
  key: typeof monitoringAttributes[keyof typeof monitoringAttributes],
  value: AttributeValue
) {
  return setAttributeOnSpan(otlpTrace.getActiveSpan(), key, value);
}

/**
 * Warming-up the database connection is done to improve the legibility of traces. The first connection to the database will initiate a
 * polling process between the mongodb driver and the Mongo server. If the connection is not warmed up on server start, the first API which
 * uses the database will initiate the connection.  The trace data captured for that API call will also include the polling traffic between
 * the mongodb driver and the Mongo server.  This polling will continue until the server is shut down, and as a result, the trace will last
 * as long as this server is running, and will contain details about the polling traffic between the mongo client and server.  We do not
 * want to capture this polling traffic, and warming-up the database connection outside an API handler will prevent this.
**/
export async function warmUpDatabaseConnectionForTracing(simpleDao: SimpleDao, logger: BtrzLogger) {
  try {
    await simpleDao.connect();
  } catch (error) {
    // Do not re-throw the error in case this would prevent the server from starting.
    logger.error("Error warming up connection to database", error);
  }
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
    global.__btrz_monitoring__spanProcessorForTests = new SimpleSpanProcessor(global.__btrz_monitoring__spanExporterForTests);
  }

  return {
    spanExporter: global.__btrz_monitoring__spanExporterForTests,
    spanProcessor: global.__btrz_monitoring__spanProcessorForTests
  };
}

export function __getActiveOtlpSdkInstance(): NodeSDK | null {
  return __activeOtlpSdkInstance;
}
