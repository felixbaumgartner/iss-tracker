# ISS Tracker

A single-page live tracker for the International Space Station (NORAD 25544).

Polls the [wheretheiss.at](https://wheretheiss.at) API every 3 seconds and renders the ISS position on a dark Leaflet map, with a trailing breadcrumb of the last ~6 minutes of orbit. A telemetry panel shows latitude, longitude, altitude, velocity, sunlight status, and last update time.

## Run

Open `index.html` in any modern browser — no build step, no dependencies to install. Leaflet and tiles are loaded from CDN.

## Stack

- Leaflet 1.9.4 for the map
- CARTO dark basemap tiles
- `api.wheretheiss.at/v1/satellites/25544` for position data
