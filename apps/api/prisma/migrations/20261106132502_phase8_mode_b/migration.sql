-- AlterEnum
ALTER TYPE "SuggestionStatus" ADD VALUE 'FAILED';

-- DropIndex
DROP INDEX "Suggestion_status_idx";

-- AlterTable
ALTER TABLE "Suggestion" ADD COLUMN     "event" JSONB,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "inferenceId" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "prefill" TEXT,
ADD COLUMN     "simulated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "traceId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "autoAct" JSONB;

-- CreateTable
CREATE TABLE "TelegramLinkCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramLinkCode_codeHash_key" ON "TelegramLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX "TelegramLinkCode_userId_idx" ON "TelegramLinkCode"("userId");

-- CreateIndex
CREATE INDEX "Suggestion_status_expiresAt_idx" ON "Suggestion"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
