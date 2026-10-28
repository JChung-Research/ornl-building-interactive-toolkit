// Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import "./style.scss";

import Custom from "../../components/Custom";
import { Header } from "components";
import React from "react";
import { RootProps } from "routes";

export default class About extends React.Component<RootProps, any> {
  render() {
    return (
      <div className={"about"}>
        <Header {...this.props} />
        <Custom url="/about.html" />
      </div>
    );
  }
}