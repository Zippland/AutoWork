import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
export default function Markdown({
  body,
  basePath = "background/",
  onOpenTask,
  linkTarget = "_blank",
}: {
  body: string;
  basePath?: string;
  onOpenTask?: (id: string) => boolean;
  linkTarget?: "_blank" | "_self";
}) {
  const link = (href: string | undefined) => {
    if (!href || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return href;
    const url = new URL(href, `http://taskpilot.local/${basePath}`);
    return `/api/pilot/files${url.pathname}${url.hash}`;
  };
  return (
    <div className="background-markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="markdown-table-scroll" role="region" aria-label="表格" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a
              href={link(href)}
              target={linkTarget}
              rel="noreferrer"
              onClick={(event) => {
                const target = link(href);
                const match = target?.match(
                  /^\/api\/pilot\/files\/tasks\/([^/]+)\/SUMMARY\.md(?:#.*)?$/,
                );
                if (match && onOpenTask?.(decodeURIComponent(match[1]!)))
                  event.preventDefault();
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt || "图片"}</span>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
