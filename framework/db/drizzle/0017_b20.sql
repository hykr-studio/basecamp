CREATE TABLE "app"."import_batches" (
	"job_id" text NOT NULL,
	"batch" integer NOT NULL,
	"tenant_id" text NOT NULL,
	"counts" jsonb NOT NULL,
	"problems" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_job_id_batch_pk" PRIMARY KEY("job_id","batch")
);
--> statement-breakpoint
CREATE TABLE "app"."import_keys" (
	"tenant_id" text NOT NULL,
	"entity" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"record_id" text NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_keys_tenant_id_entity_source_external_id_pk" PRIMARY KEY("tenant_id","entity","source","external_id")
);
--> statement-breakpoint
ALTER TABLE "app"."import_batches" ADD CONSTRAINT "import_batches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_batches" ADD CONSTRAINT "import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_keys" ADD CONSTRAINT "import_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_keys" ADD CONSTRAINT "import_keys_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_keys_record_idx" ON "app"."import_keys" USING btree ("tenant_id","entity","record_id");