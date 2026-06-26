import { SystemLabel } from "@/components/portal/SystemLabel";

export function PortalFooter() {
  return (
    <footer className="border-t border-portal-border-soft bg-portal-panel-soft">
      <div className="content-container flex flex-col gap-3 py-8 md:flex-row md:items-center md:justify-between">
        {/* Left — green system-dot fronts the brand line. The dot stays on
            its own SystemLabel so the existing `signal-dot` CSS keeps doing
            its pulse, and the label text reuses the same uppercase/mono
            chrome as every other footer line. */}
        <SystemLabel tone="green" dot>
          <span className="text-portal-text-muted">
            ConveGenius Internal Blog OS · Team Dhurandhar
          </span>
        </SystemLabel>

        {/* Right — credit line. `♥` uses the brand red token (matches the
            light-theme red accent without going neon). "Sumit" links to
            LinkedIn in a new tab with a noopener relationship; hover
            brightens the text and adds a subtle underline. */}
        <SystemLabel>
          Made with{" "}
          <span aria-hidden className="text-portal-red">
            ♥
          </span>
          <span className="sr-only">love</span>
          {" "}by{" "}
          <a
            href="https://www.linkedin.com/in/sumit-ai-product/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 transition-colors hover:text-portal-text hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-portal-blue focus-visible:ring-offset-2 focus-visible:ring-offset-portal-panel-soft"
          >
            Sumit
          </a>
        </SystemLabel>
      </div>
    </footer>
  );
}
