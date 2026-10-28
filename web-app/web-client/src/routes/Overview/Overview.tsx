// Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import "./style.scss";

import { Alert, Button, Card, Collapse, InputGroup, TextArea, Intent, Label, Position, Tree, Menu, MenuItem, Tabs, Tab, Tag, Classes, Icon, HTMLSelect, Switch } from "@blueprintjs/core";
import { Header, Prompt } from "components";
import {
  IConfiguration,
  createConfiguration,
  deleteConfiguration,
  readConfigurations,
  readConfigurationsPoll,
  selectReadConfigurations,
  updateConfiguration,
} from "controllers/configurations/action";
import {
  IFilter,
  IUnit,
  filterUnits,
  readUnits,
  readUnit,
  readUnitsPoll,
  selectFilterUnits,
  selectReadUnits,
  updateUnit
} from "controllers/units/action";
import { IconName, IconNames } from "@blueprintjs/icons";
import { cloneDeep, get, isEqualWith, isNil, isObject, merge, set } from "lodash";

import { Configuration } from "./Configuration";
import { Holidays } from "./Holidays";
import { Occupancies } from "./Occupancies";
import React from "react";
import { RootProps } from "routes";
import { Schedules } from "./Schedules";
import { Setpoints } from "./Setpoints";
import { HolidayType, RoleType, StageType } from "common";
import { Popover2, Tooltip2, Placement } from "@blueprintjs/popover2";
import { connect } from "react-redux";
import { createConfigurationDefault } from "utils/configuration";
import { defaultPollInterval } from "controllers/poll/action";
import { isSetpointValid } from "utils/setpoint";
import { DeepPartial } from "../../utils/types";
import { ISetpoint, updateSetpoint } from "controllers/setpoints/action";
import { getCommon } from "utils/util";
import { Holiday } from "./Holiday";
import Plot from 'react-plotly.js';

import { useLocation } from "react-router-dom";

import { readSensors } from "controllers/units/api";
import { campuses, type Campus, type CampusId, type Room } from "common/campuses";

const BLDG_CHART_OFFSET = 100;
const CMPR_CHART_OFFSET = 10000;

function withLocation(Component: any) {
  return function WrappedComponent(props: any) {
    const location = useLocation();
    return <Component {...props} location={location} />;
  };
}

const HelpIcon = ({ text, placement }: { text: string; placement?: Placement }) => (
  <Tooltip2
    content={
      <span style={{ maxWidth: 280, display: "block", lineHeight: 1.45 }}>
        {text}
      </span>
    }
    placement={placement ?? "top"}
    hoverOpenDelay={120}
    hoverCloseDelay={80}
  >
    <span className="help-icon-trigger">?</span>
  </Tooltip2>
);


function convertChartConfigs(input: Record<string, any>) {
  return Object.entries(input).map(([_, config], id) => {
    const type = config.chartConfigType as string;
    const selectedVariables = Object.values(config.chartSelectVars) as string[];

    let vizSettings;
    if (type === "line") {
      vizSettings = Object.values(config.chartVizSetting);
    } else if (type === "scatter") {
      vizSettings = config.chartVizSetting;
    } else if (type === "box") {
      vizSettings = config.chartVizSetting;
    }

    return {
      id,
      type,
      selectedVariables,
      vizSettings
    };
  });
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// UTC string for server / persisted chart ranges
const fmt = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;

// Local browser string for display only
const fmtLocal = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

// Local browser value for <input type="datetime-local">
const fmtLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// Wall-clock parts of an absolute instant in a given IANA timezone.
// Uses Intl.formatToParts (not new Date(localizedString)) to avoid fragile
// re-parsing of localized strings, which breaks for some zones/engines.
const tzParts = (d: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour"); // some engines emit "24" at midnight
  return { y: get("year"), mo: get("month"), d: get("day"), h: hour, mi: get("minute"), s: get("second") };
};

// Absolute instant -> "YYYY-MM-DD HH:MM:SS" in the given timezone (chart display)
const fmtTZ = (d: Date, timeZone: string) => {
  const p = tzParts(d, timeZone);
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}:${p.s}`;
};

// Absolute instant -> "YYYY-MM-DDTHH:MM" in the given timezone (datetime-local input)
const fmtTZInput = (d: Date, timeZone: string) => {
  const p = tzParts(d, timeZone);
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}`;
};

// Absolute server timestamps are treated as UTC
const parseAbs = (s: string) => new Date(`${s.replace(" ", "T").replace(/Z$/, "")}Z`);

// Already-converted browser-local timestamps are treated as local
const parseLocalAbs = (s: string) => new Date(s.replace(" ", "T").replace(/Z$/, ""));

const parseRel = (s: string, base = new Date()) => {
  const m = /^now-(\d+)([hmd])$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const d = new Date(base);
  if (m[2] === "h") d.setHours(d.getHours() - n);
  else if (m[2] === "d") d.setDate(d.getDate() - n);
  else if (m[2] === "m") d.setMonth(d.getMonth() - n);
  return d;
};

// token ('now', 'now-6h', or absolute UTC string) -> Date
const toDateOrNull = (s?: string, base: Date = new Date()): Date | null => {
  if (typeof s !== "string") return null;
  if (s === "now") return base;
  return parseRel(s, base) || parseAbs(s) || null;
};

// token -> UTC string for server use
const toTimeString = (s?: string, base: Date = new Date()): string | undefined => {
  const d = toDateOrNull(s, base);
  return d ? fmt(d) : undefined;
};

// Browser-local input -> UTC string for server/state
const localInputToUtcString = (s?: string) => (s ? fmt(new Date(s)) : "");

// Offset in minutes of `timeZone` relative to UTC at instant `d` (positive = ahead of UTC).
const tzOffsetMinutes = (d: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const h = m.hour === "24" ? "00" : m.hour;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +h, +m.minute, +m.second);
  return (asUTC - d.getTime()) / 60000;
};

// datetime-local input value, interpreted as wall-clock in `timeZone` -> UTC string for server/state.
// Falls back to browser-local interpretation when no timezone is given.
const inputToUtcString = (s?: string, timeZone?: string) => {
  if (!s) return "";
  if (!timeZone) return localInputToUtcString(s);
  const mt = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!mt) return localInputToUtcString(s);
  const [, y, mo, da, h, mi, sec] = mt;
  // Treat the wall-clock as if it were UTC, then correct by the zone's offset at that instant.
  let utcMs = Date.UTC(+y, +mo - 1, +da, +h, +mi, sec ? +sec : 0);
  try {
    utcMs -= tzOffsetMinutes(new Date(utcMs), timeZone) * 60000;
  } catch {
    return localInputToUtcString(s);
  }
  return fmt(new Date(utcMs));
};

// UTC string from server/state -> datetime-local value (in selected timezone if given)
const utcStringToLocalInput = (s?: string, timeZone?: string) => {
  if (!s) return "";
  const d = parseAbs(s);
  if (!timeZone) return fmtLocalInput(d);
  try {
    return fmtTZInput(d, timeZone);
  } catch {
    return fmtLocalInput(d);
  }
};

// UTC string from server -> chart/display string (in selected timezone if given)
const utcStringToLocalString = (s?: string, timeZone?: string) => {
  if (!s) return "";
  const d = parseAbs(s);
  if (!timeZone) return fmtLocal(d);
  try {
    return fmtTZ(d, timeZone);
  } catch {
    return fmtLocal(d);
  }
};

// Default datetime-local value: now minus N hours (in selected timezone if given)
const nowLocalMinusHr = (hours: number, timeZone?: string) => {
  const d = new Date(Date.now() - hours * 60 * 60 * 1000);
  if (!timeZone) return fmtLocalInput(d);
  try {
    return fmtTZInput(d, timeZone);
  } catch {
    return fmtLocalInput(d);
  }
};

const toInputOrDefault = (token: string | undefined, fallbackHours: number, timeZone?: string) => {
  if (!token || token.startsWith("now")) return nowLocalMinusHr(fallbackHours, timeZone);
  return utcStringToLocalInput(token, timeZone) || nowLocalMinusHr(fallbackHours, timeZone);
};


interface UnitsProps extends RootProps {
  readUnits: () => void;
  readUnit: () => void;
  readUnitsPoll: (payload?: number) => void;
  filterUnits: (payload: IFilter) => void;
  updateUnit: (payload: DeepPartial<IUnit>) => void;
  units?: IUnit[];
  filtered?: IUnit[];
  readConfigurations: () => void;
  readConfigurationsPoll: (payload?: number) => void;
  createConfiguration: (payload: DeepPartial<IConfiguration>) => void;
  updateConfiguration: (payload: DeepPartial<IConfiguration>) => void;
  deleteConfiguration: (payload: number) => void;
  configurations?: IConfiguration[];
  updateSetpoint: (payload: DeepPartial<ISetpoint>) => void;
  location?: Location & {
    state?: {
      selectedUnitId?: string | number;
    };
  };
}

interface MetadataItem {
  name: string;
  label: string;
  unit: string;
  type: string; 
}

interface VizSetting {
  color?: string;
  marker_size?: number;
  line_width?: number;
  marker_symbol?: string;
  line_dash?: string;
}

type lineChartDataType = { index: number; time: string; timeUtc?: string; values: Record<string, any> };
type TimeRange = Partial<{ start_time: string; end_time: string }>;
type IBuilding = {
  building: string;
  stage: string;
};

interface UnitsState {
  editing: DeepPartial<IUnit> | null;
  editingAll: DeepPartial<IUnit> | null;
  editingBuilding: DeepPartial<IUnit> | null;
  editingBuildingKey: string | null;
  expandedBuilding: string | null;
  expanded: string | null;
  confirm: (() => void) | null;
  unitManagerData: {
    [unitId: string]: {
      id: number; 
      building: string;
      system: string;
      dataTimeRange: TimeRange;
      varList: string[];
      ctrlValues: Record<string, number | string>;
      lineChartData: lineChartDataType[];      
      chartConfigs: { id: number; type: string; selectedVariables: string[]; timeRange?: TimeRange; vizSettings?: Record<string, VizSetting>; }[];
    };
  };
  bldgChartConfigs: Record<
    string,
    { chartConfigs: { id: number; type: string; selectedVariables: string[]; timeRange?: TimeRange; vizSettings?: Record<string, VizSetting>; aggOp?: "average" | "sum"; }[] }
  >;
  cmprChartConfigs: Record<
    string,
    { chartConfigs: { id: number; type: string; selectedVariables: string[]; timeRange?: TimeRange; vizSettings?: Record<string, VizSetting> }[] }
  >;
  startCollect: boolean | null;
  sensorMetadata: MetadataItem[];
  openBuildings?: Record<string, boolean>;
  activeCampus?: string;
  openBuildingControl: Record<string, boolean>;
  openBuildingMonitoring: Record<string, boolean>;
  openZoneComparison: Record<string, boolean>;
  openZoneControl: Record<string, boolean>;
  openZoneMonitoring: Record<string, boolean>;
  floorPlanUnitDraft: Record<string, string>;
  floorPlanUnitSelected: Record<string, string>;
  openZoneDetails: Record<string, boolean>;
  zoneOverrideLock: Record<number, boolean>;
  pollSensorData: boolean;
  /** Selected timezone for chart time display */
  selectedTimezone: string;
}

type AxisInfo = {
  name: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  values: Array<number | null>;
};

class Dashboard extends React.Component<UnitsProps, UnitsState> {
  private configRouteIsHidden: boolean;
  private unitRefs: Record<string, React.RefObject<HTMLDivElement>> = {};
  private hasScrolledToUnit = false;
  private hasAppliedQueryParams = false;
  private sensorDataInterval?: ReturnType<typeof setInterval>;
  private bldgCompareRoomSelected: Record<string, string> = {};
  private bldgChartRoomFilter: Record<string, string> = {};
  private getBldgChartRoomFilter = (key: string) => this.bldgChartRoomFilter[key];

  private setBldgChartRoomFilter = (key: string, room: string) => {
    this.bldgChartRoomFilter[key] = room;
    this.forceUpdate();
  };

  constructor(props: UnitsProps) {
    super(props);
    const configRoute = Object.values(props.routes.map).find((v) => v.data?.name === "configuration")?.data;
    const selectedUnitId = props.location?.state?.selectedUnitId ?? null;
    this.configRouteIsHidden = !!configRoute?.hidden;
    
    const params = new URLSearchParams(props.location?.search ?? "");
    const qsCampus = params.get("campus") ?? undefined;
    const qsBuilding = params.get("building");

    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.state = {
      editing: typeof selectedUnitId === "number" ? { id: selectedUnitId } : null,
      editingAll: { configuration: { holidays: HolidayType.values.map(() => ({})) } },
      editingBuilding: { configuration: { holidays: HolidayType.values.map(() => ({})) } },
      editingBuildingKey: null,
      expandedBuilding: null,
      expanded: null,
      confirm: null,
      unitManagerData: {},
      bldgChartConfigs: {},
      cmprChartConfigs: {},
      startCollect: true,
      sensorMetadata: [],
      openBuildings: {},
      activeCampus: undefined,
      openBuildingControl: {},
      openBuildingMonitoring: {},
      openZoneComparison: {},
      openZoneControl: {},
      openZoneMonitoring: {},
      floorPlanUnitDraft: {},
      floorPlanUnitSelected: {},
      zoneOverrideLock: {},
      openZoneDetails: {},
      pollSensorData: true,
      selectedTimezone: browserTz,
    };
  }

  // Initial data load and start data-collation interval
  componentDidMount() {
    this.props.readUnits();    
    this.props.readUnitsPoll(defaultPollInterval);
    console.log("this.props: ", this.props)

    if (!this.configRouteIsHidden) {
      this.props.readConfigurations();
      this.props.readConfigurationsPoll(defaultPollInterval);
    }

    this.initializeUnitData();

    // Automatically run 'readSensors()' function every 10 seconds
    this.sensorDataInterval = setInterval(() => {
      if (!this.state.pollSensorData) return;

      const openBldg = Object.keys(this.state.openBuildings || {})[0];
      if (!openBldg) return;

      this.getVoltData(openBldg);
    }, 5000 * 12);// * 5);
  }

  // Scroll to selected unit and reinitialize unit data on props update
componentDidUpdate(prevProps: UnitsProps) {
  const selectedUnitId = this.props.location?.state?.selectedUnitId;

  if (prevProps.units !== this.props.units && this.props.units && this.props.units.length > 0) {
      this.initializeUnitData();

    // ── Query-param deep-link: match campus tab + open building ──
    const params = new URLSearchParams(this.props.location?.search ?? "");
    const qsCampus   = params.get("campus");   // e.g. "ornl"
    const qsBuilding = params.get("building"); // e.g. "3147"

    if ((qsCampus || qsBuilding) && !this.hasAppliedQueryParams) {
      this.hasAppliedQueryParams = true;
      const units = this.props.units!;

      // Build the same campusGroups structure used by render()
      const campusGroups: Record<string, Record<string, IUnit[]>> = {};
      for (const unit of units) {
        const campus = unit.campus || "Unknown";
        const bldg   = unit.building || "Unknown";
        (campusGroups[campus] ??= {});
        (campusGroups[campus][bldg] ??= []).push(unit);
      }

      // Case-insensitive match for campus tab ID
      const campusIds = Object.keys(campusGroups);
      const matchedCampus = qsCampus
        ? campusIds.find((id) => id.toLowerCase() === qsCampus.toLowerCase())
        : undefined;

      // Case-insensitive match for building name within that campus
      let matchedBuilding: string | undefined;
      if (qsBuilding && matchedCampus) {
        const bldgNames = Object.keys(campusGroups[matchedCampus]);
        matchedBuilding = bldgNames.find(
          (name) => name.toLowerCase() === qsBuilding.toLowerCase()
        );
      }

      // Only set state if we found real matches and they differ from current state
      const needsCampus  = matchedCampus  && this.state.activeCampus !== matchedCampus;
      const needsBuilding = matchedBuilding && !this.state.openBuildings?.[matchedBuilding];

      if (needsCampus || needsBuilding) {
        this.setState(
          (prev) => ({
            activeCampus:  matchedCampus ?? prev.activeCampus,
            openBuildings: matchedBuilding ? { [matchedBuilding]: true } : prev.openBuildings,
          }),
          () => {
            // Fetch sensor data for the auto-opened building
            if (matchedBuilding && this.state.pollSensorData) {
              this.getVoltData(matchedBuilding);
            }
          }
        );
      }
    }
  }

  // Auto-open building & scroll to the selected unit
  if (
    selectedUnitId !== undefined &&
    String(selectedUnitId) in this.unitRefs &&
    !this.hasScrolledToUnit
  ) {
    const unit = this.props.units?.find(unit => unit.id === Number(selectedUnitId));
    const bldgKey = unit?.building || "Unknown";
    const doScroll = () => {
      const ref = this.unitRefs[String(selectedUnitId)];
      if (ref?.current) {
        this.hasScrolledToUnit = true;
        requestAnimationFrame(() => {
          const element = ref.current!;
          const offset = element.getBoundingClientRect().top + window.pageYOffset - 60;
          window.scrollTo({ top: offset, behavior: "smooth" });
        });
      }
    };

    // Open the containing building if it's closed, then scroll
    if (unit && !this.state.openBuildings?.[bldgKey]) {
      this.setState(
        prev => ({ openBuildings: { ...(prev.openBuildings || {}), [bldgKey]: true } }),
        doScroll
      );
    } else {
      doScroll();
    }
  }
}

  // Clean up polling and intervals
  componentWillUnmount() {
    this.props.readUnitsPoll();
    this.props.readConfigurationsPoll();

    if (this.sensorDataInterval) {
      clearInterval(this.sensorDataInterval);
    }
  }

  getValue = (field: string, editing?: DeepPartial<IUnit> | null, unit?: DeepPartial<IUnit> | null) => {
    const { units } = this.props;
    const temp = unit ? unit : units?.find((v) => v.id === editing?.id);
    return get(editing, field, get(temp, field));
  };

  // Update control values for a unit
  handleSetpointValueChange = (unitId: number, name: string, value: number | string) => {

    this.setState(prevState => {
      const unitData = prevState.unitManagerData[unitId] || {
        id: unitId,
        building: "",
        system: "",
        dataTimeRange: {},
        varList: [],        
        ctrlValues: {},
        chartConfigs: [],
        lineChartData: []
      };
  
      return {
        unitManagerData: {
          ...prevState.unitManagerData,
          [unitId]: {
            ...unitData,
            ctrlValues: {
              ...unitData.ctrlValues,
              [name]: value,
            }
          }
        }
      };
    });
  };

  // Track building-scoped setpoint edits (used by Setpoints component to reflect input changes)
  handleSetpointValueChangeBuilding = (name: string, value: number | string) => {
    this.setState((prevState) => {
      const path = `configuration.setpoint.${name}`;
      const current = get(prevState.editingBuilding, path);

      // Guard against infinite update loops (e.g., Setpoint syncing props -> callback -> setState -> rerender -> ...)
      // Skip nil values entirely — undefined keys cause infinite loops since isNil guard never catches them.
      if (isNil(value)) return null;
      // Treat numeric/string equivalents as equal ("72" vs 72) to avoid flip-flopping.
      if (!isNil(current) && String(current) === String(value)) return null;

      const editingBuilding = prevState.editingBuilding ? cloneDeep(prevState.editingBuilding) : { configuration: { setpoint: {} } };
      set(editingBuilding, path, value);
      return { editingBuilding };
    });
  };

