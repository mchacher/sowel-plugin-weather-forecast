/**
 * Sowel Plugin — Weather Forecast
 *
 * Provides a daily forecast via the Open-Meteo API (free, no API key required).
 *
 * Since v2.0 (spec 159) the deterministic call carries a superset of models and
 * each daily value is resolved from the best model available for that day, while
 * a second call to the ensemble endpoint yields a genuine rain probability and a
 * per-day confidence. The 25 historical `jN_*` aliases are unchanged.
 */

import { CANDIDATE_MODELS, ENSEMBLE_MODEL } from "./models.js";
import { DEFAULT_THRESHOLDS, type ConfidenceThresholds } from "./confidence.js";
import { CONFIDENCE_DAYS, FORECAST_DAYS, buildForecastPayload } from "./payload.js";
import {
  DEFAULT_POLL_INTERVAL_MIN,
  parseModelsSetting,
  parsePollingInterval,
  parseThresholds,
} from "./settings.js";
import {
  IMPLICIT_MODEL,
  buildDailyUrl,
  buildEnsembleUrl,
  buildHourlyUrl,
  buildHistoryUrl,
  daylightOnly,
  parseHourly,
  type HourlyPoint,
  parseDaily,
  parseEnsembleDaily,
  parseJsonLenient,
  type DailyResponse,
  type EnsembleResponse,
} from "./open-meteo.js";

// ============================================================
// Local type definitions (no imports from Sowel source)
// ============================================================

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
}

interface EventBus {
  emit(event: unknown): void;
}

interface SettingsManager {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

interface DiscoveredDevice {
  ieeeAddress?: string;
  friendlyName: string;
  manufacturer?: string;
  model?: string;
  data: {
    key: string;
    type: string;
    category: string;
    unit?: string;
  }[];
  orders: {
    key: string;
    type: string;
    dispatchConfig?: Record<string, unknown>;
    min?: number;
    max?: number;
    enumValues?: string[];
    unit?: string;
  }[];
}

interface DeviceManager {
  upsertFromDiscovery(
    integrationId: string,
    source: string,
    discovered: DiscoveredDevice,
  ): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
  ): void;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
  manufacturer?: string;
  model?: string;
}

interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(
    device: Device,
    orderKeyOrDispatchConfig: string | Record<string, unknown>,
    value: unknown,
  ): Promise<void>;
  refresh?(): Promise<void>;
  getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

// ============================================================
// Constants
// ============================================================

const PLUGIN_ID = "weather-forecast";
const SETTINGS_PREFIX = `integration.${PLUGIN_ID}.`;
const REQUEST_TIMEOUT_MS = 30_000;
const SOURCE_DEVICE_ID = "Weather Forecast"; // Must match friendlyName for updateDeviceData lookup
const IRRADIANCE_KEY = "irradiance_120h";

/**
 * The past irradiance a PV model can be fitted on straight away (spec 161).
 *
 * A separate point from the forward series, refreshed once a day rather than on
 * every poll: 45 days of daylight hours is about 630 entries, and republishing
 * that twice an hour alongside its `previous` value would put a quarter of a
 * megabyte on the wire for data that changes when a day rolls over.
 */
const IRRADIANCE_HISTORY_KEY = "irradiance_history";

/** Days of history published. Matches the core's rolling fit window. */
const HISTORY_DAYS = 45;

/** How often the history is refreshed. */
const HISTORY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Calendar days of hourly irradiance published.
 *
 * Six, not five: Open-Meteo counts from today 00:00 local, so `forecast_days=5`
 * ends at the close of J+4. Reaching the end of J+5, which is what the consumer
 * asks for, takes six.
 */
const IRRADIANCE_DAYS = 6;

// ============================================================
// Discovered device definition (static)
// ============================================================

