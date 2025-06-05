import * as semanticConventions from "@opentelemetry/semantic-conventions";

export const monitoringAttributes = {
  ATTR_BTRZ_ACCOUNT_ID: "btrz.account.id",
  ...semanticConventions
} as const;

export {initializeTracing, warmUpDatabaseConnectionForTracing, trace, withTracing} from "./tracing";
