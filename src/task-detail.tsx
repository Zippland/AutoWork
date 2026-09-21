import { useEffect, useRef, useState } from "react";
import { Archive, Check, LoaderCircle, Pause, Play } from "lucide-react";
import { STATUS_LABELS, CATEGORY_LABELS, executionLane, type PilotTask } from "../core";
import type { InteractionProps } from "./frontdesk";
import Markdown from "./markdown";
import { Button } from "./ui";

const dateLabel = (at: string) => new Date(at).toLocaleString("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});
const emptyDraft = () => ({ message: "", requestId: crypto.randomUUID() });
function readDraft(key: string) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "null");
    if (value && typeof value === "object" && "message" in value && typeof value.message === "string" && "requestId" in value && typeof value.requestId === "string") {
      return { message: value.message, requestId: value.requestId };
    }
  } catch { /* Browser storage is optional; the open card still keeps its draft. */ }
  return emptyDraft();
}

export function TaskDetail({ task, state, send, pending }: { task: PilotTask } & InteractionProps) {
  pending = pending || state.reviewMode !== "batch";
  const draftKey = `taskpilot-card-draft:${task.id}`;
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const [tab, setTab] = useState<"summary" | "activity">("summary");
  const [historyCount, setHistoryCount] = useState(20);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  useEffect(() => {
    try {
      if (draft.message) localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch { /* Keep the draft in this card if browser storage is unavailable. */ }
  }, [draft, draftKey]);
  const act = async (action: "approve" | "pause" | "resume" | "archive" | "close") => {
    setError("");
    try {
      const common = { taskId: task.id, digest: task.digest, requestId: crypto.randomUUID() };
      await send(action === "approve" ? { type: "approve", ...common } : { type: "task", action, ...common });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const submitNote = async () => {
    if (!draft.message.trim() || pending || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await send({ type: "note", taskId: task.id, ...draft });
      setDraft(emptyDraft());
    } catch (reason) {
      setError(`未能确认提交，批注已保留，可重试。${reason instanceof Error ? `（${reason.message}）` : ""}`);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  const messages = state.messages.filter((message) => message.review?.status !== "cancelled" && (message.scope === task.id || message.contextId === task.id || message.contextIds?.includes(task.id)));
  const reviews = messages.filter((message) => message.review?.status === "pending");
  const latestNote = reviews.findLast((message) => message.review?.action === "note");
  const approved = reviews.some((message) => message.review?.action === "approve" && message.review.digest === task.digest);
  const activeRun = state.runs.findLast((run) => executionLane(run) === "work" && run.status === "running");
  const switchTab = (next: "summary" | "activity") => {
    setTab(next);
    document.getElementById(`issue-${next}-tab`)?.focus();
  };

  return <div className="issue-layout">
    <article className="issue-content">
      <div className="issue-heading"><span className="detail-meta">{task.id}</span><h1>{task.title}</h1></div>
      <div className="issue-tabs" role="tablist" aria-label="事项内容">
        <button id="issue-summary-tab" role="tab" aria-selected={tab === "summary"} aria-controls="issue-summary" tabIndex={tab === "summary" ? 0 : -1} onClick={() => setTab("summary")} onKeyDown={(event) => { if (event.key === "ArrowRight") switchTab("activity"); }}>概览与方案</button>
        <button id="issue-activity-tab" role="tab" aria-selected={tab === "activity"} aria-controls="issue-activity" tabIndex={tab === "activity" ? 0 : -1} onClick={() => setTab("activity")} onKeyDown={(event) => { if (event.key === "ArrowLeft") switchTab("summary"); }}>活动 <span>{messages.length}</span></button>
      </div>
      {task.error && <p className="error" role="alert">{task.error}</p>}
      <section id="issue-summary" role="tabpanel" aria-labelledby="issue-summary-tab" hidden={tab !== "summary"} tabIndex={0}>
        <Markdown basePath={`tasks/${task.id}/`} body={task.body || "AI 正在整理这件事的背景与下一步。"} />
        <details className="file-references"><summary>资料与成果 <span>{task.files.length}</span></summary>{task.files.map((file) => <a key={file} href={`/api/pilot/files/${file.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer">{file.slice(`tasks/${task.id}/`.length)}</a>)}</details>
      </section>
      <section id="issue-activity" className="issue-activity" role="tabpanel" aria-labelledby="issue-activity-tab" hidden={tab !== "activity"} tabIndex={0}>
        <h3>批注、审核与处理回报</h3>
        {!messages.length && <p className="issue-activity-empty">补充意见后，AI 的处理回报会留在这里。</p>}
        {messages.slice(-historyCount).reverse().map((message) => <article key={message.id}>
          <span className="activity-avatar">{message.role === "user" ? "我" : "助"}</span>
          <div><small>{message.role === "user" ? "你" : "AI"}{message.review && <span>{message.review.status === "pending" ? "待统一推进" : "已交给 AI"}</span>}<time dateTime={message.at}>{dateLabel(message.at)}</time></small>
            <Markdown basePath={`tasks/${task.id}/`} body={message.body} />
          </div>
        </article>)}
        {messages.length > historyCount && <Button variant="ghost" size="sm" onClick={() => setHistoryCount(historyCount + 20)}>更早的记录</Button>}
      </section>
    </article>
    <aside className="issue-aside">
      {state.reviewMode !== "batch" && <p className="issue-feedback" role="status">工作台正在更新，当前 AI 任务结束后即可保存审阅意见。</p>}
      <dl><dt>状态</dt><dd><span className={`status-tag status-${task.status}`}>{STATUS_LABELS[task.status]}</span></dd>{task.category && <><dt>来源</dt><dd>{CATEGORY_LABELS[task.category]}</dd></>}{task.project && <><dt>项目</dt><dd>{task.project}</dd></>}<dt>最近更新</dt><dd>{dateLabel(task.updatedAt)}</dd></dl>
      {reviews.length > 0 && <div className="issue-feedback issue-review-feedback" role="status"><strong><Check size={13}/>{task.status === "running" || task.queued ? "新意见待下一轮推进" : "待推进"}</strong><p>{latestNote ? "修改意见已保存。" : approved ? "方案已批准。" : "推进意愿已保存。"}{activeRun ? "这些新意见留到下一轮，可手动推进或等定时推进。" : "你可以继续审阅其他事项，最后点顶部“推进”，或等定时推进统一处理。"}</p>{latestNote && <blockquote>{latestNote.body}</blockquote>}<Button variant="ghost" size="xs" disabled={pending} onClick={() => { void send({ type: "review_discard", taskId: task.id, requestId: crypto.randomUUID() }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }}>撤回本次意见</Button></div>}
      {task.request && <section className="decision-box"><h3>{task.request.kind === "approval" ? "需要你判断" : "需要你补充"}</h3><p>{task.request.question}</p>{task.request.kind === "approval" && <Button disabled={pending || approved} onClick={() => void act("approve")}>{approved ? "已批准，待推进" : "批准此方案"}</Button>}</section>}
      {task.status === "done" && <section className="decision-box"><h3>请验收这次交付</h3><p>确认成果符合预期后归档。</p><Button disabled={pending} onClick={() => void act("archive")}><Check size={14} />验收通过并归档</Button></section>}
      <form className="issue-comment-form" onSubmit={(event) => { event.preventDefault(); void submitNote(); }}>
        <label htmlFor="issue-comment">{reviews.length ? "继续补充意见" : "修改意见"}</label>
        <textarea id="issue-comment" value={draft.message} rows={5} maxLength={16000} readOnly={submitting} placeholder="补充背景、指出哪里要改，或告诉 AI 下一步怎么做…" aria-describedby="issue-comment-hint" onChange={(event) => { setDraft({ message: event.target.value, requestId: crypto.randomUUID() }); }} onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }}/>
        <p id="issue-comment-hint">保存后进入待推进；点顶部“推进”或等定时推进后，AI 才开始处理。修改意见不代替方案审批。</p>
        <Button type="submit" disabled={pending || submitting || !draft.message.trim()}>{submitting ? <LoaderCircle size={14} className="refresh-spinning"/> : <Check size={14}/>} {submitting ? "正在保存…" : "保存修改意见"}</Button>
        <span className="issue-comment-shortcut">⌘ / Ctrl + Enter 保存</span>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="issue-secondary-actions">
        {["paused", "blocked", "waiting", "done", "archived"].includes(task.status) ? <Button variant="ghost" disabled={pending || task.queued || reviews.some((item) => item.review?.action === "resume")} title="记录本次推进意愿，点顶部推进后一起处理" onClick={() => void act("resume")}><Play size={13} />{task.status === "paused" || task.status === "archived" ? "恢复并加入推进" : "加入下一轮推进"}</Button> : <Button variant="ghost" disabled={pending} onClick={() => void act("pause")}><Pause size={13} />暂缓事项</Button>}
        {task.status !== "archived" && <Button variant="ghost" disabled={pending} title="立即归档，不再推进；保留资料与记录" onClick={() => void act("close")}><Archive size={13} />结束并归档</Button>}
      </div>
    </aside>
  </div>;
}