  // Handle general field value updates for editing
  handleChange = (field: string, editing?: DeepPartial<IUnit> | null) => {
    return (value: any) => {
      const doDefault = (value: any) => {
        if (editing) {
          if (isObject(this.getValue(field, editing))) {
            set(editing, field, merge(cloneDeep(get(editing, field)), value));
          } else {
            set(editing, field, value);
          }
          this.setState({ editing });
        }
      };
      switch (field) {
        case "configurationId":
          this.props.updateUnit({ id: editing?.id, configurationId: value as number });
          break;
        default:
          doDefault(value);
      }
    };
  };

  handleCreate = (unit: DeepPartial<IUnit>) => {
    const configuration = createConfigurationDefault();
    configuration.unitId = unit.id;
    this.props.createConfiguration(configuration);
    this.setState({
      editing: null,
      expanded: null,
    });
  };

  handleEdit = (unit: IUnit) => {
    const { filtered } = this.props;
    const { editing } = this.state;
    const current = editing && filtered?.find((v) => v.id === editing.id);
    if (current && this.isSave(current)) {
      this.setState({ confirm: () => this.setState({ editing: { id: unit.id } }) });
    } else {
      this.setState({ editing: { id: unit.id } });
    }
  };

  handleCancel = () => {
    const { filtered } = this.props;
    const { editing } = this.state;
    const current = editing && filtered?.find((v) => v.id === editing.id);
    if (current && this.isSave(current)) {
      this.setState({ confirm: () => this.setState({ editing: null, expanded: null }) });
    } else {
      this.setState({ editing: null, expanded: null });
    }
  };

  handleConfirm = () => {
    const { confirm } = this.state;
    this.setState({ confirm: null }, confirm ?? undefined);
  };

  handleSave = () => {
    const { editing } = this.state;
    if (editing) {
      this.props.updateUnit(editing);
    }
  };

  handleClearAll = () => {
    this.setState({ editingAll: { configuration: { holidays: HolidayType.values.map(() => ({})) } }, expanded: null, expandedBuilding: null });
  };

  handleSaveAll = () => {
    const { editingAll } = this.state;
    const { filtered } = this.props;
    if (editingAll) {
      filtered?.forEach((unit) => {
        if (!this.unitRefs[unit.id!]) {
          this.unitRefs[unit.id!] = React.createRef<HTMLDivElement>();
        }

        const id = unit.id;
        const location = {
          name: editingAll.location?.name,
          latitude: editingAll.location?.latitude,
          longitude: editingAll.location?.longitude,
        };
        const configuration = {
          id: unit.configuration?.id,
          holidays: HolidayType.values
            .map((holiday, i) => {
              const type = editingAll.configuration?.holidays?.[i]?.type;
              if (type) {
                const id = unit.configuration?.holidays?.find((h) => h?.label === holiday?.label)?.id;
                return { id, type };
              } else {
                return undefined;
              }
            })
            .filter((v) => v),
        };
        if (location.name || configuration.holidays.length) {
          this.props.updateUnit({
            id,
            ...(location.name ? { location } : {}),
            ...(configuration.holidays.length ? { configuration } : {}),
          });
        }
      });
      this.handleClearAll();
    }
  };

  ensureBuildingEditor = (editingBuildingKey: string) => {
    if (this.state.editingBuildingKey !== editingBuildingKey) {
      this.setState({
        editingBuildingKey,
        editingBuilding: { configuration: { holidays: HolidayType.values.map(() => ({})) } },
      });
    }
  };

  ensureZoneEditor = (unitId: number) => {
    const currId = this.state.editing?.id;
    if (currId !== unitId) {
      this.setState({ editing: { id: unitId } });
    }
  };
 
  handleDelete = (configuration: DeepPartial<IConfiguration>) => {
    const { id } = configuration;
    if (id !== undefined) {
      this.props.deleteConfiguration(id);
    }
  };

  handlePush = (unit: DeepPartial<IUnit>) => {
    const { id } = unit;
    if (id !== undefined) {
      this.props.updateUnit({ id, stage: StageType.UpdateType.label });
    }
  };

  isSave = (unit: DeepPartial<IUnit> | IUnit, editing?: DeepPartial<IUnit> | null) => {
    editing = editing ?? this.state.editing;
    const temp = merge({}, unit, editing);
    const valid = temp.configuration?.setpoint ? isSetpointValid(temp.configuration.setpoint) : true;
    return (
      // valid &&
      !isEqualWith(unit, temp, (_a, _b, k) =>
        ["createdAt", "updatedAt", "action"].includes(k as any) ? true : undefined
      )
    );
  };

  isPush = (unit: IUnit) => {
    switch (unit.stage) {
      case StageType.UpdateType.label:
      case StageType.DeleteType.label:
      case StageType.ProcessType.label:
        return false;
      case StageType.CreateType.label:
      case StageType.CompleteType.label:
      case StageType.FailType.label:
      default:
        return !this.isSave(unit);
    }
  };

  private getUnitsInBuilding = (bldgName: string, opts?: { excludeLocked?: boolean }): IUnit[] => {
    const units = this.props.filtered ?? this.props.units ?? [];
    const inBldg = units.filter((u) => String(u.building ?? "") === String(bldgName));

    if (!opts?.excludeLocked) return inBldg;

    return inBldg.filter((u) => !this.isZoneLockedFromBuilding(u.id));
  };

  // Building stage derived from zone stages (simple precedence)
  private getBuildingStage = (units: IUnit[], bldgName?: string): string => {
    // If caller passed all units, we can recompute unlocked subset here.
    const unlocked = bldgName ? this.getUnitsInBuilding(bldgName, { excludeLocked: true }) : units;

    // If everything is locked, treat as Complete (or whatever you prefer)
    const effective = unlocked.length ? unlocked : units;

    const stages = effective.map((u) => u.stage);

    if (stages.includes(StageType.FailType.label)) return StageType.FailType.label;
    if (stages.includes(StageType.DeleteType.label)) return StageType.DeleteType.label;
    if (stages.includes(StageType.ProcessType.label)) return StageType.ProcessType.label;
    if (stages.includes(StageType.UpdateType.label)) return StageType.UpdateType.label;
    if (stages.includes(StageType.CreateType.label)) return StageType.CreateType.label;

    return StageType.CompleteType.label;
  };

  private setBldgChartAggOp = (bldgName: string, chartId: number, aggOp: "average" | "sum") => {
    this.setState(prev => {
      const entry = prev.bldgChartConfigs[bldgName];
      if (!entry) return null;
      const chartConfigs = entry.chartConfigs.map(c => (c.id === chartId ? { ...c, aggOp } : c));
      return { bldgChartConfigs: { ...prev.bldgChartConfigs, [bldgName]: { chartConfigs } } };
    }, () => this.getVoltData(bldgName));
  };

  isSaveBuilding = (
    bldgName: string,
    editing?: DeepPartial<IUnit> | null
  ) => {
    const buildingEditing = editing ?? this.state.editingBuilding;
    if (!buildingEditing) return false;

    const units = this.getUnitsInBuilding(bldgName);

    return units.some((unit) => {
      const temp = merge({}, unit, buildingEditing);

      const valid = temp.configuration?.setpoint
        ? isSetpointValid(temp.configuration.setpoint)
        : true;

      return (
        // valid &&
        !isEqualWith(unit, temp, (_a, _b, k) =>
          ["createdAt", "updatedAt", "action"].includes(k as any) ? true : undefined
        )
      );
    });
  };

  handlePushBuilding = (bldgName: string) => {
    const units = this.getUnitsInBuilding(bldgName);

    units.forEach((u) => {
      if (u.id === undefined) return;

      if (this.isZoneLockedFromBuilding(u.id)) return;

      this.props.updateUnit({ id: u.id, stage: StageType.UpdateType.label });
    });
  };

  isPushBuilding = (bldgName: string) => {
    const units = this.getUnitsInBuilding(bldgName);
    const stage = this.getBuildingStage(units);

    switch (stage) {
      case StageType.UpdateType.label:
      case StageType.DeleteType.label:
      case StageType.ProcessType.label:
        return false;

      case StageType.CreateType.label:
      case StageType.CompleteType.label:
      case StageType.FailType.label:
      default:
        return !this.isSaveBuilding(bldgName);
    }
  };

  handleSaveBuilding = (_campusId: string, bldgName: string) => {
    const { editingBuilding } = this.state;
    if (!editingBuilding) return;

    const units = this.getUnitsInBuilding(bldgName);

    units.forEach((u) => {
      if (u.id === undefined) return;

      if (this.isZoneLockedFromBuilding(u.id)) return;

      console.log("unit: ", u.configuration)

      this.props.updateUnit({ id: u.id, ...editingBuilding });
    });
  };

  handleCancelBuilding = (bldgName: string) => {
    if (this.isSaveBuilding(bldgName)) {
      this.setState({
        confirm: () =>
          this.setState({
            editingBuilding: null,
            expandedBuilding: null, 
          }),
      });
    } else {
      this.setState({
        editingBuilding: null,
        expandedBuilding: null, 
      });
    }
  };

  // Handle general field value updates for BUILDING-level editing
  handleChangeBuilding = (field: string, editing?: DeepPartial<IUnit> | null) => {
    return (value: any) => {
      const buildingEditing = editing ?? this.state.editingBuilding;

      if (buildingEditing) {
        if (isObject(this.getValue(field, buildingEditing))) {
          set(buildingEditing, field, merge(cloneDeep(get(buildingEditing, field)), value));
        } else {
          set(buildingEditing, field, value);
        }
        this.setState({ editingBuilding: buildingEditing });
      }
    };
  };

  renderStatusBuilding = (bldgName: string) => {
    const units = this.getUnitsInBuilding(bldgName);
    const stage = this.getBuildingStage(units);

    let icon: IconName = IconNames.ISSUE;
    let intent: Intent = Intent.WARNING;
    const message: string = "Push Building Configuration";

    switch (stage) {
      case StageType.UpdateType.label:
        icon = IconNames.REFRESH;
        intent = Intent.PRIMARY;
        break;
      case StageType.ProcessType.label:
        icon = IconNames.REFRESH;
        intent = Intent.SUCCESS;
        break;
      case StageType.CreateType.label:
        icon = IconNames.ISSUE;
        intent = Intent.WARNING;
        break;
      case StageType.DeleteType.label:
        icon = IconNames.DELETE;
        intent = Intent.DANGER;
        break;
      case StageType.CompleteType.label:
        icon = IconNames.CONFIRM;
        intent = Intent.SUCCESS;
        break;
      case StageType.FailType.label:
        icon = IconNames.ERROR;
        intent = Intent.DANGER;
        break;
      default:
    }

    const canPush = this.isPushBuilding(bldgName);

    return (
      <Tooltip2 content={message} placement={Position.TOP} disabled={!canPush}>
        <Button
          icon={icon}
          intent={intent}
          minimal
          onClick={() => this.handlePushBuilding(bldgName)}
          disabled={!this.isAdmin() || !canPush}
        />
      </Tooltip2>
    );
  };

  
  isAdmin() {
    const { user } = this.props;
    return RoleType.Admin.granted(...(user?.role.split(" ") ?? [""]));
  }

  isManager() {
    const { user } = this.props;
    return RoleType.Manager.granted(...(user?.role.split(" ") ?? [""]));
  }


  isReadOnlyUser() {
    const { user } = this.props;

    return user?.readOnly;
  }

  renderStatus(unit: IUnit) {
    let icon: IconName = IconNames.ISSUE;
    let intent: Intent = Intent.WARNING;
    let message: string = "Push Unit Configuration";
    switch (unit.stage) {
      case StageType.UpdateType.label:
        icon = IconNames.REFRESH;
        intent = Intent.PRIMARY;
        break;
      case StageType.ProcessType.label:
        icon = IconNames.REFRESH;
        intent = Intent.SUCCESS;
        break;
      case StageType.CreateType.label:
        icon = IconNames.ISSUE;
        intent = Intent.WARNING;
        break;
      case StageType.DeleteType.label:
        icon = IconNames.DELETE;
        intent = Intent.DANGER;
        break;
      case StageType.CompleteType.label:
        icon = IconNames.CONFIRM;
        intent = Intent.SUCCESS;
        break;
      case StageType.FailType.label:
        icon = IconNames.ERROR;
        intent = Intent.DANGER;
        break;
      default:
    }
    return (
      <Tooltip2 content={message} placement={Position.TOP} disabled={!this.isPush(unit)}>
        <Button
          icon={icon}
          intent={intent}
          minimal
          onClick={() => this.handlePush(unit)}
          disabled={!this.isAdmin() || !this.isPush(unit)}
        />
      </Tooltip2>
    );
  }
  
  renderConfirm() {
    const { confirm } = this.state;
    if (confirm === null) {
      return null;
    }
    return (
      <Alert
        intent={Intent.DANGER}
        isOpen={true}
        confirmButtonText="Yes"
        cancelButtonText="Cancel"
        onConfirm={() => this.handleConfirm()}
        onClose={() => this.setState({ confirm: null })}
      >
        <p>There are changes which have not been saved. Do you still want to continue?</p>
      </Alert>
    );
  }

  renderPrompt() {
    const { filtered } = this.props;
    const { editing } = this.state;
    const current = editing && filtered?.find((v) => v.id === editing.id);
    const prompt = !isNil(current) && this.isSave(current);
    return (
      <Prompt when={prompt} message="There are changes which have not been saved. Do you still want to continue?" />
    );
  }

  addChart = (unitId: number) => {
    this.setState((prevState) => {
      const currentCharts = prevState.unitManagerData[unitId]?.chartConfigs || [];
      const nextChartId = currentCharts.length > 0 
        ? Math.max(...currentCharts.map(c => c.id)) + 1 
        : 0;
      const nextChartType = "line";

      return {
        unitManagerData: {
          ...prevState.unitManagerData,
          [unitId]: {
            ...prevState.unitManagerData[unitId],
            chartConfigs: [...currentCharts, { id: nextChartId, type: nextChartType, selectedVariables: [], vizSettings: [] }]
          }
        }
      };
    });
  };
  
  removeChart = (unitId: number) => {
    this.setState((prevState) => {
      const currentCharts = prevState.unitManagerData[unitId]?.chartConfigs || [];
  
      if (currentCharts.length > 1) {
        return {
          unitManagerData: {
            ...prevState.unitManagerData,
            [unitId]: {
              ...prevState.unitManagerData[unitId],
              chartConfigs: currentCharts.slice(0, -1),
            }
          }
        };
      }
  
      return null;
    });
  };

  addBldgChart = (bldgName: string) => {
    this.setState(prev => {
      const entry = prev.cmprChartConfigs[bldgName] ?? { chartConfigs: [] as any[] };
      const nextId = entry.chartConfigs.length + CMPR_CHART_OFFSET;
      return {
        cmprChartConfigs: {
          ...prev.cmprChartConfigs,
          [bldgName]: {
            chartConfigs: [
              ...entry.chartConfigs,
              { id: nextId, type: "line", selectedVariables: [], timeRange: {} }
            ],
          },
        },
      };
    });
  };

  removeBldgChart = (bldgName: string) => {
    this.setState(prev => {
      const entry = prev.cmprChartConfigs[bldgName];
      if (!entry || entry.chartConfigs.length === 0) return null;
      return {
        cmprChartConfigs: {
          ...prev.cmprChartConfigs,
          [bldgName]: { chartConfigs: entry.chartConfigs.slice(0, -1) },
        },
      };
    });
  };

  handleBldgChartSelect = (bldgName: string, chartId: number, newSelection: string[]) => {
    this.setState(prev => {
      const entry = prev.bldgChartConfigs[bldgName];
      if (!entry) return null;
      const chartConfigs = entry.chartConfigs.map(c => (c.id === chartId ? { ...c, selectedVariables: newSelection } : c));
      return { bldgChartConfigs: { ...prev.bldgChartConfigs, [bldgName]: { chartConfigs } } };
    });
  };

  handleCmprChartSelect = (bldgName: string, chartId: number, newSelection: string[]) => {
    this.setState(prev => {
      const entry = prev.cmprChartConfigs[bldgName];
      if (!entry) return null;
      const chartConfigs = entry.chartConfigs.map(c => (c.id === chartId ? { ...c, selectedVariables: newSelection } : c));
      return { cmprChartConfigs: { ...prev.cmprChartConfigs, [bldgName]: { chartConfigs } } };
    });
  };

  private isZoneLockedFromBuilding = (unitId?: number) =>
    !!(unitId && this.state.zoneOverrideLock?.[unitId]);

  toggleZoneLockedFromBuilding = (unitId: number) => {
    this.setState((prev) => ({
      zoneOverrideLock: {
        ...(prev.zoneOverrideLock || {}),
        [unitId]: !prev.zoneOverrideLock?.[unitId],
      },
    }));
  };

  private toBuildingData = (unitManagerData: any, bldgName?: string) => {
    const units: any[] = Array.isArray(unitManagerData)
      ? unitManagerData
      : Object.values(unitManagerData || {});

    const sameBldg = bldgName ? units.filter(u => u.building === bldgName) : units;
    if (!sameBldg.length) return null;

    const building = sameBldg[0].building;
    const varList = sameBldg[0].varList ?? ["index", "values"];

    // Merge control values with system prefix e.g., "201_ZoneAirHeatingSetpoint"
    const ctrlValues = sameBldg.reduce<Record<string, any>>((acc, u) => {
      Object.entries(u.ctrlValues || {}).forEach(([k, v]) => {
        acc[`${u.system}_${k}`] = v;
      });
      return acc;
    }, {});

    // Merge timeseries by time; prefix variable names with system (201_, 202_, ...)
    const byTime = new Map<string, lineChartDataType>();
    sameBldg.forEach(u => {
      (u.lineChartData || []).forEach((s: lineChartDataType) => {
        const key = s.time;
        const tgt = byTime.get(key) ?? { index: s.index, time: s.time, timeUtc: s.timeUtc, values: {} };
        Object.entries(s.values || {}).forEach(([k, v]) => {
          tgt.values[`${u.system}_${k}`] = v;
        });
        byTime.set(key, tgt);
      });
    });

    const lineChartData = Array.from(byTime.values()).sort((a, b) => a.time.localeCompare(b.time));
    const chartConfigs = this.state.cmprChartConfigs?.[String(bldgName)]?.chartConfigs ?? [];

    return { id: 0, building, varList, ctrlValues, chartConfigs, lineChartData };
  };

