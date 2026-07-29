CREATE TABLE `process_events` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`ts` integer NOT NULL,
	`event` text NOT NULL,
	`pid` integer NOT NULL,
	`ppid` integer,
	`name` text NOT NULL,
	`cmdline` text,
	FOREIGN KEY (`instance_id`) REFERENCES `sandbox_instances`(`id`) ON UPDATE no action ON DELETE no action
);
