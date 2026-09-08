import type { ConnectorHubEvent } from "./protocol";
import type { DevelopmentConnectorTicketStore } from "./tickets";
import type { EnvironmentConnectorHub } from "./hub";

interface SharedBindings {
  ASSETS: Fetcher;
  ENVIRONMENT_CONNECTOR_HUB: DurableObjectNamespace<EnvironmentConnectorHub>;
  CONNECTOR_TICKET_AUDIENCE: string;

  // Local-development secrets only. They are intentionally absent from the
  // staging and production configurations, which use private Worker bindings.
  ROUTER_SHARED_SECRET?: string;
  DEV_TICKET_ISSUER_SECRET?: string;

  // Optional integration bindings. The hub works without them only for local
  // protocol development; production readiness requires a durable event sink.
  CONNECTOR_EVENTS?: Queue<ConnectorHubEvent>;
  BACKGROUND_TASKS?: Queue<import("./background").CloudBackgroundTask>;
  BACKGROUND_QUARANTINE?: Queue<import("./background").CloudBackgroundQuarantineEnvelope>;
  CONNECTOR_EVENT_SINK?: Fetcher;
  MEDIA_BUCKET?: R2Bucket;
  CONVEX_HTTP_BASE_URL?: string;
  TELEMETRY?: AnalyticsEngineDataset;
  TELEMETRY_SUCCESS_SAMPLE_RATE?: string;
}

export interface LocalRuntimeBindings extends SharedBindings {
  DEPLOYMENT_ENVIRONMENT: "local";
  CONNECTOR_AUTH_MODE: "dev-do";
  DEV_CONNECTOR_TICKETS: DurableObjectNamespace<DevelopmentConnectorTicketStore>;
  CONTROL_PLANE?: never;
}

export interface ManagedRuntimeBindings extends SharedBindings {
  DEPLOYMENT_ENVIRONMENT: "staging" | "production";
  CONNECTOR_AUTH_MODE: "control-plane";
  // The private service owns atomic ticket consumption in managed environments.
  CONTROL_PLANE: Fetcher;
  // This prevents managed code from accidentally depending on the local-only
  // issuer even if a stale generated binding type is present.
  DEV_CONNECTOR_TICKETS?: never;
}

export type RuntimeBindings = LocalRuntimeBindings | ManagedRuntimeBindings;

export type CloudflareBindings = RuntimeBindings;
