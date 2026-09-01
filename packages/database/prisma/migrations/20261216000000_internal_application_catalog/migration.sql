-- The internal application catalog, made durable.
--
-- Applications registered through the API lived only in the gateway's memory, so every
-- registration was lost when the container moved. That is a governance record
-- disappearing on a restart, not a cache being cold.
--
-- Purely additive: a new table, no column dropped, no row rewritten. The in-memory
-- catalog is seeded from this table at start-up, so an empty table behaves exactly as
-- the previous build did.

CREATE TABLE "internal_application" (
    "id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_application_pkey" PRIMARY KEY ("id")
);

-- The registration control, in the database rather than only in application code:
-- two rows cannot claim the same application in the same environment.
CREATE UNIQUE INDEX "internal_application_environment_appId_key" ON "internal_application"("environment", "appId");

CREATE INDEX "internal_application_environment_idx" ON "internal_application"("environment");
