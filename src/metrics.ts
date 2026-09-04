import color from "ansi-colors";
import express from "express";
import {register, ClusterRegistry, collectDefaultMetrics} from "@prometheus-io/client";
import cluster from "node:cluster";
import util from "node:util";

interface MetricsInitOptions {
  serviceName: string;
  metricsPort: number;
}


export function publishMetrics(options: MetricsInitOptions) {
  const {serviceName, metricsPort} = options;

  register.setDefaultLabels({
    service_name: serviceName
  });

  collectDefaultMetrics();

  // Must be instantiated in every process (the cluster primary and all workers)
  const clusterRegistry = new ClusterRegistry();

  if (cluster.isPrimary) {
    const metricsServer = express();

    metricsServer.get("/metrics", async (req, res) => {
      try {
        const metrics = await clusterRegistry.clusterMetrics();
        res.set("Content-Type", clusterRegistry.contentType);
        res.send(metrics);
      } catch (error) {
        console.log(color.red("[btrz-monitoring] Error publishing metrics"));
        console.log(color.red(util.inspect(error)));
        res.statusCode = 500;
        res.send("Unexpected error");
      }
    });

    metricsServer.listen(metricsPort, "127.0.0.1", () => {
      console.log(color.yellow(`[btrz-monitoring] Metrics published at http://localhost:${metricsPort}/metrics`));
    });
  }
}
