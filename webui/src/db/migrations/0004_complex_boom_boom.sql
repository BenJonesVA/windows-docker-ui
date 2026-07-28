ALTER TABLE `resource_tiers` ADD `max_concurrent_instances` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `resource_tiers` ADD `max_aggregate_ram_mb` integer DEFAULT 40960 NOT NULL;--> statement-breakpoint
ALTER TABLE `resource_tiers` ADD `max_aggregate_disk_gb` integer DEFAULT 640 NOT NULL;