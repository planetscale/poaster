import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Users table — each user has a unique name and email.
 */
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
  comments: many(comments),
}))

/**
 * Posts table — a user's post body.
 */
export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** Feed sort + count polling: ORDER BY created_at DESC LIMIT N */
    index('idx_posts_created_at').on(t.createdAt.desc()),
    /** Cascade deletes + user profile lookups */
    index('idx_posts_user_id').on(t.userId),
  ],
)

export const postsRelations = relations(posts, ({ one, many }) => ({
  user: one(users, { fields: [posts.userId], references: [users.id] }),
  comments: many(comments),
  postTags: many(postTags),
}))

/**
 * Comments table — a comment on a post by a user.
 */
export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** Lateral joins for comment counts + post detail page */
    index('idx_comments_post_id_created_at').on(t.postId, t.createdAt),
    /** Feed sort: ORDER BY created_at DESC LIMIT N */
    index('idx_comments_created_at').on(t.createdAt.desc()),
  ],
)

export const commentsRelations = relations(comments, ({ one }) => ({
  post: one(posts, { fields: [comments.postId], references: [posts.id] }),
  user: one(users, { fields: [comments.userId], references: [users.id] }),
}))

/**
 * Tags table — named labels for categorizing posts.
 */
export const tags = pgTable('tags', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
})

export const tagsRelations = relations(tags, ({ many }) => ({
  postTags: many(postTags),
}))

/**
 * Post-tags join table — many-to-many between posts and tags.
 */
export const postTags = pgTable(
  'post_tags',
  {
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
)

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}))

// -------------------------------------------------------------------------
// Analytics tables — used by the admin dashboard for heavy query workloads
// -------------------------------------------------------------------------

/**
 * Activity log — large table seeded with ~2M rows for expensive
 * analytical queries. Each row represents a user action (post,
 * comment, like, repost, tag, delete, view) with JSONB metadata.
 */
export const activity = pgTable(
  'activity',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: integer('target_id'),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_activity_user').on(t.userId, t.createdAt),
    index('idx_activity_action').on(t.action, t.createdAt),
    index('idx_activity_target').on(t.targetType, t.targetId, t.createdAt),
  ],
)

/**
 * Report snapshots — written inside analytics transactions to pin
 * the MVCC horizon. Each INSERT assigns a transaction ID (xid) that
 * prevents VACUUM from cleaning dead tuples while the transaction
 * is open.
 */
export const reportSnapshots = pgTable('report_snapshots', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
})
