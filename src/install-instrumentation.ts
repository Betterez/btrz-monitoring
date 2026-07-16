import assert from "node:assert";
import * as fs from "node:fs";
import {IncomingMessage} from "node:http";
import * as path from "node:path";
import process from "node:process";
import * as util from "node:util";

import color from "ansi-colors";

import {NodeSDK} from "@opentelemetry/sdk-node";
import {getNodeAutoInstrumentations} from "@opentelemetry/auto-instrumentations-node";
import {OTLPTraceExporter} from "@opentelemetry/exporter-trace-otlp-grpc";
import {OTLPMetricExporter} from "@opentelemetry/exporter-metrics-otlp-grpc";
import {AggregationTemporalityPreference} from "@opentelemetry/exporter-metrics-otlp-http";
import {
  AggregationSelector,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics";
import {
  Resource,
  ResourceDetector,
  defaultResource,
  detectResources,
  resourceFromAttributes
} from "@opentelemetry/resources";
import {ATTR_SERVICE_NAME} from "@opentelemetry/semantic-conventions";
import {
  SpanProcessor,
  SimpleSpanProcessor,
  BatchSpanProcessor,
  SpanExporter,
  InMemorySpanExporter,
  Sampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  IdGenerator,
} from "@opentelemetry/sdk-trace-base";
import {
  Span,
  TraceFlags,
  TextMapPropagator,
} from "@opentelemetry/api";
import {
  AwsSdkRequestHookInformation,
} from "@opentelemetry/instrumentation-aws-sdk";
import {AWSXRayIdGenerator} from "@opentelemetry/id-generator-aws-xray";
import {AWSXRayPropagator} from "@opentelemetry/propagator-aws-xray";
import {envDetector, processDetector, hostDetector, osDetector} from "@opentelemetry/resources";
import {awsEc2Detector} from "@opentelemetry/resource-detector-aws";

import {BtrzLogger, SimpleDao} from "./types/external.types";
import {monitoringAttributes} from "./attributes";
import {escapeStringRegexp} from "./escape-string-regexp";

interface TracingInitOptions {
  enabled?: boolean;
  serviceName: string;
  samplePercentage?: number;
  productCompatibility?: ProductCompatibilityMode;
  traceDestinationUrl: string;
  metricDestinationUrl?: string;
  ignoreStaticAssetDir?: string | string[];
  ignoredHttpMethods?: HttpMethod[];
  ignoredRoutes?: HttpRoute[];
  ignoredAwsSqsEvents?: AwsSqsEvent[];
  enableFilesystemTracing?: boolean;
}

const DEFAULT_SAMPLE_PERCENTAGE = 100;
// When exporting to CloudWatch, the metrics export interval must not exceed 60 seconds or metric/trace correlation
// will not work correctly.
const METRIC_EXPORT_INTERVAL_MILLIS = 60000;


// CloudWatch Application Signals aggregates latency using an exponential histogram; all other instruments use the
// default aggregation.  This should match the aggregation selector used by the
// "@aws/aws-distro-opentelemetry-node-autoinstrumentation" package.
const cloudWatchAggregationSelector: AggregationSelector = (instrumentType) => {
  if (instrumentType === InstrumentType.HISTOGRAM) {
    return {type: AggregationType.EXPONENTIAL_HISTOGRAM};
  }
  return {type: AggregationType.DEFAULT};
};

enum ProductCompatibilityMode {
  DEFAULT = "default",
  CLOUDWATCH = "cloudwatch",
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "CONNECT" | "TRACE";
type HttpRoute = {
  method: HttpMethod;
  url: string | RegExp;
}

type AwsSqsEvent = "ReceiveMessage" | "ProcessMessage";

// The default resource detectors do not include the "awsEc2Detector".  To add it, we must define our own list
// of resource detectors instead of using the defaults.
const resourceDetectors = [envDetector, processDetector, hostDetector, osDetector, awsEc2Detector];

let __activeOtlpSdkInstance: NodeSDK | null = null;
let __activeMeterProvider: MeterProvider | null = null;

interface CloudWatchProprietaryComponents {
  AlwaysRecordSampler: {create(rootSampler: Sampler): Sampler};
  AttributePropagatingSpanProcessorBuilder: {create(): {build(): SpanProcessor}};
  AwsSpanMetricsProcessorBuilder: {
    create(meterProvider: MeterProvider, resource: Resource, meterProviderForceFlusher: () => Promise<void>): {build(): SpanProcessor};
  };
  AwsMetricAttributesSpanExporterBuilder: {create(delegate: SpanExporter, resource: Resource): {build(): SpanExporter}};
}

// The "@aws/aws-distro-opentelemetry-node-autoinstrumentation" is the package that AWS recommends you use if you want
// to instrumenta NodeJS application using OpenTelemetry.  However the package does not allow the consumer to customize
// any of the OpenTelemetry instrumentation behaviour.  We want to achieve compatibility with CloudWatch in the same way
// that "@aws/aws-distro-opentelemetry-node-autoinstrumentation" does, while also allowing customization of
// OpenTelemetry functionality. To do this, we import some pieces of
// "@aws/aws-distro-opentelemetry-node-autoinstrumentation" that are not explicitly exported.  This is a hack and may
// break if the installed version of "@aws/aws-distro-opentelemetry-node-autoinstrumentation" is upgraded.
// This would not be necessary if "@aws/aws-distro-opentelemetry-node-autoinstrumentation" was open for customization,
// but it is completely closed.
function loadCloudWatchProprietaryComponents(): CloudWatchProprietaryComponents {
  const packageBuildDir = path.dirname(
    require.resolve("@aws/aws-distro-opentelemetry-node-autoinstrumentation/register")
  );
  const {AlwaysRecordSampler} = require(path.join(packageBuildDir, "always-record-sampler.js"));
  const {AttributePropagatingSpanProcessorBuilder} = require(path.join(packageBuildDir, "attribute-propagating-span-processor-builder.js"));
  const {AwsSpanMetricsProcessorBuilder} = require(path.join(packageBuildDir, "aws-span-metrics-processor-builder.js"));
  const {AwsMetricAttributesSpanExporterBuilder} = require(path.join(packageBuildDir, "aws-metric-attributes-span-exporter-builder.js"));

  return {
    AlwaysRecordSampler,
    AttributePropagatingSpanProcessorBuilder,
    AwsSpanMetricsProcessorBuilder,
    AwsMetricAttributesSpanExporterBuilder
  };
}

function getSampler(samplePercentage: number = DEFAULT_SAMPLE_PERCENTAGE): Sampler {
  // Wrap the root sampler in a ParentBasedSampler so that a service honours any sampling decision
  // that was made upstream (propagated in the incoming trace context) instead of re-deciding on its own.
  // This keeps distributed traces intact across services when samplePercentage is less than 100.
  const rootSampler = samplePercentage === 100 ?
    new AlwaysOnSampler() : new TraceIdRatioBasedSampler(samplePercentage / 100);
  return new ParentBasedSampler({root: rootSampler});
}

function getSdkConfigurationForGenericProduct(options: TracingInitOptions) {
  const {
    serviceName,
    traceDestinationUrl,
    samplePercentage
  } = options;

  const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName
    });

  const traceExporter = global.__btrz_monitoring__spanExporterForTests ||
    new OTLPTraceExporter({
      url: traceDestinationUrl
    });

  const spanProcessor = global.__btrz_monitoring__spanProcessorForTests ||
    new BatchSpanProcessor(traceExporter, {
      maxExportBatchSize: 4096,
      maxQueueSize: 8192
    });

  return {
    resource,
    resourceDetectors,
    autoDetectResources: true,
    idGenerator: undefined,         // Use the default id generator
    spanProcessors: [spanProcessor],
    sampler: getSampler(samplePercentage),
    textMapPropagator: undefined,   // Use the default propagator
  };
}

