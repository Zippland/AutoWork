import { lazy, Suspense, useEffect, useState, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Bell, CheckCheck, CircleDot, CirclePause, Columns3, Folder, History, MessageSquare, Plus, Play, LoaderCircle, Settings2, Square, SquarePen, UserRound, X } from "lucide-react";
import { executionLane, type PilotTask } from "../core";
import { pilotCommand, pilotStateOptions } from "../core/queries";
import { Board, inView, VIEW_LABELS, type BoardLayout, type BoardView } from "./board";
import { Conversation, type InteractionProps } from "./frontdesk";
import { Button, Modal } from "./ui";
import { SettingsView } from "./settings";
import { TaskDetail } from "./task-detail";
import { Activity } from "./activity";
import { AdvanceSchedule } from "./advance-schedule";
import { Onboarding } from "./onboarding";
import { FilePreview, fileName, localFileUrl } from "./file-preview";
const BackgroundView = lazy(() => import("./background"));
const Markdown = lazy(() => import("./markdown"));
type Page = BoardView | "attention" | "background" | "activity";
const titles: Record<Page,string> = { ...VIEW_LABELS, attention: "需要关注", background: "我的背景", activity: "最近活动" };
export default function App() {
  const client = useQueryClient();
  const query = useQuery(pilotStateOptions());
  const mutation = useMutation({ mutationFn: pilotCommand, onSuccess: (state) => client.setQueryData(["pilot", "local", "state"], state) });
  const [page, setPage] = useState<Page>("board");
  const [layout, setLayout] = useState<BoardLayout>(() => {
    try { return localStorage.getItem("taskpilot-board-layout") === "list" ? "list" : "board"; }
    catch { return "board"; }
  });
  useEffect(() => {
    try { localStorage.setItem("taskpilot-board-layout", layout); }
    catch { /* Keep the shared preference in memory if browser storage is unavailable. */ }
  }, [layout]);
  const [project, setProject] = useState<string|null>(null);
  const [selected, setSelected] = useState<string|null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [composeRequest, setComposeRequest] = useState(0);
  const [refreshError, setRefreshError] = useState("");
  const [stopRequestedRun, setStopRequestedRun] = useState<string | null>(null);
  const [fileHistory, setFileHistory] = useState<string[]>([]);
  const currentFile = fileHistory.at(-1);
  const openLocalFile = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download")) return;
    const href = localFileUrl(anchor.getAttribute("href")!, window.location.origin);
    if (!href) return;
    event.preventDefault();
    setFileHistory((history) => history.at(-1) === href ? history : [...history, href]);
  };
  const state = query.data;
  if (!state) return <div className="loading"><span className="brand-mark">T</span><p>{query.error ? `无法连接本地服务：${query.error.message}` : "正在读取工作台..."}</p>{query.error && <Button onClick={() => void query.refetch()}>重试</Button>}</div>;
  const props: InteractionProps = { state, send: (command) => mutation.mutateAsync(command), pending: mutation.isPending };
  const onboarding = !state.onboardingCompletedAt;
  const tasks = state.tasks.filter((task) => !task.demo);
  const projects = [...new Set(tasks.filter((task) => task.status !== "archived").map((task) => task.project).filter((name): name is string => !!name))];
  const active = tasks.find((task) => task.id === selected);
  const connected = state.runtime.modelConnection.status === "connected";
  const researching = state.activeScopes.some((scope) => scope !== "background");
  const workRun = state.runs.findLast((run) => executionLane(run) === "work" && run.status === "running");
  const stopping = !!workRun && stopRequestedRun === workRun.id;
  const researchQueued = state.research.queued.includes("daily") || tasks.some((task) => task.queued);
  const refreshLabel = stopping ? "正在停止…" : researching ? "停止推进" : researchQueued ? "推进已排队" : "推进";
  const startResearch = async () => {
    setRefreshError("");
    try {
      await props.send({ type: "research", kind: "daily", requestId: crypto.randomUUID() });
    } catch (reason) {
      setRefreshError(reason instanceof Error ? reason.message : "未能启动，请重试。");
    }
  };
  const stopResearch = async () => {
    if (!workRun || stopping) return;
    setRefreshError("");
    setStopRequestedRun(workRun.id);
    try {
      await props.send({ type: "cancel", lane: "work" });
    } catch (reason) {
      setStopRequestedRun(null);
      setRefreshError(reason instanceof Error ? reason.message : "未能停止，请重试。");
    }
  };
  const openTask = (task: PilotTask) => setSelected(task.id);
  const openReferencedTask = (id: string) => { if (!tasks.some((task) => task.id === id)) return false; setSelected(id); return true; };
  const navigate = (next: Page) => { setPage(next); setProject(null); };
  const toggleWorkChat = () => { if (page === "background") navigate("board"); setChatOpen(!chatOpen || page === "background"); };
  const nav = (view: BoardView, icon: React.ReactNode) => <button key={view} className={`nav-item ${page === view ? "active" : ""}`} aria-current={page === view ? "page" : undefined} onClick={() => navigate(view)}>{icon}<span>{titles[view]}</span><small>{tasks.filter((task) => inView(task, view)).length}</small></button>;

  return <div onClick={openLocalFile} className={`workspace ${chatOpen && !onboarding && page !== "background" ? "chat-open" : ""} ${onboarding ? "onboarding-workspace" : ""}`}>
    {onboarding ? <div className="onboarding-shell">
      <header className="onboarding-topbar"><div className="onboarding-brand"><span className="brand-mark">T</span><strong>TaskPilot</strong></div><Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}><Settings2 size={15}/>设置</Button></header>
      {query.error && <p className="error onboarding-connection-error">连接中断，正在尝试重新连接本地服务。</p>}
      <Onboarding {...props}/>
    </div> : <>
    <aside className="sidebar" aria-label="工作台导航"><button className="brand" onClick={() => navigate("board")}><span className="brand-mark">T</span><span>TaskPilot<small>个人工作空间</small></span></button>
      <div className="sidebar-navigation"><div className="nav-group-label">工作空间</div><nav>{nav("board",<Columns3 size={16}/>)}{nav("review",<CircleDot size={16}/>)}<button className={`nav-item ${page === "attention" ? "active" : ""}`} onClick={() => navigate("attention")}><Bell size={16}/><span>需要关注</span>{state.attention.trim() && <i className="nav-dot"/>}</button></nav>
      <div className="nav-group-label">进展与记录</div><nav>{nav("todo",<Play size={16}/>)}{nav("progress",<CircleDot size={16}/>)}{nav("adjust",<SquarePen size={16}/>)}{nav("acceptance",<CheckCheck size={16}/>)}{nav("archive",<Archive size={16}/>)}</nav>
      <div className="nav-group-label">项目</div><nav><button className={`nav-item ${page === "board" && !project ? "project-selected" : ""}`} onClick={() => navigate("board")}><Folder size={15}/><span>全部项目</span></button>{projects.map((name) => <button key={name} className={`nav-item ${project === name ? "active" : ""}`} onClick={() => {setProject(name);setPage("board");}}><i className="project-dot"/><span>{name}</span></button>)}</nav>
      </div><div className="sidebar-bottom"><button className={`nav-item ${page === "activity" ? "active" : ""}`} onClick={() => navigate("activity")}><History size={16}/><span>最近活动</span></button><button className={`nav-item ${page === "background" ? "active" : ""}`} onClick={() => navigate("background")}><UserRound size={16}/><span>我的背景</span></button><button className="nav-item" onClick={() => setSettingsOpen(true)}><Settings2 size={16}/><span>设置</span></button><button className="assistant-status" onClick={toggleWorkChat}><span className="assistant-avatar">助</span><span>{connected ? state.runtime.modelConnection.label : "连接 AI"}<small>{state.busy ? "正在处理" : state.paused ? "自动推进已暂停" : "你的工作助手"}</small></span><i className={connected ? "online" : "offline"}/></button></div>
    </aside>
    <main className="main"><header className="topbar"><div className="breadcrumb"><span>我的工作空间</span><span>/</span><h1>{titles[page]}</h1>{project && <span>/ {project}</span>}</div><select className="mobile-navigation" aria-label="页面导航" value={page} onChange={(event) => navigate(event.target.value as Page)}>{Object.entries(titles).map(([key,value]) => <option key={key} value={key}>{value}</option>)}</select><div className="topbar-actions">{page !== "background" && <><div className="advance-control"><AdvanceSchedule research={state.research} paused={state.paused} connected={connected} running={researching} queued={researchQueued} unavailable={query.error ? "正在恢复与本地服务的连接。" : state.runtime.fileIssues.length ? "工作台文件需要修正，请查看页面提示。" : state.runtime.error || undefined}/><Button variant={researching ? "outline" : "brandSubtle"} size="sm" aria-label={refreshLabel} title={researching ? "停止本轮工作推进，保留记录与草稿" : "查看全局，并按当前计划推进工作"} disabled={mutation.isPending || stopping || (!researching && (researchQueued || state.reviewMode !== "batch"))} onClick={() => void (researching ? stopResearch() : startResearch())}>{stopping || researchQueued ? <LoaderCircle size={15} className="refresh-spinning"/> : researching ? <Square size={15}/> : <Play size={15}/>} {refreshLabel}</Button></div><Button variant={chatOpen ? "brandSubtle" : "ghost"} size="sm" aria-expanded={chatOpen} onClick={toggleWorkChat}><MessageSquare size={15}/>和 AI 聊聊</Button><Button size="sm" onClick={() => {setChatOpen(true);setComposeRequest(composeRequest+1);}}><Plus size={14}/>新建事项</Button></>}</div></header>
      <div className="page-content">{refreshError && <p className="error top-error" role="alert">{refreshError}</p>}{query.error && <p className="error top-error">连接中断，正在显示上次读取的内容。</p>}{state.runtime.error && <p className="error top-error">{state.runtime.error}</p>}{state.runtime.fileIssues.length > 0 && <div className="error top-error">文件需要修正，自动推进已停止。{state.runtime.fileIssues.map((issue,index) => <p key={index}>{issue.file}：{issue.message}</p>)}</div>}{state.paused && <div className="pause-banner"><CirclePause size={15}/><span>自动推进已暂停，仍可直接和 AI 对话。</span><Button variant="ghost" size="xs" disabled={mutation.isPending} onClick={() => void props.send({type:"pause",paused:false}).catch(() => undefined)}>恢复</Button></div>}{!connected && <div className="connection-banner"><span>连接本地 AI，开始处理你交办的事。</span><Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>连接 AI</Button></div>}
        {page === "background" ? <Suspense fallback={<p>正在读取...</p>}><BackgroundView {...props} onOpenTask={openReferencedTask} /></Suspense> : page === "attention" ? <section className="reading-page"><h2>需要关注</h2>{state.attention.trim() ? <Suspense fallback={<p>{state.attention}</p>}><Markdown body={state.attention} basePath="assistant/" onOpenTask={openReferencedTask}/></Suspense> : <p className="page-caption">暂时没有需要你关注的新变化。</p>}</section> : page === "activity" ? <Activity state={state}/> : <Board key={`${page}:${project}`} tasks={tasks} view={page} project={project} onOpen={openTask} layout={layout} onLayoutChange={setLayout}/>}
      </div><footer className="board-footer"><span>本地工作台<span>审核与资料保存在本机</span></span><span>打开事项审核 <kbd>/</kbd> 搜索</span></footer>
    </main></>}
    <div className="chat-panel" hidden={!chatOpen || onboarding || page === "background"}><Button className="chat-close" variant="ghost" size="icon-sm" aria-label="收起 AI 对话" onClick={() => setChatOpen(false)}><X size={16}/></Button><Conversation {...props} composeRequest={composeRequest} onOpenTask={onboarding ? () => false : openReferencedTask}/></div>
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="设置" className="settings-modal">{settingsOpen && <SettingsView {...props} setupOnly={onboarding}/>}</Modal>
    <Modal open={!onboarding && !!active} onClose={() => setSelected(null)} title="事项详情" className="issue-modal">{!onboarding && active && <TaskDetail key={active.id} task={active} {...props}/>}</Modal>
    <Modal open={!!currentFile} onClose={() => setFileHistory([])} title={currentFile ? fileName(currentFile).split("/").at(-1)! : "资料"} className="file-preview-modal">{currentFile && <FilePreview key={currentFile} href={currentFile} onBack={fileHistory.length > 1 ? () => setFileHistory((history) => history.slice(0, -1)) : undefined}/>}</Modal>
  </div>;
}
