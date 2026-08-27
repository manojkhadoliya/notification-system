import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export interface StartTracingOptions {
  /**
   * Shows up as the service name in Jaeger. Pass the composition root's own
   * name (e.g. "router", "worker-sms") — not the monorepo name.
   */
  serviceName: string;
  /**
   * OTLP HTTP collector base URL (no `/v1/traces` suffix). Defaults to
   * `OTEL_EXPORTER_OTLP_ENDPOINT`, then to the Jaeger instance in
   * `infra/docker-compose.yml`.
   */
  otlpEndpoint?: string;
}

/**
 * Starts the OpenTelemetry Node SDK for one composition root: traces only
 * (no metrics/logs pipeline yet — see docs/roadmap.md's reliability-polish
 * items for Prometheus metrics, which stay a separate concern). Call this
 * once, at the very top of a `services/*` entrypoint, before importing
 * anything that should be auto-instrumented (Kafka client, pg, Redis,
 * HTTP) — auto-instrumentation patches modules at `require`/`import` time.
 *
 * Registers a SIGTERM/SIGINT shutdown hook so buffered spans flush on
 * container stop rather than being dropped.
 */
export function startTracing(options: StartTracingOptions): NodeSDK {
  if (process.env.OTEL_DIAG_LOG === "1") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  const endpoint =
    options.otlpEndpoint ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    "http://localhost:4318";

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: options.serviceName,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/+$/, "")}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  const shutdown = () => {
    sdk
      .shutdown()
      .catch((err: unknown) => {
        console.error("Error shutting down OpenTelemetry SDK", err);
      })
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return sdk;
}
