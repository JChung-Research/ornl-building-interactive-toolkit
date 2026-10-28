// Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

export type CampusId = "ornl" | "pnnl" | "arizona" | "boptest" | "campus-1";

export interface Room {
  id: string;
  name: string;
  floor: string; // e.g. "1", "2", "B1"
  description?: string;
}

export interface Building {
  id: string;
  name: string;
  imageUrl: string;
  thumbnailUrl?: string;
  center: { x: number; y: number };
  description?: string;
  rooms?: Room[];
}

export interface Campus {
  id: CampusId;
  name: string;
  imageUrl: string;
  mapUrl: string;
  shortName: string;
  subtitle: string;
  color: string;
  accentColor: string;
  description: string;
  center: { x: number; y: number };
  buildings: Building[];
}

export const campuses: Campus[] = [

];

export interface Building {
  id: string;
  name: string;
  description?: string;
  imageUrl: string;
  center: { x: number; y: number };
  floor?: string;
  rooms?: Room[];

  // Optional Direction B card fields
  area?: number;           // e.g. 13000 — displays as "13,000 ft²"
  sensorCount?: number;    // e.g. 24
  temperature?: number;    // e.g. 72 — overridden by live data when available
}