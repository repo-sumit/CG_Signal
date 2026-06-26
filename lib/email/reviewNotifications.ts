import "server-only";

// Transactional emails for the admin review workflow. Separate from the
// subscriber newsletter (lib/email/newsletter.ts) — these go to internal
// ConveGenius staff (admins on submission, the writer on a review decision),
// never to public subscribers, so there is no unsubscribe footer.
//
// Every send is best-effort: callers invoke these fire-and-forget so a missing
// Resend config or a transient failure never blocks the underlying action.

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { publicEnv, serverEnv } from "@/lib/env";
import { sendEmail } from "@/lib/email/resend";

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function esc(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

/** Minimal dark-masthead shell — same brand chrome as the newsletter, no
 *  unsubscribe footer (these are transactional, not subscription mail). */
function reviewShell(opts: {
  eyebrow: string;
  eyebrowColor?: string;
  heading: string;
  bodyHtml: string;
  ctaLabel: string;
  ctaHref: string;
}): string {
  const eyebrowColor = opts.eyebrowColor ?? "#ff5a1f";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>CG Signal · Review</title>
</head>
<body style="margin:0;padding:0;background:#f4f0df;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111111;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f0df;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #ded8c8;border-radius:18px;overflow:hidden;">
          <tr>
            <td style="padding:18px 24px;background:#08090d;">
              <a href="${esc(publicEnv.appUrl)}" style="text-decoration:none;display:block;">
                <div style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:#f5f1e8;letter-spacing:-0.01em;">CG&nbsp;SIGNAL</div>
                <div style="font-family:'Space Mono','SF Mono','Menlo',monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.18em;color:#a8a294;margin-top:4px;">ConveGenius · Review</div>
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 32px;">
              <div style="font-family:'Space Mono','SF Mono','Menlo',monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:${eyebrowColor};font-weight:700;">${esc(opts.eyebrow)}</div>
              <h1 style="margin:10px 0 14px;font-size:28px;line-height:1.15;font-family:Georgia,serif;letter-spacing:-0.02em;color:#111111;font-weight:700;">${esc(opts.heading)}</h1>
              ${opts.bodyHtml}
              <div style="margin-top:22px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="background:#08090d;border-radius:999px;">
                      <a href="${esc(opts.ctaHref)}" style="display:inline-block;padding:14px 28px;color:#ffffff;font-weight:700;font-size:12px;text-decoration:none;letter-spacing:0.14em;text-transform:uppercase;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">${esc(opts.ctaLabel)}</a>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function noteBlock(label: string, body: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 8px;background:#f4f0df;border:1px solid #e5e7eb;border-radius:10px;">
    <tr><td style="padding:16px 18px;">
      <div style="font-family:'Space Mono','SF Mono','Menlo',monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:#6b7280;margin-bottom:8px;">${esc(label)}</div>
      <div style="font-size:15px;line-height:1.6;color:#374151;">${esc(body)}</div>
    </td></tr>
  </table>`;
}

/** Recipient list for "a post was submitted": env managers ∪ manager profiles. */
async function adminRecipients(): Promise<string[]> {
  const set = new Set<string>(serverEnv().managerEmails);
  try {
    const service = createSupabaseServiceClient();
    const { data } = await service.from("profiles").select("email").eq("role", "manager");
    for (const row of (data ?? []) as { email: string }[]) {
      if (row.email) set.add(row.email.toLowerCase());
    }
  } catch (err) {
    console.error("[reviewNotifications] failed to load manager profiles", err);
  }
  return [...set];
}

export interface SubmissionNotice {
  postId: string;
  title: string;
  authorName: string;
}

/** Notify admins that a general writer submitted a post for review. */
export async function notifyAdminsOfSubmission(notice: SubmissionNotice): Promise<void> {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) return;
  const recipients = await adminRecipients();
  if (recipients.length === 0) return;

  const reviewUrl = `${publicEnv.appUrl}/admin/review`;
  const html = reviewShell({
    eyebrow: "Awaiting review",
    heading: "A new signal needs your review",
    bodyHtml:
      `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#374151;"><strong>${esc(notice.authorName)}</strong> submitted a signal for review.</p>` +
      noteBlock("Title", notice.title),
    ctaLabel: "Open review queue →",
    ctaHref: reviewUrl,
  });
  const text = `${notice.authorName} submitted "${notice.title}" for review.\n\nReview it: ${reviewUrl}`;

  // One email to all admins — they share the queue, no per-recipient tokens.
  const res = await sendEmail({
    to: recipients,
    subject: `CG Signal · Review needed: ${notice.title}`,
    html,
    text,
  });
  if (!res.ok) console.error("[reviewNotifications] submission email failed", res.error);
}

export type ReviewDecision = "approved" | "changes_requested" | "rejected";

export interface DecisionNotice {
  postId: string;
  slug: string;
  title: string;
  writerEmail: string;
  decision: ReviewDecision;
  /** Admin feedback — review note for changes, rejection reason for rejected. */
  note?: string | null;
}

/** Notify the writer of an admin's review decision. */
export async function notifyWriterOfReview(notice: DecisionNotice): Promise<void> {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) return;
  if (!notice.writerEmail) return;

  const editUrl = `${publicEnv.appUrl}/editor/${notice.postId}`;
  const liveUrl = `${publicEnv.appUrl}/posts/${notice.slug}`;
  const note = (notice.note ?? "").trim();

  let html: string;
  let subject: string;
  let text: string;

  if (notice.decision === "approved") {
    subject = `CG Signal · Published: ${notice.title}`;
    html = reviewShell({
      eyebrow: "Review passed",
      eyebrowColor: "#1f9d55",
      heading: "Your signal is live",
      bodyHtml: `<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:#374151;">An admin approved and published <strong>${esc(notice.title)}</strong>. It's now live on CG Signal.</p>`,
      ctaLabel: "View live signal →",
      ctaHref: liveUrl,
    });
    text = `Your signal "${notice.title}" was approved and published.\n\nView it: ${liveUrl}`;
  } else if (notice.decision === "changes_requested") {
    subject = `CG Signal · Changes requested: ${notice.title}`;
    html = reviewShell({
      eyebrow: "Changes requested",
      heading: "Please update your signal",
      bodyHtml:
        `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#374151;">An admin reviewed <strong>${esc(notice.title)}</strong> and asked for some changes before it goes live.</p>` +
        (note ? noteBlock("What to change", note) : "") +
        `<p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:#374151;">Update your post and submit it for review again.</p>`,
      ctaLabel: "Edit your signal →",
      ctaHref: editUrl,
    });
    text = `Changes requested on "${notice.title}".\n\n${note ? `Feedback: ${note}\n\n` : ""}Edit and resubmit: ${editUrl}`;
  } else {
    subject = `CG Signal · Review rejected: ${notice.title}`;
    html = reviewShell({
      eyebrow: "Review rejected",
      eyebrowColor: "#c0392b",
      heading: "Your signal was not approved",
      bodyHtml:
        `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#374151;">An admin reviewed <strong>${esc(notice.title)}</strong> and could not approve it.</p>` +
        (note ? noteBlock("Reason", note) : "") +
        `<p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:#374151;">You can revise the post and submit it for review again.</p>`,
      ctaLabel: "Edit your signal →",
      ctaHref: editUrl,
    });
    text = `Your signal "${notice.title}" was rejected.\n\n${note ? `Reason: ${note}\n\n` : ""}Revise and resubmit: ${editUrl}`;
  }

  const res = await sendEmail({ to: notice.writerEmail, subject, html, text });
  if (!res.ok) console.error("[reviewNotifications] decision email failed", res.error);
}
