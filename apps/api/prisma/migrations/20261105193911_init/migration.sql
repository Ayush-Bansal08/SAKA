-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('dev', 'world');

-- CreateEnum
CREATE TYPE "RiskProfile" AS ENUM ('CAREFUL', 'BALANCED', 'ADVENTUROUS');

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('VERIFY', 'WALLET', 'PROFILE', 'FUND', 'DONE');

-- CreateEnum
CREATE TYPE "HookPolicy" AS ENUM ('SAFE_ONLY', 'SAFE_AND_CAUTION');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RequestChannel" AS ENUM ('WEB', 'TELEGRAM', 'DETECTOR', 'TRIGGER');

-- CreateEnum
CREATE TYPE "AgentRequestStatus" AS ENUM ('RECEIVED', 'PLANNING', 'PREPARED', 'AWAITING_APPROVAL', 'QUEUED', 'EXECUTING', 'DONE', 'REFUSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InferenceRole" AS ENUM ('PLANNER', 'GUARD', 'EXPLAINER');

-- CreateEnum
CREATE TYPE "PolicyOutcome" AS ENUM ('AUTO', 'STEP_UP', 'REFUSE', 'ASK');

-- CreateEnum
CREATE TYPE "ActionPlanStatus" AS ENUM ('PREPARED', 'AWAITING_APPROVAL', 'APPROVED', 'QUEUED', 'EXECUTING', 'EXECUTED', 'REFUSED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'USED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalChannel" AS ENUM ('WEB', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "IdentityPurpose" AS ENUM ('SIGN_IN', 'ENROLL', 'STEP_UP');

-- CreateEnum
CREATE TYPE "IdentityAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExecutionKind" AS ENUM ('APPROVAL', 'PERMIT_SIGN', 'SWAP', 'TRANSFER', 'LP_CREATE', 'LP_DECREASE', 'LP_CLAIM');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'SIGNED', 'BROADCAST', 'CONFIRMED', 'FAILED', 'REVERTED');

-- CreateEnum
CREATE TYPE "ApprovedBy" AS ENUM ('AGENT', 'HUMAN');

-- CreateEnum
CREATE TYPE "DecisionLogStatus" AS ENUM ('PENDING', 'UPLOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "LpProtocol" AS ENUM ('V4', 'V3');

-- CreateEnum
CREATE TYPE "LpPositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TokenLotSource" AS ENUM ('DEPOSIT', 'SWAP', 'LP_EXIT');

-- CreateEnum
CREATE TYPE "TriggerKind" AS ENUM ('TAKE_PROFIT', 'STOP_LOSS', 'DCA', 'CHAINED', 'PRICE_ALERT');

-- CreateEnum
CREATE TYPE "TriggerStatus" AS ENUM ('ACTIVE', 'FIRED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SuggestionDetector" AS ENUM ('DIP', 'PROFIT', 'IDLE_USDC', 'BETTER_POOL', 'OUT_OF_RANGE', 'NEW_HOOK', 'HOOK_CHANGED', 'BIG_MOVE', 'MORNING_BRIEF');

-- CreateEnum
CREATE TYPE "SuggestionSeverity" AS ENUM ('INFO', 'NORMAL', 'RED');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'AUTO_EXECUTED', 'INFO');

-- CreateEnum
CREATE TYPE "HookBand" AS ENUM ('SAFE', 'CAUTION', 'DANGER');

-- CreateEnum
CREATE TYPE "TraceKind" AS ENUM ('system', 'plan', 'tool_call', 'tool_result', 'score', 'simulation', 'guard', 'policy', 'approval', 'tx', 'receipt', 'log', 'error', 'detector');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "identityIss" TEXT NOT NULL,
    "identitySub" TEXT NOT NULL,
    "identityKind" "ProviderKind" NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastAuthAt" TIMESTAMP(3),
    "displayName" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "riskProfile" "RiskProfile" NOT NULL DEFAULT 'BALANCED',
    "onboardingStep" "OnboardingStep" NOT NULL DEFAULT 'VERIFY',
    "telegramChatId" TEXT,
    "telegramMuted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "approvalId" TEXT,
    "purpose" "IdentityPurpose" NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "pkceVerifierEnc" TEXT NOT NULL,
    "deviceCodeEnc" TEXT,
    "userCode" TEXT,
    "verificationUri" TEXT,
    "status" "IdentityAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "privyWalletId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "policyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Limits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "perActionUsd" DECIMAL(20,2) NOT NULL,
    "perDayUsd" DECIMAL(20,2) NOT NULL,
    "maxSlippagePct" DECIMAL(6,3) NOT NULL,
    "minTradeScoreAuto" INTEGER NOT NULL,
    "hookPolicy" "HookPolicy" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnownRecipient" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnownRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "text" TEXT NOT NULL,
    "cards" JSONB,
    "traceId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "RequestChannel" NOT NULL,
    "input" JSONB NOT NULL,
    "status" "AgentRequestStatus" NOT NULL DEFAULT 'RECEIVED',
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inference" (
    "id" TEXT NOT NULL,
    "agentRequestId" TEXT,
    "role" "InferenceRole" NOT NULL,
    "model" TEXT NOT NULL,
    "trustMode" TEXT NOT NULL,
    "zgRequestId" TEXT,
    "clientRequestId" TEXT NOT NULL,
    "providerAddress" TEXT,
    "providerIdentity" TEXT,
    "teeVerified" BOOLEAN,
    "trace" JSONB,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costRaw" TEXT,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionPlan" (
    "id" TEXT NOT NULL,
    "agentRequestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "intent" JSONB NOT NULL,
    "planHash" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "quote" JSONB,
    "amountUsd" DECIMAL(24,8) NOT NULL,
    "tradeScore" INTEGER,
    "hookScore" INTEGER,
    "hookAddress" TEXT,
    "simulation" JSONB,
    "guardVerdict" JSONB,
    "policyOutcome" "PolicyOutcome" NOT NULL,
    "policyReasons" JSONB NOT NULL,
    "status" "ActionPlanStatus" NOT NULL DEFAULT 'PREPARED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "actionPlanId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "amountUsd" DECIMAL(24,8) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "channel" "ApprovalChannel" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "approvedByIss" TEXT,
    "approvedBySub" TEXT,
    "authTime" TIMESTAMP(3),
    "acr" TEXT,
    "amr" JSONB,
    "providerKind" "ProviderKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL,
    "actionPlanId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" "ExecutionKind" NOT NULL,
    "txHash" TEXT,
    "nonce" INTEGER,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "usdValue" DECIMAL(24,8) NOT NULL,
    "gasUsed" TEXT,
    "effectiveGasPrice" TEXT,
    "blockNumber" TEXT,
    "error" TEXT,
    "approvedBy" "ApprovedBy" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionLog" (
    "id" TEXT NOT NULL,
    "actionPlanId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "zgRootHash" TEXT,
    "zgTxHash" TEXT,
    "status" "DecisionLogStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecisionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LpPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "protocol" "LpProtocol" NOT NULL,
    "tokenId" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "token0" TEXT NOT NULL,
    "token1" TEXT NOT NULL,
    "hookAddress" TEXT,
    "tickLower" INTEGER NOT NULL,
    "tickUpper" INTEGER NOT NULL,
    "status" "LpPositionStatus" NOT NULL DEFAULT 'OPEN',
    "openedTxHash" TEXT NOT NULL,
    "costBasisUsd" DECIMAL(24,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LpPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenLot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "costUsd" DECIMAL(24,8) NOT NULL,
    "source" "TokenLotSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trigger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "TriggerKind" NOT NULL,
    "spec" JSONB NOT NULL,
    "status" "TriggerStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextRunAt" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suggestion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "detector" "SuggestionDetector" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "severity" "SuggestionSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "actionPlanId" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'OPEN',
    "telegramMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hook" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "flags" JSONB NOT NULL,
    "permissions" JSONB NOT NULL,
    "isProxy" BOOLEAN NOT NULL,
    "implementation" TEXT,
    "owner" TEXT,
    "verifiedSource" BOOLEAN,
    "codeHash" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "band" "HookBand" NOT NULL,
    "scoreBreakdown" JSONB NOT NULL,
    "explanation" TEXT,
    "explanationInferenceId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSnapshot" JSONB NOT NULL,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HookPool" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "poolId" TEXT NOT NULL,
    "hookAddress" TEXT NOT NULL,
    "token0" TEXT NOT NULL,
    "token1" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "tickSpacing" INTEGER NOT NULL,
    "tvlUsd" DECIMAL(24,2),
    "createdAtBlock" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HookPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceCache" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraceEventRow" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "kind" "TraceKind" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "data" JSONB,
    "zg" JSONB,

    CONSTRAINT "TraceEventRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramChatId_key" ON "User"("telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "User_identityIss_identitySub_key" ON "User"("identityIss", "identitySub");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityAttempt_state_key" ON "IdentityAttempt"("state");

-- CreateIndex
CREATE INDEX "IdentityAttempt_userId_idx" ON "IdentityAttempt"("userId");

-- CreateIndex
CREATE INDEX "IdentityAttempt_approvalId_idx" ON "IdentityAttempt"("approvalId");

-- CreateIndex
CREATE INDEX "IdentityAttempt_status_expiresAt_idx" ON "IdentityAttempt"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWallet_userId_key" ON "AgentWallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWallet_privyWalletId_key" ON "AgentWallet"("privyWalletId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWallet_address_key" ON "AgentWallet"("address");

-- CreateIndex
CREATE UNIQUE INDEX "Limits_userId_key" ON "Limits"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "KnownRecipient_userId_address_key" ON "KnownRecipient"("userId", "address");

-- CreateIndex
CREATE INDEX "ChatMessage_userId_createdAt_idx" ON "ChatMessage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_traceId_idx" ON "ChatMessage"("traceId");

-- CreateIndex
CREATE INDEX "AgentRequest_userId_createdAt_idx" ON "AgentRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRequest_traceId_idx" ON "AgentRequest"("traceId");

-- CreateIndex
CREATE INDEX "AgentRequest_status_idx" ON "AgentRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Inference_clientRequestId_key" ON "Inference"("clientRequestId");

-- CreateIndex
CREATE INDEX "Inference_agentRequestId_idx" ON "Inference"("agentRequestId");

-- CreateIndex
CREATE INDEX "Inference_zgRequestId_idx" ON "Inference"("zgRequestId");

-- CreateIndex
CREATE INDEX "Inference_createdAt_idx" ON "Inference"("createdAt");

-- CreateIndex
CREATE INDEX "ActionPlan_agentRequestId_idx" ON "ActionPlan"("agentRequestId");

-- CreateIndex
CREATE INDEX "ActionPlan_userId_createdAt_idx" ON "ActionPlan"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionPlan_planHash_idx" ON "ActionPlan"("planHash");

-- CreateIndex
CREATE INDEX "ActionPlan_status_idx" ON "ActionPlan"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_actionPlanId_key" ON "Approval"("actionPlanId");

-- CreateIndex
CREATE INDEX "Approval_userId_createdAt_idx" ON "Approval"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_status_expiresAt_idx" ON "Approval"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_idempotencyKey_key" ON "Execution"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_txHash_key" ON "Execution"("txHash");

-- CreateIndex
CREATE INDEX "Execution_userId_createdAt_idx" ON "Execution"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Execution_status_idx" ON "Execution"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_actionPlanId_stepIndex_key" ON "Execution"("actionPlanId", "stepIndex");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionLog_actionPlanId_key" ON "DecisionLog"("actionPlanId");

-- CreateIndex
CREATE INDEX "DecisionLog_status_idx" ON "DecisionLog"("status");

-- CreateIndex
CREATE INDEX "LpPosition_userId_createdAt_idx" ON "LpPosition"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LpPosition_poolId_idx" ON "LpPosition"("poolId");

-- CreateIndex
CREATE UNIQUE INDEX "LpPosition_chainId_protocol_tokenId_key" ON "LpPosition"("chainId", "protocol", "tokenId");

-- CreateIndex
CREATE INDEX "TokenLot_userId_tokenAddress_createdAt_idx" ON "TokenLot"("userId", "tokenAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Trigger_userId_createdAt_idx" ON "Trigger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Trigger_status_nextRunAt_idx" ON "Trigger"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "Suggestion_userId_createdAt_idx" ON "Suggestion"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Suggestion_actionPlanId_idx" ON "Suggestion"("actionPlanId");

-- CreateIndex
CREATE INDEX "Suggestion_status_idx" ON "Suggestion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Suggestion_userId_dedupeKey_key" ON "Suggestion"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Hook_band_idx" ON "Hook"("band");

-- CreateIndex
CREATE UNIQUE INDEX "Hook_chainId_address_key" ON "Hook"("chainId", "address");

-- CreateIndex
CREATE INDEX "HookPool_chainId_hookAddress_idx" ON "HookPool"("chainId", "hookAddress");

-- CreateIndex
CREATE INDEX "HookPool_chainId_token0_token1_idx" ON "HookPool"("chainId", "token0", "token1");

-- CreateIndex
CREATE UNIQUE INDEX "HookPool_chainId_poolId_key" ON "HookPool"("chainId", "poolId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceCache_key_key" ON "PriceCache"("key");

-- CreateIndex
CREATE INDEX "TraceEventRow_traceId_idx" ON "TraceEventRow"("traceId");

-- CreateIndex
CREATE INDEX "TraceEventRow_userId_ts_idx" ON "TraceEventRow"("userId", "ts");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityAttempt" ADD CONSTRAINT "IdentityAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityAttempt" ADD CONSTRAINT "IdentityAttempt_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWallet" ADD CONSTRAINT "AgentWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Limits" ADD CONSTRAINT "Limits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnownRecipient" ADD CONSTRAINT "KnownRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inference" ADD CONSTRAINT "Inference_agentRequestId_fkey" FOREIGN KEY ("agentRequestId") REFERENCES "AgentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_agentRequestId_fkey" FOREIGN KEY ("agentRequestId") REFERENCES "AgentRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionLog" ADD CONSTRAINT "DecisionLog_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LpPosition" ADD CONSTRAINT "LpPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenLot" ADD CONSTRAINT "TokenLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceEventRow" ADD CONSTRAINT "TraceEventRow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
