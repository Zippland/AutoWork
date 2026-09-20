import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, LoaderCircle } from "lucide-react";
import Markdown from "./markdown";
import { Button } from "./ui";

const prefix = "/api/pilot/files/";

export function localFileUrl(href: string, origin: string) {
  try {
    const url = new URL(href, origin);
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith(prefix) || url.searchParams.has("download")) return null;
    decodeURIComponent(url.pathname);
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}

export function fileName(href: string) {
  return decodeURIComponent(new URL(href, "http://taskpilot.local").pathname.slice(prefix.length));
}

export function FilePreview({ href, onBack }: { href: string; onBack?: () => void }) {
  const path = fileName(href);
  const basePath = path.slice(0, path.lastIndexOf("/") + 1);
  const download = `${prefix}${path.split("/").map(encodeURIComponent).join("/")}?download=1`;
  const query = useQuery({
    queryKey: ["pilot", "file", href],
    queryFn: async ({ signal }) => {
      const response = await fetch(href, { signal, headers: { Accept: "text/plain" } });
      if (!response.ok) throw new Error("资料暂时无法读取，文件可能已被移动或删除。");
      if (!response.headers.get("content-type")?.startsWith("text/plain")) return { binary: true, body: "" };
      return { binary: false, body: await response.text() };
    },
    retry: false,
  });
  return <div className="file-preview-content">
    <div className="file-preview-toolbar">
      {onBack && <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={14}/>上一份资料</Button>}
      <span className="file-preview-path">{path}</span>
      <a href={download} download className="button button-ghost button-sm"><Download size={14}/>下载原文件</a>
    </div>
    {query.isPending ? <p className="file-preview-status" role="status"><LoaderCircle size={16} className="refresh-spinning"/>正在读取资料…</p>
      : query.isError ? <div className="file-preview-status" role="alert"><p>{query.error.message}</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>重试</Button></div>
      : query.data.binary ? <p className="file-preview-status">此文件可下载后使用对应应用打开。</p>
      : !query.data.body.trim() ? <p className="file-preview-status">这份文件暂无内容。</p>
      : /\.(md|markdown)$/i.test(path) ? <Markdown body={query.data.body} basePath={basePath} />
      : <pre className="file-preview-text">{query.data.body}</pre>}
  </div>;
}
