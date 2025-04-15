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
const node_process_1 = __importDefault(require("node:process"));
const util = __importStar(require("node:util"));
const chalk_1 = __importDefault(require("chalk"));
const sdk_node_1 = require("@opentelemetry/sdk-node");
const auto_instrumentations_node_1 = require("@opentelemetry/auto-instrumentations-node");
const exporter_trace_otlp_proto_1 = require("@opentelemetry/exporter-trace-otlp-proto");
const resources_1 = require("@opentelemetry/resources");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
function initializeTracing(options) {
    if (node_process_1.default.env.NODE_ENV === "test") {
        return;
    }
    const { serviceName, traceDestinationUrl } = options;
    const traceExporter = new exporter_trace_otlp_proto_1.OTLPTraceExporter({
        url: traceDestinationUrl
    });
    const sdk = new sdk_node_1.NodeSDK({
        resource: (0, resources_1.resourceFromAttributes)({
            [semantic_conventions_1.ATTR_SERVICE_NAME]: serviceName
        }),
        traceExporter,
        instrumentations: [(0, auto_instrumentations_node_1.getNodeAutoInstrumentations)()]
    });
    sdk.start();
    const shutdown = async () => {
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
    node_process_1.default.on("SIGTERM", shutdown);
}
//# sourceMappingURL=tracing.js.map