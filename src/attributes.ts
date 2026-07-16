import * as semanticConventions from "@opentelemetry/semantic-conventions";

export const monitoringAttributes = {
  ATTR_BTRZ_ACCOUNT_ID: "btrz.account.id",
  ATTR_BTRZ_PROVIDER_ID: "btrz.provider.id",
  ...semanticConventions
} as const;