function buildForecastDataDefs(): DiscoveredDevice["data"] {
  const data: DiscoveredDevice["data"] = [];
  for (let i = 1; i <= FORECAST_DAYS; i++) {
    data.push(
      { key: `j${i}_condition`, type: "enum", category: "weather_condition" },
      { key: `j${i}_temp_min`, type: "number", category: "temperature_outdoor", unit: "°C" },
      { key: `j${i}_temp_max`, type: "number", category: "temperature_outdoor", unit: "°C" },
      { key: `j${i}_rain_prob`, type: "number", category: "rain", unit: "%" },
      { key: `j${i}_wind_gusts`, type: "number", category: "wind", unit: "km/h" },
    );
  }
  for (let i = 1; i <= CONFIDENCE_DAYS; i++) {
    data.push(
      {
        key: `j${i}_temp_max_spread`,
        type: "number",
        category: "temperature_outdoor",
        unit: "°C",
      },
      // `generic`, not a weather category: this is metadata about the forecast,
      // and it must not be aggregated by zones or historised as a measurement.
      { key: `j${i}_confidence`, type: "enum", category: "generic" },
    );
  }
  data.push({ key: "model_used", type: "text", category: "generic" });
  // Spec 160 — hourly irradiance for the PV production forecast. One `json`
  // point rather than 360 flat bindings: it is a computation input, not
  // something a household reads off a card.
  // `generic`, not `solar_radiation`: that category's contract expects a number
  // (`CATEGORY_EXPECTED_TYPE` in the core), so declaring a json series under it
  // logs a contract warning at every discovery and offers the series as a
  // binding candidate — the very friction this series exists to avoid.
  data.push({ key: IRRADIANCE_KEY, type: "json", category: "generic" });
  // Spec 161 — the same shape, over the past instead of the future.
  data.push({ key: IRRADIANCE_HISTORY_KEY, type: "json", category: "generic" });
  return data;
}

const WEATHER_DISCOVERED_DEVICE: DiscoveredDevice = {
  friendlyName: "Weather Forecast",
  manufacturer: "Open-Meteo",
  model: "Forecast API",
  data: buildForecastDataDefs(),
  orders: [],
};

// ============================================================
// Plugin implementation
// ============================================================

class WeatherForecastPlugin implements IntegrationPlugin {
  readonly id = PLUGIN_ID;
  readonly name = "Weather Forecast";
  readonly description = "Weather forecast via Open-Meteo API";
  readonly icon = "CloudSun";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;

  // Polling state
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt: string | null = null;
  /** When the 45-day history was last published, so it is refreshed daily. */
  private lastHistoryAt = 0;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MIN * 60 * 1000;

  // Resolution state (spec 159)
  private models: readonly string[] = CANDIDATE_MODELS;
  private thresholds: ConfidenceThresholds = DEFAULT_THRESHOLDS;

  // Connection state
  private status: IntegrationStatus = "disconnected";
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;

  constructor(deps: PluginDeps) {
    this.logger = deps.logger.child({ module: PLUGIN_ID });
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
  }

