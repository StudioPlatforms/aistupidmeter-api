CREATE TABLE IF NOT EXISTS "baselines" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"task_type" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"means" jsonb NOT NULL,
	"stds" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metrics" (
	"run_id" integer PRIMARY KEY NOT NULL,
	"correctness" double precision NOT NULL,
	"spec" double precision NOT NULL,
	"code_quality" double precision NOT NULL,
	"efficiency" double precision NOT NULL,
	"stability" double precision NOT NULL,
	"refusal" double precision NOT NULL,
	"recovery" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "models" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"vendor" text NOT NULL,
	"version" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"task_id" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now(),
	"temp" double precision NOT NULL,
	"seed" integer NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"attempts" integer NOT NULL,
	"passed" boolean NOT NULL,
	"artifacts" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now(),
	"stupid_score" double precision NOT NULL,
	"axes" jsonb NOT NULL,
	"cusum" double precision NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"lang" text NOT NULL,
	"type" text NOT NULL,
	"difficulty" integer NOT NULL,
	"schema_uri" text,
	"hidden" boolean DEFAULT false,
	CONSTRAINT "tasks_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "baselines" ADD CONSTRAINT "baselines_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "metrics" ADD CONSTRAINT "metrics_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scores" ADD CONSTRAINT "scores_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
