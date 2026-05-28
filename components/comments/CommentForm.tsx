"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { addComment } from "@/app/posts/[slug]/actions";
import { track } from "@/lib/analytics/track";
import { getClientContext, sendAnalyticsEvent } from "@/lib/analytics/client-context";
import { cn } from "@/lib/utils/cn";

interface Props {
  postId: string;
  postSlug: string;
  isAuthenticated: boolean;
}

const MAX_LEN = 100;

export function CommentForm({ postId, postSlug, isAuthenticated }: Props) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  // Logged-out preview — looks like the real input but doesn't accept text;
  // clicking anywhere on it bounces to /login.
  if (!isAuthenticated) {
    const loginHref = `/login?redirect=${encodeURIComponent(`/posts/${postSlug}`)}#comments`;
    return (
      <div className="space-y-3 rounded-md border border-portal-border-soft bg-portal-panel-soft p-4">
        <div className="text-sm text-portal-text-muted">
          Login to comment. Use Google to join the discussion.
        </div>
        <div
          aria-hidden
          className="rounded-md border border-portal-border-soft bg-portal-main p-3 text-sm text-portal-text-soft italic"
        >
          Share your thoughts on this post…
        </div>
        <Button asChild>
          <a href={loginHref}>Login to comment</a>
        </Button>
      </div>
    );
  }

  const trimmed = body.trim();
  const tooLong = body.length > MAX_LEN;
  const disabled = pending || tooLong || trimmed.length === 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    startTransition(async () => {
      const res = await addComment({ postId, body });
      if (!res.ok) {
        toast.error(res.error ?? "Failed to post comment.");
        return;
      }
      setBody("");
      track("comment_added", { postId, slug: postSlug });
      const ctx = getClientContext();
      sendAnalyticsEvent({
        eventName: "comment_added",
        sessionId: ctx.sessionId,
        postId,
        path: ctx.path,
        metadata: { slug: postSlug },
      });
      toast.success("Comment posted.");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor="comment-body" className="sr-only">Comment</label>
      <textarea
        id="comment-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Share your thoughts…"
        rows={3}
        maxLength={MAX_LEN + 1 /* allow over-typing so the validation message can show */}
        className={cn(
          "w-full resize-none rounded-md border bg-portal-panel-soft px-3 py-2.5 text-sm font-ui text-portal-text",
          "placeholder:text-portal-text-soft focus-visible:outline-none focus-visible:border-portal-blue",
          "focus-visible:shadow-[0_0_0_4px_rgba(79,140,255,0.18)]",
          tooLong ? "border-portal-red/60" : "border-portal-border-muted",
        )}
      />
      <div className="flex items-center justify-between gap-3">
        <div
          className={cn(
            "font-ui text-[11px] tabular-nums",
            tooLong ? "text-portal-red" : body.length > MAX_LEN - 20 ? "text-portal-yellow" : "text-portal-text-muted",
          )}
          aria-live="polite"
        >
          {body.length}/{MAX_LEN}
          {tooLong && <span className="ml-2 uppercase tracking-wider">Comment must be {MAX_LEN} characters or less.</span>}
        </div>
        <Button type="submit" size="sm" disabled={disabled}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Post comment
        </Button>
      </div>
    </form>
  );
}
