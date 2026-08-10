import {NodeSDK} from "@opentelemetry/sdk-node";import {resourceFromAttributes} from "@opentelemetry/resources";import {OTLPTraceExporter} from "@opentelemetry/exporter-trace-otlp-http";import {OTLPMetricExporter} from "@opentelemetry/exporter-metrics-otlp-http";import {PeriodicExportingMetricReader} from "@opentelemetry/sdk-metrics";import {OTLPLogExporter} from "@opentelemetry/exporter-logs-otlp-http";import {BatchLogRecordProcessor} from "@opentelemetry/sdk-logs";
let sdk:NodeSDK|undefined;
export const validateCollectorEndpoint=(raw:string)=>{const url=new URL(raw);const host=url.hostname.toLowerCase();if(!["localhost","127.0.0.1","::1","otel-collector"].includes(host))throw new Error("Slice 1G permits only a local/private OpenTelemetry collector endpoint");return url.toString().replace(/\/$/,"");};
/* An unset endpoint means "no collector is running", not "assume localhost".
   Exporting to a loopback address nothing listens on retries on every batch and
   metric interval, so the previous default turned observability-on into a
   steady stream of connection failures wherever a collector was not deployed —
   including ECS, which runs no collector sidecar. Structured logging does not
   depend on this: safeLog writes its JSON line to stdout before it ever reaches
   the OTel logger, which is what the CloudWatch log driver collects. */
export const collectorEndpoint=()=>{const raw=process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();return raw?validateCollectorEndpoint(raw):undefined;};
export const initializeObservability=()=>{if(process.env.OBSERVABILITY_ENABLED!=="true"||sdk)return;const base=collectorEndpoint();if(!base)return;sdk=new NodeSDK({autoDetectResources:false,resourceDetectors:[],resource:resourceFromAttributes({"service.name":process.env.OTEL_SERVICE_NAME||"rfpilot-backend","deployment.environment.name":process.env.NODE_ENV||"development","service.version":process.env.APP_VERSION||"unknown"}),traceExporter:new OTLPTraceExporter({url:`${base}/v1/traces`}),metricReaders:[new PeriodicExportingMetricReader({exporter:new OTLPMetricExporter({url:`${base}/v1/metrics`}),exportIntervalMillis:Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS||10000)})],logRecordProcessors:[new BatchLogRecordProcessor({exporter:new OTLPLogExporter({url:`${base}/v1/logs`})})],instrumentations:[]});sdk.start();};
export const shutdownObservability=async()=>{if(sdk)await sdk.shutdown();sdk=undefined;};
initializeObservability();
