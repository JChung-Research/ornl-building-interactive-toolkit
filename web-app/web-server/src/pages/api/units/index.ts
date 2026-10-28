"use server";
// Modifications Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0


import { NextApiRequest, NextApiResponse } from "next";

import { authUser, buildBldgAccessFilter } from "@/auth";
import { logger } from "@/logging";
import { prisma } from "@/prisma";
import { Units } from "@prisma/client";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await authUser(req);
  if (!user.roles.user) {
    return res.status(401).json(null);
  }
  if (req.method === "POST") {
    if (!user.roles.user) {
      return res.status(401).json(null);
    }
    const unit = req.body as Partial<Units>;
    return prisma.units
      .create({
        data: {
          name: unit.name || "",
          label: unit.label || "",
        },
      })
      .then((unit) => {
        return res.status(201).json(unit);
      })
      .catch((error) => {
        logger.warn(error);
        return res.status(400).json(error.message);
      });
  } else if (req.method === "GET") {
    return prisma.units
      .findMany({
        include: {
          configuration: {
            include: {
              setpoint: true,
              mondaySchedule: true,
              tuesdaySchedule: true,
              wednesdaySchedule: true,
              thursdaySchedule: true,
              fridaySchedule: true,
              saturdaySchedule: true,
              sundaySchedule: true,
              holidaySchedule: true,
              holidays: { orderBy: [{ id: "desc" }] },
              occupancies: {
                include: { schedule: true },
                orderBy: [{ date: "desc" }, { id: "desc" }],
              },
            },
          },
          location: true,
        },
        orderBy: [{ campus: "asc" }, { building: "asc" }, { name: "asc" }, { id: "asc" }],
        where: await buildBldgAccessFilter(user),
      })
      .then((units) => {
        return res.status(200).json(units);
      })
      .catch((error) => {
        logger.warn(error);
        return res.status(400).json(error.message);
      });
  } else {
    return res.status(404).json(null);
  }
}
