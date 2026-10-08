-- Every existing person gets their own business (tenant), as a new sign-up does, and becomes
-- its owner. Then each existing row moves into its owner's business.
INSERT INTO "app"."tenants" ("id", "name", "default_owner_id")
SELECT gen_random_uuid()::text, coalesce(nullif(u."name", ''), u."email"), u."id"
FROM "public"."user" u
WHERE NOT EXISTS (SELECT 1 FROM "app"."memberships" m WHERE m."user_id" = u."id");
--> statement-breakpoint
INSERT INTO "app"."memberships" ("tenant_id", "user_id", "roles", "is_default")
SELECT t."id", t."default_owner_id", '{owner}'::text[], true
FROM "app"."tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "app"."memberships" m WHERE m."user_id" = t."default_owner_id");
--> statement-breakpoint
UPDATE "app"."meetings" x SET "tenant_id" = m."tenant_id" FROM "app"."memberships" m WHERE m."user_id" = x."owner_id" AND m."is_default" AND x."tenant_id" IS NULL;
--> statement-breakpoint
UPDATE "app"."notes" x SET "tenant_id" = m."tenant_id" FROM "app"."memberships" m WHERE m."user_id" = x."owner_id" AND m."is_default" AND x."tenant_id" IS NULL;
--> statement-breakpoint
UPDATE "app"."todos" x SET "tenant_id" = m."tenant_id" FROM "app"."memberships" m WHERE m."user_id" = x."owner_id" AND m."is_default" AND x."tenant_id" IS NULL;
--> statement-breakpoint
UPDATE "app"."pages" x SET "tenant_id" = m."tenant_id" FROM "app"."memberships" m WHERE m."user_id" = x."owner_id" AND m."is_default" AND x."tenant_id" IS NULL;
--> statement-breakpoint
UPDATE "app"."channel_links" x SET "tenant_id" = m."tenant_id" FROM "app"."memberships" m WHERE m."user_id" = x."owner_id" AND m."is_default" AND x."tenant_id" IS NULL;
--> statement-breakpoint
UPDATE "app"."threads" x SET "tenant_id" = m."tenant_id" FROM "app"."memberships" m WHERE m."user_id" = x."owner_id" AND m."is_default" AND x."tenant_id" IS NULL;
--> statement-breakpoint
-- An approval was always decided by the person it was for: say so explicitly.
UPDATE "app"."approvals" x SET "tenant_id" = m."tenant_id", "approver_user_id" = x."owner_id" FROM "app"."memberships" m WHERE m."user_id" = x."owner_id" AND m."is_default" AND x."tenant_id" IS NULL;
