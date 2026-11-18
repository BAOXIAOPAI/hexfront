import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Private authoritative room data. Only publicState is returned to browsers. */
export const rooms = sqliteTable("rooms", {
  code: text("code").primaryKey(),
  version: integer("version").notNull().default(1),
  hostId: text("host_id").notNull(),
  status: text("status", { enum: ["lobby", "playing", "finished"] }).notNull(),
  optionsJson: text("options_json").notNull(),
  membersJson: text("members_json").notNull(),
  gameJson: text("game_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("rooms_updated_at_idx").on(table.updatedAt)]);
