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
// This must be executed before any other code (including "require" / "import" statements) or the tracing
// instrumentation may not be installed
function initializeTracing(options) {
    if (node_process_1.default.env.NODE_ENV === "test") {
        return;
    }
    const { serviceName, traceDestinationUrl, ignoreStaticAssetDir, ignoreHttpOptionsRequests } = options;
    const incomingHttpRequestUrlsToIgnore = [
        ...getRegularExpressionsMatchingAllContentsOfDirectory(ignoreStaticAssetDir),
        /^\/__webpack_hmr/ // Ignore requests made by webpack hot-reload tooling
    ];
    setEnabledInstrumentations();
    const traceExporter = new exporter_trace_otlp_grpc_1.OTLPTraceExporter({
        url: traceDestinationUrl
    });
    const sdk = new sdk_node_1.NodeSDK({
        resource: (0, resources_1.resourceFromAttributes)({
            [semantic_conventions_1.ATTR_SERVICE_NAME]: serviceName
        }),
        traceExporter,
        instrumentations: [(0, auto_instrumentations_node_1.getNodeAutoInstrumentations)({
                "@opentelemetry/instrumentation-fs": {
                    enabled: true, // This setting is currently ignored due to a bug.  See setEnabledInstrumentations().
                    requireParentSpan: true
                },
                "@opentelemetry/instrumentation-http": {
                    ignoreIncomingRequestHook(req) {
                        debugger;
                        if (incomingHttpRequestUrlsToIgnore.some(regex => regex.test(req.url ?? ""))) {
                            return true;
                        }
                        else if (ignoreHttpOptionsRequests && req.method === "OPTIONS") {
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
function getRegularExpressionsMatchingAllContentsOfDirectory(directory) {
    if (!directory) {
        return [];
    }
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
function setEnabledInstrumentations() {
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
//# sourceMappingURL=tracing.js.map