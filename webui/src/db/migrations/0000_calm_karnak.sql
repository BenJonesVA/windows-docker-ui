CREATE TABLE `sandbox_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`windows_version` text NOT NULL,
	`ram_mb` integer NOT NULL,
	`cpu_cores` integer NOT NULL,
	`disk_gb` integer NOT NULL,
	`container_id` text,
	`container_name` text NOT NULL,
	`volume_name` text NOT NULL,
	`container_state` text DEFAULT 'pending' NOT NULL,
	`phase` text DEFAULT 'installing' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`stopped_at` integer,
	`last_seen_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);