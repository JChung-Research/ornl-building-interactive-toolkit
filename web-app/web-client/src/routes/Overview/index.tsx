// Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import Overview from "./Overview";
import RouteBase from "routes/RouteBase";

const Root = (props: any) => <RouteBase {...props} renderRoute={(p) => <Overview {...p} />} />;

export default Root;
