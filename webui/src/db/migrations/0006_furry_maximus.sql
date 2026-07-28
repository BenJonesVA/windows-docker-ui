CREATE TABLE `firewall_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`default_action` text DEFAULT 'deny' NOT NULL,
	`rules` text DEFAULT '[]' NOT NULL,
	`node_layout` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `sandbox_instances` ADD `firewall_profile_id` text REFERENCES firewall_profiles(id);