  // ============================================================
  // IntegrationPlugin interface
  // ============================================================

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    return this.status;
  }

  isConfigured(): boolean {
    return (
      !!this.settingsManager.get("home.latitude") &&
      !!this.settingsManager.get("home.longitude")
    );
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      {
        key: "polling_interval",
        label: "Polling interval (minutes)",
        type: "number",
        required: false,
        defaultValue: "30",
        placeholder: "Min 15, default 30",
      },
      {
        key: "models",
        label: "Weather models",
        type: "text",
        required: false,
        placeholder: "Empty = automatic. Use best_match for the pre-2.0 behaviour",
      },
      {
        key: "confidence_high_max",
        label: "High confidence below (°C of spread)",
        type: "number",
        required: false,
        defaultValue: "2",
        placeholder: "Default 2",
      },
      {
        key: "confidence_medium_max",
        label: "Medium confidence below (°C of spread)",
        type: "number",
        required: false,
        defaultValue: "5",
        placeholder: "Default 5",
      },
    ];
  }

  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    return { lastPollAt: this.lastPollAt ?? "", intervalMs: this.pollIntervalMs };
  }

  async start(options?: { pollOffset?: number }): Promise<void> {
    // Clean up previous state
    this.stopTimers();

    if (!this.isConfigured()) {
      this.status = "not_configured";
      this.logger.warn("Home latitude/longitude not configured — plugin cannot start");
      return;
    }

    // Read polling interval from settings
    const pollingIntervalMin = parsePollingInterval(
      this.settingsManager.get(`${SETTINGS_PREFIX}polling_interval`),
    );
    this.pollIntervalMs = pollingIntervalMin * 60 * 1000;
    this.models = this.readModelsSetting();
    this.thresholds = this.readThresholds();

    try {
      // Initial poll
      await this.poll();

      // Schedule periodic polling
      const offset = options?.pollOffset ?? 0;
      this.schedulePoll(offset);

      this.status = "connected";
      this.retryCount = 0;
      this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
      this.logger.info(
        { pollIntervalMs: this.pollIntervalMs },
        "Weather Forecast integration started",
      );
    } catch (err) {
      this.status = "error";
      this.logger.error({ err }, "Failed to start Weather Forecast integration");
      this.scheduleRetry();
    }
  }

  async stop(): Promise<void> {
    this.cancelRetry();
    this.stopTimers();
    this.status = "disconnected";
    this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
    this.logger.info("Weather Forecast integration stopped");
  }

  async executeOrder(
    _device: Device,
    _orderKey: string,
    _value: unknown,
  ): Promise<void> {
    throw new Error("Weather Forecast plugin does not support orders");
  }

  async refresh(): Promise<void> {
    await this.poll();
    this.logger.info("Weather Forecast manual refresh completed");
  }

  // ============================================================
  // Settings parsing
  // ============================================================

  private readModelsSetting(): readonly string[] {
    const { models, unknown } = parseModelsSetting(
      this.settingsManager.get(`${SETTINGS_PREFIX}models`),
    );
    if (unknown.length > 0) {
      this.logger.warn(
        { unknown, kept: models.length },
        "Unknown model ids in the `models` setting, ignored",
      );
    }
    return models;
  }

  private readThresholds(): ConfidenceThresholds {
    return parseThresholds(
      this.settingsManager.get(`${SETTINGS_PREFIX}confidence_high_max`),
      this.settingsManager.get(`${SETTINGS_PREFIX}confidence_medium_max`),
    );
  }

  // ============================================================
  // Polling
  // ============================================================

  private async poll(): Promise<void> {
    const lat = this.settingsManager.get("home.latitude");
    const lon = this.settingsManager.get("home.longitude");

    if (!lat || !lon) {
      throw new Error("Home latitude/longitude not available");
    }

    try {
      const daily = await this.fetchDaily(lat, lon);
      // A failed ensemble degrades the forecast, it never fails the poll.
      const ensemble = await this.fetchEnsembleSafely(lat, lon);

      this.deviceManager.upsertFromDiscovery(PLUGIN_ID, SOURCE_DEVICE_ID, WEATHER_DISCOVERED_DEVICE);

      const payload: Record<string, unknown> = buildForecastPayload(
        daily,
        ensemble,
        this.thresholds,
      );

      // The irradiance series is an enrichment like the ensemble: its absence
      // costs the PV forecast downstream, never this poll.
      const irradiance = await this.fetchHourlySafely(lat, lon);
      if (irradiance) {
        payload[IRRADIANCE_KEY] = {
          issuedAt: new Date().toISOString(),
          model: this.models.length === 1 ? this.models[0] : IMPLICIT_MODEL,
          hours: irradiance,
        };
      }

      // Spec 161 — the past series, at most once a day. Its absence costs a
      // household the ability to fit a model straight away, never this poll.
      if (Date.now() - this.lastHistoryAt >= HISTORY_INTERVAL_MS) {
        const history = await this.fetchHistorySafely(lat, lon);
        if (history) {
          payload[IRRADIANCE_HISTORY_KEY] = {
            issuedAt: new Date().toISOString(),
            model: this.models.length === 1 ? this.models[0] : IMPLICIT_MODEL,
            hours: history,
          };
          this.lastHistoryAt = Date.now();
        }
      }

      this.deviceManager.updateDeviceData(PLUGIN_ID, SOURCE_DEVICE_ID, payload);

      this.lastPollAt = new Date().toISOString();
      this.logger.info(
        {
          models: Object.keys(daily.byModel).length,
          modelUsed: payload.model_used,
          ensemble: ensemble !== null,
          j1Condition: payload.j1_condition,
          j1TempMin: payload.j1_temp_min,
          j1TempMax: payload.j1_temp_max,
          j1RainProb: payload.j1_rain_prob,
          j1Confidence: payload.j1_confidence,
          irradianceHours: irradiance?.length ?? 0,
        },
        "Weather Forecast poll complete",
      );
    } catch (err) {
      this.logger.error({ err }, "Weather Forecast poll failed");
      throw err;
    }
  }

  // ============================================================
  // Open-Meteo API
  // ============================================================

  private async fetchJson(url: string): Promise<unknown> {
    const res = await this.fetchWithTimeout(url, { method: "GET" });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Open-Meteo request failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return parseJsonLenient(body);
  }

  /**
   * The multi-model call, with one retry on `best_match`.
   *
   * Open-Meteo rejects the *whole* request when a single model id is unknown, so
   * a stale candidate list or a bad `models` setting would otherwise take the
   * forecast down entirely. The retry keeps the plugin on the pre-2.0 behaviour
   * instead.
   */
  private async fetchDaily(lat: string, lon: string): Promise<DailyResponse> {
    const days = FORECAST_DAYS + 1; // index 0 is today
    try {
      return parseDaily(await this.fetchJson(buildDailyUrl(lat, lon, this.models, days)));
    } catch (err) {
      if (this.models.length === 0) throw err;
      this.logger.warn(
        { err, models: this.models.length },
        "Multi-model forecast request failed, falling back to best_match",
      );
      return parseDaily(await this.fetchJson(buildDailyUrl(lat, lon, [], days)));
    }
  }

  /**
   * Never throws: the series feeds a downstream consumer (spec 160), it is not
   * needed by anything this plugin publishes itself.
   *
   * Single model on purpose, and `best_match` by default: a consumer projecting
   * the beam onto a tilted plane needs one coherent series. Spec 160 measured
   * that the irradiance forecast is not the accuracy bottleneck anyway.
   */
  private async fetchHourlySafely(lat: string, lon: string): Promise<HourlyPoint[] | null> {
    try {
      const model = this.models.length === 1 ? this.models[0] : "";
      const url = buildHourlyUrl(lat, lon, model, IRRADIANCE_DAYS);
      const hours = parseHourly(await this.fetchJson(url));
      return hours.length > 0 ? hours : null;
    } catch (err) {
      this.logger.warn(
        { err },
        "Hourly irradiance request failed, forecast continues without the series",
      );
      return null;
    }
  }

  /**
   * The past 45 days of daylight irradiance (spec 161).
   *
   * Never throws, for the same reason as its forward twin: a household that
   * cannot reach Open-Meteo for the history still gets today's forecast.
   */
  private async fetchHistorySafely(lat: string, lon: string): Promise<HourlyPoint[] | null> {
    try {
      const model = this.models.length === 1 ? this.models[0] : "";
      const url = buildHistoryUrl(lat, lon, model, HISTORY_DAYS);
      const hours = daylightOnly(parseHourly(await this.fetchJson(url)));
      return hours.length > 0 ? hours : null;
    } catch (err) {
      this.logger.warn(
        { err },
        "Irradiance history request failed, the forecast is unaffected",
      );
      return null;
    }
  }

  /** Never throws: the ensemble is an enrichment, not a dependency. */
  private async fetchEnsembleSafely(
    lat: string,
    lon: string,
  ): Promise<EnsembleResponse | null> {
    try {
      const url = buildEnsembleUrl(lat, lon, ENSEMBLE_MODEL, FORECAST_DAYS + 1);
      return parseEnsembleDaily(await this.fetchJson(url));
    } catch (err) {
      this.logger.warn(
        { err, model: ENSEMBLE_MODEL },
        "Ensemble request failed, forecast continues without rain probability or confidence",
      );
      return null;
    }
  }

  // ============================================================
  // Scheduling
  // ============================================================

  private schedulePoll(offsetMs: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);

    const delay = offsetMs > 0 ? offsetMs : this.pollIntervalMs;
    this.pollTimer = setTimeout(async () => {
      try {
        await this.poll();
      } catch (_err) {
        // Error already logged in poll()
      }
      // Schedule next poll regardless of success/failure
      this.schedulePoll(0);
    }, delay);
  }

  // ============================================================
  // Retry logic
  // ============================================================

  private scheduleRetry(): void {
    this.cancelRetry();
    this.retryCount++;
    const delaySec = Math.min(30 * Math.pow(2, this.retryCount - 1), 600);
    this.logger.warn({ retryCount: this.retryCount, delaySec }, "Scheduling automatic retry");
    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      this.start().catch((err) => this.logger.error({ err }, "Retry start failed"));
    }, delaySec * 1000);
  }

  private cancelRetry(): void {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private stopTimers(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============================================================
// Plugin factory (exported for Sowel plugin loader)
// ============================================================

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new WeatherForecastPlugin(deps);
}
