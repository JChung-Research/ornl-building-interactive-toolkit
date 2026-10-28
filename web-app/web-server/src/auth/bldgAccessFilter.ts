// Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import { prisma } from "@/prisma";
import { AuthUser } from "./types";

export async function buildBldgAccessFilter(user: AuthUser) {
  if (!user.id || user.roles.admin) return {};

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { bldgAccess: true },
  });
  // console.log("[bldgAccessFilter] dbUser.bldgAccess:", JSON.stringify(dbUser?.bldgAccess));

  const bldgAccess = (dbUser?.bldgAccess ?? {}) as Record<string, any>;
  const entries = Object.entries(bldgAccess)
    .map(([k, v]) => [k, v === true ? ["all"] : v] as [string, string[]])
    .filter(([_, zones]) => Array.isArray(zones) && zones.length > 0);

  if (entries.length === 0) {
    console.log("[bldgAccessFilter] No valid entries, returning id: -1 (deny all)");
    return { id: -1 };
  }

  const filter = {
    OR: entries.map(([building, zones]) =>
      zones.includes("all")
        ? { building }
        : { building, system: { in: zones } }
    ),
  };
  // console.log("[bldgAccessFilter] Returning filter:", JSON.stringify(filter));
  return filter;
}
