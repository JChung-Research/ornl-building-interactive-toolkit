// Modifications Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import { RouteType } from "routes/types";
import { lazy } from "react";

const Element = lazy(() => import("./index"));

const route: RouteType = {
  id: 8000,
  parentId: 0,
  name: "Log",
  label: "Log",
  path: "log",
  element: Element,
  footer: false,
  user: true,
  admin: true,
  hidden: true,
};

export default route;
