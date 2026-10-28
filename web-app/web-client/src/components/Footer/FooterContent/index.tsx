// Modifications Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import "./style.scss";

import { RouteProps } from "routes";
import moment from "moment";

export default function FooterContent(props: RouteProps) {
  return (
    <div className="footer-background">
      <div className="footer-content">
        <div className="footer-left">
          <div>
            Developed by <strong>Dr. Jihoon Chung</strong>, led by <strong>Dr. Jamie Lian</strong> from <strong><a href="https://www.ornl.gov/content/controlsbuildings-grid" target="_blank">ORNL Grid Interactive Controls Group</a></strong>.<br />
          </div>
        </div>
        <div className="footer-right">
          <div>Last update: {moment(process.env.REACT_APP_DATE).format("MMMM YYYY")}</div>
        </div>
      </div>
    </div>
  );
}
