import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../src/markdown";

const styles = `
*{box-sizing:border-box}body{margin:0;background:#fff;color:#303744;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
a{color:#5369a5;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:2px solid #5369a5;outline-offset:4px}
.file-header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 32px;border-bottom:1px solid #e6e7eb;font-size:13px}.file-header>a:first-child{font-weight:600;color:#282d37;text-decoration:none}.file-actions{display:flex;gap:20px}
main{max-width:900px;margin:48px auto 80px;padding:0 32px}.file-path{color:#8b93a1;font-size:12px;overflow-wrap:anywhere;margin:0 0 30px}
.background-markdown{font-size:15px;line-height:1.9;overflow-wrap:anywhere}.background-markdown>:first-child{margin-top:0}.background-markdown h1{font-size:28px;line-height:1.4}.background-markdown h2{font-size:21px;line-height:1.5;margin-top:32px}.background-markdown h3{font-size:17px;margin-top:26px}.background-markdown p,.background-markdown ul,.background-markdown ol{margin:16px 0}.background-markdown li{margin:6px 0}.background-markdown blockquote{border-left:3px solid #ccd3e5;margin:22px 0;padding:0 20px;color:#657087}.background-markdown hr{border:0;border-top:1px solid #e6e7eb;margin:30px 0}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}code{background:#f4f5f8;padding:2px 5px;border-radius:4px}pre{padding:18px;background:#f6f7fa;border:1px solid #e6e7eb;border-radius:8px;overflow:auto;line-height:1.7}pre code{padding:0;background:none}.file-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}
.markdown-table-scroll{overflow-x:auto;margin:22px 0;border:1px solid #e6e7eb;border-radius:8px}table{border-collapse:collapse;min-width:100%}th,td{padding:12px 16px;border-right:1px solid #e6e7eb;border-bottom:1px solid #e6e7eb;text-align:left;vertical-align:top}th{background:#f6f7fa;font-weight:600}th:last-child,td:last-child{border-right:0}tbody tr:last-child td{border-bottom:0}
@media(max-width:600px){.file-header{padding:16px 20px}.file-actions{gap:14px}main{margin:28px auto 48px;padding:0 20px}.background-markdown{font-size:14px}.background-markdown h1{font-size:24px}}
`;

export const previewPolicy = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(styles).digest("base64")}'; style-src-attr 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-downloads`;

// Render a script-free document for browser navigation. The same URL still serves
// original bytes to API clients and explicit downloads.
export function filePreview(name: string, body: string) {
  const title = name.split("/").at(-1)!;
  const basePath = name.slice(0, name.lastIndexOf("/") + 1);
  const download = `/api/pilot/files/${name.split("/").map(encodeURIComponent).join("/")}?download=1`;
  return "<!doctype html>" + renderToStaticMarkup(
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · TaskPilot`}</title>
        <style>{styles}</style>
      </head>
      <body>
        <header className="file-header">
          <a href="/">TaskPilot</a>
          <nav className="file-actions" aria-label="资料操作"><a href="/">返回工作台</a><a href={download}>下载原文件</a></nav>
        </header>
        <main>
          <p className="file-path">{name}</p>
          {/\.(md|markdown)$/i.test(name)
            ? <Markdown body={body} basePath={basePath} linkTarget="_self" />
            : <pre className="file-text">{body}</pre>}
        </main>
      </body>
    </html>,
  );
}
