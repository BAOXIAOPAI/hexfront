CREATE TABLE `rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`host_id` text NOT NULL,
	`status` text NOT NULL,
	`options_json` text NOT NULL,
	`members_json` text NOT NULL,
	`game_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rooms_updated_at_idx` ON `rooms` (`updated_at`);