"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeTracing = initializeTracing;
const node_process_1 = __importDefault(require("node:process"));
const sdk_node_1 = __importDefault(require("@opentelemetry/sdk-node"));
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
    const sdk = new sdk_node_1.default.NodeSDK({
        resource: (0, resources_1.resourceFromAttributes)({
            [semantic_conventions_1.ATTR_SERVICE_NAME]: serviceName
        }),
        traceExporter,
        instrumentations: [(0, auto_instrumentations_node_1.getNodeAutoInstrumentations)()]
    });
    sdk.start();
    node_process_1.default.on("SIGTERM", async () => {
        try {
            await sdk.shutdown();
            console.log("[btrz-monitoring] Tracing stopped");
        }
        catch (error) {
            console.error("[btrz-monitoring] Error while stopping tracing", error);
        }
        finally {
            node_process_1.default.exit(0);
        }
    });
}
//# sourceMappingURL=tracing.js.map