// Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import About from "./About";
import RouteBase from "routes/RouteBase";

const Root = (props: any) => <RouteBase {...props} renderRoute={(p) => <About {...p} />} />;

export default Root;
