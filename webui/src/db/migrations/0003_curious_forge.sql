CREATE TABLE `resource_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ram_mb_min` integer NOT NULL,
	`ram_mb_max` integer NOT NULL,
	`cpu_cores_min` integer NOT NULL,
	`cpu_cores_max` integer NOT NULL,
	`disk_gb_max` integer NOT NULL,
	`idle_timeout_seconds` integer NOT NULL,
	`max_lifetime_seconds` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sandbox_instances` ADD `max_uptime_override_seconds` integer;