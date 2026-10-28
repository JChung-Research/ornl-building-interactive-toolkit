-- AlterTable
ALTER TABLE "Configurations" 
  ALTER COLUMN "dataTimeRange" SET DATA TYPE JSONB,
  ALTER COLUMN "chartConfigs" SET DATA TYPE JSONB;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "readOnly" SET DEFAULT false;
