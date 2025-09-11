CREATE TABLE IF NOT EXISTS "bench_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"temp" double precision NOT NULL,
	"seed" integer NOT NULL,
	"max_tokens" integer NOT NULL,
	"system_prompt_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"bench_config_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now(),
	"note" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_batches" ADD CONSTRAINT "run_batches_bench_config_id_bench_configs_id_fk" FOREIGN KEY ("bench_config_id") REFERENCES "bench_configs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
