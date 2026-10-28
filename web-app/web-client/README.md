# ORBIT — Web Client

The React operator UI of the ORBIT [web application](../README.md) — dashboards, building-unit overview, and time-series visualization. See the [root README](../../README.md) for the overall architecture and the [web-app README](../README.md) for the UI feature tour.

## Commands

```bash
yarn install     # install / update dependencies (re-run if it fails once)
yarn start       # run the dev server
yarn test        # interactive test runner
yarn coverage    # tests + coverage
yarn build       # production build → build/
```

## Configuration

Client config lives in `.env.production`; override locally in a `*.local` file (only
set what differs from the base). Key variables:

- `REACT_APP_TITLE` / `REACT_APP_DESCRIPTION` — application title / description
- `REACT_APP_API_URL` — relative path of the server API
- `REACT_APP_MOCK` — use mock data for API calls (`true`/`false`)
- `REACT_APP_POLLING` / `REACT_APP_DEBOUNCE` — poll interval / debounce wait (ms)
- `REACT_APP_NOTICE` — display the U.S. Government notice (`true`/`false`)
- `REACT_APP_LOGIN` — enable login / server authentication (`true`/`false`)

If the client is not served from a base URL, set the `homepage` field in
`package.json` accordingly.

## Provenance

Forked and extended from PNNL's `volttron-pnnl-aems` client (`client/`), Apache-2.0, © Battelle Memorial Institute, with substantial ORNL additions. See the root [`NOTICE`](../../NOTICE) and [`LICENSE`](../../LICENSE).