function getSdkConfigurationForCloudwatch(options: TracingInitOptions) {
  const {
    serviceName,
    traceDestinationUrl,
    metricDestinationUrl,
    samplePercentage
  } = options;

  const {
    AlwaysRecordSampler,
    AttributePropagatingSpanProcessorBuilder,
    AwsSpanMetricsProcessorBuilder,
    AwsMetricAttributesSpanExporterBuilder
  } = loadCloudWatchProprietaryComponents();

  // The resource must be fully resolved before it is passed through other Cloudwatch-specific SDK components
  // (ie. the span exporter), otherwise the metric data generated from the spans will be missing important resource attributes.
  const resource = defaultResource()
    .merge(detectResources({detectors: resourceDetectors}))
    .merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName
      })
    );

  const traceExporter = global.__btrz_monitoring__spanExporterForTests ||
    new OTLPTraceExporter({
      url: traceDestinationUrl
    });

  // Record every span (even sampled-out ones) so that CloudWatch metrics are generated for
  // 100% of traffic without changing the trace sampling rate.
  const sampler = AlwaysRecordSampler.create(getSampler(samplePercentage));

  // Wrap the trace exporter so exported spans carry the aws.local.* / aws.remote.* attributes that
  // correlate traces with the CloudWatch Application Signals metrics.
  const spanExporter = AwsMetricAttributesSpanExporterBuilder
    .create(traceExporter, resource)
    .build();
  const spanProcessor = global.__btrz_monitoring__spanProcessorForTests ||
    new BatchSpanProcessor(spanExporter, {
      maxExportBatchSize: 4096,
      maxQueueSize: 8192
    });

  const metricExporter = new OTLPMetricExporter({
    url: metricDestinationUrl,
    temporalityPreference: AggregationTemporalityPreference.DELTA, // Required by CloudWatch Application Signals
    aggregationPreference: cloudWatchAggregationSelector
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MILLIS
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [metricReader]
  });
  __activeMeterProvider = meterProvider;

  // Order is important here. The attribute-propagating processor runs first to copy attributes down to
  // child spans, and the span-metrics processor runs afterward to produce related metrics.
  const spanProcessors = [
      spanProcessor,
      AttributePropagatingSpanProcessorBuilder.create().build(),
      AwsSpanMetricsProcessorBuilder
        .create(meterProvider, resource, meterProvider.forceFlush.bind(meterProvider))
        .build()
    ];

  return {
    resource,
    resourceDetectors: undefined,  // No need for the Otel SDK to detect resources since we already did this above
    autoDetectResources: false,
    idGenerator: new AWSXRayIdGenerator(),
    spanProcessors,
    sampler,
    textMapPropagator: new AWSXRayPropagator(),
  };
}

