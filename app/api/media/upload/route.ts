import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { classifyMime, validateFile } from "@/lib/utils/file-validation";
import { publicEnv } from "@/lib/env";
import { checkRateLimit, clientIdFromRequest, rateLimitHeaders } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "blog-media";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `{userId}/{postId|drafts}/{ts}-{filename}` — matches buildStoragePath().
// The first folder MUST be a UUID we can compare against auth.uid().
const PATH_RE = new RegExp(
  `^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|drafts)/[^/].+$`,
  "i",
);

// fileName is rendered in admin UI without escaping in some places, so we
// strip HTML control chars defensively (`<`, `>`, `"`, `'`) and forbid
// path-traversal segments. The DB column is large enough for 256 chars but
// shorter names render better in lists.
const Body = z.object({
  path: z.string().min(8).max(512),
  fileName: z
    .string()
    .min(1)
    .max(256)
    .refine((s) => !/[<>"']/.test(s), "fileName cannot contain <, >, \", or '")
    .refine((s) => !s.includes("..") && !s.includes("/") && !s.includes("\\"), "fileName cannot contain path separators"),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().nonnegative(),
  postId: z.string().uuid().optional().nullable(),
});

/**
 * POST /api/media/upload
 *
 * Records a `media_assets` row for a file the client has already uploaded
 * directly to Supabase Storage. The actual bytes never travel through this
 * function — that's why we can support 150 MB videos despite Vercel's
 * 4.5 MB request-body limit. The browser hits Supabase Storage directly
 * (see `lib/media/direct-upload.ts`), then sends a small JSON payload here
 * to register the metadata.
 *
 * Security:
 *   1. Caller must be an author or manager (cookie auth).
 *   2. The claimed `path` must start with the caller's own user.id — stops
 *      Alice from registering Bob's upload as her own. Supabase storage RLS
 *      already enforces the same constraint at the storage layer; this is
 *      defense-in-depth.
 *   3. Mime and size must pass the same caps as before.
 */
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit by user id (authenticated endpoint). 30 uploads / 60 s gives
  // legitimate authors plenty of headroom for media-rich posts while still
  // shutting down a runaway script or compromised session.
  const rl = await checkRateLimit("media-upload", user.id);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many uploads. Please slow down." },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile as { role?: string } | null)?.role;
  if (role !== "author" && role !== "manager") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { path, fileName, mimeType, sizeBytes, postId: rawPostId } = parsed.data;

  // Path shape + ownership check.
  const m = PATH_RE.exec(path);
  if (!m) return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  const pathOwner = m[1]!.toLowerCase();
  if (pathOwner !== user.id.toLowerCase()) {
    return NextResponse.json({ error: "Path does not belong to you." }, { status: 403 });
  }

  const mediaType = classifyMime(mimeType);
  if (!mediaType) {
    return NextResponse.json({ error: `Unsupported file type: ${mimeType}` }, { status: 400 });
  }

  // Per-media-type byte cap — same as before, but enforced AFTER the upload
  // now. The client also checks this before uploading; the double-check
  // here closes the loophole where a tampered client could ignore the cap.
  const MB = 1024 * 1024;
  const maxBytes = {
    image: publicEnv.maxUploadMb * MB,
    video: publicEnv.maxVideoUploadMb * MB,
    audio: publicEnv.maxAudioUploadMb * MB,
    document: publicEnv.maxUploadMb * MB,
  };
  const v = validateFile({ size: sizeBytes, mime: mimeType, maxBytes });
  if (!v.ok || !v.mediaType) {
    return NextResponse.json({ error: v.error ?? "Invalid file" }, { status: 400 });
  }

  // Only accept UUID `postId` so a tampered client can't claim the upload
  // belongs to an arbitrary string. Anything else is recorded as draft media.
  const postId =
    typeof rawPostId === "string" && UUID_RE.test(rawPostId) ? rawPostId : null;

  // When the upload targets a specific post, the caller must be allowed to EDIT
  // it (owner, manager, or editor collaborator). This blocks a reviewer
  // collaborator from uploading media into a draft they can only read.
  if (postId) {
    const { data: canEdit, error: rpcErr } = await supabase.rpc("can_edit_draft_post", {
      p_post_id: postId,
    });
    if (rpcErr) {
      return NextResponse.json({ error: "Could not verify post access." }, { status: 500 });
    }
    if (canEdit !== true) {
      return NextResponse.json({ error: "You can't add media to this post." }, { status: 403 });
    }
  }

  const { data: asset } = await supabase
    .from("media_assets")
    .insert({
      owner_id: user.id,
      post_id: postId,
      storage_bucket: BUCKET,
      storage_path: path,
      source_type: "upload",
      media_type: v.mediaType,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      title: fileName,
    })
    .select("id")
    .maybeSingle();

  // Stable internal URL. /api/media/file re-signs the storage path on every
  // request, so embedded media keeps playing forever (no 7-day TTL).
  const stableUrl = `/api/media/file?path=${encodeURIComponent(path)}`;
  return NextResponse.json({
    ok: true,
    path,
    signedUrl: stableUrl,
    mediaType: v.mediaType,
    mediaId: (asset as { id?: string } | null)?.id ?? null,
  });
}
