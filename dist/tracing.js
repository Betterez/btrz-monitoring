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
exports.trace = trace;
exports.__enableTestMode = __enableTestMode;
const node_assert_1 = __importDefault(require("node:assert"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_process_1 = __importDefault(require("node:process"));
const util = __importStar(require("node:util"));
const chalk_1 = __importDefault(require("chalk"));
const lodash_1 = require("lodash");
const sdk_node_1 = require("@opentelemetry/sdk-node");
const auto_instrumentations_node_1 = require("@opentelemetry/auto-instrumentations-node");
const exporter_trace_otlp_grpc_1 = require("@opentelemetry/exporter-trace-otlp-grpc");
const resources_1 = require("@opentelemetry/resources");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const sdk_trace_base_1 = require("@opentelemetry/sdk-trace-base");
const api_1 = require("@opentelemetry/api");
const incubating_1 = require("@opentelemetry/semantic-conventions/incubating");
// This must be executed before any other code (including "require" / "import" statements) or the tracing
// instrumentation may not be installed
function initializeTracing(options) {
    const { enabled = true, serviceName, samplePercentage = 100, traceDestinationUrl, ignoreStaticAssetDir = [], ignoredHttpMethods = [], ignoredRoutes = [], enableFilesystemTracing = false } = options;
    (0, node_assert_1.default)(samplePercentage >= 0 && samplePercentage <= 100, "samplePercentage must be a number between 0 and 100");
    if (enabled === false || node_process_1.default.env.NODE_ENV === "test") {
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
        new exporter_trace_otlp_grpc_1.OTLPTraceExporter({
            url: traceDestinationUrl
        });
    const spanProcessor = global.__btrz_monitoring__spanProcessorForTests ||
        new sdk_trace_base_1.BatchSpanProcessor(traceExporter, {
            maxExportBatchSize: 4096,
            maxQueueSize: 8192
        });
    const sdk = new sdk_node_1.NodeSDK({
        resource: (0, resources_1.resourceFromAttributes)({
            [semantic_conventions_1.ATTR_SERVICE_NAME]: serviceName
        }),
        spanProcessors: [spanProcessor],
        sampler: samplePercentage === 100 ? new sdk_trace_base_1.AlwaysOnSampler() : new sdk_trace_base_1.TraceIdRatioBasedSampler(samplePercentage / 100),
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
                }
            })]
    });
    sdk.start();
    node_process_1.default.on("SIGTERM", shutdown(sdk));
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
            return new RegExp(`^\/${(0, lodash_1.escapeRegExp)(entry)}\/`);
        }
        else if (stats.isFile()) {
            return new RegExp(`^\/${(0, lodash_1.escapeRegExp)(entry)}$`);
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
function shutdown(sdk) {
    return async () => {
        try {
            await sdk.shutdown();
            node_process_1.default.exit(0);
        }
        catch (error) {
            console.error(chalk_1.default.red("[btrz-monitoring] Error while stopping tracing"));
            console.error(chalk_1.default.red(util.inspect(error)));
            node_process_1.default.exit(1);
        }
    };
}
function trace(arg1, arg2, arg3) {
    const tracer = api_1.trace.getTracer("btrz-monitoring");
    let spanName;
    let traceOptions;
    let functionToTrace;
    if (typeof arg1 === "function") {
        functionToTrace = arg1;
        spanName = functionToTrace.name || "anonymous function";
        traceOptions = {};
    }
    else if (typeof arg2 === "function") {
        spanName = arg1;
        functionToTrace = arg2;
        traceOptions = {};
    }
    else {
        spanName = arg1;
        traceOptions = arg2 || {};
        functionToTrace = arg3;
    }
    let result;
    let synchronousError;
    const { inheritAttributesFromParentTrace, ..._spanOptions } = traceOptions;
    const activeSpan = api_1.trace.getActiveSpan();
    let attributesToCopy = {};
    let linksToCopy = [];
    let spanKind = api_1.SpanKind.INTERNAL;
    if (inheritAttributesFromParentTrace && activeSpan) {
        attributesToCopy = activeSpan.attributes;
        linksToCopy = activeSpan.links;
        spanKind = activeSpan.kind;
    }
    const spanOptions = {
        ..._spanOptions,
        attributes: {
            [incubating_1.ATTR_CODE_FUNCTION_NAME]: functionToTrace.name || undefined,
            ...attributesToCopy,
            ...(_spanOptions.attributes || {})
        },
        links: [...(_spanOptions.links || []), ...linksToCopy],
        kind: _spanOptions.kind ?? spanKind,
    };
    tracer.startActiveSpan(spanName, spanOptions, (span) => {
        try {
            result = functionToTrace();
        }
        catch (error) {
            synchronousError = error;
            span.setStatus({
                code: api_1.SpanStatusCode.ERROR,
                message: error?.message
            });
        }
        if (isPromiseLike(result)) {
            result
                .then((result) => {
                span.setStatus({
                    code: api_1.SpanStatusCode.OK
                });
                span.end();
                return result;
            }, (_error) => {
                span.setStatus({
                    code: api_1.SpanStatusCode.ERROR,
                    message: _error?.message
                });
                span.end();
                throw _error;
            });
        }
        else {
            if (!synchronousError) {
                span.setStatus({
                    code: api_1.SpanStatusCode.OK
                });
            }
            span.end();
        }
    });
    if (synchronousError) {
        throw synchronousError;
    }
    return result;
}
function isPromiseLike(value) {
    return typeof value?.then === "function";
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
        global.__btrz_monitoring__spanProcessorForTests = new sdk_trace_base_1.SimpleSpanProcessor(__btrz_monitoring__spanExporterForTests);
    }
    return {
        spanExporter: global.__btrz_monitoring__spanExporterForTests,
        spanProcessor: global.__btrz_monitoring__spanProcessorForTests
    };
}
//# sourceMappingURL=tracing.js.map