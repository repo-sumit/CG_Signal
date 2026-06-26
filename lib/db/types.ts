// Minimal hand-written Database type — sufficient for our hand-rolled query helpers.
// In a real project, regenerate with `supabase gen types typescript` and replace this file.

export type AppRole = "viewer" | "writer" | "author" | "manager";
export type PostStatus = "draft" | "submitted" | "scheduled" | "published" | "archived" | "hidden";
/**
 * Review sub-state for the admin approval workflow. Orthogonal to `PostStatus`:
 * `status` is the publishing lifecycle, `review_status` is where a post sits in
 * the review queue. General-writer posts move not_submitted → under_review →
 * approved (and live) | changes_requested | rejected.
 */
export type ReviewStatus =
  | "not_submitted"
  | "under_review"
  | "changes_requested"
  | "approved"
  | "rejected";
export type MediaType = "image" | "video" | "audio" | "document";
export type MediaSourceType = "upload" | "external_url";

/** Collaboration role on a single post — distinct from the app-wide AppRole. */
export type PostCollaboratorRole = "editor" | "reviewer";
/** Public co-author credit role. */
export type PostContributorRole = "owner" | "editor" | "contributor";

export interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: AppRole;
  weekly_post_day: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthorizedUserRow {
  id: string;
  email: string;
  role: AppRole;
  weekly_post_day: number | null;
  created_by: string | null;
  created_at: string;
}

export interface TagRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface PostRow {
  id: string;
  author_id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  content_json: unknown;
  content_html: string;
  status: PostStatus;
  week_start_date: string;
  assigned_weekday: number | null;
  published_at: string | null;
  scheduled_for: string | null;
  cover_media_id: string | null;
  read_time_minutes: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  newsletter_sent_at: string | null;
  review_status: ReviewStatus;
  submitted_for_review_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  rejection_reason: string | null;
  hidden_at: string | null;
  hidden_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface SubscriberRow {
  id: string;
  email: string;
  unsubscribe_token: string;
  unsubscribed_at: string | null;
  created_at: string;
  source: string | null;
  user_id: string | null;
  welcome_sent_at: string | null;
}

export interface PostCollaboratorInviteRow {
  id: string;
  post_id: string;
  email: string;
  role: PostCollaboratorRole;
  invited_by: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  created_at: string;
}

export interface MediaAssetRow {
  id: string;
  owner_id: string;
  post_id: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  source_type: MediaSourceType;
  media_type: MediaType;
  mime_type: string | null;
  size_bytes: number | null;
  external_url: string | null;
  provider: string | null;
  title: string | null;
  alt_text: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface PostTemplateRow {
  id: string;
  name: string;
  description: string | null;
  content_json: unknown;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
}

export interface PostCollaboratorRow {
  id: string;
  post_id: string;
  user_id: string;
  role: PostCollaboratorRole;
  invited_by: string | null;
  created_at: string;
}

export interface PostEditLockRow {
  post_id: string;
  locked_by: string;
  locked_at: string;
  expires_at: string;
}

export interface PostReviewCommentRow {
  id: string;
  post_id: string;
  user_id: string;
  body: string;
  resolved_at: string | null;
  created_at: string;
}

export interface PostContributorRow {
  id: string;
  post_id: string;
  user_id: string;
  role: PostContributorRole;
  display_order: number;
  created_at: string;
}

// `Database` is intentionally permissive — we only use it as a generic to the
// Supabase client so server queries compile without `any`. Replace with
// generated types (`supabase gen types typescript`) in production.
//
// IMPORTANT: each `Tables` entry MUST include a `Relationships` field, and the
// `Views` / `CompositeTypes` must use the `{ [_ in never]: never }` empty-shape
// idiom. Otherwise supabase-js's `GenericSchema` constraint silently rejects
// the Database type and falls back to default overloads where `rpc()` requires
// `args: undefined`. See https://github.com/supabase/postgrest-js types.ts.
type GenericTable = {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      app_settings: GenericTable;
      profiles: GenericTable;
      authorized_users: GenericTable;
      tags: GenericTable;
      post_templates: GenericTable;
      posts: GenericTable;
      media_assets: GenericTable;
      post_tags: GenericTable;
      audit_logs: GenericTable;
      post_collaborators: GenericTable;
      post_edit_locks: GenericTable;
      post_review_comments: GenericTable;
      post_contributors: GenericTable;
    };
    Views: { [_ in never]: never };
    Functions: {
      assign_weekday: {
        Args: { p_user_id: string; p_weekday: number | null };
        Returns: undefined;
      };
      bootstrap_profile: {
        Args: Record<string, never>;
        Returns: unknown;
      };
      is_convegenius_user: { Args: Record<string, never>; Returns: boolean };
      is_manager: { Args: Record<string, never>; Returns: boolean };
      current_user_role: { Args: Record<string, never>; Returns: AppRole };
      is_author_or_manager: { Args: Record<string, never>; Returns: boolean };
      is_writer_or_above: { Args: Record<string, never>; Returns: boolean };
      is_authorized_author: { Args: Record<string, never>; Returns: boolean };
      is_post_owner: { Args: { p_post_id: string }; Returns: boolean };
      is_post_collaborator: { Args: { p_post_id: string }; Returns: boolean };
      is_post_editor_collaborator: { Args: { p_post_id: string }; Returns: boolean };
      can_read_draft_post: { Args: { p_post_id: string }; Returns: boolean };
      can_edit_draft_post: { Args: { p_post_id: string }; Returns: boolean };
      can_review_draft_post: { Args: { p_post_id: string }; Returns: boolean };
      can_manage_post_collaborators: { Args: { p_post_id: string }; Returns: boolean };
    };
    Enums: {
      app_role: AppRole;
      post_status: PostStatus;
      media_type: MediaType;
      media_source_type: MediaSourceType;
    };
    CompositeTypes: { [_ in never]: never };
  };
};
