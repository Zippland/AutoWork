import { lazy, Suspense, useState } from "react";
import { Check, LoaderCircle, MessageSquare, Square } from "lucide-react";
import { executionLane } from "../core";
import { BackgroundConversation, type InteractionProps } from "./frontdesk";
import { AIConnection } from "./settings";
import { Button } from "./ui";
import { RunProgress } from "./run-progress";

const Markdown = lazy(() => import("./markdown"));

export function Onboarding({ state, send, pending }: InteractionProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const onChat = () => setChatOpen((open) => !open);
  const [error, setError] = useState("");
  const connected = state.runtime.modelConnection.status === "connected";
  const background = state.background.body.trim();
  const queued = state.research.queued.includes("background");
  const active = state.runs.findLast((run) => executionLane(run) === "background" && run.status === "running");
  const busy = !!active;
  const lastResearch = state.runs.findLast((run) => run.research === "background");
  const ready = !!background && !busy && !queued;
  const incomplete = lastResearch && !["running", "succeeded"].includes(lastResearch.status);
  const step = ready ? 2 : connected ? 1 : 0;
  const act: InteractionProps["send"] = async (command) => {
    setError("");
    try { return await send(command); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
  };
  const start = () => void act({ type: "research", kind: "background", requestId: crypto.randomUUID() }).catch(() => undefined);
  return <main className="onboarding-content">
    <ol className="onboarding-steps" aria-label="开始使用">
      {["连接 AI", "了解你的背景", "进入工作台"].map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "complete" : ""} aria-current={index === step ? "step" : undefined}><span>{index < step ? <Check size={12}/> : index + 1}</span>{label}</li>)}
    </ol>
    {!connected && !ready ? <>
      <div className="onboarding-heading"><h1>先连接你的 AI 助手</h1><p>沿用你本机已经登录的 AI。连接后，先让它了解你的近况，再开始处理工作。</p></div>
      <AIConnection state={state} send={send} pending={pending}/>
      <p className="onboarding-footnote">已有工具和登录照常使用，不需要重新填写个人资料。</p>
    </> : ready ? <>
      <div className="onboarding-heading"><h1>先看看，AI 是否理解了你</h1><p>这是根据已读取资料整理的近期背景。有偏差可以直接对话调整。</p></div>
      <article className="onboarding-summary" aria-label="你的背景摘要"><Suspense fallback={<p className="preserve">{background}</p>}><Markdown body={background}/></Suspense></article>
      <div className="onboarding-actions"><Button disabled={pending || state.runtime.fileIssues.length > 0} onClick={() => void act({ type: "onboarding_complete", requestId: crypto.randomUUID() }).catch(() => undefined)}>进入工作台</Button><Button variant="ghost" onClick={onChat}><MessageSquare size={15}/>和 AI 调整背景</Button></div>
      <p className="onboarding-footnote">进入后再查看待办、审核方案，安排定期巡检。</p>
    </> : <>
      <div className="onboarding-heading"><h1>{busy ? "正在了解你的工作" : queued ? "背景调研已排队" : incomplete ? "继续了解你的背景" : "从你的近况开始"}</h1><p>AI 会调研飞书和已连接资料，梳理你在做什么、承担什么，以及哪些事情值得关注。</p></div>
      <div className="onboarding-research">
        <div className="onboarding-connection"><span className="connection-dot"/>{state.runtime.modelConnection.label} 已连接</div>
        {busy || queued ? <div className="onboarding-progress" role="status"><LoaderCircle size={20} className="refresh-spinning"/><div><strong>{busy ? active?.research === "background" ? "正在调研背景" : "AI 正在整理你的补充" : "等待本轮开始"}</strong>{busy ? <RunProgress run={active}/> : <p>即将开始整理背景，无需重复提交。</p>}</div></div> : <>
          <h2>{incomplete ? "上次调研未完成，已有对话会保留" : "先整理背景，再展开工作"}</h2>
          <p>先呈现一份简短、可追溯的背景摘要。需要登录或补充信息时，AI 会在对话里告诉你。</p>
          {incomplete && <details className="onboarding-failure"><summary>查看上次中断原因</summary><p>{lastResearch.detail}</p></details>}
          {lastResearch?.status === "succeeded" && !background && <p className="onboarding-result-hint">上轮尚未生成背景摘要，可以继续调研或在对话中补充线索。</p>}
        </>}
        <div className="onboarding-actions">
          {!busy && !queued && <Button disabled={pending} onClick={start}>{lastResearch ? "继续调研背景" : "开始调研背景"}</Button>}
          <Button variant={busy || queued ? "outline" : "ghost"} onClick={onChat}><MessageSquare size={15}/>{busy || queued || lastResearch ? "查看对话与补充" : "先和 AI 聊聊"}</Button>
          {busy && <Button variant="ghost" disabled={pending} onClick={() => void act({type:"cancel",lane:"background"}).catch(() => undefined)}><Square size={12}/>停止本轮</Button>}
        </div>
      </div>
      <p className="onboarding-footnote">背景准备好后，再进入工作台。期间不会启动日常巡检。</p>
    </>}
    {chatOpen && <div className="background-conversation-section"><BackgroundConversation state={state} send={send} pending={pending} onOpenTask={() => false}/></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {state.runtime.error && <p className="error" role="alert">{state.runtime.error}</p>}
    {state.runtime.fileIssues.length > 0 && <div className="error" role="alert">资料需要修正，请在对话中让 AI 检查。{state.runtime.fileIssues.map((issue) => <p key={issue.file}>{issue.file}：{issue.message}</p>)}</div>}
  </main>;
}
