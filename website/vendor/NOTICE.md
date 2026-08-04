# Third-party browser assets

This directory contains browser assets vendored so the release page can render without a third-party CDN.

## Apache ECharts

- Project: https://github.com/apache/echarts
- File: `echarts.min.js`
- License: Apache License 2.0

The minified file retains its upstream license header.

## World map geometry

- File: `worldgeo.js`
- Source dataset: Natural Earth world boundaries, distributed through the Apache ECharts map examples
- Natural Earth data: public domain, https://www.naturalearthdata.com/about/terms-of-use/

OPC Studio uses the geometry only to render country-level aggregate Stargazer counts. The published snapshot does not contain GitHub usernames, raw profile locations, company names, biographies, or IP addresses.
