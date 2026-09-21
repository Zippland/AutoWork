import { useState } from "react";
import { MessageSquare, RefreshCw } from "lucide-react";
import { executionLane } from "../core";
import { Button } from "./ui";
import { BackgroundConversation, type InteractionProps } from "./frontdesk";
import Markdown from "./markdown";
export default function BackgroundView({
  state,
  send,
  pending,
  onOpenTask,
}: InteractionProps & {
  onOpenTask: (id: string) => boolean;
}) {
  const [error, setError] = useState("");
  const schedule = state.research.background;
  const running = state.runs.some((run) => executionLane(run) === "background" && run.status === "running");
  const queued = state.research.queued.includes("background");
  const time = (value: string) =>
    new Date(value).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Shanghai",
    });
  return (
    <section className="native-background">
      <div className="native-background-heading">
        <h2>我的背景</h2>
        <div className="native-background-actions"><Button variant="ghost" size="sm" onClick={() => document.getElementById("background-conversation")?.scrollIntoView({ behavior: "smooth", block: "start" })}><MessageSquare size={14}/>对话与补充</Button><Button
          variant="outline"
          size="sm"
          disabled={pending || running || queued}
          onClick={async () => {
            setError("");
            try {
              await send({
                type: "research",
                kind: "background",
                requestId: crypto.randomUUID(),
              });
            } catch (reason) {
              setError(
                reason instanceof Error
                  ? reason.message
                  : "刷新请求未保存，请重试。",
              );
            }
          }}
        >
          <RefreshCw size={14} className={running ? "refresh-spinning" : undefined}/>
          {running ? "正在调研…" : queued ? "已排队" : "立即总结"}
        </Button></div>
      </div>
      <p className="muted native-research-meta">
        {running
          ? "AI 正在整理背景，结果会更新在这里。工作推进可同时进行。"
          : queued
            ? state.runtime.modelConnection.status === "connected"
              ? "请求已保存，即将开始；进展会显示在本页的背景对话。"
              : "已保存请求，连接 AI 后开始。"
            : `${schedule.lastCompletedAt ? `上次总结 ${time(schedule.lastCompletedAt)}` : "尚未立即总结"} · ${state.paused ? "自动复查已暂停" : !schedule.enabled ? "自动复查已关闭" : schedule.nextAt ? `下次复查 ${time(schedule.nextAt)}（北京时间）` : "等待工作日历更新"}`}
      </p>
      {state.research.calendarError && <p className="error" role="status">{state.research.calendarError}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {state.background.body ? (
        <Markdown body={state.background.body} onOpenTask={onOpenTask} />
      ) : (
        <p className="muted">
          点击“立即总结”，AI
          会调研飞书和已连接资料，整理你的当前背景。也可以直接聊聊近况。
        </p>
      )}
      <div id="background-conversation" className="background-conversation-section"><BackgroundConversation state={state} send={send} pending={pending} onOpenTask={onOpenTask}/></div>
    </section>
  );
}
