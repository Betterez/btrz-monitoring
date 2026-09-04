"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishMetrics = publishMetrics;
const ansi_colors_1 = __importDefault(require("ansi-colors"));
const express_1 = __importDefault(require("express"));
const client_1 = require("@prometheus-io/client");
const node_cluster_1 = __importDefault(require("node:cluster"));
const node_util_1 = __importDefault(require("node:util"));
function publishMetrics(options) {
    const { serviceName, metricsPort } = options;
    client_1.register.setDefaultLabels({
        service_name: serviceName
    });
    (0, client_1.collectDefaultMetrics)();
    // Must be instantiated in every process (the cluster primary and all workers)
    const clusterRegistry = new client_1.ClusterRegistry();
    if (node_cluster_1.default.isPrimary) {
        const metricsServer = (0, express_1.default)();
        metricsServer.get("/metrics", async (req, res) => {
            try {
                const metrics = await clusterRegistry.clusterMetrics();
                res.set("Content-Type", clusterRegistry.contentType);
                res.send(metrics);
            }
            catch (error) {
                console.log(ansi_colors_1.default.red("[btrz-monitoring] Error publishing metrics"));
                console.log(ansi_colors_1.default.red(node_util_1.default.inspect(error)));
                res.statusCode = 500;
                res.send("Unexpected error");
            }
        });
        metricsServer.listen(metricsPort, "127.0.0.1", () => {
            console.log(ansi_colors_1.default.yellow(`[btrz-monitoring] Metrics published at http://localhost:${metricsPort}/metrics`));
        });
    }
}
//# sourceMappingURL=metrics.js.map