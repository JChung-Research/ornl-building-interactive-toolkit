// Modifications Copyright 2026 UT-Battelle, LLC
// SPDX-License-Identifier: Apache-2.0

import authUser from "@/auth/authUser";
import { createApolloServer } from "@/graphql";
import { startServerAndCreateNextHandler } from "@as-integrations/next";
import { initContextCache } from "@pothos/core";
import { pubsub } from "@/graphql/pubsub";

export const dynamic = "force-dynamic";

const handleRequest = startServerAndCreateNextHandler(createApolloServer(), {
  context: async () => ({
    // Adding this will prevent any issues if your server implementation
    // copies or extends the context object before passing it to your resolvers
    ...initContextCache(),
    authUser: await authUser(),
    pubsub: pubsub,
  }),
});

export { handleRequest as GET, handleRequest as POST, handleRequest as OPTIONS };
