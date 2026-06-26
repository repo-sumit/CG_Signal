import Link from "next/link";
import { Clock, ImageIcon, Video, Music } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { formatPostDate } from "@/lib/utils/dates";
import { reviewBadge } from "@/lib/utils/reviewStatus";
import type { PostWithAuthor } from "@/lib/db/posts";

function mediaIndicators(html: string) {
  return {
    video: /<video\b|youtube\.com\/embed|vimeo\.com|loom\.com\/embed|drive\.google\.com/.test(html),
    audio: /<audio\b/.test(html),
    image: /<img\b/.test(html),
  };
}

export function PostCard({ post }: { post: PostWithAuthor }) {
  const m = mediaIndicators(post.content_html);
  return (
    <article className="group rounded-md border border-portal-border-soft bg-portal-panel transition-colors hover:border-portal-border-muted">
      <Link href={`/posts/${post.slug}`} className="block p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex flex-wrap gap-1.5">
            {post.tags.slice(0, 2).map((t) => (
              <Badge key={t.id} variant="secondary">{t.name}</Badge>
            ))}
            {post.status !== "published" &&
              (() => {
                const b = reviewBadge(post.status, post.review_status);
                return <Badge variant={b.variant}>{b.label}</Badge>;
              })()}
          </div>
          <span className="inline-flex items-center gap-1.5 text-portal-text-muted">
            {m.image && <ImageIcon className="h-3.5 w-3.5" aria-label="image" />}
            {m.video && <Video className="h-3.5 w-3.5" aria-label="video" />}
            {m.audio && <Music className="h-3.5 w-3.5" aria-label="audio" />}
          </span>
        </div>

        <h3 className="font-hero text-lg font-bold uppercase leading-snug tracking-tighter text-portal-text group-hover:text-portal-orange">
          {post.title}
        </h3>
        {post.excerpt && (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-portal-text-muted">{post.excerpt}</p>
        )}

        <div className="mt-4 flex items-center gap-2 border-t border-portal-border-soft pt-3">
          <Avatar
            src={post.author?.avatar_url}
            name={post.author?.full_name}
            email={post.author?.email}
            size="sm"
          />
          <span className="min-w-0 flex-1 truncate font-ui text-xs text-portal-text">
            {post.author?.full_name || post.author?.email}
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-portal-text-muted">
            <Clock className="h-3 w-3" /> {post.read_time_minutes}m
          </span>
        </div>
      </Link>
    </article>
  );
}