  private toBuildingAggregatedData = (
    unitManagerData: any,
    bldgName: string,
    aggOp: "average" | "sum" = "average"
  ) => {
    const units: any[] = Array.isArray(unitManagerData)
      ? unitManagerData
      : Object.values(unitManagerData || {});

    const sameBldg = units.filter(u => String(u.building ?? "") === String(bldgName));
    if (!sameBldg.length) return null;

    // Aggregate by timestamp
    const byTime = new Map<string, { index: number; time: string; timeUtc?: string; sums: Record<string, number>; counts: Record<string, number> }>();

    sameBldg.forEach(u => {
      (u.lineChartData || []).forEach((pt: any) => {
        const key = pt.time;
        const tgt = byTime.get(key) ?? {
          index: pt.index ?? 0,
          time: pt.time,
          timeUtc: pt.timeUtc,
          sums: {} as Record<string, number>,
          counts: {} as Record<string, number>,
        };

        Object.entries(pt.values || {}).forEach(([k, v]) => {
          const num = typeof v === "number" ? v : parseFloat(String(v));
          if (!Number.isFinite(num)) return;
          tgt.sums[k] = (tgt.sums[k] ?? 0) + num;
          tgt.counts[k] = (tgt.counts[k] ?? 0) + 1;
        });

        byTime.set(key, tgt);
      });
    });

    const lineChartData: lineChartDataType[] = Array.from(byTime.values())
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((t) => {
        const values: Record<string, any> = {};
        Object.keys(t.sums).forEach((k) => {
          if (aggOp === "sum") values[k] = t.sums[k];
          else values[k] = t.counts[k] ? t.sums[k] / t.counts[k] : t.sums[k];
        });
        return { index: t.index, time: t.time, timeUtc: t.timeUtc, values };
      });

    const varList = lineChartData[0]?.values ? Object.keys(lineChartData[0].values) : [];
    const chartConfigs = this.state.bldgChartConfigs?.[String(bldgName)]?.chartConfigs ?? [];

    return {
      id: 0,
      building: bldgName,
      varList,
      ctrlValues: {},      // not needed for monitoring charts
      chartConfigs,
      lineChartData,
    };
  };

  /** "HH:MM" -> minutes since midnight (local) */
  private timeToMinutes = (hhmm?: string | null): number | null => {
    if (!hhmm || typeof hhmm !== "string") return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    return h * 60 + min;
  };

  /** Best-effort holiday match: uses month/day fields if present and holiday type is Enabled */
  private isTodayHoliday = (unit: any, now = new Date()): boolean => {
    const holidays = unit?.configuration?.holidays ?? unit?.holidays ?? [];
    const mm = now.getMonth() + 1;
    const dd = now.getDate();

    return holidays.some((h: any) => {
      const t = String(h?.type ?? "").toLowerCase();
      const typeOk = t === "enabled" || t === "custom";
      const monthOk = Number(h?.month) === mm;
      const dayOk = Number(h?.day) === dd;
      return typeOk && monthOk && dayOk;
    });
  };

  /** Best-effort "temporary occupancy now" check (supports a few common field shapes) */
  private isTemporarilyOccupiedNow = (unit: any, now = new Date()): boolean => {
    const occs = unit?.configuration?.occupancies ?? unit?.occupancies ?? [];
    if (!Array.isArray(occs) || occs.length === 0) return false;

    return occs.some((o: any) => {
      // Prefer schedule-based times (your example)
      const st = this.timeToMinutes(o?.schedule?.startTime);
      const et = this.timeToMinutes(o?.schedule?.endTime);

      // Temporary occupancy entries are date-scoped in your data model
      const dateStr = o?.date;
      if (!dateStr || st == null || et == null) return false;

      const d = new Date(String(dateStr));
      if (Number.isNaN(d.getTime())) return false;

      // Same calendar day (local)
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();

      if (!sameDay) return false;

      const nowMin = now.getHours() * 60 + now.getMinutes();

      // Normal window: 08:00 -> 18:00
      if (st <= et) return nowMin >= st && nowMin <= et;

      // Overnight window: 22:00 -> 02:00 (or 08:00 -> 00:00 treated as overnight)
      return nowMin >= st || nowMin <= et;
    });
  };

  /** Compute occupancy label color/text for "right now" (local time) */
  private getCurrentOccupancyStatus = (unit: any, now = new Date()) => {
    // Priority: holiday > temporary occupancy > schedule
    if (this.isTodayHoliday(unit, now)) {
      return { text: "Holiday", color: "#d11a2a" }; // red
    }

    if (this.isTemporarilyOccupiedNow(unit, now)) {
      return { text: "Temporarily occupied", color: "#2d72d2" }; // blue
    }

    const day = now.getDay(); // 0 Sun ... 6 Sat
    const dayKey =
      day === 0 ? "sunday" :
      day === 1 ? "monday" :
      day === 2 ? "tuesday" :
      day === 3 ? "wednesday" :
      day === 4 ? "thursday" :
      day === 5 ? "friday" : "saturday";

    const cfg = unit?.configuration ?? unit ?? {};
    const sched = cfg?.[`${dayKey}Schedule`];

    // If no schedule, default to Unoccupied
    if (!sched) return { text: "Unoccupied", color: "#8a9ba8" }; // grey

    // If schedule explicitly says unoccupied all day, keep it simple
    if (sched?.occupied === false) {
      return { text: "Unoccupied", color: "#8a9ba8" };
    }

    const st = this.timeToMinutes(sched?.startTime);
    const et = this.timeToMinutes(sched?.endTime);
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // If missing times but occupied=true, treat as occupied
    if (st == null || et == null) return { text: "Occupied", color: "#0f9960" }; // green

    const inWindow =
      st <= et ? (nowMin >= st && nowMin <= et) : (nowMin >= st || nowMin <= et);

    return inWindow
      ? { text: "Occupied", color: "#0f9960" }
      : { text: "Unoccupied", color: "#8a9ba8" };
  };

