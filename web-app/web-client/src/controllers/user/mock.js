// Modifications Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import { SERVICE_ENDPOINT_LOGIN, SERVICE_ENDPOINT_READ_USER, SERVICE_ENDPOINT_UPDATE_USER } from "./api";

const mock = {
  [SERVICE_ENDPOINT_LOGIN]: {
    payload: {
      email: "demo@example.com",
      password: "password",
    },
    result: { email: "demo@example.com", password: "password" },
  },
  [SERVICE_ENDPOINT_READ_USER]: {
    payload: null,
    result: {
      id: 1,
      email: "demo@example.com",
      scope: "user",
      preferences: {},
      bldgAccess: {},
      readOnly: true,
    },
  },
  [SERVICE_ENDPOINT_UPDATE_USER]: {
    payload: {
      email: "demo@example.com",
      password: "password",
      preferences: {},
      bldgAccess: {},
      readOnly: true,
    },
    result: {
      id: 1,
      email: "demo@example.com",
      scope: "user",
      preferences: {},
      bldgAccess: {},
      readOnly: true,
    },
  },
};

export default mock;
