-- AlterTable
ALTER TABLE "Hook" ADD COLUMN     "ageDays" DOUBLE PRECISION,
ADD COLUMN     "contractName" TEXT,
ADD COLUMN     "explanationScore" INTEGER,
ADD COLUMN     "poolCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tvlUsd" DECIMAL(24,2);

-- AlterTable
ALTER TABLE "HookPool" ADD COLUMN     "token0Symbol" TEXT,
ADD COLUMN     "token1Symbol" TEXT;

-- AlterTable
ALTER TABLE "Trigger" ADD COLUMN     "lastResult" TEXT,
ADD COLUMN     "rule" JSONB,
ADD COLUMN     "state" JSONB,
ADD COLUMN     "summary" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "HookSnapshot" (
    "id" TEXT NOT NULL,
    "hookId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "band" "HookBand" NOT NULL,
    "codeHash" TEXT,
    "implementation" TEXT,
    "owner" TEXT,
    "permissionsBitmap" INTEGER,
    "fees" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HookSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HookSnapshot_hookId_takenAt_idx" ON "HookSnapshot"("hookId", "takenAt");

-- CreateIndex
CREATE INDEX "Hook_chainId_firstSeenAt_idx" ON "Hook"("chainId", "firstSeenAt");

-- AddForeignKey
ALTER TABLE "HookSnapshot" ADD CONSTRAINT "HookSnapshot_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "Hook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
