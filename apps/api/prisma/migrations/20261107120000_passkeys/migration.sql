-- Passkeys replace the planned World ID integration.
ALTER TYPE "ProviderKind" RENAME VALUE 'world' TO 'passkey';

-- World-only (OIDC/PKCE) attempts were never used.
DROP TABLE "IdentityAttempt";
DROP TYPE "IdentityPurpose";
DROP TYPE "IdentityAttemptStatus";

CREATE TYPE "PasskeyPurpose" AS ENUM ('REGISTER', 'SIGN_IN', 'APPROVE');

CREATE TABLE "PasskeyCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasskeyChallenge" (
    "id" TEXT NOT NULL,
    "purpose" "PasskeyPurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "subject" TEXT,
    "displayName" TEXT,
    "approvalId" TEXT,
    "planHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasskeyChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key" ON "PasskeyCredential"("credentialId");
CREATE INDEX "PasskeyCredential_userId_idx" ON "PasskeyCredential"("userId");
CREATE UNIQUE INDEX "PasskeyChallenge_challenge_key" ON "PasskeyChallenge"("challenge");
CREATE INDEX "PasskeyChallenge_expiresAt_idx" ON "PasskeyChallenge"("expiresAt");
CREATE INDEX "PasskeyChallenge_approvalId_idx" ON "PasskeyChallenge"("approvalId");

ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasskeyChallenge" ADD CONSTRAINT "PasskeyChallenge_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE CASCADE ON UPDATE CASCADE;
