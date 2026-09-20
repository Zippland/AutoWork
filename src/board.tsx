import { useEffect, useRef, useState } from "react";
import { Columns3, List, Search } from "lucide-react";
import { CATEGORY_LABELS, STATUS_LABELS, type TaskCategory, type PilotTask } from "../core";
import { Button } from "./ui";

export type BoardView = "board" | "review" | "todo" | "progress" | "adjust" | "acceptance" | "archive";
export type BoardLayout = "board" | "list";
export const VIEW_LABELS: Record<BoardView, string> = { board: "工作看板", review: "待我审核", todo: "待推进", progress: "跟进中", adjust: "需要调整", acceptance: "待我验收", archive: "已归档" };
const columns = [
  { id: "review", title: "待审核", hint: "等待你的判断", statuses: ["review"] },
  { id: "todo", title: "待推进", hint: "准备交给 AI 处理", statuses: ["todo", "awaiting_ai"] },
  { id: "progress", title: "跟进中", hint: "已启动推进，等待处理或结果", statuses: ["queued", "running", "waiting"] },
  { id: "adjust", title: "待调整", hint: "需要修改或暂缓", statuses: ["paused", "blocked"] },
  { id: "acceptance", title: "待验收", hint: "成果已准备好", statuses: ["done"] },
];
const archiveColumn = { id: "archive", title: "已归档", hint: "已验收的历史成果", statuses: ["archived"] };
export function inView(task: PilotTask, view: BoardView) {
  if (view === "board") return task.status !== "archived";
  if (view === "archive") return task.status === "archived";
  return columns.find((column) => column.id === view)?.statuses.includes(task.status) ?? false;
}
const excerpt = (value: string) => value.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
export function Board({ tasks, onOpen, view, project, layout, onLayoutChange }: { tasks: PilotTask[]; onOpen: (task: PilotTask) => void; view: BoardView; project: string | null; layout: BoardLayout; onLayoutChange: (layout: BoardLayout) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<TaskCategory | "all">("all");
  const [limit, setLimit] = useState(20);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLElement && event.target.isContentEditable) && !document.querySelector("dialog[open]")) { event.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, []);
  const scoped = tasks.filter((task) => !task.demo && inView(task, view) && (!project || task.project === project));
  const filtered = scoped.filter((task) => (category === "all" || task.category === category) && `${task.id} ${task.title} ${task.body}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const card = (task: PilotTask) => <button className="task-card" key={task.id} onClick={() => onOpen(task)}>
    <span className="task-card-meta"><span>{task.id}</span><span className={`status-tag status-${task.status}`}>{STATUS_LABELS[task.status]}</span></span>
    <strong>{task.title}</strong>
    <span className="task-preview">{excerpt(task.body) || "AI 将在这里整理背景与下一步。"}</span>
    {task.request && <span className="task-decision"><b>{task.request.kind === "approval" ? "需要你判断" : "需要你补充"}</b>{task.request.question}</span>}
    <span className="task-card-footer">{task.project && <span className="project-tag"><i />{task.project}</span>}{task.category && <span className={`category-tag ${task.category}`}>{CATEGORY_LABELS[task.category]}</span>}</span>
  </button>;
  const visibleColumns = view === "archive" ? [archiveColumn] : view === "board" ? columns.filter((column) => column.id !== "acceptance" || filtered.some((task) => task.status === "done")) : columns.filter((column) => column.id === view);
  return <>
    <div className="board-toolbar">
      <div className="layout-switch" aria-label="显示方式"><Button variant="ghost" size="sm" aria-pressed={layout === "board"} onClick={() => onLayoutChange("board")}><Columns3 size={14} />看板</Button><Button variant="ghost" size="sm" aria-pressed={layout === "list"} onClick={() => onLayoutChange("list")}><List size={14} />列表</Button></div>
      <label className="search-box"><Search size={15} /><input ref={input} type="search" aria-label="搜索事项" placeholder="搜索事项、人物、编号" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(20); }} /><kbd>/</kbd></label>
      <label className="source-filter"><span>来源</span><select value={category} aria-label="筛选事项来源" onChange={(event) => { setCategory(event.target.value as TaskCategory | "all"); setLimit(20); }}><option value="all">全部来源</option><option value="commitment">应做事项</option><option value="proactive">主动推进</option></select></label>
      <span className="list-count">{filtered.length} 项{view === "archive" ? "归档" : "事项"}</span>
    </div>
    <p className="board-intro">{view === "archive" ? "已验收归档的成果，需要时可以继续推进。" : "先看值得你判断的事，再看推进到了哪里。"}</p>
    {layout === "list" ? <div className="task-list" aria-label={view === "archive" ? "归档事项" : "事项列表"}>
      {filtered.slice(0, limit).map((task) => <button className="task-list-row" key={task.id} onClick={() => onOpen(task)}><span className="muted">{task.id}</span><strong>{task.title}</strong><span className={`status-tag status-${task.status}`}>{STATUS_LABELS[task.status]}</span><span className="muted">{task.category ? CATEGORY_LABELS[task.category] : ""}</span></button>)}
      {!filtered.length && <div className="list-empty">{search || category !== "all" ? "没有匹配的事项" : view === "archive" ? "还没有归档的事项" : "这里暂时没有事项"}</div>}
      {filtered.length > limit && <Button className="load-more" variant="ghost" onClick={() => setLimit(limit + 20)}>加载更多（还有 {filtered.length - limit} 项）</Button>}
    </div> : <div className={`task-board ${view !== "board" ? "single-column" : ""}`} aria-label="事项看板">
      {visibleColumns.map((column) => { const items = filtered.filter((task) => column.statuses.includes(task.status)); const visible = view === "archive" ? items.slice(0, limit) : items; return <section key={column.id} className={`board-column column-${column.id}`} aria-label={column.title}>
        <header><h2><i />{column.title}<span>{items.length}</span></h2><p>{column.hint}</p></header><div className="column-cards">{visible.map(card)}{!items.length && <div className="column-empty">{search || category !== "all" ? "没有匹配的事项" : "暂无事项"}</div>}</div>
        {items.length > visible.length && <Button className="load-more" variant="ghost" onClick={() => setLimit(limit + 20)}>加载更多（还有 {items.length - visible.length} 项）</Button>}
      </section>; })}
    </div>}
  </>;
}
