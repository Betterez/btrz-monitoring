"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeTracing = initializeTracing;
exports.warmUpDatabaseConnectionForTracing = warmUpDatabaseConnectionForTracing;
exports.__enableTestMode = __enableTestMode;
exports.__getActiveOtlpSdkInstance = __getActiveOtlpSdkInstance;
const node_assert_1 = __importDefault(require("node:assert"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_process_1 = __importDefault(require("node:process"));
const util = __importStar(require("node:util"));
const ansi_colors_1 = __importDefault(require("ansi-colors"));
const sdk_node_1 = require("@opentelemetry/sdk-node");
const auto_instrumentations_node_1 = require("@opentelemetry/auto-instrumentations-node");
const exporter_trace_otlp_grpc_1 = require("@opentelemetry/exporter-trace-otlp-grpc");
const exporter_metrics_otlp_grpc_1 = require("@opentelemetry/exporter-metrics-otlp-grpc");
const exporter_metrics_otlp_http_1 = require("@opentelemetry/exporter-metrics-otlp-http");
const sdk_metrics_1 = require("@opentelemetry/sdk-metrics");
const resources_1 = require("@opentelemetry/resources");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const sdk_trace_base_1 = require("@opentelemetry/sdk-trace-base");
const api_1 = require("@opentelemetry/api");
const id_generator_aws_xray_1 = require("@opentelemetry/id-generator-aws-xray");
const propagator_aws_xray_1 = require("@opentelemetry/propagator-aws-xray");
const resources_2 = require("@opentelemetry/resources");
const resource_detector_aws_1 = require("@opentelemetry/resource-detector-aws");
const attributes_1 = require("./attributes");
const escape_string_regexp_1 = require("./escape-string-regexp");
const DEFAULT_SAMPLE_PERCENTAGE = 100;
// When exporting to CloudWatch, the metrics export interval must not exceed 60 seconds or metric/trace correlation
// will not work correctly.
const METRIC_EXPORT_INTERVAL_MILLIS = 60000;
// CloudWatch Application Signals aggregates latency using an exponential histogram; all other instruments use the
// default aggregation.  This should match the aggregation selector used by the
// "@aws/aws-distro-opentelemetry-node-autoinstrumentation" package.
const cloudWatchAggregationSelector = (instrumentType) => {
    if (instrumentType === sdk_metrics_1.InstrumentType.HISTOGRAM) {
        return { type: sdk_metrics_1.AggregationType.EXPONENTIAL_HISTOGRAM };
    }
    return { type: sdk_metrics_1.AggregationType.DEFAULT };
};
var ProductCompatibilityMode;
(function (ProductCompatibilityMode) {
    ProductCompatibilityMode["CLOUDWATCH"] = "cloudwatch";
})(ProductCompatibilityMode || (ProductCompatibilityMode = {}));
// The default resource detectors do not include the "awsEc2Detector".  To add it, we must define our own list
// of resource detectors instead of using the defaults.
const resourceDetectors = [resources_2.envDetector, resources_2.processDetector, resources_2.hostDetector, resources_2.osDetector, resource_detector_aws_1.awsEc2Detector];
let __activeOtlpSdkInstance = null;
let __activeMeterProvider = null;
// The "@aws/aws-distro-opentelemetry-node-autoinstrumentation" is the package that AWS recommends you use if you want
// to instrumenta NodeJS application using OpenTelemetry.  However the package does not allow the consumer to customize
// any of the OpenTelemetry instrumentation behaviour.  We want to achieve compatibility with CloudWatch in the same way
// that "@aws/aws-distro-opentelemetry-node-autoinstrumentation" does, while also allowing customization of
// OpenTelemetry functionality. To do this, we import some pieces of
// "@aws/aws-distro-opentelemetry-node-autoinstrumentation" that are not explicitly exported.  This is a hack and may
// break if the installed version of "@aws/aws-distro-opentelemetry-node-autoinstrumentation" is upgraded.
// This would not be necessary if "@aws/aws-distro-opentelemetry-node-autoinstrumentation" was open for customization,
// but it is completely closed.
function loadCloudWatchProprietaryComponents() {
    const packageBuildDir = path.dirname(require.resolve("@aws/aws-distro-opentelemetry-node-autoinstrumentation/register"));
    const { AlwaysRecordSampler } = require(path.join(packageBuildDir, "always-record-sampler.js"));
    const { AttributePropagatingSpanProcessorBuilder } = require(path.join(packageBuildDir, "attribute-propagating-span-processor-builder.js"));
    const { AwsSpanMetricsProcessorBuilder } = require(path.join(packageBuildDir, "aws-span-metrics-processor-builder.js"));
    const { AwsMetricAttributesSpanExporterBuilder } = require(path.join(packageBuildDir, "aws-metric-attributes-span-exporter-builder.js"));
    return {
        AlwaysRecordSampler,
        AttributePropagatingSpanProcessorBuilder,
        AwsSpanMetricsProcessorBuilder,
        AwsMetricAttributesSpanExporterBuilder
    };
}
function getSampler(samplePercentage = DEFAULT_SAMPLE_PERCENTAGE) {
    // Wrap the root sampler in a ParentBasedSampler so that a service honours any sampling decision
    // that was made upstream (propagated in the incoming trace context) instead of re-deciding on its own.
    // This keeps distributed traces intact across services when samplePercentage is less than 100.
    const rootSampler = samplePercentage === 100 ?
        new sdk_trace_base_1.AlwaysOnSampler() : new sdk_trace_base_1.TraceIdRatioBasedSampler(samplePercentage / 100);
    return new sdk_trace_base_1.ParentBasedSampler({ root: rootSampler });
}
function getSdkConfigurationForGenericProduct(options) {
    const { serviceName, traceDestinationUrl, samplePercentage } = options;
    const resource = (0, resources_1.resourceFromAttributes)({
        [semantic_conventions_1.ATTR_SERVICE_NAME]: serviceName
    });
    const traceExporter = global.__btrz_monitoring__spanExporterForTests ||
        new exporter_trace_otlp_grpc_1.OTLPTraceExporter({
            url: traceDestinationUrl
        });
    const spanProcessor = global.__btrz_monitoring__spanProcessorForTests ||
        new sdk_trace_base_1.BatchSpanProcessor(traceExporter, {
            maxExportBatchSize: 4096,
            maxQueueSize: 8192
        });
    return {
        resource,
        resourceDetectors,
        autoDetectResources: true,
        idGenerator: undefined, // Use the default id generator
        spanProcessors: [spanProcessor],
        sampler: getSampler(samplePercentage),
        textMapPropagator: undefined, // Use the default propagator
    };
}
function getSdkConfigurationForCloudwatch(options) {
    const { serviceName, traceDestinationUrl, metricDestinationUrl, samplePercentage } = options;
    const { AlwaysRecordSampler, AttributePropagatingSpanProcessorBuilder, AwsSpanMetricsProcessorBuilder, AwsMetricAttributesSpanExporterBuilder } = loadCloudWatchProprietaryComponents();
    // The resource must be fully resolved before it is passed through other Cloudwatch-specific SDK components
    // (ie. the span exporter), otherwise the metric data generated from the spans will be missing important resource attributes.
    const resource = (0, resources_1.defaultResource)()
        .merge((0, resources_1.detectResources)({ detectors: resourceDetectors }))
        .merge((0, resources_1.resourceFromAttributes)({
        [semantic_conventions_1.ATTR_SERVICE_NAME]: serviceName
    }));
    const traceExporter = global.__btrz_monitoring__spanExporterForTests ||
        new exporter_trace_otlp_grpc_1.OTLPTraceExporter({
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
        new sdk_trace_base_1.BatchSpanProcessor(spanExporter, {
            maxExportBatchSize: 4096,
            maxQueueSize: 8192
        });
    const metricExporter = new exporter_metrics_otlp_grpc_1.OTLPMetricExporter({
        url: metricDestinationUrl,
        temporalityPreference: exporter_metrics_otlp_http_1.AggregationTemporalityPreference.DELTA, // Required by CloudWatch Application Signals
        aggregationPreference: cloudWatchAggregationSelector
    });
    const metricReader = new sdk_metrics_1.PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: METRIC_EXPORT_INTERVAL_MILLIS
    });
    const meterProvider = new sdk_metrics_1.MeterProvider({
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
        resourceDetectors: undefined, // No need for the Otel SDK to detect resources since we already did this above
        autoDetectResources: false,
        idGenerator: new id_generator_aws_xray_1.AWSXRayIdGenerator(),
        spanProcessors,
        sampler,
        textMapPropagator: new propagator_aws_xray_1.AWSXRayPropagator(),
    };
}
function getSdkConfiguration(options) {
    const { productCompatibility } = options;
    if (productCompatibility === ProductCompatibilityMode.CLOUDWATCH) {
        return getSdkConfigurationForCloudwatch(options);
    }
    else {
        return getSdkConfigurationForGenericProduct(options);
    }
}
// This must be executed before any other code (including "require" / "import" statements) or the tracing
// instrumentation may not be installed
function initializeTracing(options) {
    const { enabled = true, samplePercentage = DEFAULT_SAMPLE_PERCENTAGE, metricDestinationUrl, productCompatibility, ignoreStaticAssetDir = [], ignoredHttpMethods = [], ignoredRoutes = [], ignoredAwsSqsEvents = [], enableFilesystemTracing = false } = options;
    (0, node_assert_1.default)(samplePercentage >= 0 && samplePercentage <= 100, "samplePercentage must be a number between 0 and 100");
    (0, node_assert_1.default)(!(productCompatibility === ProductCompatibilityMode.CLOUDWATCH && !metricDestinationUrl), "You must provide a metricDestinationUrl when sending telemetry to CloudWatch");
    if (enabled === false || node_process_1.default.env.NODE_ENV === "test") {
        return {
            shutdownTracing: async () => { }
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
    const sdkConfiguration = getSdkConfiguration(options);
    const sdk = new sdk_node_1.NodeSDK({
        ...sdkConfiguration,
        instrumentations: [(0, auto_instrumentations_node_1.getNodeAutoInstrumentations)({
                "@opentelemetry/instrumentation-fs": {
                    enabled: true, // This setting is currently ignored due to a bug.  See setEnabledInstrumentations().
                    requireParentSpan: true
                },
                "@opentelemetry/instrumentation-http": {
                    ignoreIncomingRequestHook(req) {
                        if (incomingHttpRequestUrlPatternsToIgnore.some(regex => regex.test(req.url ?? ""))) {
                            return true;
                        }
                        else if (ignoredHttpMethods.includes(req.method)) {
                            return true;
                        }
                        else if (routeIsExplicitlyIgnored(ignoredRoutes, req)) {
                            return true;
                        }
                        return false;
                    }
                },
                "@opentelemetry/instrumentation-aws-sdk": {
                    suppressInternalInstrumentation: true,
                    preRequestHook(span, request) {
                        // Newer versions of @opentelemetry/instrumentation-aws-sdk no longer provide a
                        // dedicated sqsProcessHook. We can still suppress request-based SQS events here.
                        if (ignoredAwsSqsEvents.includes(request.request.commandName)) {
                            span.spanContext().traceFlags = api_1.TraceFlags.NONE;
                        }
                    }
                },
                "@opentelemetry/instrumentation-express": {
                    requestHook(span, info) {
                        if (info.request.account?.accountId) {
                            span.setAttribute(attributes_1.monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID, info.request.account.accountId);
                        }
                        else if (info.request.session?.account?._id) {
                            span.setAttribute(attributes_1.monitoringAttributes.ATTR_BTRZ_ACCOUNT_ID, info.request.session.account._id);
                        }
                        if (info.request.session?.networkContext?.providerIds) {
                            span.setAttribute(attributes_1.monitoringAttributes.ATTR_BTRZ_PROVIDER_ID, info.request.session.networkContext.providerIds);
                        }
                    }
                }
            })]
    });
    __activeOtlpSdkInstance = sdk;
    sdk.start();
    node_process_1.default.on("SIGTERM", async () => {
        try {
            await shutdownTracing(sdk)();
            node_process_1.default.exit(0);
        }
        catch (error) {
            node_process_1.default.exit(1);
        }
    });
    return {
        shutdownTracing: shutdownTracing(sdk)
    };
}
function routeIsExplicitlyIgnored(ignoredRoutes, req) {
    return ignoredRoutes.some((route) => {
        if (route.method !== req.method) {
            return false;
        }
        if (typeof route.url === "string") {
            return req.url === route.url;
        }
        else {
            return route.url.test(req.url ?? "");
        }
    });
}
function getRegularExpressionsMatchingAllContentsOfDirectory(directory) {
    const allContentsOfDirectory = fs.readdirSync(directory);
    const regularExpressions = allContentsOfDirectory.map((entry) => {
        const pathToEntry = path.join(directory, entry);
        const stats = fs.lstatSync(pathToEntry);
        if (stats.isDirectory()) {
            return new RegExp(`^\/${(0, escape_string_regexp_1.escapeStringRegexp)(entry)}\/`);
        }
        else if (stats.isFile()) {
            return new RegExp(`^\/${(0, escape_string_regexp_1.escapeStringRegexp)(entry)}$`);
        }
        else {
            return undefined;
        }
    }).filter(entry => entry !== undefined);
    return regularExpressions;
}
// Work around a bug in the open telemetry library where the "@opentelemetry/instrumentation-fs" instrumentation
// cannot be enabled via the instrumentation config.  Instead, it must be enabled by setting an environment variable.
// https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2515
function forcefullyEnableFilesystemTracing() {
    if (!node_process_1.default.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS) {
        node_process_1.default.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = [
            "amqplib", "aws-lambda", "aws-sdk",
            "bunyan", "cassandra-driver", "connect",
            "cucumber", "dataloader", "dns",
            "express", "fs", "generic-pool",
            "graphql", "grpc", "hapi",
            "http", "ioredis", "kafkajs",
            "knex", "koa", "lru-memoizer",
            "memcached", "mongodb", "mongoose",
            "mysql2", "mysql", "nestjs-core",
            "net", "pg", "pino",
            "redis", "redis-4", "restify",
            "router", "socket.io", "tedious",
            "undici", "winston"
        ].join(",");
    }
}
function shutdownTracing(sdk) {
    return async () => {
        try {
            console.log(ansi_colors_1.default.yellow("[btrz-monitoring] Stopping tracing..."));
            await sdk.shutdown();
            await __activeMeterProvider?.shutdown();
            console.log(ansi_colors_1.default.yellow("[btrz-monitoring] Tracing stopped"));
        }
        catch (error) {
            console.error(ansi_colors_1.default.red("[btrz-monitoring] Error while stopping tracing"));
            console.error(ansi_colors_1.default.red(util.inspect(error)));
        }
        finally {
            __activeOtlpSdkInstance = null;
            __activeMeterProvider = null;
        }
    };
}
/**
 * Warming-up the database connection is done to improve the legibility of traces. The first connection to the database will initiate a
 * polling process between the mongodb driver and the Mongo server. If the connection is not warmed up on server start, the first API which
 * uses the database will initiate the connection.  The trace data captured for that API call will also include the polling traffic between
 * the mongodb driver and the Mongo server.  This polling will continue until the server is shut down, and as a result, the trace will last
 * as long as this server is running, and will contain details about the polling traffic between the mongo client and server.  We do not
 * want to capture this polling traffic, and warming-up the database connection outside an API handler will prevent this.
**/
async function warmUpDatabaseConnectionForTracing(simpleDao, logger) {
    try {
        await simpleDao.connect();
    }
    catch (error) {
        // Do not re-throw the error in case this would prevent the server from starting.
        logger.error("Error warming up connection to database", error);
    }
}
// Called by internal tests so that they can inspect the spans that are created by the tracing instrumentation.
function __enableTestMode() {
    // Global variables are used here to avoid changing the span exporter / span processor when tests are running.
    // The OpenTelemetry library seems to internally keep a reference to the first span exporter and span processor that
    // is provided to it.  If the span exporter / span processor is changed, the OpenTelemetry code will not respect this
    // change and will continue to use the previous span exporter / span processor.  Using a global variable ensures that
    // the span exporter / span processor never changes, which can be difficult to avoid when tests are running in "watch"
    // mode.
    if (!global.__btrz_monitoring__spanExporterForTests) {
        global.__btrz_monitoring__spanExporterForTests = new sdk_trace_base_1.InMemorySpanExporter();
    }
    if (!global.__btrz_monitoring__spanProcessorForTests) {
        global.__btrz_monitoring__spanProcessorForTests = new sdk_trace_base_1.SimpleSpanProcessor(global.__btrz_monitoring__spanExporterForTests);
    }
    return {
        spanExporter: global.__btrz_monitoring__spanExporterForTests,
        spanProcessor: global.__btrz_monitoring__spanProcessorForTests
    };
}
function __getActiveOtlpSdkInstance() {
    return __activeOtlpSdkInstance;
}
//# sourceMappingURL=install-instrumentation.js.map