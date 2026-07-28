ALTER TABLE `sandbox_instances` ADD `egress_mode` text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE `sandbox_instances` ADD `egress_allowlist` text DEFAULT '[]' NOT NULL;