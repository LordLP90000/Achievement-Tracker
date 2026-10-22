CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	CONSTRAINT "job_runs_status_check" CHECK ("job_runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
-- Worker-only operational table (no personal data, so no RLS); the API role has no access at all.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "job_runs" TO questline_worker;
