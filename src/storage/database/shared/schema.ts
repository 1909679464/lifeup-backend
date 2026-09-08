import { sql } from "drizzle-orm";
import { pgTable, serial, timestamp, varchar, boolean, text, jsonb, integer, index } from "drizzle-orm/pg-core"
import { createSchemaFactory } from "drizzle-zod";
import { z } from "zod";



export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 穿搭博主信息表
export const outfitBloggers = pgTable(
  "outfit_bloggers",
  {
    id: serial().primaryKey(),
    style: varchar("style", { length: 50 }).notNull(), // 风格：商务正装、休闲通勤等
    blogger_name: varchar("blogger_name", { length: 200 }).notNull(), // 博主名称
    platform: varchar("platform", { length: 50 }).notNull(), // 平台：小红书、抖音
    followers: varchar("followers", { length: 50 }), // 粉丝数（整数；由 parseFollowers 从 "12万+" 等文本转换而来）
    search_keyword: varchar("search_keyword", { length: 200 }).notNull(), // 主要搜索关键词
    fallback_keywords: jsonb("fallback_keywords"), // 备选关键词数组
    reason: text("reason"), // 推荐理由
    verified: boolean("verified").default(true).notNull(), // 是否已验证
    last_verified: timestamp("last_verified", { withTimezone: true }), // 最后验证时间
    verification_info: text("verification_info"), // 验证信息
    is_active: boolean("is_active").default(true).notNull(), // 是否有效
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    index("outfit_bloggers_style_idx").on(table.style), // 按风格查询
    index("outfit_bloggers_active_idx").on(table.is_active), // 按有效性查询
    index("outfit_bloggers_verified_idx").on(table.verified), // 按验证状态查询
    index("outfit_bloggers_last_verified_idx").on(table.last_verified), // 按验证时间查询
  ]
);

const { createInsertSchema: createCoercedInsertSchema } = createSchemaFactory({ coerce: { date: true } });
export const insertOutfitBloggerSchema = createCoercedInsertSchema(outfitBloggers).pick({
  style: true,
  blogger_name: true,
  platform: true,
  followers: true,
  search_keyword: true,
  fallback_keywords: true,
  reason: true,
  verified: true,
  last_verified: true,
  verification_info: true,
  is_active: true,
});
export type OutfitBlogger = typeof outfitBloggers.$inferSelect;
export type InsertOutfitBlogger = z.infer<typeof insertOutfitBloggerSchema>;

// 博主验证日志表
export const bloggerVerificationLogs = pgTable(
  "blogger_verification_logs",
  {
    id: serial().primaryKey(),
    blogger_id: integer("blogger_id").notNull().references(() => outfitBloggers.id),
    verification_result: boolean("verification_result").notNull(), // 验证结果
    verification_details: text("verification_details"), // 验证详情
    verified_at: timestamp("verified_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("blogger_verification_logs_blogger_id_idx").on(table.blogger_id), // 按博主ID查询
    index("blogger_verification_logs_verified_at_idx").on(table.verified_at), // 按验证时间查询
  ]
);

export const insertBloggerVerificationLogSchema = createCoercedInsertSchema(bloggerVerificationLogs).pick({
  blogger_id: true,
  verification_result: true,
  verification_details: true,
});
export type BloggerVerificationLog = typeof bloggerVerificationLogs.$inferSelect;
export type InsertBloggerVerificationLog = z.infer<typeof insertBloggerVerificationLogSchema>;
