"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageSquare, Check, X, Loader2, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Textarea } from "@/components/ui/Input";
import {
  addReviewComment,
  deleteReviewComment,
  resolveReviewComment,
} from "@/app/(app)/editor/actions";
import { formatScheduledLabel } from "@/lib/utils/dates";
import type { ReviewCommentView } from "@/lib/auth/collaboration";

const MAX_LEN = 500;

interface Props {
  postId?: string;
  canComment: boolean;
  /** Owner or manager — may resolve / delete anyone's comment. */
  canModerate: boolean;
  currentUserId: string;
  comments: ReviewCommentView[];
}

export function ReviewCommentsPanel({
  postId,
  canComment,
  canModerate,
  currentUserId,
  comments,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState("");

  const open = comments.filter((c) => !c.resolvedAt);
  const resolved = comments.filter((c) => c.resolvedAt);

  const handleAdd = () => {
    const trimmed = body.trim();
    if (!postId || !trimmed) return;
    startTransition(async () => {
      const res = await addReviewComment({ postId, body: trimmed });
      if (!res.ok) {
        toast.error(res.error || "Could not add comment.");
        return;
      }
      setBody("");
      router.refresh();
    });
  };

  const handleResolve = (commentId: string) => {
    startTransition(async () => {
      const res = await resolveReviewComment({ commentId });
      if (!res.ok) {
        toast.error(res.error || "Could not update comment.");
        return;
      }
      router.refresh();
    });
  };

  const handleDelete = (commentId: string) => {
    startTransition(async () => {
      const res = await deleteReviewComment({ commentId });
      if (!res.ok) {
        toast.error(res.error || "Could not delete comment.");
        return;
      }
      router.refresh();
    });
  };

  const canModifyComment = (c: ReviewCommentView) => canModerate || c.userId === currentUserId;

  const renderComment = (c: ReviewCommentView) => (
    <li
      key={c.id}
      className="space-y-1.5 rounded-md border border-portal-border-soft bg-portal-panel-soft p-2.5"
    >
      <div className="flex items-center gap-2">
        <Avatar src={c.authorAvatarUrl} name={c.authorName} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-ui text-xs text-portal-text">{c.authorName}</div>
          <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
            {c.createdAt ? formatScheduledLabel(c.createdAt) : ""}
          </div>
        </div>
        {c.resolvedAt && <Badge variant="success">Resolved</Badge>}
        {canModifyComment(c) && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleResolve(c.id)}
              disabled={pending}
              aria-label={c.resolvedAt ? "Reopen comment" : "Resolve comment"}
              title={c.resolvedAt ? "Reopen" : "Resolve"}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-portal-text-muted hover:bg-portal-panel hover:text-portal-green disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleDelete(c.id)}
              disabled={pending}
              aria-label="Delete comment"
              title="Delete"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-portal-text-muted hover:bg-portal-panel hover:text-portal-red disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      <p className={`whitespace-pre-wrap break-words text-sm ${c.resolvedAt ? "text-portal-text-muted line-through" : "text-portal-text"}`}>
        {c.body}
      </p>
    </li>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4" /> Review comments
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!postId ? (
          <p className="rounded-md border border-dashed border-portal-border-soft bg-portal-panel-soft p-2.5 text-[11px] leading-relaxed text-portal-text-muted">
            Save your draft first — then you and your collaborators can leave review notes.
          </p>
        ) : (
          <>
            {comments.length === 0 ? (
              <p className="text-xs leading-relaxed text-portal-text-muted">
                No review notes yet. Comments live only on the draft and are cleared when the post
                is published.
              </p>
            ) : (
              <ul className="space-y-2">
                {open.map(renderComment)}
                {resolved.map(renderComment)}
              </ul>
            )}

            {canComment && (
              <div className="space-y-2 border-t border-portal-border-soft pt-3">
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value.slice(0, MAX_LEN))}
                  placeholder="Leave a review note…"
                  className="min-h-[64px] resize-y border-2 border-portal-border-soft bg-portal-panel-soft text-sm"
                  maxLength={MAX_LEN}
                  disabled={pending}
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                    {body.trim().length}/{MAX_LEN}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAdd}
                    disabled={pending || body.trim().length === 0}
                  >
                    {pending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    Comment
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
