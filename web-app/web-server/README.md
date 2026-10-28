# ORBIT — Web Server

The backend of the ORBIT [web application](../README.md): a Next.js app with a Prisma
+ Postgres data layer and a GraphQL (Apollo/Pothos) API, plus authentication. See the [root README](../../README.md) for the overall architecture.

## Commands

Uses the `yarn` package manager (`corepack enable` if you don't have it).

```bash
# source: install / compile / lint / test
yarn install
yarn compile
yarn lint
yarn test

# database (Prisma)
yarn migrate:create      # create a new migration
yarn migrate:deploy      # apply migrations
yarn migrate:reset       # reset the database

# run
yarn dev                 # development server
yarn build && yarn start # production
```

## Environment

Default variables live in `.env`; override locally in `.env.local` (untracked). Node environment-specific overrides go in `.env.development`, `.env.test`, `.env.production`. Only variables that differ from the defaults need to be set.

## Development

- **Backend** uses Prisma — edit `schema.prisma`, then create a migration.
- Built on [Next.js](https://nextjs.org/) (bootstrapped from `create-next-app`).

## Provenance

Derived from PNNL's `volttron-pnnl-aems` (`app/`), Apache-2.0, © Battelle Memorial Institute, extended at ORNL. See the root [`NOTICE`](../../NOTICE) and [`LICENSE`](../../LICENSE).
