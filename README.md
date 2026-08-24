# Sowel Plugin: Weather Forecast

Daily weather forecast for [Sowel](https://github.com/mchacher/sowel), from the
[Open-Meteo](https://open-meteo.com/) API. Free, no API key required. Latitude
and longitude come from Sowel's home settings, so there is nothing to configure
to get started.

## What it does

Every poll, the plugin asks Open-Meteo for a **superset of weather models** and
keeps whichever ones actually cover the home. Models that do not are simply
absent from the response, so a French household ends up on AROME, a German one
on ICON-D2 and an American one on HRRR, with no geography configured anywhere.

Each daily value is then resolved from the models that answered:

| Horizon | Rule |
|---|---|
| J+1 | the median of the models within 1.5x of the finest grid available |
| J+2 and beyond | the median of every available model |

A median absorbs an outlier where a single pick would follow it. Measured on one
J+3: ARPEGE said 34.1 °C, ICON-EU 29.5 °C, the median 33.1 °C.

At J+1 the median runs over a class rather than over everything: a 7 km model has
no business next to a 2 km one. Where several models are comparably fine none is
elected, because nothing says a foreign 2 km grid beats the national 2.5 km one.
Where one model is alone in its class it is named directly.

A second call to Open-Meteo's **ensemble** endpoint adds two things no single
deterministic run can give:

- a genuine rain probability, counted over 51 members, rather than a model-side
  heuristic. It is also the only source that survives once Meteo-France models
  are in the set: they carry no `precipitation_probability_max` at all;
- a per-day **confidence**, from the wider of the inter-model disagreement and
  the ensemble band. The wider of the two on purpose: claiming more confidence
  than the most pessimistic available measure is the failure mode that hurts,
  because a recipe acts on it.

## Data Provided

Creates a single "Weather Forecast" device with 36 data points.

| Data | Type | Unit | Description |
|---|---|---|---|
| `j1_condition` … `j5_condition` | enum | — | sunny, partly_cloudy, cloudy, foggy, rainy, snowy, stormy |
| `j1_temp_min` … `j5_temp_min` | number | °C | Daily minimum |
| `j1_temp_max` … `j5_temp_max` | number | °C | Daily maximum |
| `j1_rain_prob` … `j5_rain_prob` | number | % | Share of ensemble members reaching 0.5 mm |
| `j1_wind_gusts` … `j5_wind_gusts` | number | km/h | Daily maximum gust |
| `j1_temp_max_spread` … `j5_temp_max_spread` | number | °C | Full width of the uncertainty band |
| `j1_confidence` … `j5_confidence` | enum | — | high, medium, low |
| `model_used` | text | — | The model that fed J+1, or `median(n)` |

`jN` is the horizon in days: `j1` is tomorrow, `j5` is in five days. Confidence
is published for every day. It is not monotonic with the horizon: measured on
one run, J+4 came out `low` on an 8.5 °C band while J+5 was `medium` on 3.5 °C,
so the far days carry real information rather than a foregone verdict.

The five original metrics keep the key, type, category and unit they had in
1.0.0, so upgrading changes what is behind the numbers, never the bindings.

## Installation

Install from the Sowel plugin store (Administration > Plugins).

## Configuration

| Setting | Default | What it does |
|---|---|---|
| Latitude / Longitude | — | Read automatically from Sowel home settings (`Administration > Home`) |
| Polling interval | 30 min | Minimum 15 |
| Weather models | empty | Empty or `auto` uses the automatic selection. `best_match` restores the pre-2.0 source for the deterministic values. A comma-separated list of Open-Meteo model ids forces a set; unknown ids are dropped with a warning rather than failing the request |
| High confidence below | 2 °C | Spread at or below which confidence reads `high` |
| Medium confidence below | 5 °C | Spread at or below which it reads `medium`, above which `low` |

## Degradation

Nothing here takes the forecast down:

- the ensemble endpoint failing costs the confidence and moves the rain
  probability back to a deterministic model, the poll still succeeds;
- the multi-model call failing retries once with `best_match`;
- a model that has no value for a day drops out of the set for that day only;
- fewer than two sources means no confidence is published, rather than a
  fabricated `high`.

## Development

```bash
npm install
npm run build       # tsc to dist/
npm test            # vitest
npm run typecheck   # tsc over the sources and the tests
```

Tests run against payloads captured from the live API, including a New York one
where the European regional models drop out on their own.

Design and measurements: `specs/159-weather-forecast-multi-model/` in the Sowel
repository.

## Attribution

Weather data provided by [Open-Meteo](https://open-meteo.com/) — free weather API for non-commercial use.

## License

AGPL-3.0
