"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEditor, EditorContent, BubbleMenu } from "@tiptap/react";
import { toast } from "sonner";
import {
  Save, FileCheck2, Loader2, Sparkles, Send,
  Image as ImageIcon, Video, Music, Link as LinkIcon,
  Upload, X, Check, Calendar, RotateCcw,
  Bold, Italic, Underline as UnderlineIcon, Highlighter,
} from "lucide-react";
import { editorExtensions } from "@/lib/editor/extensions";
import { sanitizePastedHtml } from "@/lib/editor/paste-sanitize";
import { WEEKLY_TEMPLATE } from "@/lib/editor/template";
import {
  clearLocalDraft,
  isLocalDraftNewerThan,
  loadLocalDraft,
  saveLocalDraft,
  type LocalDraftSnapshot,
} from "@/lib/editor/local-draft";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EditorToolbar } from "@/components/editor/EditorToolbar";
import { SchedulePostModal } from "@/components/editor/SchedulePostModal";
import { CollaboratorsPanel } from "@/components/editor/CollaboratorsPanel";
import { ReviewCommentsPanel } from "@/components/editor/ReviewCommentsPanel";
import { createTagAsAuthor, savePost } from "@/app/(app)/editor/actions";
import { LOCK_HEARTBEAT_MS, type EditorCollaborationProps, type LockHolder } from "@/lib/auth/collaboration";
import { Eye, Lock as LockIcon, Pencil } from "lucide-react";
import { wordCount } from "@/lib/utils/read-time";
import { formatScheduledLabel } from "@/lib/utils/dates";
import { track } from "@/lib/analytics/track";
import { parseEmbedUrl } from "@/lib/utils/embeds";
import { validateFile } from "@/lib/utils/file-validation";
import { directUploadMedia } from "@/lib/media/direct-upload";
import { insertMediaBlock, insertVideoEmbed } from "@/lib/editor/media-extensions";
import { publicEnv } from "@/lib/env";
import type { PostRow, PostStatus, ReviewStatus, TagRow, AppRole } from "@/lib/db/types";
import { cn } from "@/lib/utils/cn";

type SaveState = "idle" | "saving" | "saved" | "unsaved" | "error";

interface Props {
  initialPost?: Partial<PostRow> & {
    tag_ids?: string[];
    content_json?: unknown;
    /** Pre-resolved cover image — `url` points at /api/media/file. */
    cover?: { id: string; url: string } | null;
  };
  tags: Pick<TagRow, "id" | "name" | "slug">[];
  role: AppRole;
  requireReview: boolean;
  collaboration: EditorCollaborationProps;
}

interface PostImage {
  id: string;
  url: string;
  title?: string | null;
}

// Autosave fires 15s after the user stops typing — long enough that we're not
// thrashing Supabase, short enough that crashes don't lose meaningful work.
const AUTOSAVE_MS = 15_000;
// Local draft snapshot is much cheaper than the server round-trip, so we
// fire it five times faster. Worst-case lost work between two writes is ~3s.
const LOCAL_BACKUP_MS = 3_000;

