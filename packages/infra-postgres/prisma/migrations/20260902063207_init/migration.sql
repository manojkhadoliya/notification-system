-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('sms', 'push', 'email', 'in_app');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('critical', 'standard', 'bulk');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('accepted', 'sent', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "ScheduledNotificationStatus" AS ENUM ('pending', 'claimed', 'emitted');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "hashed_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone" TEXT,
    "push_token" TEXT,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preferences" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "notification_type" TEXT NOT NULL,
    "opted_in" BOOLEAN NOT NULL,
    "quiet_hours_start" TIME(0),
    "quiet_hours_end" TIME(0),
    "fallback_order" "Channel"[],

    CONSTRAINT "preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "notification_type" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "channel" "Channel" NOT NULL,
    "broadcast_id" UUID,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "notification_request_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "provider_response" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("notification_request_id","attempt_number")
);

-- CreateTable
CREATE TABLE "dedupe_claims" (
    "tenant_id" UUID NOT NULL,
    "notification_request_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dedupe_claims_pkey" PRIMARY KEY ("tenant_id","notification_request_id","recipient_id","channel")
);

-- CreateTable
CREATE TABLE "scheduled_notifications" (
    "id" UUID NOT NULL,
    "notification_request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "notification_type" TEXT NOT NULL,
    "channel" "Channel",
    "template_version_id" UUID,
    "payload" JSONB NOT NULL,
    "priority" "Priority" NOT NULL,
    "broadcast_id" UUID,
    "idempotency_key" TEXT,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "due_minute" INTEGER NOT NULL,
    "status" "ScheduledNotificationStatus" NOT NULL,
    "claimed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_feed_items" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "notification_request_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_feed_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hashed_key_key" ON "api_keys"("hashed_key");

-- CreateIndex
CREATE UNIQUE INDEX "preferences_recipient_id_channel_notification_type_key" ON "preferences"("recipient_id", "channel", "notification_type");

-- CreateIndex
CREATE UNIQUE INDEX "templates_tenant_id_name_key" ON "templates"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_id_locale_version_key" ON "template_versions"("template_id", "locale", "version");

-- CreateIndex
CREATE INDEX "scheduled_notifications_status_due_minute_idx" ON "scheduled_notifications"("status", "due_minute");

-- CreateIndex
CREATE UNIQUE INDEX "notification_feed_items_notification_request_id_key" ON "notification_feed_items"("notification_request_id");

-- CreateIndex
CREATE INDEX "notification_feed_items_recipient_id_created_at_idx" ON "notification_feed_items"("recipient_id", "created_at");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_notification_request_id_fkey" FOREIGN KEY ("notification_request_id") REFERENCES "notification_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
