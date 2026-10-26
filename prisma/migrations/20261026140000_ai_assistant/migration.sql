BEGIN;
-- CreateTable
CREATE TABLE "AssistantSettings" (
    "organizationId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL DEFAULT 'Support assistant',
    "instructions" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AssistantSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "AssistantConversation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "branchId" UUID,
    "subscriberId" UUID NOT NULL,
    "customerAccountId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL,
    "model" TEXT,
    "ticketId" UUID,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantMessage" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "text" TEXT,
    "tools" TEXT[],
    "replay" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantConversation_organizationId_lastMessageAt_idx" ON "AssistantConversation"("organizationId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "AssistantConversation_subscriberId_status_idx" ON "AssistantConversation"("subscriberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantMessage_conversationId_seq_key" ON "AssistantMessage"("conversationId", "seq");

-- AddForeignKey
ALTER TABLE "AssistantMessage" ADD CONSTRAINT "AssistantMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one open chat per customer (concurrent first messages cannot create two).
CREATE UNIQUE INDEX "AssistantConversation_one_open_per_subscriber" ON "AssistantConversation"("subscriberId") WHERE "status" = 'OPEN';
ALTER TABLE "AssistantConversation" ADD CONSTRAINT "AssistantConversation_status" CHECK ("status" IN ('OPEN', 'CLOSED'));
ALTER TABLE "AssistantConversation" ADD CONSTRAINT "AssistantConversation_source" CHECK ("source" IN ('anthropic', 'mock'));
ALTER TABLE "AssistantMessage" ADD CONSTRAINT "AssistantMessage_role" CHECK ("role" IN ('user', 'assistant', 'notice'));

COMMIT;