  /** JSX label with dot + status text */
  private renderOccupancySchedulesLabel = (unit: any) => {
    const s = this.getCurrentOccupancyStatus(unit, new Date());
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
        <span>Occupancy Schedules</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 5 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: s.color,
              display: "inline-block",
            }}
          />
          <span style={{ color: s.color, fontWeight: 500, fontSize: "0.95em" }}>
            {s.text}
          </span>
        </span>
      </span>
    );
  };

  /** Toggle helpers: (un)select all items of a given type for a chart */
  private toggleAllByType = (
    opts: {
      allItems: { name: string; type: string }[];
      selected: string[];
      type: "control" | "sensor";
      checked: boolean;
    }
  ) => {
    const names = (opts.allItems || [])
      .filter((x) => x.type === opts.type)
      .map((x) => x.name);

    if (names.length === 0) return opts.selected;

    if (opts.checked) {
      // add all (dedupe)
      return Array.from(new Set([...(opts.selected || []), ...names]));
    }

    // remove all
    const remove = new Set(names);
    return (opts.selected || []).filter((v) => !remove.has(v));
  };

  private isAllSelectedByType = (
    items: { name: string; type: string }[],
    selected: string[],
    type: "control" | "sensor"
  ) => {
    const names = (items || []).filter((x) => x.type === type).map((x) => x.name);
    if (names.length === 0) return false;
    const sel = new Set(selected || []);
    return names.every((n) => sel.has(n));
  };

  private renderMenuTitleWithAll = (
    title: "Control" | "Sensor",
    checked: boolean,
    onToggle: (next: boolean) => void
  ) => {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 16}}>
        <span>{title}</span>
        <Label style={{ margin: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(e.currentTarget.checked)}
          />
          <span>All</span>
        </Label>
      </div>
    );
  };


  renderZoneChartSelect = (
    unitId: number,
    chartId: number,
    label: string,
    chartData: lineChartDataType,
    selectedVariables: string[],
    onChange: (selection: string[]) => void
  ) => {
    const usedVariables = Object.keys(chartData.values);
    const selectMetadata = this.state.sensorMetadata.filter(item => usedVariables.includes(item.name));
    const bldgName = this.state.unitManagerData[unitId]?.building;
    const chartConfig = this.state.unitManagerData[unitId].chartConfigs[chartId];
    const chartTypeOptions: { key: string; icon: IconName; text: string; description: string }[] = [
      { key: "line",    icon: IconNames.TIMELINE_LINE_CHART, text: "Line Chart",   description: "Trends over time" },
      { key: "scatter", icon: IconNames.SCATTER_PLOT,        text: "Scatter Plot",  description: "Correlations between two variables" },
      { key: "box",     icon: IconNames.HORIZONTAL_BAR_CHART, text: "Box Plot",     description: "Distribution by hour of day" },
    ];

    return (
      <Label>
        <b>{label}</b>
        <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', width: '100%'}}>
        <Popover2
          content={
            <div style={{ display: 'flex', gap: '5px', padding: '10px' }}>
              {/* Control Column */}
              <Menu style={{ flex: 1, width: '450px' }}>
                <MenuItem
                  disabled
                  text={this.renderMenuTitleWithAll(
                    "Control",
                    this.isAllSelectedByType(selectMetadata as any, selectedVariables, "control"),
                    (next) => {
                      const nextSel = this.toggleAllByType({
                        allItems: selectMetadata as any,
                        selected: selectedVariables,
                        type: "control",
                        checked: next,
                      });

                      this.setState((prevState) => {
                        const updatedConfigs = prevState.unitManagerData[unitId].chartConfigs.map((config, idx) => {
                          if (idx !== chartId) return config;
                          return { ...config, selectedVariables: nextSel };
                        });

                        return {
                          unitManagerData: {
                            ...prevState.unitManagerData,
                            [unitId]: {
                              ...prevState.unitManagerData[unitId],
                              chartConfigs: updatedConfigs,
                            },
                          },
                        };
                      });
                    }
                  )}
                />
                {selectMetadata?.filter((v) => v.type === "control").map((item) => {
                  const isChecked = selectedVariables.includes(item.name);
                  return (
                    <MenuItem
                      key={item.label}
                      text={
                        <Label style={{ margin: 0 }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const isChecked = e.target.checked;
                            const itemName = item.name;

                            this.setState(prevState => {
                              const updatedConfigs = prevState.unitManagerData[unitId].chartConfigs.map((config, idx) => {
                                if (idx !== chartId) return config;

                                const updatedSelectedVars = isChecked
                                  ? [...config.selectedVariables, itemName]
                                  : config.selectedVariables.filter((v) => v !== itemName);

                                return {
                                  ...config,
                                  selectedVariables: updatedSelectedVars,
                                };
                              });

                              return {
                                unitManagerData: {
                                  ...prevState.unitManagerData,
                                  [unitId]: {
                                    ...prevState.unitManagerData[unitId],
                                    chartConfigs: updatedConfigs,
                                  }
                                }
                              };
                            });
                          }}
                        />
                          {" " + item.label}
                        </Label>
                      }
                      shouldDismissPopover={false}
                    />
                  );
                })}
              </Menu>

              {/* Sensor Column */}
              <Menu style={{ flex: 1 }}>
                <MenuItem
                  disabled
                  text={this.renderMenuTitleWithAll(
                    "Sensor",
                    this.isAllSelectedByType(selectMetadata as any, selectedVariables, "sensor"),
                    (next) => {
                      const nextSel = this.toggleAllByType({
                        allItems: selectMetadata as any,
                        selected: selectedVariables,
                        type: "sensor",
                        checked: next,
                      });

                      this.setState((prevState) => {
                        const updatedConfigs = prevState.unitManagerData[unitId].chartConfigs.map((config, idx) => {
                          if (idx !== chartId) return config;
                          return { ...config, selectedVariables: nextSel };
                        });

                        return {
                          unitManagerData: {
                            ...prevState.unitManagerData,
                            [unitId]: {
                              ...prevState.unitManagerData[unitId],
                              chartConfigs: updatedConfigs,
                            },
                          },
                        };
                      });
                    }
                  )}
                />
                {selectMetadata?.filter((v) => v.type === "sensor").map((item) => {
                  const isChecked = selectedVariables.includes(item.name);
                  return (
                    <MenuItem
                      key={item.label}
                      text={
                        <Label style={{ margin: 0 }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              const isChecked = e.target.checked;
                              const itemName = item.name;

                              this.setState(prevState => {
                                const updatedConfigs = prevState.unitManagerData[unitId].chartConfigs.map((config, idx) => {
                                  if (idx !== chartId) return config;

                                  const updatedSelectedVars = isChecked
                                    ? [...config.selectedVariables, itemName]
                                    : config.selectedVariables.filter((v) => v !== itemName);

                                  return {
                                    ...config,
                                    selectedVariables: updatedSelectedVars,
                                  };
                                });

                                return {
                                  unitManagerData: {
                                    ...prevState.unitManagerData,
                                    [unitId]: {
                                      ...prevState.unitManagerData[unitId],
                                      chartConfigs: updatedConfigs,
                                    }
                                  }
                                };
                              });
                            }}
                          />
                          {" " + item.label}
                        </Label>
                      }
                      shouldDismissPopover={false}
                    />
                  );
                })}
              </Menu>
            </div>
          }
          placement="bottom-start"
        >
          <Button rightIcon={IconNames.CARET_DOWN} minimal>
            {selectedVariables.length > 0
              ? `${selectedVariables.length} selected`
              : "Select variables..."}
          </Button>
        </Popover2>
        <span style={{ marginRight: 112 }}>
          <HelpIcon text="Pick one or more control/sensor variables to plot. Use the 'All' checkbox to toggle an entire category." />
        </span>
        
        {/* Chart Type Dropdown */}
        <Popover2
          content={
            <Menu>
              {chartTypeOptions.map((opt) => (
                <MenuItem
                  key={opt.key}
                  icon={opt.icon}
                  text={opt.text}
                  labelElement={
                    <span style={{ fontSize: "0.8em", color: "#8a9ba8" }}>
                      {opt.description}
                    </span>
                  }
                  onClick={() => {
                    this.setState((prevState) => {
                      const updatedConfigs = prevState.unitManagerData[unitId].chartConfigs.map((config) =>
                        config.id === chartId ? { ...config, type: opt.key } : config
                      );
                      return {
                        unitManagerData: {
                          ...prevState.unitManagerData,
                          [unitId]: {
                            ...prevState.unitManagerData[unitId],
                            chartConfigs: updatedConfigs,
                          },
                        },
                      };
                    });
                  }}
                />
              ))}
            </Menu>
          }
          placement="bottom-start"          
        >
          <Button
            rightIcon={IconNames.CARET_DOWN}
            icon={chartTypeOptions.find((o) => o.key === chartConfig?.type)?.icon}
            minimal
          >
            {chartTypeOptions.find((o) => o.key === chartConfig?.type)?.text ?? "Select Chart Type"}
          </Button>
        </Popover2>
        <HelpIcon text="Line: trends over time. Scatter: relationship between exactly 2 variables. Box: hourly distribution grouped by occupancy." />
        
        </div>

        {/* Time Range Selection */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%'}}>
          <Label style={{ width: '47%', fontSize: '12pt', margin: '5px 15px'}}>
            <b>Start Time</b>
            <InputGroup
              key={`zone-start-${unitId}-${chartId}-${this.state.selectedTimezone}`}
              type="datetime-local"
              value={toInputOrDefault(
                this.state.unitManagerData?.[unitId]?.chartConfigs?.find((c: any) => c.id === chartId)?.timeRange?.start_time as any,
                6,
                this.state.selectedTimezone
              )}
              onChange={(e) => {
                const v = e.currentTarget.value;                                 // wall-clock in selected tz
                const stored = inputToUtcString(v, this.state.selectedTimezone); // UTC for server/state

                this.setState((prevState) => {
                  const currCfg = prevState.unitManagerData[unitId].chartConfigs.find((c: any) => c.id === chartId);
                  const endToken = currCfg?.timeRange?.end_time ?? "now";
                  const end = toDateOrNull(endToken, new Date());

                  if (end) {
                    const start = parseAbs(stored); // true instant
                    const minStart = new Date(end);
                    minStart.setMonth(minStart.getMonth() - 3);

                    if (start >= end || start <= minStart) {
                      return null;
                    }
                  }

                  const updatedConfigs = prevState.unitManagerData[unitId].chartConfigs.map((config: any) =>
                    config.id === chartId
                      ? { ...config, timeRange: { ...(config.timeRange ?? {}), start_time: stored } }
                      : config
                  );

                  return {
                    unitManagerData: {
                      ...prevState.unitManagerData,
                      [unitId]: { ...prevState.unitManagerData[unitId], chartConfigs: updatedConfigs },
                    },
                  };
                }, () => {
                  this.getVoltData(bldgName);
                });
              }}
            />
          </Label>
          <Label style={{ width: '47%', fontSize: '12pt', margin: '5px 15px'}}>
            <b>End Time</b>
            <InputGroup
              key={`zone-end-${unitId}-${chartId}-${this.state.selectedTimezone}`}
              type="datetime-local"
              value={toInputOrDefault(
                this.state.unitManagerData?.[unitId]?.chartConfigs?.find((c: any) => c.id === chartId)?.timeRange?.end_time as any,
                0,
                this.state.selectedTimezone
              )}
              onChange={(e) => {
                const v = e.currentTarget.value;                                 // wall-clock in selected tz
                const stored = inputToUtcString(v, this.state.selectedTimezone); // UTC for server/state

                this.setState((prevState) => {
                  const currCfg = prevState.unitManagerData[unitId].chartConfigs.find((c: any) => c.id === chartId);
                  const startToken = currCfg?.timeRange?.start_time ?? "now";
                  const start = toDateOrNull(startToken, new Date());

                  if (start) {
                    const end = parseAbs(stored); // true instant
                    const maxEnd = new Date(start);
                    maxEnd.setMonth(maxEnd.getMonth() + 3);

                    if (end <= start || end >= maxEnd) {
                      return null;
                    }
                  }

                  const updatedConfigs = prevState.unitManagerData[unitId].chartConfigs.map((config: any) =>
                    config.id === chartId
                      ? { ...config, timeRange: { ...(config.timeRange ?? {}), end_time: stored } }
                      : config
                  );

                  return {
                    unitManagerData: {
                      ...prevState.unitManagerData,
                      [unitId]: { ...prevState.unitManagerData[unitId], chartConfigs: updatedConfigs },
                    },
                  };
                }, () => {
                  this.getVoltData(bldgName);
                });
              }}
            />
          </Label>
        </div>
        
        {/* Quick range buttons */}
        {(() => {
          const presets = [
            { label: 'Past 1 month', start: 'now-1m' },
            { label: 'Past 1 week',  start: 'now-7d' },
            { label: 'Past 24 hours',start: 'now-24h' },
            { label: 'Past 6 hours', start: 'now-6h' },
          ];

          const currCfg = this.state.unitManagerData[unitId].chartConfigs
            .find((c: any) => c.id === chartId);
          const tr = currCfg?.timeRange ?? {};
          const activeStart = presets.find(p => tr.start_time === p.start && (tr.end_time ?? 'now') === 'now')?.start;

          return (
            <div className="quick-range">
              {presets.map(p => (
                <button
                  key={p.start}
                  type="button"
                  className={`quick-range__btn ${activeStart === p.start ? 'is-active' : ''}`}
                  aria-pressed={activeStart === p.start}
                  onClick={() => {
                    this.setState((prevState: any) => {
                      const updated = prevState.unitManagerData[unitId].chartConfigs.map((config: any) =>
                        config.id === chartId
                          ? {
                              ...config, timeRange: {...(config.timeRange ?? {}), start_time: p.start,  end_time: 'now', },
                            } : config
                      );
                      return {
                        unitManagerData: {
                          ...prevState.unitManagerData,
                          [unitId]: { ...prevState.unitManagerData[unitId], chartConfigs: updated },
                        },
                      };
                    }, () => {
                      this.getVoltData(bldgName);
                    });
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          );
        })()}

      </Label>
    );
  };

  renderBldgChartSelect = (
    bldgName: string,
    chartId: number,
    label: string,
    chartData: lineChartDataType, 
    selectedVariables: string[],
    onChange: (selection: string[]) => void
  ) => {
    const usedVariables = Object.keys(chartData.values);

    const rooms = Array.from(
      new Set(
        usedVariables
          .map((full) => {
            const s = String(full);
            return (s.startsWith('bestest_air_') || s.startsWith('bestest_hydronic_'))
              ? s.split('_').slice(0, 2).join('_')
              : s.split(/_(.+)/)[0];
          })
          .filter(Boolean)
      )
    ).sort();

    // const chartKey = `${bldgName}::${chartId}`;
    const bldgEntry = this.state.bldgChartConfigs?.[bldgName];
    const chartConfig = bldgEntry?.chartConfigs?.find((v: any) => v.id === chartId);
    const aggOp = chartConfig?.aggOp ?? "average";
    const selectMetadata = usedVariables
      .map((fullName) => {
        const s = String(fullName);
        const [room, baseName] = (s.startsWith('bestest_air_') || s.startsWith('bestest_hydronic_'))
          ? [s.split('_').slice(0, 2).join('_'), s.split('_').slice(2).join('_')]
          : [s.split(/_(.+)/)[0], s.split(/_(.+)/)[1] ?? fullName];
        const meta = this.state.sensorMetadata.find((m) => m.name === baseName);
        const labelText = `${meta?.label ?? baseName}`;

        return meta
          ? { ...meta, name: fullName, label: labelText, _room: room }
          : { name: fullName, label: labelText, unit: "", type: "sensor", _room: room };
      });

    return (
        <Label>

          {/* Top row: Room dropdown (LEFT) + Select variables... + Chart Type */}
          <div style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", width: "100%" }}>

            {/* 2) Select variables... (filtered by room, but selections persist via bldgChartConfigs) */}
            <Popover2
              content={
                <div style={{ display: "flex", gap: "5px", padding: "10px" }}>
                  {/* Control Column */}
                  <Menu style={{ flex: 1, width: "450px" }}>
                    <MenuItem
                      disabled
                      text={this.renderMenuTitleWithAll(
                        "Control",
                        this.isAllSelectedByType(selectMetadata as any, selectedVariables, "control"),
                        (next) => {
                          const nextSel = this.toggleAllByType({
                            allItems: selectMetadata as any,
                            selected: selectedVariables,
                            type: "control",
                            checked: next,
                          });

                          this.setState((prevState) => {
                            const updatedConfigs = prevState.bldgChartConfigs[bldgName].chartConfigs.map((config, idx) => {
                              if (idx + BLDG_CHART_OFFSET !== chartId) return config;
                              return { ...config, selectedVariables: nextSel };
                            });

                            return {
                              bldgChartConfigs: {
                                ...prevState.bldgChartConfigs,
                                [bldgName]: { ...prevState.bldgChartConfigs[bldgName], chartConfigs: updatedConfigs },
                              },
                            };
                          });
                        }
                      )}
                    />
                    {selectMetadata
                      ?.filter((v: any) => v.type === "control")
                      .map((item: any) => {
                        const isChecked = selectedVariables.includes(item.name);
                        return (
                          <MenuItem
                            key={item.name}
                            text={
                              <Label style={{ margin: 0 }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    const itemName = item.name;

                                    this.setState((prevState) => {
                                      const updatedConfigs = prevState.bldgChartConfigs[bldgName].chartConfigs.map((config, idx) => {
                                        if (idx + BLDG_CHART_OFFSET !== chartId) return config;

                                        const updatedSelectedVars = checked
                                          ? Array.from(new Set([...(config.selectedVariables || []), itemName]))
                                          : (config.selectedVariables || []).filter((v) => v !== itemName);

                                        return { ...config, selectedVariables: updatedSelectedVars };
                                      });

                                      return {
                                        bldgChartConfigs: {
                                          ...prevState.bldgChartConfigs,
                                          [bldgName]: { ...prevState.bldgChartConfigs[bldgName], chartConfigs: updatedConfigs },
                                        },
                                      };
                                    });
                                  }}
                                />
                                {" " + item.label}
                              </Label>
                            }
                            shouldDismissPopover={false}
                          />
                        );
                      })}
                  </Menu>

                  {/* Sensor Column */}
                  <Menu style={{ flex: 1 }}>
                    <MenuItem
                      disabled
                      text={this.renderMenuTitleWithAll(
                        "Sensor",
                        this.isAllSelectedByType(selectMetadata as any, selectedVariables, "sensor"),
                        (next) => {
                          const nextSel = this.toggleAllByType({
                            allItems: selectMetadata as any,
                            selected: selectedVariables,
                            type: "sensor",
                            checked: next,
                          });

                          this.setState((prevState) => {
                            const updatedConfigs = prevState.bldgChartConfigs[bldgName].chartConfigs.map((config, idx) => {
                              if (idx + BLDG_CHART_OFFSET !== chartId) return config;
                              return { ...config, selectedVariables: nextSel };
                            });

                            return {
                              bldgChartConfigs: {
                                ...prevState.bldgChartConfigs,
                                [bldgName]: { ...prevState.bldgChartConfigs[bldgName], chartConfigs: updatedConfigs },
                              },
                            };
                          });
                        }
                      )}
                    />
                    {selectMetadata
                      ?.filter((v: any) => v.type === "sensor")
                      .map((item: any) => {
                        const isChecked = selectedVariables.includes(item.name);
                        return (
                          <MenuItem
                            key={item.name}
                            text={
                              <Label style={{ margin: 0 }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    const itemName = item.name;

                                    this.setState((prevState) => {
                                      const updatedConfigs = prevState.bldgChartConfigs[bldgName].chartConfigs.map((config, idx) => {
                                        if (idx + BLDG_CHART_OFFSET !== chartId) return config;

                                        const updatedSelectedVars = checked
                                          ? Array.from(new Set([...(config.selectedVariables || []), itemName]))
                                          : (config.selectedVariables || []).filter((v) => v !== itemName);

                                        return { ...config, selectedVariables: updatedSelectedVars };
                                      });

                                      return {
                                        bldgChartConfigs: {
                                          ...prevState.bldgChartConfigs,
                                          [bldgName]: { ...prevState.bldgChartConfigs[bldgName], chartConfigs: updatedConfigs },
                                        },
                                      };
                                    });
                                  }}
                                />
                                {" " + item.label}
                              </Label>
                            }
                            shouldDismissPopover={false}
                          />
                        );
                      })}
                  </Menu>
                </div>
              }
              placement="bottom-start"
            >
              <Button rightIcon={IconNames.CARET_DOWN} minimal>
                {selectedVariables.length > 0 ? `${selectedVariables.length} selected` : "Select variables..."}
              </Button>              
            </Popover2>
            <span style={{ marginRight: 15 }}>
              <HelpIcon text="Pick one or more control/sensor variables to plot. Use the 'All' checkbox to toggle an entire category." />
            </span>

            <Popover2
              content={
                <Menu>
                  <MenuItem
                    text="Average"
                    icon={aggOp === "average" ? IconNames.TICK : "blank"}
                    onClick={() => this.setBldgChartAggOp(bldgName, chartId, "average")}
                  />
                  <MenuItem
                    text="Sum"
                    icon={aggOp === "sum" ? IconNames.TICK : "blank"}
                    onClick={() => this.setBldgChartAggOp(bldgName, chartId, "sum")}
                  />
                </Menu>
              }
              placement="bottom-start"
            >
              <Button rightIcon={IconNames.CARET_DOWN} minimal>
                {aggOp}
              </Button>
            </Popover2>
            <HelpIcon text="1) Average: mean across all zones at each timestamp. 2) Sum: total across all zones." />
          </div>
          {/* Time Range Selection */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <Label style={{ width: "47%", fontSize: "12pt", margin: "5px 15px" }}>
              <b>Start Time</b>
              <InputGroup
                key={`bldg-start-${chartId}-${this.state.selectedTimezone}`}
                type="datetime-local"
                value={toInputOrDefault(chartConfig?.timeRange?.start_time as any, 6, this.state.selectedTimezone)}
                onChange={(e) => {
                  const v = e.currentTarget.value;                                 // wall-clock in selected tz
                  const stored = inputToUtcString(v, this.state.selectedTimezone); // UTC for server/state

                  this.setState((prevState: any) => {
                    const currCfg = prevState.bldgChartConfigs?.[bldgName]?.chartConfigs?.find((c: any) => c.id === chartId);
                    const endToken = currCfg?.timeRange?.end_time ?? "now";
                    const end = toDateOrNull(endToken, new Date());

                    if (end) {
                      const start = parseAbs(stored);
                      const minStart = new Date(end);
                      minStart.setMonth(minStart.getMonth() - 3);
                      if (start >= end || start <= minStart) return null;
                    }

                    const updatedConfigs = prevState.bldgChartConfigs[bldgName].chartConfigs.map((config: any) =>
                      config.id === chartId
                        ? { ...config, timeRange: { ...(config.timeRange ?? {}), start_time: stored } }
                        : config
                    );

                    return {
                      bldgChartConfigs: {
                        ...prevState.bldgChartConfigs,
                        [bldgName]: { ...prevState.bldgChartConfigs[bldgName], chartConfigs: updatedConfigs },
                      },
                    };
                  }, () => this.getVoltData(bldgName));
                }}
              />
            </Label>

            <Label style={{ width: "47%", fontSize: "12pt", margin: "5px 15px" }}>
              <b>End Time</b>
              <InputGroup
                key={`bldg-end-${chartId}-${this.state.selectedTimezone}`}
                type="datetime-local"
                value={toInputOrDefault(chartConfig?.timeRange?.end_time as any, 0, this.state.selectedTimezone)}
                onChange={(e) => {
                  const v = e.currentTarget.value;                                 // wall-clock in selected tz
                  const stored = inputToUtcString(v, this.state.selectedTimezone); // UTC for server/state

                  this.setState((prevState: any) => {
                    const currCfg = prevState.bldgChartConfigs?.[bldgName]?.chartConfigs?.find((c: any) => c.id === chartId);
                    const startToken = currCfg?.timeRange?.start_time ?? "now";
                    const start = toDateOrNull(startToken, new Date());

                    if (start) {
                      const end = parseAbs(stored);
                      const maxEnd = new Date(start);
                      maxEnd.setMonth(maxEnd.getMonth() + 3);
                      if (end <= start || end >= maxEnd) return null;
                    }

                    const updatedConfigs = prevState.bldgChartConfigs[bldgName].chartConfigs.map((config: any) =>
                      config.id === chartId
                        ? { ...config, timeRange: { ...(config.timeRange ?? {}), end_time: stored } }
                        : config
                    );

                    return {
                      bldgChartConfigs: {
                        ...prevState.bldgChartConfigs,
                        [bldgName]: { ...prevState.bldgChartConfigs[bldgName], chartConfigs: updatedConfigs },
                      },
                    };
                  }, () => this.getVoltData(bldgName));
                }}
              />
            </Label>
          </div>

          {/* Quick range buttons */}
          {(() => {
            const presets = [
              { label: "Past 1 month", start: "now-1m" },
              { label: "Past 1 week", start: "now-7d" },
              { label: "Past 24 hours", start: "now-24h" },
              { label: "Past 6 hours", start: "now-6h" },
            ];

            const currCfg = this.state.bldgChartConfigs?.[bldgName]?.chartConfigs?.find((c: any) => c.id === chartId);
            const tr = currCfg?.timeRange ?? {};
            const activeStart = presets.find((p) => tr.start_time === p.start && (tr.end_time ?? "now") === "now")?.start;

            return (
              <div className="quick-range">
                {presets.map((p) => (
                  <button
                    key={p.start}
                    type="button"
                    className={`quick-range__btn ${activeStart === p.start ? "is-active" : ""}`}
                    aria-pressed={activeStart === p.start}
                    onClick={() => {
                      this.setState((prevState: any) => {
                        const updated = prevState.bldgChartConfigs[bldgName].chartConfigs.map((config: any) =>
                          config.id === chartId
                            ? { ...config, timeRange: { ...(config.timeRange ?? {}), start_time: p.start, end_time: "now" } }
                            : config
                        );

                        return {
                          bldgChartConfigs: {
                            ...prevState.bldgChartConfigs,
                            [bldgName]: { ...prevState.bldgChartConfigs[bldgName], chartConfigs: updated },
                          },
                        };
                      }, () => this.getVoltData(bldgName));
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            );
          })()}

        </Label>
    );
  };

  renderCmprChartSelect = (
    bldgName: string,
    chartId: number,
    label: string,
    chartData: lineChartDataType, 
    selectedVariables: string[],
    onChange: (selection: string[]) => void
  ) => {
    const usedVariables = Object.keys(chartData.values);

    const rooms = Array.from(
      new Set(
        usedVariables
          .map((full) => {
            const s = String(full);
            return (s.startsWith('bestest_air_') || s.startsWith('bestest_hydronic_'))
              ? s.split('_').slice(0, 2).join('_')
              : s.split(/_(.+)/)[0];
          })
          .filter(Boolean)
      )
    ).sort();

    const chartKey = `${bldgName}::${chartId}`;
    const selectedRoom = this.bldgChartRoomFilter[chartKey] ?? "All";

    const selectMetadata = usedVariables
      .map((fullName) => {
        const s = String(fullName);
        const [room, baseName] = (s.startsWith('bestest_air_') || s.startsWith('bestest_hydronic_'))
          ? [s.split('_').slice(0, 2).join('_'), s.split('_').slice(2).join('_')]
          : [s.split(/_(.+)/)[0], s.split(/_(.+)/)[1] ?? fullName];
        const meta = this.state.sensorMetadata.find((m) => m.name === baseName);
        const labelText =
          selectedRoom === "All"
            ? `[${room}] ${meta?.label ?? baseName}`
            : `${meta?.label ?? baseName}`;

        return meta
          ? { ...meta, name: fullName, label: labelText, _room: room }
          : { name: fullName, label: labelText, unit: "", type: "sensor", _room: room };
      })
      .filter((m: any) => selectedRoom === "All" || String(m._room) === selectedRoom);

    return (
        <Label>
          <b>{label}</b>

          {/* Top row: Room dropdown (LEFT) + Select variables... + Chart Type */}
          <div style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", width: "100%" }}>

            {/* 1) Room dropdown (not stored in this.state; stored in instance field) */}

            <Popover2
              content={
                <Menu>
                  <MenuItem
                    text="All"
                    active={selectedRoom === "All"}
                    onClick={() => {
                      this.bldgChartRoomFilter[chartKey] = "All";
                      this.forceUpdate();
                    }}
                  />
                  {rooms.map((r) => (
                    <MenuItem
                      key={r}
                      text={r}
                      active={selectedRoom === r}
                      onClick={() => {
                        this.bldgChartRoomFilter[chartKey] = r;
                        this.forceUpdate();
                      }}
                    />
                  ))}
                </Menu>
              }
              placement="bottom-start"
            >
              <Button rightIcon={IconNames.CARET_DOWN} minimal>
                {selectedRoom}
              </Button>
            </Popover2>
            <HelpIcon text="Filter the variable list by a specific zone/room, or choose 'All' to see every zone's variables." />

            {/* 2) Select variables... (filtered by room, but selections persist via bldgChartConfigs) */}
            <Popover2
              content={
                <div style={{ display: "flex", gap: "5px", padding: "10px" }}>
                  {/* Control Column */}
                  <Menu style={{ flex: 1, width: "450px" }}>
                    <MenuItem
                      disabled
                      text={this.renderMenuTitleWithAll(
                        "Control",
                        this.isAllSelectedByType(selectMetadata as any, selectedVariables, "control"),
                        (next) => {
                          const nextSel = this.toggleAllByType({
                            allItems: selectMetadata as any,
                            selected: selectedVariables,
                            type: "control",
                            checked: next,
                          });

                          this.setState((prevState) => {
                            const updatedConfigs = prevState.cmprChartConfigs[bldgName].chartConfigs.map((config, idx) => {
                              if (idx + CMPR_CHART_OFFSET !== chartId) return config;
                              return { ...config, selectedVariables: nextSel };
                            });

                            return {
                              cmprChartConfigs: {
                                ...prevState.cmprChartConfigs,
                                [bldgName]: { ...prevState.cmprChartConfigs[bldgName], chartConfigs: updatedConfigs },
                              },
                            };
                          });
                        }
                      )}
                    />
                    {selectMetadata
                      ?.filter((v: any) => v.type === "control")
                      .map((item: any) => {
                        const isChecked = selectedVariables.includes(item.name);
                        return (
                          <MenuItem
                            key={item.name}
                            text={
                              <Label style={{ margin: 0 }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    const itemName = item.name;

                                    this.setState((prevState) => {
                                      const updatedConfigs = prevState.cmprChartConfigs[bldgName].chartConfigs.map((config, idx) => {
                                        if (idx + CMPR_CHART_OFFSET !== chartId) return config;

                                        const updatedSelectedVars = checked
                                          ? Array.from(new Set([...(config.selectedVariables || []), itemName]))
                                          : (config.selectedVariables || []).filter((v) => v !== itemName);

                                        return { ...config, selectedVariables: updatedSelectedVars };
                                      });

                                      return {
                                        cmprChartConfigs: {
                                          ...prevState.cmprChartConfigs,
                                          [bldgName]: { ...prevState.cmprChartConfigs[bldgName], chartConfigs: updatedConfigs },
                                        },
                                      };
                                    });
                                  }}
                                />
                                {" " + item.label}
                              </Label>
                            }
                            shouldDismissPopover={false}
                          />
                        );
                      })}
                  </Menu>

                  {/* Sensor Column */}
                  <Menu style={{ flex: 1 }}>
                    <MenuItem
                      disabled
                      text={this.renderMenuTitleWithAll(
                        "Sensor",
                        this.isAllSelectedByType(selectMetadata as any, selectedVariables, "sensor"),
                        (next) => {
                          const nextSel = this.toggleAllByType({
                            allItems: selectMetadata as any,
                            selected: selectedVariables,
                            type: "sensor",
                            checked: next,
                          });

                          this.setState((prevState) => {
                            const updatedConfigs = prevState.cmprChartConfigs[bldgName].chartConfigs.map((config, idx) => {
                              if (idx + CMPR_CHART_OFFSET !== chartId) return config;
                              return { ...config, selectedVariables: nextSel };
                            });

                            return {
                              cmprChartConfigs: {
                                ...prevState.cmprChartConfigs,
                                [bldgName]: { ...prevState.cmprChartConfigs[bldgName], chartConfigs: updatedConfigs },
                              },
                            };
                          });
                        }
                      )}
                    />
                    {selectMetadata
                      ?.filter((v: any) => v.type === "sensor")
                      .map((item: any) => {
                        const isChecked = selectedVariables.includes(item.name);
                        return (
                          <MenuItem
                            key={item.name}
                            text={
                              <Label style={{ margin: 0 }}>
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    const itemName = item.name;

                                    this.setState((prevState) => {
                                      const updatedConfigs = prevState.cmprChartConfigs[bldgName].chartConfigs.map((config, idx) => {
                                        if (idx + CMPR_CHART_OFFSET !== chartId) return config;

                                        const updatedSelectedVars = checked
                                          ? Array.from(new Set([...(config.selectedVariables || []), itemName]))
                                          : (config.selectedVariables || []).filter((v) => v !== itemName);

                                        return { ...config, selectedVariables: updatedSelectedVars };
                                      });

                                      return {
                                        cmprChartConfigs: {
                                          ...prevState.cmprChartConfigs,
                                          [bldgName]: { ...prevState.cmprChartConfigs[bldgName], chartConfigs: updatedConfigs },
                                        },
                                      };
                                    });
                                  }}
                                />
                                {" " + item.label}
                              </Label>
                            }
                            shouldDismissPopover={false}
                          />
                        );
                      })}
                  </Menu>
                </div>
              }
              placement="bottom-start"
            >
              <Button rightIcon={IconNames.CARET_DOWN} minimal>
                {selectedVariables.length > 0 ? `${selectedVariables.length} selected` : "Select variables..."}
              </Button>              
            </Popover2>
            <HelpIcon text="Pick one or more control/sensor variables to plot. Use the 'All' checkbox to toggle an entire category." />
          </div>

          {/* Time Range Selection */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <Label style={{ width: "47%", fontSize: "12pt", margin: "5px 15px" }}>
              <b>Start Time</b>
              <InputGroup
                type="datetime-local"
                key={`cmpr-start-${chartId}-${this.state.selectedTimezone}`}
                value={toInputOrDefault(
                  (this.state.cmprChartConfigs?.[bldgName]?.chartConfigs?.find((c: any) => c.id === chartId)?.timeRange?.start_time as any),
                  6,
                  this.state.selectedTimezone
                )}
                onChange={(e) => {
                  const v = e.currentTarget.value;                                 // wall-clock in selected tz
                  const stored = inputToUtcString(v, this.state.selectedTimezone); // UTC for server/state

                  this.setState((prevState: any) => {
                    const currCfg = prevState.cmprChartConfigs?.[bldgName]?.chartConfigs?.find((c: any) => c.id === chartId);
                    const endToken = currCfg?.timeRange?.end_time ?? "now";
                    const end = toDateOrNull(endToken, new Date());

                    if (end) {
                      const start = parseAbs(stored);
                      const minStart = new Date(end);
                      minStart.setMonth(minStart.getMonth() - 3);
                      if (start >= end || start <= minStart) return null;
                    }

                    const updatedConfigs = prevState.cmprChartConfigs[bldgName].chartConfigs.map((config: any) =>
                      config.id === chartId
                        ? { ...config, timeRange: { ...(config.timeRange ?? {}), start_time: stored } }
                        : config
                    );

                    return {
                      cmprChartConfigs: {
                        ...prevState.cmprChartConfigs,
                        [bldgName]: { ...prevState.cmprChartConfigs[bldgName], chartConfigs: updatedConfigs },
                      },
                    };
                  }, () => this.getVoltData(bldgName));
                }}
              />
            </Label>

            <Label style={{ width: "47%", fontSize: "12pt", margin: "5px 15px" }}>
              <b>End Time</b>
              <InputGroup
                type="datetime-local"
                key={`cmpr-end-${chartId}-${this.state.selectedTimezone}`}
                value={toInputOrDefault(
                  (this.state.cmprChartConfigs?.[bldgName]?.chartConfigs?.find((c: any) => c.id === chartId)?.timeRange?.end_time as any),
                  0,
                  this.state.selectedTimezone
                )}
                onChange={(e) => {
                  const v = e.currentTarget.value;                                 // wall-clock in selected tz
                  const stored = inputToUtcString(v, this.state.selectedTimezone); // UTC for server/state

                  this.setState((prevState: any) => {
                    const currCfg = prevState.cmprChartConfigs?.[bldgName]?.chartConfigs?.find((c: any) => c.id === chartId);
                    const startToken = currCfg?.timeRange?.start_time ?? "now";
                    const start = toDateOrNull(startToken, new Date());

                    if (start) {
                      const end = parseAbs(stored);
                      const maxEnd = new Date(start);
                      maxEnd.setMonth(maxEnd.getMonth() + 3);
                      if (end <= start || end >= maxEnd) return null;
                    }

                    const updatedConfigs = prevState.cmprChartConfigs[bldgName].chartConfigs.map((config: any) =>
                      config.id === chartId
                        ? { ...config, timeRange: { ...(config.timeRange ?? {}), end_time: stored } }
                        : config
                    );

                    return {
                      cmprChartConfigs: {
                        ...prevState.cmprChartConfigs,
                        [bldgName]: { ...prevState.cmprChartConfigs[bldgName], chartConfigs: updatedConfigs },
                      },
                    };
                  }, () => this.getVoltData(bldgName));
                }}
              />
            </Label>
          </div>

          {/* Quick range buttons */}
          {(() => {
            const presets = [
              { label: "Past 1 month", start: "now-1m" },
              { label: "Past 1 week", start: "now-7d" },
              { label: "Past 24 hours", start: "now-24h" },
              { label: "Past 6 hours", start: "now-6h" },
            ];

            const currCfg = this.state.cmprChartConfigs?.[bldgName]?.chartConfigs?.find((c: any) => c.id === chartId);
            const tr = currCfg?.timeRange ?? {};
            const activeStart = presets.find((p) => tr.start_time === p.start && (tr.end_time ?? "now") === "now")?.start;

            return (
              <div className="quick-range">
                {presets.map((p) => (
                  <button
                    key={p.start}
                    type="button"
                    className={`quick-range__btn ${activeStart === p.start ? "is-active" : ""}`}
                    aria-pressed={activeStart === p.start}
                    onClick={() => {
                      this.setState((prevState: any) => {
                        const updated = prevState.cmprChartConfigs[bldgName].chartConfigs.map((config: any) =>
                          config.id === chartId
                            ? { ...config, timeRange: { ...(config.timeRange ?? {}), start_time: p.start, end_time: "now" } }
                            : config
                        );

                        return {
                          cmprChartConfigs: {
                            ...prevState.cmprChartConfigs,
                            [bldgName]: { ...prevState.cmprChartConfigs[bldgName], chartConfigs: updated },
                          },
                        };
                      }, () => this.getVoltData(bldgName));
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            );
          })()}


        </Label>
    );
  };

  handleZoneChartSelect = (unitId:number, chartId: number, selectedVariables: string[]) => {
    this.setState((prevState) => ({
      unitManagerData: {
        ...prevState.unitManagerData,
        [unitId]: {
          ...prevState.unitManagerData[unitId],
          chartConfigs: prevState.unitManagerData[unitId].chartConfigs.map((cfg) =>
            cfg.id === chartId ? { ...cfg, selectedVariables } : cfg
          ),
        },
      },
    }));
  };

  // Filter unitData.lineChartData by the timeRange of a specific chart config
  private filterUnitDataForChart = (unitData: any, chartId: number) => {
    if (!unitData?.lineChartData?.length || !unitData?.chartConfigs?.length) return unitData;

    const cfg = (unitData.chartConfigs as any[]).find((c) => c?.id === chartId);
    const tr: TimeRange | undefined = cfg?.timeRange;

    if (!tr?.start_time && !tr?.end_time) return unitData;

    const now = new Date();
    const start = toDateOrNull(tr.start_time, now);                 // supports now / now-6h / absolute
    const end   = toDateOrNull(tr.end_time ?? "now", now) ?? now;   // default end to now

    const startMs = start ? start.getTime() : -Infinity;
    const endMs   = end ? end.getTime() : Infinity;

    const filtered = (unitData.lineChartData as lineChartDataType[]).filter((pt) => {
      // Filter on the absolute UTC instant so it is timezone-independent.
      // pt.time is wall-clock in the *selected* timezone, so interpreting it as
      // browser-local would shift points and drop them when the selected tz
      // differs from the browser tz. Use timeUtc (true instant) when available.
      const t = pt.timeUtc ? parseAbs(pt.timeUtc) : parseLocalAbs(pt.time);
      if (Number.isNaN(t.getTime())) return false;
      const ms = t.getTime();
      return ms >= startMs && ms <= endMs;
    });

    // If no change, keep original ref
    if (filtered.length === unitData.lineChartData.length) return unitData;

    return { ...unitData, lineChartData: filtered };
  };

  private getEffectiveWindowForChart(unitData: any, chartId: number) {
    const rows: lineChartDataType[] = unitData?.lineChartData ?? [];
    if (!rows.length) return { start: 0, end: -1 };

    const cfg = (unitData?.chartConfigs ?? []).find((c: any) => c?.id === chartId);
    const selected: string[] = cfg?.selectedVariables ?? [];
    if (!selected.length) return { start: 0, end: rows.length - 1 };

    const hasAny = (r: lineChartDataType) =>
      selected.some((k) => {
        const v = r.values?.[k];
        return v !== null && v !== undefined;
      });

    let start = 0;
    let end = rows.length - 1;

    while (start <= end && !hasAny(rows[start])) start++;
    while (end >= start && !hasAny(rows[end])) end--;

    // if everything is null for those selected vars, fall back to full range
    if (start > end) return { start: 0, end: rows.length - 1 };

    return { start, end };
  }

  buildAxisInfo = (unitData: any, chartId: number, spaceType: string, aggOp: string = "_"): AxisInfo[] => {
    if (!unitData) return [];
  
    const chartConfig = (unitData.chartConfigs as { id: number; selectedVariables: string[]; timeRange: TimeRange }[])
      .find((c) => c.id === chartId); 
    if (!chartConfig) return [];
    
    // Resolve any 'now' / 'now-6h' / absolute tokens to strings
    const now = new Date();
    const tr = chartConfig.timeRange ?? {};
    const resolvedStart = toTimeString(tr.start_time, now);
    const resolvedEnd   = toTimeString(tr.end_time,   now);
    const shortAggOp = aggOp  === "average" ? "AVG" : "SUM"

    return chartConfig.selectedVariables.map((outputName) => {
      const values: Array<number | null> = unitData.lineChartData.map(
        ({ values }: { values: Record<string, number | string | null | undefined> }) => {
          const raw = values?.[outputName];

          // keep alignment: missing bucket => null
          if (raw == null) return null;

          if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

          // occupancy string -> numeric (optional)
          if (typeof raw === "string") {
            if (raw === "occupied") return 1;
            if (raw === "unoccupied") return 0;
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
          }

          return null;
        }
      );

      // min/max should ignore nulls
      const numeric = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const yAxisMin = numeric.length ? Math.min(...numeric) : 0;
      const yAxisMax = numeric.length ? Math.max(...numeric) : 1;

      const match =
        spaceType === "building"
          ? this.state.sensorMetadata.find((o) => {
              // if "101_Temp" → use right side, else use full key
              const base = outputName.includes("_")
                ? (outputName.startsWith('bestest_air_') || outputName.startsWith('bestest_hydronic_')
                    ? outputName.split('_').slice(2).join('_')
                    : outputName.split(/_(.+)/)[1])
                : outputName;
              return o.name === base;
            })
          : this.state.sensorMetadata.find((o) => o.name === outputName);

      return {
        name: outputName,
        label:
          spaceType === "building"
            ? (outputName.includes("_")
                ? (outputName.startsWith('bestest_air_') || outputName.startsWith('bestest_hydronic_')
                    ? `[${outputName.split('_').slice(0, 2).join('_')}] ${outputName.split('_').slice(2).join('_')}`
                    : `[${outputName.split(/_(.+)/)[0]}] ${outputName.split(/_(.+)/)[1]}`)
                : `${shortAggOp} - ${(match?.label || outputName)}`)
            : (match?.label || outputName),
        unit: match?.unit || "",
        min: yAxisMin,
        max: yAxisMax,
        values,
      };
    });
  };  

  // Render a Plotly line chart with dual Y-axes for selected outputs
  renderLineChart = (unitData: any, yAxisInfo: any, chartIndex: number) => {
    // Unit setting for line charts
    const primaryUnit = yAxisInfo[0]?.unit;

    let secondaryIndex: number | null = null;
    const chartConfig = unitData.chartConfigs.find((c: { id: number }) => c.id === chartIndex);

    for (let i = 1; i < yAxisInfo.length; i++) {
      if (yAxisInfo[i].unit !== primaryUnit) {
        secondaryIndex = i;
        break;
      }
    }

    // Separate values based on axis assignment
    const primaryYValues = yAxisInfo
      .filter((_: AxisInfo, idx: number) => idx !== (secondaryIndex ?? -1))
      .flatMap((info: AxisInfo) => info.values)
      .filter((v: number | null): v is number => typeof v === "number" && Number.isFinite(v));

    const secondyCutStart = 600
    const secondyCutEnd = 1500
    const secondaryYValues =
      secondaryIndex !== null
        ? yAxisInfo[secondaryIndex].values.filter(
            (v: number | null): v is number =>
              typeof v === "number" && Number.isFinite(v)
          )
          /* .slice(secondyCutStart, secondyCutEnd) */
        : [];


    const getDashStyle = (dash: string | undefined): Plotly.Dash => {
      const valid: Plotly.Dash[] = ["solid", "dot", "dash", "longdash", "dashdot", "longdashdot"];
      return valid.includes(dash as Plotly.Dash) ? (dash as Plotly.Dash) : "solid";
    };

    const { start, end } = this.getEffectiveWindowForChart(unitData, chartIndex);
    const slicedRows =
      end >= start ? unitData.lineChartData.slice(start, end + 1) : unitData.lineChartData;
      
    const xStart = slicedRows[0]?.time;
    const xEnd = slicedRows[slicedRows.length - 1]?.time;

    return (
        <Plot
          key={`${unitData.building}-${chartIndex}`}
          data={yAxisInfo.map((info: AxisInfo, idx: number) => ({
            x: slicedRows.map((d: { time: string }) => d.time),//.split(" ")[1]),
            // x: unitData.lineChartData.slice(secondyCutStart, secondyCutEnd).map((d: { time: string, index: number }) => {
            //   const est = new Date(
            //     new Date(d.time).toLocaleString("en-US", { timeZone: "America/New_York" })
            //   );
            //   if (d.index > 292) {
            //     est.setHours(est.getHours() +1-4)
            //   } else {
            //     est.setHours(est.getHours()-4)
            //   }
            //   return est.toISOString(); 
            // }),
            y: info.values.slice(start, end + 1),//.slice(secondyCutStart, secondyCutEnd),
            type: 'scatter',
            mode: 'lines',
            name: `${info.label} (${info.unit})`,
            line: {
              shape: 'spline',
              color: chartConfig?.vizSettings?.[idx]?.color ?? `hsl(${(idx * 60) % 360}, 70%, 40%)`,
              width: chartConfig?.vizSettings?.[idx]?.line_width ?? 2,
              dash: getDashStyle(chartConfig?.vizSettings?.[idx]?.line_dash)
            },
            yaxis: idx === secondaryIndex ? 'y2' : 'y', 
            hovertemplate: `%{y} ${info.unit}<extra>${info.label}</extra>`,
          }))}
          layout={{
            showlegend: true,
            autosize: true,
            height: 420,
            margin: { l: 40, r: 20, t: 0, b: 130 },
            xaxis: {
              title: {
                text: 'Time (hh:mm:ss)',
                font: { size: 14 },
                standoff: 14,
              },
              range: (xStart && xEnd) ? [xStart, xEnd] : undefined,
              tickfont: { size: 12, family: 'Arial' },
              showline: true,
              tickmode: 'auto',
              nticks: 5
            },
            yaxis: {
              title: {
                text: yAxisInfo[0] ? `${this.unitLabels.find((o) => o.name === yAxisInfo[0].unit)?.label}` : 'Y Axis',
                font: { size: 14 },
                standoff: 10,
              },
              tickfont: { size: 12, family: 'Arial' },
              range: primaryYValues.length
              ?[Math.min(...primaryYValues) * 0.95, Math.max(...primaryYValues) * 1.05]
              : undefined,
              showline: true,
              automargin: true,
            },
            yaxis2: {
              title: {
                text: 
                  secondaryIndex !== null && yAxisInfo[secondaryIndex as number]
                    ? `${this.unitLabels.find((o) => o.name === yAxisInfo[secondaryIndex as number].unit)?.label}`
                    : '',
                font: { size: 14 },
                standoff: 10,
              },
              overlaying: 'y',
              side: 'right', 
              range: secondaryYValues.length
              ? [Math.min(...secondaryYValues) * 0.95, Math.max(...secondaryYValues) * 1.05]
              : undefined,
              tickfont: { size: 12, family: 'Arial' },
              showline: true,
              automargin: true,
            },
            legend: {
              font: { size: 14, family: 'Arial' },
              orientation: 'h',
              x: 0.5,
              y: -0.19,
              xanchor: 'center',
              yanchor: 'top',
            },
          }}
          config={{ responsive: true }}
          useResizeHandler
          style={{ width: '100%', height: '100%' }}
        />
      );

    };


  // Render a Plotly scatter plot for selected outputs
  renderScatterPlot = (unitData: any, axisInfo: any, chartIndex: number) => {

    // Unit setting for line charts
    const xVar = axisInfo[0];
    const yVar = axisInfo[1];
    const chartConfig = unitData.chartConfigs.find((c: { id: number }) => c.id === chartIndex);

    return (
        <Plot
          key={`${unitData.building}-${chartIndex}`}
          data={
            xVar && yVar
              ? (Object.entries(
                  unitData.lineChartData.reduce(
                    (
                      acc: Record<string, { x: number[]; y: number[] }>,
                      point: { values: Record<string, number | string | null | undefined> }
                    ) => {
                      const zoneName = xVar.name.split('_')[0];
                      const occ = (Object.keys(unitData).includes("system")) ? String(point.values["Occupancy"] ?? "unknown") : String(point.values[`${zoneName}_Occupancy`] ?? "unknown");
                      const x = parseFloat(String(point.values[xVar.name]));
                      const y = parseFloat(String(point.values[yVar.name]));
                      if (!isNaN(x) && !isNaN(y)) {
                        acc[occ] = acc[occ] || { x: [], y: [] };
                        acc[occ].x.push(x);
                        acc[occ].y.push(y);
                      }
                      return acc;
                    },
                    {} as Record<string, { x: number[]; y: number[] }>
                  )
                ) as [string, { x: number[]; y: number[] }][]).map(([occ, coords], idx) => ({
                  x: coords.x,
                  y: coords.y,
                  type: 'scatter',
                  mode: 'markers',
                  name: `${occ}`,
                  marker: {
                    color: chartConfig?.vizSettings?.[occ]?.color ?? `hsl(${(idx * 90) % 360}, 70%, 40%)`,
                    size: chartConfig?.vizSettings?.[occ]?.marker_size ?? 6,
                    symbol: chartConfig?.vizSettings?.[occ]?.marker_symbol ?? "circle"
                  },
                  xaxis: 'x',
                  yaxis: 'y', 
                  hovertemplate: `%{x} ${xVar.unit}, %{y} ${yVar.unit}<br>Occupancy: ${occ}`,
                }))
              : []}
          layout={{
            autosize: true,
            height: 370,
            margin: { l: 40, r: 20, t: 0, b: 80 },

            xaxis: {
              title: {
                text: xVar ? `${xVar.label} (${xVar.unit})` : 'X Axis',
                font: { size: 14 },
                standoff: 14,
              },
              tickfont: { size: 12, family: 'Arial' },
              range:
                xVar?.values?.length
                  ? [Math.min(...xVar.values) * 0.99, Math.max(...xVar.values) * 1.01]
                  : undefined,
              showline: true,
              tickmode: 'auto',
              nticks: 5
            },
            yaxis: {
              title: {
                text: yVar ? `${yVar.label} (${yVar.unit})` : 'Y Axis',
                font: { size: 14 },
                standoff: 10,
              },
              tickfont: { size: 12, family: 'Arial' },
              range:
                yVar?.values?.length
                  ? [Math.min(...yVar.values) * 0.99, Math.max(...yVar.values) * 1.01]
                  : undefined,
              showline: true,
              automargin: true,
            },

            legend: {
              font: { size: 14, family: 'Arial' },
              orientation: 'h',
              x: 0.5,
              y: -0.19,
              xanchor: 'center',
              yanchor: 'top',
            },
          }}
          config={{ responsive: true }}
          useResizeHandler
          style={{ width: '100%', height: '100%' }}
        />
      );

    };

  // Render a Plotly box plot with a selected outputs
  renderBoxPlot = (unitData: any, axisInfo: any, chartIndex: number) => {
    const yVar = axisInfo[0];
    const chartConfig = unitData.chartConfigs.find((c: { id: number }) => c.id === chartIndex);
    const chartKey = (Object.keys(unitData).includes("system")) ? `${unitData.id}-${chartIndex}` : `${unitData.building}-${chartIndex}`;
    
    return (
        <Plot
          key={chartKey}
          data={
            yVar
              ? (Object.entries(
                  unitData.lineChartData.reduce(
                    (
                      acc: Record<string, { x: string[]; y: number[] }>,
                      point: { time: string; values: Record<string, number | string | null | undefined> }
                    ) => {
                      const pointDate = parseLocalAbs(point.time);
                      if (Number.isNaN(pointDate.getTime())) return acc;
                      const hour = pointDate.getHours();
                      const zoneName = yVar.name.startsWith('bestest_air') || yVar.name.startsWith('bestest_hydronic')
                        ? yVar.name.split('_').slice(0, 2).join('_')
                        : yVar.name.split('_')[0];
                      const occ = (Object.keys(unitData).includes("system")) ? String(point.values["Occupancy"] ?? "unknown") : String(point.values[`${zoneName}_Occupancy`] ?? "unknown");
                      const y = parseFloat(String(point.values[yVar.name]));
                      if (hour < 6 || hour > 20 || isNaN(y)) return acc;
                      acc[occ] ??= { x: [], y: [] };
                      acc[occ].x.push(`Hour ${hour}`);
                      acc[occ].y.push(y);
                      return acc;
                    },
                    {} as Record<string, { x: string[]; y: number[] }>
                  )
                ) as Array<[string, { x: string[]; y: number[] }]>)
                  .map(([occ, coords], occIndex) => ({
                    x: coords.x,
                    y: coords.y,
                    type: 'box',
                    name: occ,
                    marker: {
                      color: chartConfig?.vizSettings?.[occ]?.color ?? `hsl(${(occIndex * 90) % 360}, 70%, 40%)`,
                      size: chartConfig?.vizSettings?.[occ]?.marker_size ?? 6,
                    },
                    line: { width: chartConfig?.vizSettings?.[occ]?.line_width ?? 2 },
                    boxpoints: 'outliers',
                    hovertemplate: `%{y}<br>Occupancy: ${occ}`,
                  }))
              : []
          }
          layout={{
            autosize: true,
            height: 390,
            margin: { l: 40, r: 20, t: 0, b: 100 },

            xaxis: {
              title: {
                text: 'Hour of Day',
                font: { size: 14 },
                standoff: 14,
              },
              tickfont: { size: 12, family: 'Arial' },
              categoryorder: 'array',
              categoryarray: [
                'Hour 6', 'Hour 7', 'Hour 8', 'Hour 9', 'Hour 10',
                'Hour 11', 'Hour 12', 'Hour 13', 'Hour 14', 'Hour 15',
                'Hour 16', 'Hour 17', 'Hour 18', 'Hour 19', 'Hour 20'
              ],
              showline: true,
            },
            yaxis: {
              title: {
                text: yVar ? `${yVar.label} (${yVar.unit})` : 'Y Axis',
                font: { size: 14 },
                standoff: 10,
              },
              tickfont: { size: 12, family: 'Arial' },
              range:
                yVar?.values?.length
                  ? [Math.min(...yVar.values) * 0.99, Math.max(...yVar.values) * 1.01]
                  : undefined,
              showline: true,
              automargin: true,
            },
            boxmode: 'group',
            legend: {
              font: { size: 14, family: 'Arial' },
              orientation: 'h',
              x: 0.5,
              y: -0.26,
              xanchor: 'center',
              yanchor: 'top',
            },
          }}
          config={{ responsive: true }}
          useResizeHandler
          style={{ width: '100%', height: '100%' }}
        />
      );

    };

    unitLabels = [
      {name: "°F", label: "Temperature (°F)"},
      {name: "[0-1]", label: "Control signal ([0,1])"},
      {name: "on/off", label: "Pump stage (on/off)"},
      {name: "kg/s", label: "Supply air flow rate (kg/s)"},
      {name: "ppm", label: "CO2 concentration (ppm)"},
      {name: "W", label: "Power consumption (W)"},
      {name: "CFM", label: "Supply air flow rate (CFM)"},
      {name: "A", label: "Electric current (A)"},
      {name: "V", label: "Electric voltage (V)"}
    ]

    updateDataTimeRange = (unitId: string | number) => {
      const now = new Date();
      const defaultStart = new Date(now.getTime() - 6 * 60 * 60 * 1000);
      const defaultEnd = new Date(now.getTime());

      const unit = this.state.unitManagerData?.[unitId as any];
      if (!unit) return { start_time: fmt(defaultStart), end_time: fmt(defaultEnd) };

      const bldgName = String(unit.building ?? "");

      const zoneCharts = unit?.chartConfigs ?? [];
      const bldgCharts = this.state.bldgChartConfigs?.[bldgName]?.chartConfigs ?? [];
      const cmprChartsAll = this.state.cmprChartConfigs?.[bldgName]?.chartConfigs ?? [];
      const sysPrefix = `${String(unit.system ?? "")}_`;
      const cmprCharts = sysPrefix.trim()
        ? cmprChartsAll.filter((cfg: any) =>
            (cfg?.selectedVariables ?? []).some((v: any) => String(v).startsWith(sysPrefix))
          )
        : [];

      const charts = [...zoneCharts, ...bldgCharts, ...cmprCharts];

      let earliest: Date | null = null;
      let latest: Date | null = null;
      let endIsNow = false;

      charts.forEach((cfg: any) => {
        const tr = cfg?.timeRange ?? {};

        const s = toDateOrNull(tr.start_time, defaultEnd);
        if (s && (!earliest || s < earliest)) earliest = s;

        if (tr.end_time === "now") {
          endIsNow = true;
        } else {
          const e = toDateOrNull(tr.end_time, defaultEnd);
          if (e && (!latest || e > latest)) latest = e;
        }
      });

      if (endIsNow) latest = defaultEnd;

      const dataTimeRange = {
        start_time: fmt(earliest ?? defaultStart),
        end_time: fmt(latest ?? defaultEnd),
      };

      this.setState((prev: any) => ({
        unitManagerData: {
          ...prev.unitManagerData,
          [unitId]: { ...prev.unitManagerData[unitId], dataTimeRange },
        },
      }));

      return dataTimeRange;
    };


    // Retrieve sensor data only for a specific building
    getVoltData = async (bldgName?: string | null) => {
      if (!bldgName) return;

      // ✅ Must be opened/selected; if not open, do nothing
      if (!this.state.openBuildings?.[bldgName]) return;

      // Only units in this building
      const unitIdsInBldg = Object.keys(this.state.unitManagerData)
        .map(Number)
        .filter((unitId) => this.state.unitManagerData?.[unitId]?.building === bldgName);

      if (unitIdsInBldg.length === 0) return;

      // Update only those units' config ranges — collect promises
      const configUpdates: Promise<any>[] = [];

      for (const unitId of unitIdsInBldg) {
        const dataTimeRange = this.updateDataTimeRange(unitId);

        const propsUnit = (this.props.units || []).find((u: any) => u?.id === unitId);
        const configId = propsUnit?.configuration?.id ?? propsUnit?.configurationId;
        if (!configId) continue;

        const p: any = this.props.updateConfiguration?.({
          id: configId,
          dataTimeRange: dataTimeRange ?? {},
        } as any);

        if (p && typeof p.then === "function") configUpdates.push(p);
      }

      // Wait for all DB writes to complete, then fetch
      await Promise.all(configUpdates);

      // Fetch sensor data once, but apply only to the building's units
      readSensors().then((res) => {
        console.log("res: ", res);

        if (this.state.sensorMetadata.length === 0) {
          this.setState({ sensorMetadata: res.metadata });
        }

        for (const unitId of unitIdsInBldg) {
          const unitData = this.state.unitManagerData[unitId];
          const unitSystem = unitData.system;

          const resSensorDataRaw =
            (Object.values(res.sensorData).find((entry: any) => entry.system === unitSystem) as {
              ctrlValues: Record<string, number | string>;
              lineChartData: lineChartDataType[];
            }) || { ctrlValues: {}, lineChartData: [] };

          const resSensorData = {
            ...resSensorDataRaw,
            lineChartData: (resSensorDataRaw.lineChartData || []).map((row) => ({
              ...row,
              timeUtc: row.time,  // Store original UTC time
              time: utcStringToLocalString(row.time, this.state.selectedTimezone),
            })),
          };

          this.setState((prevState) => {
            const existing = prevState.unitManagerData[unitId] || { id: unitId };
            return {
              unitManagerData: {
                ...prevState.unitManagerData,
                [unitId]: {
                  ...existing,
                  ...unitData,
                  ctrlValues: resSensorData.ctrlValues,
                  lineChartData: resSensorData.lineChartData,
                },
              },
            };
          });

          if (!unitData?.varList?.length) {
            this.setState(prevState => {
              const unitData = prevState.unitManagerData[unitId];
              const rows = unitData?.lineChartData;
              const firstRow = Array.isArray(rows) && rows.length ? rows[0] : undefined;
              const keys =
                firstRow && typeof firstRow === "object"
                  ? (firstRow as any).values
                    ? Object.keys((firstRow as any).values)
                    : Object.keys(firstRow as any)
                  : [];
            const unitVarList = keys.filter((k) => k !== "time");

            return {
                unitManagerData: {
                  ...prevState.unitManagerData,
                  [unitId]: { ...unitData, varList: unitVarList }
                },
              }; 
            });
          };          
        }
      });
    };   

    // Initialize default unit manager configuration for each unit
    initializeUnitData = () => {

      const withTimeRangeEverywhere = (chartConfigs: any) => {
        const tr = {};

        if (Array.isArray(chartConfigs)) {
          return chartConfigs.map(it => ({ ...it, timeRange: it?.timeRange ?? tr }));
        }

        if (chartConfigs && typeof chartConfigs === "object") {
          return Object.fromEntries(
            Object.entries(chartConfigs).map(([k, v]: [string, any]) => [
              k,
              { ...(v ?? {}), timeRange: v?.timeRange ?? tr },
            ])
          );
        }

        // if undefined/null, initialize as empty array (or {} if that's your schema)
        return [];
      };


      if (this.state.startCollect && this.props.units) {
        this.setState({ startCollect: false });
        const newUnitManagerData: UnitsState["unitManagerData"] = {};
        const newBldgChartConfigs: UnitsState["bldgChartConfigs"] = {};
        const newCmprChartConfigs: UnitsState["cmprChartConfigs"] = {};


        for (const unit of this.props.units || []) {
          if (!unit?.id) continue;

          const u = unit as any;
          const configId = u?.configuration?.id ?? u?.configurationId;
          
          const current = u?.configuration?.chartConfigs;
          const nextChartConfigs = withTimeRangeEverywhere(current);
          
          // dataTimeRange and chartConfigs are UI-only state; do NOT send to server
          // on page load, as that sets stage=UpdateType and triggers control signals.

          const unitId = unit.id;
          const bldgName = unit.building;
          const defaultChartConfigs = convertChartConfigs((unit.configuration as any)?.chartConfigs);

          newUnitManagerData[unitId] = {
            id: unitId,
            building: bldgName,
            system: unit.system,
            dataTimeRange: {},
            varList: [],
            ctrlValues: {},
            chartConfigs: defaultChartConfigs, //[{ id: 0, type: "line", selectedVariables: [] }], 
            lineChartData: [
              { index: 0, time: "2025-01-01 00:00:00", values: {con_oveTSetCoo_u: 60} },
              { index: 1, time: "2025-01-01 00:00:00", values: {con_oveTSetCoo_u: 62} },
              { index: 2, time: "2025-01-01 00:00:00", values: {con_oveTSetCoo_u: 66} },
              { index: 3, time: "2025-01-01 00:00:00", values: {con_oveTSetCoo_u: 64} },
            ],
          };

          newBldgChartConfigs[bldgName] = {
            chartConfigs: [{ id: BLDG_CHART_OFFSET, type: "line", selectedVariables: [], timeRange: {}, aggOp: "average" }],
            };
          newCmprChartConfigs[bldgName] = {
            chartConfigs: [{ id: CMPR_CHART_OFFSET, type: "line", selectedVariables: [], timeRange: {} }],
            };

        }
        const allBldgNames = Object.keys(newBldgChartConfigs);
        this.setState(prevState => ({
          unitManagerData: {
            ...prevState.unitManagerData,
            ...newUnitManagerData,
          },
          bldgChartConfigs: {
            ...prevState.bldgChartConfigs,
            ...newBldgChartConfigs,
          },
          cmprChartConfigs: {
            ...prevState.cmprChartConfigs,
            ...newCmprChartConfigs,
          },
          openBuildings: {
            ...(prevState.openBuildings || {}),
            ...Object.fromEntries(allBldgNames.map((b) => [b, true])),
          },
        }));
      }
    };

  render() {
    const { filtered, configurations } = this.props;
    const { editingAll, editing, expanded, expandedBuilding} = this.state;
    const copy = cloneDeep(filtered) ?? [];
    copy.forEach((v) => {
      v.configuration!.holidays = HolidayType.values.map(
        (t) => v.configuration?.holidays?.find((h) => h?.label === t.label) ?? {}
      );
    });

    filtered?.forEach((unit) => {
      const id = String(unit.id);
      if (!this.unitRefs[id]) {
        this.unitRefs[id] = React.createRef<HTMLDivElement>();
      }
    });    

    const defaultUnit = {
      location: filtered
        ? getCommon(
            filtered.map((f) => f.location ?? {}),
            ["createdAt", "updatedAt", "action", "terms"]
          )
        : {},
      configuration: {
        holidays: HolidayType.values.map((t) =>
          filtered
            ? getCommon(
                filtered.map((f) => f.configuration?.holidays?.find((h) => h?.label === t.label) ?? {}),
                ["createdAt", "updatedAt", "action", "terms"]
              )
            : {}
        ),
      },
    };

    const campusGroups = (filtered ?? []).reduce((acc: Record<string, Record<string, IUnit[]>>, unit) => {
      const campus = unit.campus || "Unknown";
      const bldg   = unit.building || "Unknown";
      (acc[campus] ??= {});
      (acc[campus][bldg] ??= []).push(unit);
      return acc;
    }, {});

    // Filter to the single campus/building from query params (navigated from Home)
    const qsParams = new URLSearchParams(this.props.location?.search ?? "");
    const qsCampusFilter = qsParams.get("campus");
    const qsBuildingFilter = qsParams.get("building");

    if (qsCampusFilter) {
      const allCampusIds = Object.keys(campusGroups);
      const matchKey = allCampusIds.find(
        (id) => id.toLowerCase() === qsCampusFilter.toLowerCase()
      );
      if (matchKey) {
        for (const key of allCampusIds) {
          if (key !== matchKey) delete campusGroups[key];
        }
        if (qsBuildingFilter) {
          const bldgNames = Object.keys(campusGroups[matchKey]);
          const matchBldg = bldgNames.find(
            (n) => n.toLowerCase() === qsBuildingFilter.toLowerCase()
          );
          if (matchBldg) {
            campusGroups[matchKey] = { [matchBldg]: campusGroups[matchKey][matchBldg] };
          } else {
            // Try matching against unit system values (e.g., "Zone 2" → "zone-2")
            const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
            const qsNorm = normalize(qsBuildingFilter);
            const systemMatch = bldgNames.find((bldgName) =>
              campusGroups[matchKey][bldgName].some(
                (u: any) => normalize(u.system ?? "") === qsNorm
              )
            );
            if (systemMatch) {
              campusGroups[matchKey] = { [systemMatch]: campusGroups[matchKey][systemMatch] };
            } else {
              delete campusGroups[matchKey];
            }
          }
        }
      } else {
        for (const key of allCampusIds) delete campusGroups[key];
      }
    }

    const campusIds = Object.keys(campusGroups).sort();

    return (
      <div className={"dashboard"}>
        {this.renderPrompt()}
        <Header {...this.props} />
        {/* {defaultUnit && (
          <div className="list padding update-all-units">
            <Card interactive>
              <div className="row">
                <div>
                  <Label>
                    <h3>Update All Units</h3>
                  </Label>
                </div>
                <div>
                  {this.isSave(defaultUnit, editingAll) ? (
                    <>
                      <Tooltip2 content="Save" placement={Position.TOP}>
                        <Button
                          icon={IconNames.FLOPPY_DISK}
                          intent={Intent.PRIMARY}
                          minimal
                          onClick={() => this.handleSaveAll()}
                        />
                      </Tooltip2>
                      <Tooltip2 content="Exit" placement={Position.TOP}>
                        <Button
                          icon={IconNames.CROSS}
                          intent={Intent.PRIMARY}
                          minimal
                          onClick={() => this.handleClearAll()}
                        />
                      </Tooltip2>
                    </>
                  ) : null}
                </div>
              </div>
              <div>
                <Tree
                  contents={[
                    {
                      id: "holidays-all",
                      label: "Holidays",
                      icon: IconNames.SERIES_CONFIGURATION,
                      hasCaret: true,
                      isExpanded: expanded === "holidays-all",
                    },
                  ]}
                  onNodeExpand={(e) => this.setState({ expanded: e.id as string })}
                  onNodeCollapse={() => this.setState({ expanded: null })}
                  onNodeClick={(e) => this.setState({ expanded: e.id === expanded ? null : (e.id as string) })}
                />
                <Collapse isOpen={expanded === "holidays-all"}>
                  <Label>
                    <h3>Predefined Holidays</h3>
                    <ul>
                      {defaultUnit?.configuration?.holidays?.map((holiday, i) => (
                        <li key={holiday?.label ?? i}>
                          <Holiday
                            key={holiday?.label}
                            path={`configuration.holidays.${i}`}
                            unit={defaultUnit}
                            editing={editingAll}
                            holiday={holiday!}
                            handleChange={this.handleChange}
                            readOnly={!this.isAdmin() && this.isReadOnlyUser()}
                          />
                        </li>
                      ))}
                    </ul>
                  </Label>
                </Collapse>
              </div>
            </Card>
          </div>
        )} */}

        <h1>Building Units</h1>
        <Card elevation={1}>
            {campusIds.map((campusId) => {
              return (
                    <div key={campusId} className="list campus-panel">
                      {Object.keys(campusGroups[campusId]).sort()
                      .map((bldgName) => {
                        const unitsInBldg = campusGroups[campusId][bldgName];
                        const isOpen = true;
                        const isOpenBuildingControl = !!this.state.openBuildingControl?.[bldgName];
                        const isOpenBuildingMonitoring = !!this.state.openBuildingMonitoring?.[bldgName];
                        const isOpenZoneComparison = !!this.state.openZoneComparison?.[bldgName];
                        const isOpenZoneControl = !!this.state.openZoneControl?.[bldgName];
                        const isOpenZoneMonitoring = !!this.state.openZoneMonitoring?.[bldgName];

                        const zoneCount = unitsInBldg.length;

                        return (
                          // Building lists
                          <Card key={`bldg-${campusId}-${bldgName}`} interactive style={{ marginBottom: "2rem" }}>
                            <div className="row" style={{ alignItems: "center" }}>
                              <div className="col-md-12" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                <Icon icon={IconNames.OFFICE} />
                                <h3 style={{ margin: 0 }}>{bldgName}</h3>
                                <Tag minimal round>{zoneCount} zone{zoneCount !== 1 ? "s" : ""}</Tag>

                                <Tooltip2
                                  content={this.state.pollSensorData ? "Auto-refresh sensor data: ON" : "Auto-refresh sensor data: OFF"}
                                  placement={Position.TOP}
                                >
                                  <Switch
                                    inline
                                    checked={this.state.pollSensorData}
                                    label="Auto Refresh"
                                    onChange={() =>
                                      this.setState(
                                        (prev) => ({ pollSensorData: !prev.pollSensorData }),
                                        () => {
                                          if (this.state.pollSensorData) this.getVoltData(bldgName);
                                        }
                                      )
                                    }
                                    style={{ marginLeft: 12, marginBottom: 0 }}
                                  />
                                </Tooltip2>
                              </div>
                              

                            </div>

                            {isOpen && this.isManager() && (() => {
                              const buildingKey = `${campusId}::${bldgName}`;
                              const defaultBldgUnit = unitsInBldg?.find((u) => u?.configuration?.holidays?.length) ?? unitsInBldg?.[0];
                              const holidaysNodeId = `holidays-building-${buildingKey}`;
                              const setpointsNodeId = `setpoints-building-${buildingKey}`;
                              const schedulesNodeId = `schedules-building-${buildingKey}`;
                              const occupanciesNodeId = `occupancies-building-${buildingKey}`;

                              const selectedCampus: any =  (campuses as any[]).find((c: any) => c?.id === campusId.toLowerCase() || c?.name === campusId);
                              const selectedBldg: any = selectedCampus?.buildings?.find(
                                (b: any) => b?.id === bldgName.toLowerCase() || b?.name === bldgName
                              );

                              return (
                                  <div style={{ marginBottom: "2rem" }}>
                                    <div className="row" style={{ paddingLeft: 15, paddingBottom: 15, paddingTop: 5}}>
                                      <div className="col-md-6" style={{ padding: 0, margin: 0}}>
                                        <h2>Building Info</h2>
                                      </div>
                                      <div className="col-md-6" style={{ padding: 0, marginTop: 20, paddingRight: 12, display: "flex", justifyContent: "flex-end" }}>
                                        <Tooltip2 content="Select timezone for chart display" placement={Position.TOP}>
                                          <Label style={{ marginLeft: 24, marginBottom: 0, display: "flex", alignItems: "center", gap: "8px" }}>
                                            <span style={{ fontSize: "0.95em" }}>Timezone:</span>
                                            <HTMLSelect
                                              value={this.state.selectedTimezone}
                                              onChange={(e) => {
                                                const newTz = e.currentTarget.value;
                                                this.setState((prevState) => {
                                                  const updatedUnitManagerData = { ...prevState.unitManagerData };
                                                  // Recalculate all times with new timezone (don't refetch)
                                                  for (const unitId in updatedUnitManagerData) {
                                                    const unit = updatedUnitManagerData[unitId];
                                                    if (unit.lineChartData) {
                                                      unit.lineChartData = unit.lineChartData.map((row: any) => ({
                                                        ...row,
                                                        time: utcStringToLocalString(row.timeUtc || row.time, newTz),
                                                      }));
                                                    }
                                                  }
                                                  return {
                                                    selectedTimezone: newTz,
                                                    unitManagerData: updatedUnitManagerData,
                                                  };
                                                });
                                              }}
                                              options={[
                                                { label: "America/New_York (EST)", value: "America/New_York" },
                                                { label: "America/Chicago (CST)", value: "America/Chicago" },
                                                { label: "America/Denver (MST)", value: "America/Denver" },
                                                { label: "America/Los_Angeles (PST)", value: "America/Los_Angeles" },
                                                { label: "UTC", value: "UTC" },
                                                { label: "Europe/London", value: "Europe/London" },
                                                { label: "Europe/Paris", value: "Europe/Paris" },
                                                { label: "Asia/Tokyo", value: "Asia/Tokyo" },
                                                { label: "Asia/Shanghai", value: "Asia/Shanghai" },
                                                { label: "Australia/Sydney", value: "Australia/Sydney" },
                                              ]}
                                              style={{ minWidth: "200px", marginBottom: 0 }}
                                            />
                                          </Label>
                                        </Tooltip2>
                                      </div>
                                    </div>
                                    <div className="row">                                      
                                      <div className="col-md-6">
                                        <div className="row">                                          
                                          {selectedCampus?.id.toLowerCase() === "arizona" ? (
                                            <>
                                            <img className="bldg-image" src={selectedCampus?.imageUrl || "/images/placeholder_building.png"} alt={`Image for ${bldgName}`}/>
                                            <TextArea
                                              value={selectedCampus?.description || `Building '${bldgName}' on '${selectedCampus}'`}
                                              readOnly
                                              fill
                                              growVertically
                                              large
                                            />
                                            </>
                                          ) : (
                                            <>
                                            <img className="bldg-image" src={selectedBldg?.imageUrl || "/images/placeholder_building.png"} alt={`Image for ${bldgName}`}/>
                                            <TextArea
                                              value={selectedBldg?.description || `This is the '${bldgName}' on the '${selectedCampus.name}'`}
                                              readOnly
                                              fill
                                              growVertically
                                              large
                                            />
                                            </>
                                          )}
                                        </div>
                                      </div>
                                      <div className="col-md-6" key={`bldg-chart-wrap-${bldgName}`}>
                                        <h2 style={{ marginTop: 4.5, marginBottom: "1rem" }}>Building Monitoring</h2>

                                        <div className="row" style={{ marginBottom: "0.5rem", marginTop: "2.5rem" }}>
                                          <div className="col-md-10" style={{ display: "flex", alignItems: "center", gap: "8px", paddingLeft: 0 }}>
                                            <h3 style={{ margin: 0 }}>Building Aggregated Chart</h3>
                                          </div>
                                          <div className="col-md-2" style={{ textAlign: "right", paddingRight: 0 }}>
                                            <Button
                                              minimal
                                              icon={isOpenBuildingMonitoring ? IconNames.CARET_DOWN : IconNames.CARET_RIGHT}
                                              onClick={() =>
                                                this.setState((prev) => ({
                                                  openBuildingMonitoring: {
                                                    ...(prev.openBuildingMonitoring || {}),
                                                    [bldgName]: !isOpenBuildingMonitoring,
                                                  },
                                                  openZoneComparison: {
                                                    ...(prev.openZoneComparison || {}),
                                                    [bldgName]: !isOpenBuildingMonitoring ? false : (prev.openZoneComparison?.[bldgName] ?? false),
                                                  },
                                                }))
                                              }
                                            />
                                          </div>
                                        </div>
                                        <Collapse isOpen={isOpenBuildingMonitoring}>
                                          <div className="row">
                                            {(this.state.bldgChartConfigs[bldgName]?.chartConfigs ?? []).map((chart) => {
                                              const aggOp =
                                                (this.state.bldgChartConfigs[bldgName]?.chartConfigs ?? []).find(c => c.id === chart.id)?.aggOp ?? "average";

                                              const rawUnitData = this.toBuildingAggregatedData(this.state.unitManagerData, bldgName, aggOp);
                                              const unitDataForChart = this.filterUnitDataForChart(rawUnitData, chart.id); 

                                              const lineChartData = rawUnitData?.lineChartData?.[0] ?? { index: 0, time: "", values: {} };
                                              const axisInfo = this.buildAxisInfo(unitDataForChart, chart.id, "building", aggOp); 
                                              const buildingName = unitsInBldg[0]?.building!;

                                              return (
                                                <div key={`bldg-${bldgName}-chart-${chart.id}`} style={{ marginBottom: "10px" }}>
                                                  <div className="select">
                                                    {this.renderBldgChartSelect(
                                                      buildingName,
                                                      chart.id,
                                                      `Building-Level Chart`,
                                                      lineChartData,
                                                      chart.selectedVariables,
                                                      (newSelection) => this.handleBldgChartSelect(bldgName, chart.id, newSelection)
                                                    )}
                                                  </div>
                                                  <div style={{ position: "relative" }}>
                                                    {this.renderLineChart(unitDataForChart, axisInfo, chart.id)}
                                                    {axisInfo.length === 0 && (
                                                      <div style={{
                                                        position: "absolute",
                                                        inset: 0,
                                                        display: "flex",
                                                        alignItems: "flex-start",
                                                        justifyContent: "center",
                                                        color: "#8a9ba8",
                                                        fontStyle: "italic",
                                                        fontSize: "1.3em",
                                                        pointerEvents: "none",
                                                        textAlign: "center",
                                                        lineHeight: 1.5,
                                                        paddingTop: "18%",
                                                        paddingLeft: "5%",
                                                      }}>
                                                        Select a variable above<br/>to display a chart.
                                                      </div>
                                                    )}
                                                  </div>
                                                </div>
                                              );
                                            })}

                                          </div>
                                        </Collapse>

                                        <div className="row" style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
                                          <div className="col-md-10" style={{ display: "flex", alignItems: "center", gap: "8px", paddingLeft: 0 }}>
                                            <h3 style={{ margin: 0 }}>Room Details for Comparison</h3>
                                          </div>
                                          <div className="col-md-2" style={{ textAlign: "right", paddingRight: 0 }}>
                                            <Button
                                              minimal
                                              icon={isOpenZoneComparison ? IconNames.CARET_DOWN : IconNames.CARET_RIGHT}
                                              onClick={() =>
                                                this.setState((prev) => ({
                                                  openZoneComparison: {
                                                    ...(prev.openZoneComparison || {}),
                                                    [bldgName]: !isOpenZoneComparison,
                                                  },
                                                  openBuildingMonitoring: {
                                                    ...(prev.openBuildingMonitoring || {}),
                                                    [bldgName]: !isOpenZoneComparison ? false : (prev.openBuildingMonitoring?.[bldgName] ?? false),
                                                  },
                                                }))
                                              }
                                            />
                                          </div>
                                        </div>
                                        <Collapse isOpen={isOpenZoneComparison}>
                                          <div style={{ display: "flex" }}>
                                            <h4 style={{ marginLeft: "1.5rem", marginTop: "0.8rem", marginRight: "0.5rem" }}>Add/Remove: </h4>
                                            <div style={{ marginTop: "0.3rem", marginLeft: "1%" }}>
                                              <Tooltip2 content="Add Chart" placement={Position.BOTTOM}>
                                                <Button
                                                  icon={IconNames.PLUS}
                                                  intent={Intent.PRIMARY}
                                                  small
                                                  className="custom-button"
                                                  onClick={() => this.addBldgChart(bldgName)}
                                                />
                                              </Tooltip2>
                                              <Tooltip2 content="Remove Last Chart" placement={Position.BOTTOM}>
                                                <Button
                                                  icon={IconNames.MINUS}
                                                  intent={Intent.PRIMARY}
                                                  small
                                                  className="custom-button"
                                                  onClick={() => this.removeBldgChart(bldgName)}
                                                />
                                              </Tooltip2>
                                            </div>
                                            <div style={{ marginTop: "0.6%", marginLeft: "1%" }}><HelpIcon text="Add a new independent chart panel with its own variable selection and time range. Remove deletes the last chart." /></div>
                                          </div>
                                          <div className="row">
                                            {(this.state.cmprChartConfigs[bldgName]?.chartConfigs ?? []).map((chart) => {
                                              const rawUnitData = this.toBuildingData(this.state.unitManagerData, bldgName);
                                              const unitDataForChart = this.filterUnitDataForChart(rawUnitData, chart.id); 

                                              const lineChartData = rawUnitData?.lineChartData?.[0] ?? { index: 0, time: "", values: {} }
                                              const axisInfo = this.buildAxisInfo(unitDataForChart, chart.id, "building"); 
                                              const buildingName = unitsInBldg[0]?.building!;

                                              return (
                                                <div key={`cmpr-${bldgName}-chart-${chart.id}`} style={{ marginBottom: "10px" }}>
                                                  <div className="select">
                                                    {this.renderCmprChartSelect(
                                                      buildingName,
                                                      chart.id,
                                                      `Comparison Chart ${chart.id + 1 - CMPR_CHART_OFFSET}`,
                                                      lineChartData,
                                                      chart.selectedVariables,
                                                      (newSelection) => this.handleCmprChartSelect(bldgName, chart.id, newSelection)
                                                    )}
                                                  </div>
                                                  <div style={{ position: "relative" }}>
                                                    {this.renderLineChart(unitDataForChart, axisInfo, chart.id)}
                                                    {axisInfo.length === 0 && (
                                                      <div style={{
                                                        position: "absolute",
                                                        inset: 0,
                                                        display: "flex",
                                                        alignItems: "flex-start",
                                                        justifyContent: "center",
                                                        color: "#8a9ba8",
                                                        fontStyle: "italic",
                                                        fontSize: "1.3em",
                                                        pointerEvents: "none",
                                                        textAlign: "center",
                                                        lineHeight: 1.5,
                                                        paddingTop: "18%",
                                                        paddingLeft: "5%",
                                                      }}>
                                                        Select one or more variable above<br/>to display a chart.
                                                      </div>
                                                    )}
                                                  </div>
                                                </div>
                                              );
                                            })}

                                          </div>
                                        </Collapse>
                                        <div className="row" style={{ marginTop: "1.5rem", marginBottom: "1rem" }}>
                                          <div className="col-md-6" style={{ padding: 0 }}><h2 style={{ marginTop: 5 }}>Building Control</h2></div>
                                          <div className="col-md-6" style={{ textAlign: "right", marginTop: 5, paddingRight: 0 }}>
                                            {this.renderStatusBuilding(bldgName)}

                                            <Tooltip2 content="Save" placement={Position.TOP} disabled={!this.isSaveBuilding(bldgName)}>
                                              <Button
                                                icon={IconNames.FLOPPY_DISK}
                                                intent={Intent.PRIMARY}
                                                minimal
                                                onClick={() => {
                                                  this.ensureBuildingEditor(buildingKey);
                                                  this.handleSaveBuilding(campusId, bldgName);
                                                }}
                                                disabled={!this.isSaveBuilding(bldgName)}
                                              />
                                            </Tooltip2>

                                            <Tooltip2 content="Exit" placement={Position.TOP}>
                                              <Button
                                                icon={IconNames.CROSS}
                                                intent={Intent.PRIMARY}
                                                minimal
                                                onClick={() => {
                                                  this.ensureBuildingEditor(buildingKey);
                                                  this.handleCancelBuilding(bldgName);
                                                }}
                                                disabled={!this.isSaveBuilding(bldgName)}
                                              />
                                            </Tooltip2>
                                          </div>
                                        </div>

                                      <>
                                        <Tree
                                          contents={[
                                            {
                                              id: setpointsNodeId,
                                              label: "Setpoints",
                                              icon: IconNames.TEMPERATURE,
                                              hasCaret: true,
                                              isExpanded: expandedBuilding === setpointsNodeId,
                                            },
                                          ]}
                                          onNodeExpand={(e) => {
                                            this.ensureBuildingEditor(buildingKey);
                                            this.setState({ expandedBuilding: e.id as string });
                                          }}
                                          onNodeCollapse={() => this.setState({ expandedBuilding: null })}
                                          onNodeClick={(e) => {
                                            if (e.id !== expandedBuilding) this.ensureBuildingEditor(buildingKey);
                                            this.setState({ expandedBuilding: e.id === expandedBuilding ? null : (e.id as string) });
                                          }}
                                        />
                                        <Collapse isOpen={expandedBuilding === setpointsNodeId}>
                                          <div style={{ marginTop: "20px" }}>
                                            <Setpoints
                                              unit={defaultBldgUnit!}
                                              editing={this.state.editingBuilding}
                                              handleChange={this.handleChangeBuilding}
                                              handleSetpointValueChange={(name: string, value: number | string) =>
                                                this.handleSetpointValueChangeBuilding(name, value)
                                              }
                                              readOnly={!this.isAdmin() && this.isReadOnlyUser()}
                                            />
                                          </div>
                                        </Collapse>
                                        <Tree
                                          contents={[
                                            {
                                              id: schedulesNodeId,
                                              label: "Occupancy Schedules",
                                              icon: IconNames.TIME,
                                              hasCaret: true,
                                              isExpanded: expandedBuilding === schedulesNodeId,
                                            },
                                          ]}
                                          onNodeExpand={(e) => {
                                            this.ensureBuildingEditor(buildingKey);
                                            this.setState({ expandedBuilding: e.id as string });
                                          }}
                                          onNodeCollapse={() => this.setState({ expandedBuilding: null })}
                                          onNodeClick={(e) => {
                                            if (e.id !== expandedBuilding) this.ensureBuildingEditor(buildingKey);
                                            this.setState({ expandedBuilding: e.id === expandedBuilding ? null : (e.id as string) });
                                          }}
                                        />
                                        <Collapse isOpen={expandedBuilding === schedulesNodeId}>
                                          <div style={{ marginTop: "20px" }}>
                                            <Schedules
                                              unit={defaultBldgUnit!}
                                              editing={this.state.editingBuilding}
                                              handleChange={this.handleChangeBuilding}
                                              readOnly={!this.isAdmin() && this.isReadOnlyUser()}
                                            />
                                          </div>
                                        </Collapse>
                                        <Tree
                                          contents={[
                                            {
                                              id: holidaysNodeId,
                                              label: "Holidays",
                                              icon: IconNames.TIMELINE_EVENTS,
                                              hasCaret: true,
                                              isExpanded: expandedBuilding === holidaysNodeId,
                                            },
                                          ]}
                                          onNodeExpand={(e) => {
                                            this.ensureBuildingEditor(buildingKey);
                                            this.setState({ expandedBuilding: e.id as string });
                                          }}
                                          onNodeCollapse={() => this.setState({ expandedBuilding: null })}
                                          onNodeClick={(e) => {
                                            if (e.id !== expandedBuilding) this.ensureBuildingEditor(buildingKey);
                                            this.setState({ expandedBuilding: e.id === expandedBuilding ? null : (e.id as string) });
                                          }}
                                        />
                                        <Collapse isOpen={expandedBuilding === holidaysNodeId}>
                                          {defaultBldgUnit?.configuration?.holidays?.length ? (
                                            <Label>
                                              <h3>Predefined Holidays</h3>
                                              <ul>
                                                {defaultBldgUnit.configuration.holidays.map((holiday, i) => (
                                                  <li key={holiday?.label ?? i}>
                                                    <Holiday
                                                      key={holiday?.label}
                                                      path={`configuration.holidays.${i}`}
                                                      unit={defaultBldgUnit!}
                                                      editing={this.state.editingBuilding}
                                                      holiday={holiday!}
                                                      handleChange={this.handleChangeBuilding}
                                                      readOnly={!this.isAdmin() && this.isReadOnlyUser()}
                                                    />
                                                  </li>
                                                ))}
                                              </ul>
                                            </Label>
                                          ) : (
                                            <Label>
                                              <p>No predefined holidays are configured for units in this building.</p>
                                            </Label>
                                          )}
                                        </Collapse>
                                        <Tree
                                          contents={[
                                            {
                                              id: occupanciesNodeId,
                                              label: "Temporary Occupancy",
                                              icon: IconNames.HOME,
                                              hasCaret: true,
                                              isExpanded: expandedBuilding === occupanciesNodeId,
                                            },
                                          ]}
                                          onNodeExpand={(e) => {
                                            this.ensureBuildingEditor(buildingKey);
                                            this.setState({ expandedBuilding: e.id as string });
                                          }}
                                          onNodeCollapse={() => this.setState({ expandedBuilding: null })}
                                          onNodeClick={(e) => {
                                            if (e.id !== expandedBuilding) this.ensureBuildingEditor(buildingKey);
                                            this.setState({ expandedBuilding: e.id === expandedBuilding ? null : (e.id as string) });
                                          }}
                                        />
                                        <Collapse isOpen={expandedBuilding === occupanciesNodeId}>
                                          <Occupancies
                                            unit={defaultBldgUnit!}
                                            editing={this.state.editingBuilding}
                                            handleChange={this.handleChangeBuilding}
                                            readOnly={!this.isAdmin() && this.isReadOnlyUser()}
                                          />
                                        </Collapse>
                                        </>
                                      </div>
                                    </div>
                                  </div>
                              );
                            })()}

                            {/* Room lists */}
                            {(!this.isManager() || this.isAdmin()) && <Collapse isOpen={isOpen}>
                            <div style={{marginTop: "15px"}}>
                              {(() => {
                                // A stable key for this building's floor-plan selection
                                const fpKey = `${campusId}::${bldgName}`;

                                // All unit names in the building (from unitsInBldg.unit.system)
                                const unitSystems = (unitsInBldg ?? [])
                                  .map((u) => String(u.system ?? ""))
                                  .filter(Boolean);

                                // Pick a base unit to fall back to (first in building)
                                const baseUnit = unitsInBldg?.[0];

                                // Defaults: use URL building param if it matches a system, otherwise first unit
                                const qsBldg = new URLSearchParams(this.props.location?.search ?? "").get("building");
                                const qsNorm = qsBldg ? qsBldg.toLowerCase().replace(/\s+/g, "-") : "";
                                const qsMatchedSystem = qsNorm ? unitSystems.find((s) => s.toLowerCase() === qsNorm) : undefined;
                                const selectedSystem =
                                  this.state.floorPlanUnitSelected?.[fpKey] ?? qsMatchedSystem ?? String(baseUnit?.system ?? "");
                                const draftSystem =
                                  this.state.floorPlanUnitDraft?.[fpKey] ?? selectedSystem;
                                const floorPlanUnit =
                                  unitsInBldg.find((u) => String(u.system ?? "") === selectedSystem) ?? baseUnit;

                                if (!floorPlanUnit?.id) return null;
                                if (!this.state.editing) {
                                  // Use setState in a microtask to avoid setState-during-render warnings
                                  queueMicrotask(() => this.ensureZoneEditor(floorPlanUnit.id!));
                                }
                                const unitData = this.state.unitManagerData[floorPlanUnit.id];

                                return (
                                  // Selected zones
                                <div key={floorPlanUnit.id} ref={this.unitRefs[floorPlanUnit.id!]}>
                                  <div className="row" style={{ marginBottom: 20, paddingLeft: 15 }}>
                                    {/* <Label>                                      
                                      <h1>Floor Plan</h1>                                      
                                    </Label> */}
                                    <div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "10px" }}>
                                      <h3>Select a room:</h3>
                                      <div style={{marginTop:"0.8%", marginLeft: "0.5%"}}>
                                        <HTMLSelect
                                          options={unitSystems}
                                          value={draftSystem}
                                          onChange={(e) => {
                                            const next = e.currentTarget.value;
                                            this.setState((prev) => ({
                                              floorPlanUnitDraft: {
                                                ...(prev.floorPlanUnitDraft || {}),
                                                [fpKey]: next,
                                              },
                                            }));
                                          }}
                                          style={{fontSize:"14pt", width:"110px", height: "30px"}}
                                        />
                                        <Button
                                          intent={Intent.PRIMARY}
                                          text="Enter"                                          
                                          className="custom-button"
                                          onClick={() => {
                                            this.setState((prev) => ({
                                              floorPlanUnitSelected: {
                                                ...(prev.floorPlanUnitSelected || {}),
                                                [fpKey]: prev.floorPlanUnitDraft?.[fpKey] ?? selectedSystem,
                                              },
                                              openZoneDetails: {
                                                ...prev.openZoneDetails,
                                                [fpKey]: true,
                                              },
                                            }), () => {
                                              this.ensureZoneEditor(floorPlanUnit.id!);
                                            });
                                          }}
                                          style={{marginLeft: "12px", padding: "2px 14px"}}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                  <div className="row"  style={{marginBottom: "20px"}}>
                                    <div style={{display: "flex", justifyContent: "space-between", paddingRight: "14px",  paddingLeft: 15, paddingBottom: 15, paddingTop: 5}}>
                                      <h2 style={{ margin: 0 }}>Room Info</h2>
                                      <Button
                                        minimal
                                        icon={(this.state.openZoneDetails[fpKey] ?? !this.isManager()) ? IconNames.CARET_DOWN : IconNames.CARET_RIGHT}
                                        onClick={() =>
                                          this.setState((prev) => ({
                                            openZoneDetails: {
                                              ...prev.openZoneDetails,
                                              [fpKey]: !(prev.openZoneDetails[fpKey] ?? !this.isManager()),
                                            },
                                          }))
                                        }
                                      />
                                    </div>
                                    <Collapse isOpen={this.state.openZoneDetails[fpKey] ?? !this.isManager()}>
                                    <div className="col-md-6">
                                      <div className="row">
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        </div>
                                        <img
                                          className="unit-image"
                                          src={floorPlanUnit.image || "/images/placeholder_room_2.png"}
                                          alt={`Image for ${floorPlanUnit.label}`}
                                        />
                                        <TextArea
                                          value={floorPlanUnit.description || `This is the '${floorPlanUnit.system}' in the '${bldgName}'`}
                                          readOnly
                                          fill
                                          growVertically
                                          large
                                        />
                                      </div>
                                    </div>
                                    <div className="col-md-6">
                                      {!this.configRouteIsHidden && (
                                        <>
                                          <Tree
                                            contents={[
                                              {
                                                id: "configuration",
                                                label: "Configuration",
                                                icon: IconNames.SERIES_CONFIGURATION,
                                                hasCaret: true,
                                                isExpanded: expanded === "configuration",
                                              },
                                            ]}
                                            onNodeExpand={(e) => {
                                              this.ensureZoneEditor(floorPlanUnit.id!);
                                              this.setState({ expanded: e.id as string });
                                            }}
                                            onNodeCollapse={() => this.setState({ expanded: null })}
                                            onNodeClick={(e) => {
                                              this.ensureZoneEditor(floorPlanUnit.id!);
                                              this.setState({ expanded: e.id === expanded ? null : (e.id as string) });
                                            }}
                                          />
                                          <Collapse isOpen={expanded === "configuration"}>
                                            <Configuration
                                              unit={floorPlanUnit}
                                              editing={editing}
                                              configurations={configurations}
                                              handleChange={this.handleChange}
                                              handleCreate={this.handleCreate}
                                              readOnly={!this.isAdmin() && this.isReadOnlyUser()}
                                            />
                                          </Collapse>
                                        </>
                                      )}
                                      <div className="row">
                                        <div className="col-md-10" style={{ display: "flex", alignItems: "center", gap: "8px", paddingLeft: 0 }}>
                                          <h2 style={{ marginTop: 4.5 }}>Room Monitoring</h2>
                                        </div>
                                        <div className="col-md-2" style={{ textAlign: "right", paddingRight: 0 }}>
                                          <Button
                                            minimal
                                            icon={isOpenZoneMonitoring ? IconNames.CARET_DOWN : IconNames.CARET_RIGHT}
                                            onClick={() =>
                                              this.setState((prev) => ({
                                                openZoneMonitoring: {
                                                  ...(prev.openZoneMonitoring || {}),
                                                  [bldgName]: !isOpenZoneMonitoring,
                                                },
                                              }))
                                            }
                                            style={{marginTop: 0}}
                                          />
                                        </div>
                                      </div>

                                      <Collapse isOpen={isOpenZoneMonitoring}>
                                        <div style={{display:"flex"}}>
                                          <h4 style={{ marginLeft: "1.5rem", marginTop: "0.8rem", marginRight: "0.5rem" }}>Add/Remove: </h4>
                                          <div style={{marginTop:"0.3rem", marginLeft: "1%"}}>
                                            <Tooltip2 content="Add Chart" placement={Position.BOTTOM}>
                                              <Button
                                                icon={IconNames.PLUS}
                                                intent={Intent.PRIMARY}
                                                small
                                                className="custom-button"
                                                onClick={() => this.addChart(floorPlanUnit.id!)}                          
                                              />
                                            </Tooltip2>
                                            <Tooltip2 content="Remove Last Chart" placement={Position.BOTTOM}>
                                              <Button
                                                icon={IconNames.MINUS}
                                                intent={Intent.PRIMARY}
                                                small
                                                className="custom-button"
                                                onClick={() => this.removeChart(floorPlanUnit.id!)}           
                                              />
                                            </Tooltip2>
                                          </div>
                                        </div>

                                        <div className="row">
                                          {unitData?.chartConfigs?.map((chart) => {
                                            const chartType = chart.type;

                                            const rawZoneUnitData = this.state.unitManagerData[floorPlanUnit.id!];
                                            const zoneUnitDataForChart = this.filterUnitDataForChart(rawZoneUnitData, chart.id); 

                                            const lineChartData = rawZoneUnitData?.lineChartData?.[0] ?? { index: 0, time: "", values: {} };
                                            const axisInfo = this.buildAxisInfo(zoneUnitDataForChart, chart.id, "zone");

                                            return (
                                              <div key={`${floorPlanUnit.id}-${chart.id}`} style={{ marginBottom: "10px" }}>
                                                <div className="select">
                                                  {this.renderZoneChartSelect(
                                                    floorPlanUnit.id!,
                                                    chart.id,
                                                    `Room Detail Chart ${chart.id + 1}`,
                                                    lineChartData,
                                                    chart.selectedVariables,
                                                    (newSelection) => this.handleZoneChartSelect(floorPlanUnit.id!, chart.id, newSelection)
                                                  )}
                                                </div>

                                                <div style={{ position: "relative" }}>
                                                  {chartType === "line"
                                                    ? this.renderLineChart(zoneUnitDataForChart, axisInfo, chart.id)
                                                    : chartType === "scatter"
                                                    ? this.renderScatterPlot(zoneUnitDataForChart, axisInfo, chart.id)
                                                    : chartType === "box"
                                                    ? this.renderBoxPlot(zoneUnitDataForChart, axisInfo, chart.id) 
                                                    : null}                                                  
                                                  {axisInfo.length === 0 && (
                                                    <div style={{
                                                      position: "absolute",
                                                      inset: 0,
                                                      display: "flex",
                                                      alignItems: "flex-start",
                                                      justifyContent: "center",
                                                      color: "#8a9ba8",
                                                      fontStyle: "italic",
                                                      fontSize: "1.3em",
                                                      pointerEvents: "none",
                                                      textAlign: "center",
                                                      lineHeight: 1.5,
                                                      paddingTop: "18%",
                                                      paddingLeft: "5%",
                                                    }}>
                                                      Select one or more variable above<br/>to display a chart.
                                                    </div>
                                                  )}
                                                  </div>
                                              </div>
                                            );
                                          })}
                                        </div>   
                                      </Collapse>   
                                      <div className="row" style={{  marginTop: "1.5rem", marginBottom: "1rem" }}>
                                        <div className="col-md-6"><h2>Room Control</h2></div>
                                        <div className="col-md-6" style={{textAlign: "right", marginTop: 15}}>
                                          <Tooltip2
                                            content={
                                              this.isZoneLockedFromBuilding(floorPlanUnit.id!)
                                                ? "Locked: Building control will NOT override this room"
                                                : "Unlocked: Building control CAN override this room"
                                            }
                                            placement={Position.TOP}
                                          >
                                            <Button
                                              icon={this.isZoneLockedFromBuilding(floorPlanUnit.id!) ? IconNames.LOCK : IconNames.UNLOCK}
                                              intent={this.isZoneLockedFromBuilding(floorPlanUnit.id!) ? Intent.DANGER : Intent.NONE}
                                              minimal
                                              onClick={() => this.toggleZoneLockedFromBuilding(floorPlanUnit.id!)}
                                            />
                                          </Tooltip2>

                                          {this.renderStatus(floorPlanUnit)}
                                          <Tooltip2 content="Save" placement={Position.TOP} disabled={!this.isSave(floorPlanUnit)}>
                                            <Button
                                              icon={IconNames.FLOPPY_DISK}
                                              intent={Intent.PRIMARY}
                                              minimal
                                              onClick={() => this.handleSave()}
                                              disabled={!this.isSave(floorPlanUnit)}
                                            />
                                          </Tooltip2>
                                          <Tooltip2 content="Exit" placement={Position.TOP}>
                                            <Button
                                              icon={IconNames.CROSS}
                                              intent={Intent.PRIMARY}
                                              minimal
                                              onClick={() => this.handleCancel()}
                                            />
                                          </Tooltip2>
                                        </div>
                                      </div>
                                      <Tree
                                        contents={[
                                          {
                                            id: "setpoints",
                                            label: "Setpoints",
                                            icon: IconNames.TEMPERATURE,
                                            hasCaret: true,
                                            isExpanded: expanded === "setpoints",
                                          },
                                        ]}
                                        onNodeExpand={(e) => {
                                          this.ensureZoneEditor(floorPlanUnit.id!);
                                          this.setState({ expanded: e.id as string });
                                        }}
                                        onNodeCollapse={() => this.setState({ expanded: null })}
                                        onNodeClick={(e) => {
                                          this.ensureZoneEditor(floorPlanUnit.id!);
                                          this.setState({ expanded: e.id === expanded ? null : (e.id as string) });
                                        }}
                                      />
                                      <Collapse isOpen={expanded === "setpoints"}>
                                      <div style={{ marginTop: "20px" }}>
                                        <Setpoints unit={floorPlanUnit} editing={editing} handleChange={this.handleChange} handleSetpointValueChange={(name: string, value: number | string) => this.handleSetpointValueChange(floorPlanUnit.id!, name, value)} readOnly={!this.isAdmin() && this.isReadOnlyUser()}/> 
                                      </div>
                                      </Collapse>
                                      <Tree
                                        contents={[
                                          {
                                            id: "schedules",
                                            label: this.renderOccupancySchedulesLabel(floorPlanUnit),
                                            icon: IconNames.TIME,
                                            hasCaret: true,
                                            isExpanded: expanded === "schedules",
                                          },
                                        ]}
                                        onNodeExpand={(e) => {
                                          this.ensureZoneEditor(floorPlanUnit.id!);
                                          this.setState({ expanded: e.id as string });
                                        }}
                                        onNodeCollapse={() => this.setState({ expanded: null })}
                                        onNodeClick={(e) => {
                                          this.ensureZoneEditor(floorPlanUnit.id!);
                                          this.setState({ expanded: e.id === expanded ? null : (e.id as string) });
                                        }}
                                      />
                                      <Collapse isOpen={expanded === "schedules"}>
                                      <div style={{ marginTop: "20px" }}>
                                        <Schedules
                                          unit={floorPlanUnit}
                                          editing={editing}
                                          handleChange={this.handleChange}
                                          readOnly={!this.isAdmin() && this.isReadOnlyUser()}                          
                                        />
                                      </div>
                                      </Collapse>
                                      <Tree
                                        contents={[
                                          {
                                            id: "holidays",
                                            label: "Holidays",
                                            icon: IconNames.TIMELINE_EVENTS,
                                            hasCaret: true,
                                            isExpanded: expanded === "holidays",
                                          },
                                        ]}
                                        onNodeExpand={(e) => {
                                          this.ensureZoneEditor(floorPlanUnit.id!);
                                          this.setState({ expanded: e.id as string });
                                        }}
                                        onNodeCollapse={() => this.setState({ expanded: null })}
                                        onNodeClick={(e) => {
                                          this.ensureZoneEditor(floorPlanUnit.id!);
                                          this.setState({ expanded: e.id === expanded ? null : (e.id as string) });
                                        }}
                                      />
                                      <Collapse isOpen={expanded === "holidays"}>
                                        <Holidays
                                          unit={floorPlanUnit}
                                          editing={editing}
                                          handleChange={this.handleChange}
                                          readOnly={!this.isAdmin() && this.isReadOnlyUser()}
                                        />
                                      </Collapse>
                                      <Tree
                                        contents={[
                                          {
                                            id: "occupancies",
                                            label: "Temporary Occupancy",
                                            icon: IconNames.HOME,
                                            hasCaret: true,
                                            isExpanded: expanded === "occupancies",
                                          },
                                        ]}
                                        onNodeExpand={(e) => {
                                          this.ensureZoneEditor(floorPlanUnit.id!);
                                          this.setState({ expanded: e.id as string });
                                        }}
                                        onNodeCollapse={() => this.setState({ expanded: null })}
                                        onNodeClick={(e) => {
                                          this.ensureZoneEditor(floorPlanUnit.id!);
                                          this.setState({ expanded: e.id === expanded ? null : (e.id as string) });
                                        }}
                                      />
                                      <Collapse isOpen={expanded === "occupancies"}>
                                        <Occupancies unit={floorPlanUnit} editing={editing} handleChange={this.handleChange} readOnly={!this.isAdmin() && this.isReadOnlyUser()} />
                                      </Collapse>        
                                    </div>
                                    </Collapse>
                                  </div>
                                </div>
                                );
                              })()}
                            </div>
                          </Collapse>}
                          </Card>
                        );
                      })}
                    </div>
              );
            })}
        </Card>
      </div>


    );
  }
}

const mapStateToProps = (state: any) => ({
  units: selectReadUnits(state),
  filtered: selectFilterUnits(state),
  configurations: selectReadConfigurations(state),
});

const mapActionToProps = {
  readUnits,
  readUnit,
  readUnitsPoll,
  filterUnits,
  updateUnit,
  readConfigurations,
  readConfigurationsPoll,
  createConfiguration,
  updateConfiguration,
  deleteConfiguration,
  updateSetpoint,
};

export default connect(mapStateToProps, mapActionToProps)(withLocation(Dashboard));