export function PostEditor({ initialPost, tags, role, requireReview, collaboration }: Props) {
  const router = useRouter();
  const isNew = !initialPost?.id;

  // --- Collaboration roles -------------------------------------------------
  const { relationship, canEdit, currentUser } = collaboration;
  const isReviewer = relationship === "reviewer";
  const isCollabEditor = relationship === "editor";
  const isOwnerOrManager = relationship === "owner" || relationship === "manager";
  // General writers (any @convegenius.ai employee) author through the review
  // queue: only Save Draft + Submit for Review, never direct publish/schedule.
  const isGeneralWriter = role === "writer";
  const reviewStatus: ReviewStatus = (initialPost?.review_status as ReviewStatus) ?? "not_submitted";

  const initialTitle = initialPost?.title === "Untitled draft" ? "" : (initialPost?.title ?? "");

  const [postId, setPostId] = useState<string | undefined>(initialPost?.id);
  const [title, setTitle] = useState(initialTitle);
  const [titleTouched, setTitleTouched] = useState(initialTitle.trim().length > 0);
  const [excerpt, setExcerpt] = useState(initialPost?.excerpt ?? "");
  const [status, setStatus] = useState<PostStatus>((initialPost?.status as PostStatus) ?? "draft");
  const [scheduledFor, setScheduledFor] = useState<string | null>(initialPost?.scheduled_for ?? null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(initialPost?.tag_ids ?? []);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<null | "draft" | "schedule" | "now" | "revert">(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [words, setWords] = useState(() => wordCount((initialPost?.excerpt ?? "") + " "));
  const [coverMediaId, setCoverMediaId] = useState<string | null>(initialPost?.cover?.id ?? null);
  const [coverUrl, setCoverUrl] = useState<string | null>(initialPost?.cover?.url ?? null);
  const [coverBrowserOpen, setCoverBrowserOpen] = useState(false);
  const [postImages, setPostImages] = useState<PostImage[]>([]);
  const [coverBrowserLoading, setCoverBrowserLoading] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);

  const titleEmpty = title.trim().length === 0;
  const titleInvalid = titleEmpty && titleTouched;

  // Local copy of the tag catalogue so we can append a freshly-created tag
  // without remounting the editor. Seeded from the server prop.
  const [tagOptions, setTagOptions] = useState(tags);
  const [newTagInput, setNewTagInput] = useState("");
  const [creatingTag, setCreatingTag] = useState(false);
  const MAX_TAGS_PER_POST = 10;
  const MAX_TAG_LENGTH = 30;

  // Local-storage draft restore prompt: holds the newer-than-server snapshot
  // we found on mount, until the user explicitly restores or discards it.
  // `null` after either action so the banner unmounts.
  const [restoreCandidate, setRestoreCandidate] = useState<LocalDraftSnapshot | null>(null);

  const editor = useEditor({
    extensions: editorExtensions(),
    content: (initialPost?.content_json as object) ?? { type: "doc", content: [{ type: "paragraph" }] },
    editable: canEdit,
    editorProps: {
      attributes: { class: "prose max-w-none focus:outline-none" },
      // Run Google-Docs / Word HTML through the paste sanitizer BEFORE
      // ProseMirror parses it into the schema. Anything we can't keep (vendor
      // classes, page layouts, oversized fonts) is dropped here so the rich
      // formatting that survives feels native to the CG SIGNAL editor.
      transformPastedHTML: (html: string) => sanitizePastedHtml(html),
    },
    immediatelyRender: false,
  });

  // --- Edit lock -----------------------------------------------------------
  // `lockedByOther` is set when another user holds the active lock — editing is
  // disabled until they release it (or an owner/manager takes over).
  const initialOtherHolder =
    collaboration.initialLock && collaboration.initialLock.lockedBy.id !== currentUser.id
      ? collaboration.initialLock.lockedBy
      : null;
  const [lockedByOther, setLockedByOther] = useState<LockHolder | null>(initialOtherHolder);
  // Content is editable only when the user may edit AND no one else holds the lock.
  const canEditContent = canEdit && lockedByOther === null;

  const acquireLock = useCallback(async () => {
    if (!postId || !canEdit) return;
    try {
      const res = await fetch(`/api/posts/${postId}/lock`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        lockedBy?: LockHolder | null;
      };
      if (res.status === 409) {
        setLockedByOther(data.lockedBy ?? null);
        return;
      }
      if (res.ok && data.ok) setLockedByOther(null);
    } catch {
      /* network blip — keep current state, heartbeat will retry */
    }
  }, [postId, canEdit]);

  // Acquire on mount / once a brand-new post has an id, and refresh on a
  // heartbeat so the lock never lapses while the tab is active.
  useEffect(() => {
    if (!postId || !canEdit) return;
    void acquireLock();
    const interval = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/posts/${postId}/lock/heartbeat`, { method: "POST" });
          if (res.status === 409) {
            const data = (await res.json().catch(() => ({}))) as { lockedBy?: LockHolder | null };
            // Another user holds it → drop to read-only. No holder → the lock
            // lapsed and is free, so re-acquire it for ourselves.
            if (data.lockedBy) setLockedByOther(data.lockedBy);
            else void acquireLock();
          } else if (res.ok) {
            setLockedByOther(null);
          }
        } catch {
          /* ignore */
        }
      })();
    }, LOCK_HEARTBEAT_MS);
    return () => clearInterval(interval);
  }, [postId, canEdit, acquireLock]);

  // Release the lock when leaving the editor (SPA unmount + hard navigation).
  useEffect(() => {
    if (!postId || !canEdit) return;
    const url = `/api/posts/${postId}/lock/unlock`;
    const release = () => {
      try {
        navigator.sendBeacon?.(url, new Blob([], { type: "application/json" }));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("beforeunload", release);
    return () => {
      window.removeEventListener("beforeunload", release);
      void fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    };
  }, [postId, canEdit]);

  // Keep ProseMirror's editable flag in sync with permission + lock state.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(canEditContent);
  }, [editor, canEditContent]);

  // Owner / manager "take over": force-release another holder's lock, then grab it.
  const handleTakeOver = useCallback(async () => {
    if (!postId) return;
    try {
      await fetch(`/api/posts/${postId}/lock/unlock`, { method: "POST" });
      await acquireLock();
      toast.success("You're now editing this post.");
    } catch {
      toast.error("Couldn't take over editing.");
    }
  }, [postId, acquireLock]);

  // Track whether the user edited during an in-flight save. If so, we must NOT
  // overwrite the post-save state with "saved" — the editor content has diverged
  // from what we just persisted, so mark "unsaved" to trigger another autosave.
  const dirtyDuringSave = useRef(false);

  // Mark unsaved on any edit and refresh the word counter.
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      setSaveState((s) => {
        if (s === "saving") {
          dirtyDuringSave.current = true;
          return s;
        }
        return "unsaved";
      });
      setWords(wordCount(editor.getText()));
    };
    editor.on("update", onUpdate);
    setWords(wordCount(editor.getText()));
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonically increasing token. Every save acquires the next value; only
  // the response whose token is still current is allowed to reconcile React
  // state. This prevents a stale autosave from clobbering a Post Now that
  // started later (and prevents the reverse on slow networks).
  const saveVersionRef = useRef(0);
  // Set to true while a manual save (draft/now/schedule) is in flight so the
  // autosave effect skips firing.
  const manualSaveInFlight = useRef(false);

  const handleSave = useCallback(
    async (
      overrideStatus?: PostStatus,
      opts: { scheduledFor?: string | null; source?: "manual" | "autosave" } = {},
    ) => {
      if (!editor) return null;
      // Title is required for anything beyond a draft. Drafts may save with an
      // empty title — autosave keeps running while the user is still typing.
      const nextStatus = overrideStatus ?? status;
      const promotingBeyondDraft = nextStatus !== "draft";
      if (promotingBeyondDraft && !title.trim()) {
        setTitleTouched(true);
        toast.error("Please add a title before saving.");
        return null;
      }
      // Cancel any pending autosave timer so it doesn't fire underneath us.
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
      // Acquire the version token for this attempt; any older save responses
      // that resolve after us will be ignored on the response path.
      const versionAtStart = ++saveVersionRef.current;
      const isManual = (opts.source ?? "manual") === "manual";
      if (isManual) manualSaveInFlight.current = true;

      dirtyDuringSave.current = false;
      setSaveState("saving");
      // TipTap's `getJSON()` can return objects whose internal nodes aren't
      // built from `Object.prototype` — that trips Next.js's strict Server
      // Action payload check ("Only plain objects, and a few built-ins, can
      // be passed to Server Actions"). The cheapest reliable fix is a JSON
      // round-trip: it strips every prototype and yields a guaranteed POJO.
      const json = JSON.parse(JSON.stringify(editor.getJSON())) as unknown;
      const html = editor.getHTML();
      const scheduled = opts.scheduledFor ?? (nextStatus === "scheduled" ? scheduledFor : null);
      // Build the payload with NO `undefined` values — pass nulls explicitly
      // for optional-nullable fields. Some Next versions reject `undefined`
      // entries from the RSC serializer; null is always safe.
      const res = await savePost({
        id: postId ?? undefined,
        title: title.trim(),
        excerpt: excerpt?.trim() || null,
        content_json: json,
        content_html: html,
        status: nextStatus,
        scheduled_for: scheduled,
        cover_media_id: coverMediaId ?? null,
        tag_ids: [...selectedTagIds],
      });

      // If a newer save was started while we were awaiting (e.g. the user
      // hit Post Now mid-autosave), let that newer save own the state — don't
      // overwrite with our (now stale) result.
      const isLatest = versionAtStart === saveVersionRef.current;
      if (isManual) manualSaveInFlight.current = false;
      if (!isLatest) {
        return res;
      }

      if (!res.ok) {
        setSaveState("error");
        toast.error(res.error || "Save failed.");
        return null;
      }
      setPostId(res.id);
      setStatus((res.status as PostStatus) ?? nextStatus);
      // Reconcile scheduled_for with the server's view: explicit value when
      // status==='scheduled', null otherwise (e.g. on Post Now or revert).
      setScheduledFor(res.scheduledFor ?? null);
      setSaveState(dirtyDuringSave.current ? "unsaved" : "saved");
      setLastSavedAt(new Date());
      if (isNew && res.id) {
        window.history.replaceState(null, "", `/editor/${res.id}`);
      }
      // Server snapshot is now canonical — drop the local backup so the
      // "newer local copy" prompt can't fire on a future mount unless the
      // user edits again. New posts: clear under the `new` key AND the
      // freshly-assigned id key so neither slot lingers.
      if (!dirtyDuringSave.current) {
        clearLocalDraft(isNew ? undefined : postId);
        if (isNew && res.id) clearLocalDraft(res.id);
      }
      return res;
    },
    [editor, title, excerpt, postId, status, scheduledFor, coverMediaId, selectedTagIds, isNew],
  );

  // Autosave loop (debounced via timeout). Skips when a manual save is in
  // flight so we don't queue a second request that could race the first.
  useEffect(() => {
    if (!canEditContent) return;
    if (saveState !== "unsaved") return;
    if (manualSaveInFlight.current) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      if (manualSaveInFlight.current) return;
      void handleSave(undefined, { source: "autosave" });
    }, AUTOSAVE_MS);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [saveState, handleSave, canEditContent]);

  // Local-storage backup loop. Independent of server autosave so a crash
  // between two server saves leaves at most ~3s of work missing. See
  // `docs/frontend-cache-audit.md` for the full storage contract.
  const localBackupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!editor) return;
    if (!canEditContent) return;
    if (saveState !== "unsaved") return;
    if (localBackupTimer.current) clearTimeout(localBackupTimer.current);
    localBackupTimer.current = setTimeout(() => {
      saveLocalDraft(postId, {
        title,
        excerpt: excerpt?.trim() || null,
        contentJSON: JSON.parse(JSON.stringify(editor.getJSON())),
        contentHTML: editor.getHTML(),
        status,
        scheduledFor,
        tagIds: [...selectedTagIds],
        coverMediaId,
        savedAt: new Date().toISOString(),
      });
    }, LOCAL_BACKUP_MS);
    return () => {
      if (localBackupTimer.current) clearTimeout(localBackupTimer.current);
    };
  }, [
    editor,
    saveState,
    postId,
    title,
    excerpt,
    status,
    scheduledFor,
    selectedTagIds,
    coverMediaId,
    canEditContent,
  ]);

  // Mount: look for a local snapshot newer than the server's last update.
  // Only fires once per editor instance — guarded by a ref so React 18
  // StrictMode's double-invoke doesn't re-prompt.
  const restoreChecked = useRef(false);
  useEffect(() => {
    if (restoreChecked.current) return;
    restoreChecked.current = true;
    const snapshot = loadLocalDraft(initialPost?.id);
    if (!snapshot) return;
    if (isLocalDraftNewerThan(snapshot, initialPost?.updated_at ?? null)) {
      setRestoreCandidate(snapshot);
    } else {
      // Server is at least as fresh — discard the stale local copy so we
      // don't keep re-prompting on future mounts.
      clearLocalDraft(initialPost?.id);
    }
  }, [initialPost?.id, initialPost?.updated_at]);

  const handleRestoreLocalDraft = useCallback(() => {
    const snap = restoreCandidate;
    if (!snap || !editor) return;
    setTitle(snap.title ?? "");
    setExcerpt(snap.excerpt ?? "");
    setSelectedTagIds(snap.tagIds ?? []);
    setCoverMediaId(snap.coverMediaId ?? null);
    if (snap.scheduledFor !== undefined) setScheduledFor(snap.scheduledFor ?? null);
    if (snap.contentJSON) {
      editor.commands.setContent(snap.contentJSON as object);
    }
    setSaveState("unsaved");
    setRestoreCandidate(null);
    toast.success("Local draft restored. Save to push it to the server.");
  }, [restoreCandidate, editor]);

  const handleDiscardLocalDraft = useCallback(() => {
    clearLocalDraft(initialPost?.id);
    setRestoreCandidate(null);
  }, [initialPost?.id]);

  const insertTemplate = useCallback(() => {
    if (!editor) return;
    if (
      editor.getText().trim().length > 0 &&
      !window.confirm("Replace the current content with the weekly template?")
    ) {
      return;
    }
    editor.chain().focus().setContent(WEEKLY_TEMPLATE).run();
    setSaveState("unsaved");
  }, [editor]);

  const handleFileInsert = useCallback(
    (kind: "image" | "video" | "audio") => async (file: File) => {
      if (!editor) return;
      const MB = 1024 * 1024;
      const maxBytes = {
        image: publicEnv.maxUploadMb * MB,
        video: publicEnv.maxVideoUploadMb * MB,
        audio: publicEnv.maxAudioUploadMb * MB,
        document: publicEnv.maxUploadMb * MB,
      };
      const v = validateFile({ size: file.size, mime: file.type, maxBytes });
      if (!v.ok) {
        toast.error(v.error || "File rejected.");
        return;
      }
      if (kind === "image" && v.mediaType !== "image") {
        toast.error("Choose an image file.");
        return;
      }
      if (kind === "video" && v.mediaType !== "video") {
        toast.error("Choose a video file.");
        return;
      }
      if (kind === "audio" && v.mediaType !== "audio") {
        toast.error("Choose an audio file.");
        return;
      }

      const toastId = toast.loading(`Uploading ${file.name}…`);
      try {
        // Direct upload to Supabase Storage — bypasses Vercel's 4.5 MB
        // function payload limit so 150 MB videos work.
        const result = await directUploadMedia({ file, postId });
        if (!result.ok || !result.signedUrl) {
          throw new Error(result.error || "Upload failed.");
        }
        if (result.mediaType === "image") {
          editor.chain().focus().setImage({ src: result.signedUrl, alt: file.name }).run();
        } else if (result.mediaType === "video") {
          // Typed node insert — schema-aware, so ProseMirror manages the DOM
          // lifecycle cleanly. Replaces the old raw-HTML `insertContent` path
          // that caused the `removeChild` console error + invisible media.
          insertMediaBlock(editor, "video", { src: result.signedUrl, title: file.name });
        } else {
          insertMediaBlock(editor, "audio", { src: result.signedUrl, title: file.name });
        }
        setSaveState("unsaved");
        toast.success("Inserted.", { id: toastId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Upload failed.";
        toast.error(msg, { id: toastId });
      }
    },
    [editor, postId],
  );

  const handleEmbed = useCallback(() => {
    if (!editor) return;
    const url = window.prompt("Paste a YouTube, Vimeo, Loom, or Google Drive video URL:");
    if (!url) return;
    const info = parseEmbedUrl(url);
    if (!info) {
      toast.error("Unsupported video link. Use YouTube, Loom, Vimeo, or Google Drive.");
      return;
    }
    insertVideoEmbed(editor, { src: info.embedUrl, provider: info.provider });
    setSaveState("unsaved");
    toast.success("Video embed added.");
  }, [editor]);

  // Paste-to-embed: when the clipboard contains JUST a supported video URL
  // (no other text), insert it as a typed embed node instead of dropping a
  // bare link into the paragraph. Multi-word pastes that happen to contain
  // a URL fall through to TipTap's normal link auto-detection.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const trimmed = text.trim();
      // Must be a single bare URL — no spaces, no newlines.
      if (!trimmed || trimmed.includes("\n") || trimmed.includes(" ")) return;
      if (!/^https?:\/\//i.test(trimmed)) return;
      const info = parseEmbedUrl(trimmed);
      if (!info) return;
      event.preventDefault();
      event.stopPropagation();
      insertVideoEmbed(editor, { src: info.embedUrl, provider: info.provider });
      setSaveState("unsaved");
      toast.success("Video embed added.");
    };
    dom.addEventListener("paste", onPaste);
    return () => dom.removeEventListener("paste", onPaste);
  }, [editor]);

  const handleSaveDraft = useCallback(async () => {
    setBusyAction("draft");
    const res = await handleSave("draft");
    setBusyAction(null);
    if (res?.ok) toast.success("Draft saved.");
  }, [handleSave]);

  // Editor collaborators can only save content — the server preserves the
  // post's status, so we pass it through unchanged.
  const handleSaveChanges = useCallback(async () => {
    setBusyAction("draft");
    const res = await handleSave(status);
    setBusyAction(null);
    if (res?.ok) toast.success("Changes saved.");
  }, [handleSave, status]);

  const handlePostNow = useCallback(async () => {
    if (!title.trim()) {
      setTitleTouched(true);
      toast.error("Please add a title before saving.");
      return;
    }
    setBusyAction("now");
    const requested: PostStatus = requireReview && role === "author" ? "submitted" : "published";
    const res = await handleSave(requested, { scheduledFor: null });
    setBusyAction(null);
    if (!res?.ok) return;
    const final = (res.status as PostStatus) ?? requested;
    if (final === "submitted") {
      toast.success("Submitted for review.");
      router.push("/me/posts");
    } else if (final === "published" && res.slug && res.id) {
      track("post_published", {
        postId: res.id,
        slug: res.slug,
        isManager: role === "manager",
      });
      toast.success("Post published successfully.");
      router.push(`/posts/${res.slug}`);
    } else {
      router.push("/me/posts");
    }
  }, [handleSave, requireReview, role, router, title]);

  // General-writer Submit for Review. Sets the post to "submitted"; the server
  // flips review_status to under_review, stamps submitted_for_review_at, and
  // notifies admins. Editing afterwards keeps it under review (no auto-revert).
  const handleSubmitForReview = useCallback(async () => {
    if (!title.trim()) {
      setTitleTouched(true);
      toast.error("Please add a title before submitting.");
      return;
    }
    setBusyAction("now");
    const res = await handleSave("submitted", { scheduledFor: null });
    setBusyAction(null);
    if (!res?.ok) return;
    toast.success("Submitted for review. An admin will review your signal before it goes live.");
    router.push("/me/posts");
  }, [handleSave, title, router]);

  const handleConfirmSchedule = useCallback(
    async (iso: string) => {
      if (!title.trim()) {
        setTitleTouched(true);
        toast.error("Please add a title before saving.");
        return;
      }
      setBusyAction("schedule");
      const res = await handleSave("scheduled", { scheduledFor: iso });
      setBusyAction(null);
      if (!res?.ok) return;
      setScheduleModalOpen(false);
      const slot = res.scheduledFor ?? iso;
      if (res.id && res.slug) {
        track("post_scheduled", {
          postId: res.id,
          slug: res.slug,
          isManager: role === "manager",
          scheduledForIso: slot,
        });
      }
      toast.success(`Scheduled for ${formatScheduledLabel(slot)}.`);
    },
    [handleSave, role, title],
  );

  const handleRevertToDraft = useCallback(async () => {
    if (!window.confirm("Move this post back to draft? It will be unpublished/unscheduled.")) return;
    setBusyAction("revert");
    const res = await handleSave("draft", { scheduledFor: null });
    setBusyAction(null);
    if (res?.ok) toast.success("Reverted to draft.");
  }, [handleSave]);

  const postNowLabel = useMemo(
    () => (requireReview && role === "author" ? "Submit for review" : "Post Now"),
    [requireReview, role],
  );

  // Inline tag creation. Trims, validates, asks the server, and immediately
  // selects the new tag for this post. Server returns the existing row when
  // the name / slug already exists so we don't get duplicates.
  const handleCreateTag = useCallback(async () => {
    const raw = newTagInput.trim();
    if (!raw) return;
    if (raw.length > MAX_TAG_LENGTH) {
      toast.error(`Tag must be ${MAX_TAG_LENGTH} characters or less.`);
      return;
    }
    if (selectedTagIds.length >= MAX_TAGS_PER_POST) {
      toast.error(`Up to ${MAX_TAGS_PER_POST} tags per post.`);
      return;
    }
    // Local case-insensitive dedupe: if a tag with the same display name
    // already exists in our local options, just select it.
    const existingLocal = tagOptions.find(
      (t) => t.name.toLowerCase() === raw.toLowerCase(),
    );
    if (existingLocal) {
      if (!selectedTagIds.includes(existingLocal.id)) {
        setSelectedTagIds((prev) => [...prev, existingLocal.id]);
        setSaveState("unsaved");
      }
      setNewTagInput("");
      return;
    }
    setCreatingTag(true);
    try {
      const res = await createTagAsAuthor({ name: raw });
      if (!res.ok || !res.tag) {
        toast.error(res.error || "Could not create tag.");
        return;
      }
      const created = res.tag;
      setTagOptions((prev) =>
        prev.some((t) => t.id === created.id) ? prev : [...prev, created],
      );
      setSelectedTagIds((prev) =>
        prev.includes(created.id) ? prev : [...prev, created.id],
      );
      setSaveState("unsaved");
      setNewTagInput("");
    } finally {
      setCreatingTag(false);
    }
  }, [newTagInput, selectedTagIds, tagOptions]);

  // Thumbnail picker handlers.
  const openCoverBrowser = useCallback(async () => {
    setCoverBrowserOpen(true);
    if (!postId) return;
    setCoverBrowserLoading(true);
    try {
      const res = await fetch(`/api/media/list?postId=${postId}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { images?: PostImage[] };
      setPostImages(data.images ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load images.";
      toast.error(msg);
    } finally {
      setCoverBrowserLoading(false);
    }
  }, [postId]);

  const selectCover = useCallback((img: PostImage) => {
    setCoverMediaId(img.id);
    setCoverUrl(img.url);
    setCoverBrowserOpen(false);
    setSaveState("unsaved");
  }, []);

  const clearCover = useCallback(() => {
    setCoverMediaId(null);
    setCoverUrl(null);
    setSaveState("unsaved");
  }, []);

  const uploadCover = useCallback(
    async (file: File) => {
      const maxBytes = publicEnv.maxUploadMb * 1024 * 1024;
      const v = validateFile({ size: file.size, mime: file.type, maxBytes });
      if (!v.ok) {
        toast.error(v.error || "File rejected.");
        return;
      }
      if (v.mediaType !== "image") {
        toast.error("Choose an image file.");
        return;
      }
      setCoverUploading(true);
      const toastId = toast.loading(`Uploading ${file.name}…`);
      try {
        // Direct upload — same flow as the body insert; sidesteps Vercel's
        // 4.5 MB payload cap. Cover images are usually small but using the
        // same path keeps both call-sites consistent.
        const result = await directUploadMedia({ file, postId });
        if (!result.ok || !result.mediaId || !result.signedUrl) {
          throw new Error(result.error || "Upload failed.");
        }
        setCoverMediaId(result.mediaId);
        setCoverUrl(result.signedUrl);
        setSaveState("unsaved");
        toast.success("Thumbnail set.", { id: toastId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed.";
        toast.error(msg, { id: toastId });
      } finally {
        setCoverUploading(false);
      }
    },
    [postId],
  );

  const readMin = Math.max(1, Math.round(words / 220));

  const anyActionBusy = busyAction !== null;

  return (
    // Tight top spacing — was pt-4 sm:pt-6 + the back-bar's mb-3 + the action
    // row's mb-4 = ~80px of pre-editor padding which left a big empty block
    // above the toolbar. Compressed to fit the editor closer to the nav.
    <div className="mx-auto w-full max-w-screen-xl px-3 pb-10 pt-3 sm:px-4 sm:pb-12 sm:pt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 sm:mb-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/me/posts">← My posts</Link>
        </Button>
        <span className="ml-auto text-xs text-muted-foreground" role="status" aria-live="polite">
          {saveState === "saving" && (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </span>
          )}
          {saveState === "saved" && (
            <span className="inline-flex items-center gap-1 text-success">
              <FileCheck2 className="h-3 w-3" /> Draft saved
              {lastSavedAt && (
                <> · {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(lastSavedAt)}</>
              )}
            </span>
          )}
          {saveState === "unsaved" && <span className="text-warning">Unsaved changes</span>}
          {saveState === "error" && <span className="text-destructive">Save failed</span>}
        </span>
      </div>

      {/* Collaboration mode banner — locked > reviewer > collaborator editor. */}
      {lockedByOther ? (
        <div
          role="status"
          className="mb-3 flex flex-col gap-2 rounded-md border border-portal-yellow/40 bg-portal-yellow/5 p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-center gap-2 text-sm text-portal-text">
            <LockIcon className="h-4 w-4 shrink-0 text-portal-yellow" />
            <span>
              <strong>{lockedByOther.name}</strong> is editing this post. You can review, but
              editing is locked.
            </span>
          </div>
          {isOwnerOrManager && (
            <Button type="button" variant="secondary" size="sm" onClick={handleTakeOver}>
              Take over editing
            </Button>
          )}
        </div>
      ) : isReviewer ? (
        <div
          role="status"
          className="mb-3 flex items-center gap-2 rounded-md border border-portal-blue/40 bg-portal-blue/5 p-3 text-sm text-portal-text"
        >
          <Eye className="h-4 w-4 shrink-0 text-portal-blue" />
          <span>
            <strong>Review mode.</strong> You can read the draft and leave comments. Editing is
            disabled.
          </span>
        </div>
      ) : isCollabEditor ? (
        <div
          role="status"
          className="mb-3 flex items-center gap-2 rounded-md border border-portal-green/40 bg-portal-green/5 p-3 text-sm text-portal-text"
        >
          <Pencil className="h-4 w-4 shrink-0 text-portal-green" />
          <span>
            <strong>Editing unlocked for you.</strong> You're collaborating on this draft — the
            owner controls publishing.
          </span>
        </div>
      ) : null}

      {/* Local-draft restore banner. Renders only when we found a newer
          local snapshot than what the server has — typically after a tab
          crash. Discard clears the snapshot so it can't haunt later mounts. */}
      {restoreCandidate && (
        <div
          role="status"
          className="mb-3 flex flex-col gap-2 rounded-md border border-portal-yellow/40 bg-portal-yellow/5 p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-portal-yellow">
              Unsaved local changes
            </div>
            <p className="mt-0.5 text-sm text-portal-text-muted">
              We found a draft on this device newer than the server copy.
              Restore it, or discard to keep editing the server version.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDiscardLocalDraft}
            >
              Discard
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleRestoreLocalDraft}
            >
              <RotateCcw className="h-4 w-4" />
              Restore local
            </Button>
          </div>
        </div>
      )}

      {/* Review banner for general writers — explains where the post sits in
          the admin review workflow. */}
      {isGeneralWriter && (
        <ReviewBanner isNew={isNew} reviewStatus={reviewStatus} note={(initialPost?.review_note as string | null) ?? null} reason={(initialPost?.rejection_reason as string | null) ?? null} />
      )}

      {/* Publish action bar. Owner/manager get the full publish verbs; an
          editor collaborator gets a single content-only "Save changes"
          (the server preserves status); reviewers get no save controls. */}
      {isOwnerOrManager && isGeneralWriter && (
        // General writer: draft + submit for review only — never publish/schedule.
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
          <Button
            variant="outline"
            onClick={handleSaveDraft}
            disabled={anyActionBusy || !!lockedByOther}
            className="w-full sm:w-auto sm:flex-1 sm:max-w-[200px]"
          >
            {busyAction === "draft" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Draft
          </Button>
          <Button
            onClick={handleSubmitForReview}
            disabled={anyActionBusy || titleEmpty || !!lockedByOther}
            title={titleEmpty ? "Add a title first" : undefined}
            className="w-full sm:w-auto sm:flex-1 sm:max-w-[260px]"
          >
            {busyAction === "now" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {reviewStatus === "changes_requested" || reviewStatus === "rejected"
              ? "Resubmit for Review"
              : "Submit for Review"}
          </Button>
        </div>
      )}
      {isOwnerOrManager && !isGeneralWriter && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
          <Button
            variant="outline"
            onClick={handleSaveDraft}
            disabled={anyActionBusy || !!lockedByOther}
            className="w-full sm:w-auto sm:flex-1 sm:max-w-[200px]"
          >
            {busyAction === "draft" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Draft
          </Button>
          <Button
            variant="secondary"
            onClick={() => setScheduleModalOpen(true)}
            disabled={anyActionBusy || titleEmpty || !!lockedByOther}
            title={titleEmpty ? "Add a title first" : undefined}
            className="w-full sm:w-auto sm:flex-1 sm:max-w-[220px]"
          >
            {busyAction === "schedule" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Calendar className="h-4 w-4" />
            )}
            Schedule Post
          </Button>
          <Button
            onClick={handlePostNow}
            disabled={anyActionBusy || titleEmpty || !!lockedByOther}
            title={titleEmpty ? "Add a title first" : undefined}
            className="w-full sm:w-auto sm:flex-1 sm:max-w-[220px]"
          >
            {busyAction === "now" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {postNowLabel}
          </Button>
        </div>
      )}
      {isCollabEditor && (
        <div className="mb-3">
          <Button
            variant="outline"
            onClick={handleSaveChanges}
            disabled={anyActionBusy || !canEditContent}
            className="w-full sm:w-auto sm:max-w-[220px]"
          >
            {busyAction === "draft" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save changes
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Left column: toolbar + editor card as SIBLINGS, not parent/child.
            Sticky position binds against the nearest scrolling ancestor, and
            `.portal-panel` (which the Card uses) sets `overflow: hidden` —
            which CSS treats as a scroll mechanism for sticky. Moving the
            toolbar OUT of the Card means its nearest scroll ancestor is the
            body, so it pins to the viewport like we want. */}
        <div className="flex min-w-0 flex-col gap-3">
          {canEditContent && (
            <EditorToolbar
              editor={editor}
              onInsertImage={() => pickFile("image/*", handleFileInsert("image"))}
              onInsertVideo={() => pickFile("video/*", handleFileInsert("video"))}
              onInsertAudio={() => pickFile("audio/*", handleFileInsert("audio"))}
              onInsertEmbed={handleEmbed}
            />
          )}
          <Card className="min-w-0">
            <CardContent className="p-0">
              <div className="space-y-4 px-4 pt-4 pb-4 sm:px-6 sm:pt-5 sm:pb-5">
                <label className="block">
                  <span className="mb-2 flex items-center gap-1 text-[10px] uppercase tracking-wider text-portal-text-muted">
                    Title
                    <span aria-hidden className="text-portal-red">*</span>
                    <span className="sr-only"> (required)</span>
                  </span>
                  <input
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      if (!titleTouched) setTitleTouched(true);
                      setSaveState("unsaved");
                    }}
                    onBlur={() => setTitleTouched(true)}
                    readOnly={!canEditContent}
                    placeholder="Give your transmission a title…"
                    aria-required="true"
                    aria-invalid={titleInvalid || undefined}
                    className={cn(
                      "w-full bg-transparent text-2xl font-bold leading-tight tracking-tight outline-none placeholder:text-muted-foreground sm:text-3xl md:text-4xl",
                      "border-b-2 pb-2 transition-colors",
                      titleInvalid
                        ? "border-portal-red"
                        : "border-portal-border-soft focus:border-portal-blue",
                    )}
                    maxLength={160}
                  />
                  {titleInvalid && (
                    <span className="mt-1.5 block text-[11px] font-medium text-portal-red">
                      Please add a title before saving.
                    </span>
                  )}
                </label>
                <label className="block">
                  <span className="mb-2 block text-[10px] uppercase tracking-wider text-portal-text-muted">
                    Short summary
                  </span>
                  <Textarea
                    value={excerpt ?? ""}
                    onChange={(e) => {
                      setExcerpt(e.target.value);
                      setSaveState("unsaved");
                    }}
                    readOnly={!canEditContent}
                    placeholder="Short summary used in feed cards and previews…"
                    className="min-h-[64px] resize-y border-2 border-portal-border-soft bg-portal-panel-soft text-sm leading-relaxed"
                    maxLength={500}
                  />
                </label>
              </div>

              <EditorContent editor={editor} />

              {/* Floating selection toolbar — shows on any text selection.
                  Hidden automatically when selection collapses; tippy handles
                  positioning + scroll/outside-click hiding. Suppressed in
                  read-only / reviewer / locked mode. */}
              {editor && canEditContent && (
                <BubbleMenu
                  editor={editor}
                  tippyOptions={{ duration: 100, placement: "top" }}
                  className="bubble-menu"
                >
                  <BubbleMenuButton
                    onClick={() => editor.chain().focus().toggleBold().run()}
                    active={editor.isActive("bold")}
                    label="Bold"
                  >
                    <Bold className="h-3.5 w-3.5" />
                  </BubbleMenuButton>
                  <BubbleMenuButton
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                    active={editor.isActive("italic")}
                    label="Italic"
                  >
                    <Italic className="h-3.5 w-3.5" />
                  </BubbleMenuButton>
                  <BubbleMenuButton
                    onClick={() => editor.chain().focus().toggleUnderline().run()}
                    active={editor.isActive("underline")}
                    label="Underline"
                  >
                    <UnderlineIcon className="h-3.5 w-3.5" />
                  </BubbleMenuButton>
                  <BubbleMenuButton
                    onClick={() =>
                      editor.chain().focus().toggleHighlight({ color: "#fef08a" }).run()
                    }
                    active={editor.isActive("highlight")}
                    label="Highlight"
                  >
                    <Highlighter className="h-3.5 w-3.5" />
                  </BubbleMenuButton>
                  <span className="mx-1 h-4 w-px bg-border" aria-hidden />
                  <BubbleMenuButton
                    onClick={() => {
                      const prev = editor.getAttributes("link").href as string | undefined;
                      const url = window.prompt("Link URL", prev ?? "https://");
                      if (url === null) return;
                      if (url === "") {
                        editor.chain().focus().extendMarkRange("link").unsetLink().run();
                        return;
                      }
                      editor
                        .chain()
                        .focus()
                        .extendMarkRange("link")
                        .setLink({ href: url })
                        .run();
                    }}
                    active={editor.isActive("link")}
                    label="Link"
                  >
                    <LinkIcon className="h-3.5 w-3.5" />
                  </BubbleMenuButton>
                </BubbleMenu>
              )}

              {/* Word + read-time stats. The previous "Preview" toggle here
                  was removed — the in-editor preview was breaking the page
                  by toggling out the EditorContent + BubbleMenu mid-render. */}
              <div className="flex items-center justify-between border-t border-portal-border-soft bg-portal-panel-soft px-5 py-2 text-xs text-portal-text-muted">
                <div>{words} words · ~{readMin} min read</div>
              </div>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4 min-w-0">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Badge variant={
                status === "published" ? "success" :
                status === "submitted" ? "warning" :
                status === "scheduled" ? "default" :
                status === "archived" ? "secondary" : "muted"
              } className="capitalize">{status}</Badge>

              {status === "scheduled" && scheduledFor && (
                <div className="space-y-3 rounded-md border border-portal-border-soft bg-portal-panel-soft p-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                      Scheduled for
                    </div>
                    <div className="mt-1 font-ui text-sm text-portal-text">
                      {formatScheduledLabel(scheduledFor)}
                    </div>
                  </div>
                  <p className="text-[10px] leading-relaxed text-portal-text-muted">
                    You and collaborators can keep editing until the slot hits — the post stays
                    private to the team until then.
                  </p>
                  {isOwnerOrManager && (
                    <div className="grid grid-cols-1 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setScheduleModalOpen(true)}
                        disabled={anyActionBusy || !!lockedByOther}
                      >
                        <Calendar className="h-3.5 w-3.5" /> Edit schedule
                      </Button>
                      <Button
                        size="sm"
                        onClick={handlePostNow}
                        disabled={anyActionBusy || titleEmpty || !!lockedByOther}
                      >
                        {busyAction === "now" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        Post now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleRevertToDraft}
                        disabled={anyActionBusy || !!lockedByOther}
                      >
                        {busyAction === "revert" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Back to draft
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <CollaboratorsPanel
            postId={postId}
            canManage={collaboration.canManageCollaborators}
            owner={collaboration.owner}
            currentUserId={currentUser.id}
            collaborators={collaboration.collaborators}
            approvedTeammates={collaboration.approvedTeammates}
            pendingInvites={collaboration.pendingInvites}
          />

          <ReviewCommentsPanel
            postId={postId}
            canComment={relationship !== "none"}
            canModerate={isOwnerOrManager}
            currentUserId={currentUser.id}
            comments={collaboration.reviewComments}
          />

          {/* Edit-only sidebar cards — hidden in reviewer / locked / read-only mode. */}
          {canEditContent && (
            <>
          {/* Thumbnail picker — fulfills the "upload or pick from inserted images" UX */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <ImageIcon className="h-4 w-4" /> Thumbnail
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {coverUrl ? (
                <div className="relative overflow-hidden rounded-md border border-portal-border-soft bg-portal-panel-soft">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={coverUrl}
                    alt="Thumbnail preview"
                    className="aspect-video w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={clearCover}
                    aria-label="Remove thumbnail"
                    className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-portal-panel/90 text-portal-text hover:bg-portal-panel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-md border-2 border-dashed border-portal-border-soft bg-portal-panel-soft text-center text-xs text-portal-text-muted">
                  <span>
                    No thumbnail yet.<br />Pick one to feature this post.
                  </span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={openCoverBrowser}
                  disabled={!postId}
                  title={postId ? undefined : "Save the draft once so we can list its images."}
                >
                  <ImageIcon className="mr-1.5 h-3.5 w-3.5" /> From post
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => pickFile("image/*", uploadCover)}
                  disabled={coverUploading}
                >
                  {coverUploading ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Upload
                </Button>
              </div>
              {!postId && (
                <p className="text-[10px] leading-relaxed text-portal-text-muted">
                  Tip: type a title and the post auto-saves — you'll then be able to pick a
                  thumbnail from any image you've inserted in the body.
                </p>
              )}

              {coverBrowserOpen && (
                <div className="rounded-md border border-portal-border-soft bg-portal-panel-soft p-2">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                      Images in this post
                    </div>
                    <button
                      type="button"
                      onClick={() => setCoverBrowserOpen(false)}
                      className="text-[10px] text-portal-text-muted hover:text-portal-text"
                    >
                      Close
                    </button>
                  </div>
                  {coverBrowserLoading ? (
                    <div className="flex items-center justify-center py-6 text-portal-text-muted">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : postImages.length === 0 ? (
                    <div className="py-4 text-center text-xs text-portal-text-muted">
                      No images uploaded to this post yet. Insert one in the editor body or
                      use Upload above.
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-1.5">
                      {postImages.map((img) => {
                        const active = img.id === coverMediaId;
                        return (
                          <button
                            type="button"
                            key={img.id}
                            onClick={() => selectCover(img)}
                            className={cn(
                              "group relative overflow-hidden rounded border-2 bg-portal-panel transition-colors",
                              active
                                ? "border-portal-blue"
                                : "border-transparent hover:border-portal-border-muted",
                            )}
                            aria-label={`Use ${img.title ?? "image"} as thumbnail`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={img.url}
                              alt={img.title ?? ""}
                              className="aspect-square w-full object-cover"
                              loading="lazy"
                            />
                            {active && (
                              <span className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-portal-blue text-white">
                                <Check className="h-3 w-3" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Tags</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-1.5">
                {tagOptions.length === 0 ? (
                  <p className="text-xs text-portal-text-muted">No tags yet.</p>
                ) : (
                  tagOptions.map((t) => {
                    const active = selectedTagIds.includes(t.id);
                    return (
                      <button
                        type="button"
                        key={t.id}
                        onClick={() => {
                          if (!active && selectedTagIds.length >= MAX_TAGS_PER_POST) {
                            toast.error(`Up to ${MAX_TAGS_PER_POST} tags per post.`);
                            return;
                          }
                          setSelectedTagIds((prev) =>
                            active ? prev.filter((x) => x !== t.id) : [...prev, t.id],
                          );
                          setSaveState("unsaved");
                        }}
                        className={cn(
                          "rounded-md border px-2 py-0.5 text-xs",
                          active
                            ? "border-transparent bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground hover:bg-secondary/70",
                        )}
                      >
                        {t.name}
                      </button>
                    );
                  })
                )}
              </div>

              {/* Inline tag creator. Enter to add — server dedupes by slug. */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleCreateTag();
                    }
                  }}
                  placeholder="Add a tag…"
                  maxLength={MAX_TAG_LENGTH}
                  disabled={creatingTag}
                  aria-label="Add a tag"
                  className="h-8 flex-1 min-w-0 rounded-md border border-portal-border-muted bg-portal-panel-soft px-2 font-ui text-xs text-portal-text placeholder:text-portal-text-soft focus:border-portal-blue focus:outline-none focus:shadow-[0_0_0_3px_rgba(79,140,255,0.18)]"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleCreateTag()}
                  disabled={creatingTag || newTagInput.trim().length === 0}
                >
                  {creatingTag ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
                </Button>
              </div>
              <p className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                {selectedTagIds.length} / {MAX_TAGS_PER_POST} selected · max {MAX_TAG_LENGTH} chars per tag
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4" /> Quick actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Button variant="outline" className="w-full justify-start" onClick={insertTemplate}>
                Use weekly template
              </Button>
              <Button variant="ghost" className="w-full justify-start" onClick={() => pickFile("image/*", handleFileInsert("image"))}>
                <ImageIcon className="mr-2 h-4 w-4" /> Insert image
              </Button>
              <Button variant="ghost" className="w-full justify-start" onClick={() => pickFile("video/*", handleFileInsert("video"))}>
                <Video className="mr-2 h-4 w-4" /> Upload video
              </Button>
              <Button variant="ghost" className="w-full justify-start" onClick={() => pickFile("audio/*", handleFileInsert("audio"))}>
                <Music className="mr-2 h-4 w-4" /> Upload audio
              </Button>
              <Button variant="ghost" className="w-full justify-start" onClick={handleEmbed}>
                <LinkIcon className="mr-2 h-4 w-4" /> Embed external video
              </Button>
            </CardContent>
          </Card>
            </>
          )}
        </aside>
      </div>

      <SchedulePostModal
        open={scheduleModalOpen}
        initialValue={status === "scheduled" ? scheduledFor : null}
        busy={busyAction === "schedule"}
        onCancel={() => setScheduleModalOpen(false)}
        onConfirm={handleConfirmSchedule}
      />
    </div>
  );
}

function pickFile(accept: string, onPick: (file: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) onPick(file);
  };
  input.click();
}

/** Single icon button inside the floating selection bubble. */
function BubbleMenuButton({
  onClick,
  active,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md",
        "text-muted-foreground hover:bg-secondary hover:text-foreground",
        active && "bg-secondary text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Review-workflow status banner shown to general writers in the editor. Mirrors
 * the UI copy in the product spec for each review state.
 */
function ReviewBanner({
  isNew,
  reviewStatus,
  note,
  reason,
}: {
  isNew: boolean;
  reviewStatus: ReviewStatus;
  note: string | null;
  reason: string | null;
}) {
  let tone: "info" | "warning" | "danger" | "success" = "info";
  let title: string;
  let body: string;

  if (reviewStatus === "under_review") {
    tone = "warning";
    title = "Your post is under review";
    body = "You can still make edits, but it will not go live until an admin approves it.";
  } else if (reviewStatus === "changes_requested") {
    tone = "warning";
    title = "Changes requested";
    body = note?.trim()
      ? `${note.trim()} — please update your post and resubmit.`
      : "Please update your post and resubmit for review.";
  } else if (reviewStatus === "rejected") {
    tone = "danger";
    title = "Review rejected";
    body = reason?.trim()
      ? `Reason: ${reason.trim()} — you can revise and resubmit.`
      : "You can revise your post and submit it for review again.";
  } else if (reviewStatus === "approved") {
    tone = "success";
    title = "Review passed";
    body = "An admin approved this signal.";
  } else {
    // not_submitted
    title = isNew ? "Create your signal" : "Draft";
    body = "Your post will be reviewed by an admin before publishing.";
  }

  const toneClass =
    tone === "warning"
      ? "border-portal-yellow/40 bg-portal-yellow/10"
      : tone === "danger"
        ? "border-portal-red/40 bg-portal-red/10"
        : tone === "success"
          ? "border-portal-green/40 bg-portal-green/10"
          : "border-portal-border-muted bg-portal-panel-soft";

  return (
    <div className={cn("mb-3 rounded-md border px-4 py-3", toneClass)}>
      <div className="font-ui text-[11px] font-bold uppercase tracking-label text-portal-text">
        {title}
      </div>
      <p className="mt-1 text-sm text-portal-text-muted">{body}</p>
    </div>
  );
}