function getSdkConfiguration(options: TracingInitOptions): {
  resource: Resource,
  resourceDetectors?: ResourceDetector[],
  autoDetectResources: boolean;
  idGenerator?: IdGenerator;
  spanProcessors: SpanProcessor[];
  sampler: Sampler,
  textMapPropagator?: TextMapPropagator;
} {
  const {productCompatibility} = options;

  if (productCompatibility === ProductCompatibilityMode.CLOUDWATCH) {
    return getSdkConfigurationForCloudwatch(options);
  } else {
    return getSdkConfigurationForGenericProduct(options);
  }
}

function applyOverrides(options: TracingInitOptions & {overrides?: string}): TracingInitOptions {
  if (options.overrides) {
    try {
      const overrides = JSON.parse(options.overrides) as Partial<TracingInitOptions>;
      return {
        ...options,
        enabled: overrides.enabled ?? options.enabled,
        samplePercentage: overrides.samplePercentage ?? options.samplePercentage,
        productCompatibility: overrides.productCompatibility ?? options.productCompatibility,
        traceDestinationUrl: overrides.traceDestinationUrl ?? options.traceDestinationUrl,
        metricDestinationUrl: overrides.metricDestinationUrl ?? options.metricDestinationUrl,
      };
    } catch (error) {
      console.error(color.red("[btrz-monitoring] Error applying overrides.  The 'overrides' property must be a valid JSON string."));
      console.error(color.red(util.inspect(error)));
    }
  }

  return options;
}

// This must be executed before any other code (including "require" / "import" statements) or the tracing
// instrumentation may not be installed
export function initializeTracing(options: TracingInitOptions & {overrides?: string}) {
  const tracingOptions = applyOverrides(options);
  const {
    enabled = true,
    samplePercentage = DEFAULT_SAMPLE_PERCENTAGE,
    metricDestinationUrl,
    productCompatibility,
    ignoreStaticAssetDir = [],
    ignoredHttpMethods = [],
    ignoredRoutes = [],
    ignoredAwsSqsEvents = [],
    enableFilesystemTracing = false,
  } = tracingOptions;

  assert(samplePercentage >= 0 && samplePercentage <= 100, "samplePercentage must be a number between 0 and 100");
  assert(!(productCompatibility === ProductCompatibilityMode.CLOUDWATCH && !metricDestinationUrl),
    "You must provide a metricDestinationUrl when sending telemetry to CloudWatch");

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

  const sdkConfiguration = getSdkConfiguration(tracingOptions);

  const sdk = new NodeSDK({
    ...sdkConfiguration,
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
          // Newer versions of @opentelemetry/instrumentation-aws-sdk no longer provide a
          // dedicated sqsProcessHook. We can still suppress request-based SQS events here.
          if ((ignoredAwsSqsEvents as string[]).includes(request.request.commandName)) {
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
      return new RegExp(`^\/${escapeStringRegexp(entry)}\/`);
    } else if (stats.isFile()) {
      return new RegExp(`^\/${escapeStringRegexp(entry)}$`);
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
      console.log(color.yellow("[btrz-monitoring] Stopping tracing..."));
      await sdk.shutdown();
      await __activeMeterProvider?.shutdown();
      console.log(color.yellow("[btrz-monitoring] Tracing stopped"));
    } catch (error) {
      console.error(color.red("[btrz-monitoring] Error while stopping tracing"));
      console.error(color.red(util.inspect(error)));
    } finally {
      __activeOtlpSdkInstance = null;
      __activeMeterProvider = null;
    }
  }
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
