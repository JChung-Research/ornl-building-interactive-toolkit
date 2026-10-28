// Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import { RouteType } from "routes/types";
import { lazy } from "react";

const Element = lazy(() => import("./index"));

const route: RouteType = {
  id: 2000,
  parentId: 0,
  name: "About",
  label: "About",
  path: "About",
  element: Element,
  footer: true,
  user: false,
  admin: false,
  hidden: false,
};

export default route;
