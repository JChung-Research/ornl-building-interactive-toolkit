# Copyright 2026 UT-Battelle, LLC
# SPDX-License-Identifier: Apache-2.0

# Match the app's documented Node version
FROM node:16.13.2-bullseye

WORKDIR /client
RUN corepack enable

# Copy your already-installed client AS-IS (incl. node_modules, env files, etc.)
COPY package.json yarn.lock ./
COPY .yarnrc.yml* ./

RUN yarn --version && (yarn install --immutable || yarn install)
COPY . .
# CRA respects HOST/PORT
ENV HOST=0.0.0.0
ENV PORT=2000

EXPOSE 2000

# Run the client
CMD ["yarn", "start"]
