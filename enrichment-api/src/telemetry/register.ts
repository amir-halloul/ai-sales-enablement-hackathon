// Loaded with `node --import ./dist/telemetry/register.js` so instrumentation is in place before Nest loads.
import { startTelemetry } from './telemetry.js';

startTelemetry();
