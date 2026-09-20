import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { Button } from "./ui";
import { executionLane, type Command, type ExecutionLane, type Snapshot } from "../core";
import { RunProgress } from "./run-progress";
const Markdown = lazy(() => import("./markdown"));
export type InteractionProps = {
  state: Snapshot;
  send: (command: Command) => Promise<Snapshot>;
  pending: boolean;
};
const emptyDraft = () => ({ message: "", requestId: crypto.randomUUID() });
function readDraft(lane: ExecutionLane) {
  try {
    const saved = JSON.parse(localStorage.getItem(`taskpilot-${lane}-conversation-draft`) || "null");
    if (saved && typeof saved.message === "string" && typeof saved.requestId === "string") return saved as ReturnType<typeof emptyDraft>;
    const previous = JSON.parse(localStorage.getItem("taskpilot-conversation-draft") || "null");
    if (previous && typeof previous.message === "string" && !!previous.background === (lane === "background")) return { ...emptyDraft(), message: previous.message };
    const legacy = localStorage.getItem(lane === "background" ? "taskpilot-background-draft" : "taskpilot-chat-draft");
    if (legacy) return { ...emptyDraft(), message: legacy };
  } catch { /* The current page keeps its draft if storage is unavailable. */ }
  return emptyDraft();
}
const time = (at: string) => new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
type ConversationProps = InteractionProps & { composeRequest?: number; onOpenTask: (id: string) => boolean };
export function Conversation(props: ConversationProps) { return <LaneConversation {...props} lane="work"/>; }
export function BackgroundConversation(props: ConversationProps) { return <LaneConversation {...props} lane="background"/>; }
function LaneConversation({ state, send, pending, composeRequest = 0, onOpenTask, lane }: ConversationProps & { lane: ExecutionLane }) {
  const background = lane === "background";
  const name = background ? "背景助手" : "工作助手";
  const [draft, setDraft] = useState(() => readDraft(lane));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [historyCount, setHistoryCount] = useState(30);
  const submittingRef = useRef(false);
  const lastComposeRequest = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    try {
      // Persist empty drafts too, so old drafts are not revived after sending.
      localStorage.setItem(`taskpilot-${lane}-conversation-draft`, JSON.stringify(draft));
    } catch { /* Keep the draft in this page. */ }
  }, [draft, lane]);
  useEffect(() => {
    if (composeRequest && composeRequest !== lastComposeRequest.current) {
      lastComposeRequest.current = composeRequest;
      setDraft((current) => current.message ? current : { ...current, message: "帮我推进一件事：" });
      input.current?.focus();
    }
  }, [composeRequest]);
  const messages = state.messages.filter((message) => message.scope === (background ? "background" : "frontdesk"));
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [messages.length]);
  const run = state.runs.findLast((item) => executionLane(item) === lane && item.status === "running");
  const kind = background ? "background" : "daily";
  const queued = state.research.queued.includes(kind);
  const failed = state.research[kind].blockedReason;
  const connected = state.runtime.modelConnection.status === "connected";
  const act = async (command: Command) => {
    setError("");
    try { await send(command); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const submit = async () => {
    if (!draft.message.trim() || pending || submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true); setError("");
    try {
      await send({ type: "chat", lane, message: draft.message, requestId: draft.requestId });
      setDraft(emptyDraft());
    } catch (reason) {
      setError(`未能确认提交，内容已保留，可重试。${reason instanceof Error ? `（${reason.message}）` : ""}`);
    } finally { submittingRef.current = false; setSubmitting(false); }
  };
  return <section className={`native-chat ${background ? "background-conversation" : "work-conversation"}`} aria-label={name}>
    <header><strong>{name}</strong><span className="muted">{run ? background ? "正在整理背景…" : "正在推进工作…" : background ? "聊近况，修正我对你的理解" : "聊工作，调整接下来的推进"}</span></header>
    <div className="native-chat-scroll" ref={scroll}>
      {messages.length > historyCount && <button className="quiet-link" onClick={() => setHistoryCount(historyCount + 30)}>更早的对话</button>}
      {!messages.length && <div className="native-chat-empty"><strong>{background ? "最近有什么变化？" : "有什么想交给我？"}</strong><p>{background ? "补充职责、目标与偏好，背景助手会整理到上方的背景摘要。" : "交办事情、讨论方案，或调整工作的推进方向。"}</p></div>}
      {messages.slice(-historyCount).map((message) => <article className={`native-message ${message.role}`} key={message.id}>
        <small>{message.role === "user" ? "你" : name} · {time(message.at)}{message.contextId ? ` · ${state.tasks.find((task) => task.id === message.contextId)?.title || message.contextId}` : message.contextIds?.length ? ` · ${message.contextIds.length} 项审阅` : ""}</small>
        <Suspense fallback={<p className="preserve">{message.body}</p>}><Markdown basePath={message.contextId ? `tasks/${message.contextId}/` : background ? "background/" : "assistant/"} body={message.body} onOpenTask={onOpenTask}/></Suspense>
      </article>)}
      {queued && <p className="native-run-progress" role="status">{background ? "背景整理" : "工作推进"}已排队，{connected ? "等待开始。" : "连接 AI 后开始。"}</p>}
      {run && <div className="native-run-progress" role="status"><RunProgress run={run}/><Button size="sm" variant="ghost" disabled={pending} aria-label={background ? "停止背景整理" : "停止工作推进"} onClick={() => void act({ type: "cancel", lane })}><Square size={12}/>停止本轮</Button></div>}
      {!run && !queued && failed && <div className="native-run-progress" role="status"><p>上轮未完成，已有资料和对话已保存。</p><Button size="sm" variant="outline" disabled={pending} onClick={() => void act({ type: "research", kind, requestId: crypto.randomUUID() })}>{background ? "重新总结" : "重新推进"}</Button></div>}
    </div>
    <form className="native-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea ref={input} aria-label={`和${name}对话`} value={draft.message} onChange={(event) => setDraft({ message: event.target.value, requestId: crypto.randomUUID() })} rows={3} maxLength={16000} readOnly={submitting} placeholder={background ? "告诉背景助手：我的近况、职责或偏好有这些变化…" : "发消息给工作助手…"} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.message.trim() && !pending) event.currentTarget.form?.requestSubmit(); }
      }}/>
      <div><span className="muted">{!connected ? "连接 AI 后处理已保存的消息" : "Enter 发送 · Shift + Enter 换行"}</span><Button type="submit" size="icon-sm" aria-label={`发送给${name}`} disabled={pending || submitting || !draft.message.trim()}>{submitting ? <LoaderCircle size={15} className="refresh-spinning"/> : <ArrowUp size={15}/>}</Button></div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  </section>;
}
