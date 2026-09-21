import { useState } from "react";
import { Check, ChevronRight, FolderOpen, LoaderCircle } from "lucide-react";
import type { ResearchSettings } from "../core";
import type { InteractionProps } from "./frontdesk";
import { Button, Toggle } from "./ui";

export function AIConnection({ state, send, pending }: InteractionProps) {
  const connection = state.runtime.modelConnection;
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState("");
  return <section className="settings-section connection-section"><h3>使用哪个 AI</h3><div className="provider-options" role="group" aria-label="选择 AI 执行器">
    {connection.available.map((item) => {
      const connected = connection.provider === item.provider && connection.status === "connected";
      const isConnecting = connecting === item.provider;
      return <button key={item.provider} aria-pressed={connected} aria-busy={isConnecting} className={`provider-option ${connected ? "selected" : ""} ${isConnecting ? "connecting" : ""}`} disabled={pending || !!connecting || connection.status === "checking" || state.busy || !item.installed} onClick={async () => {
        setError(""); setConnecting(item.provider);
        try { await send({ type: "model_connect", provider: item.provider }); }
        catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { setConnecting(null); }
      }}><span className="provider-name">{item.label}</span><span className="provider-status" role="status">{isConnecting ? <><LoaderCircle size={14} className="refresh-spinning" aria-hidden="true"/>正在连接…</> : !item.installed ? "未安装" : connected ? <><Check size={13}/> 已连接</> : "点击连接"}</span></button>;
    })}
  </div>
    <p className="settings-hint">模型、推理强度和工具沿用各个本地 AI 的默认配置。</p>
    {state.busy && <p className="settings-hint">当前正在处理，结束后可以切换。</p>}
    {!connection.available.some((item) => item.installed) && <p className="settings-hint">请先在本机安装并登录一个 AI 执行器，再重新启动 TaskPilot。</p>}
    {(error || connection.error) && <p className="error" role="alert">{error || connection.error}</p>}
  </section>;
}

export function SettingsView({ state, send, pending, setupOnly = false }: InteractionProps & { setupOnly?: boolean }) {
  const [settings, setSettings] = useState(state.research.settings);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const act: InteractionProps["send"] = async (command) => { setError(""); try { return await send(command); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; } };
  const update = <K extends keyof ResearchSettings>(key: K, value: ResearchSettings[K]) => { setSettings((previous) => ({ ...previous, [key]: value })); setSaved(false); };
  return <div className="settings-body">
    <AIConnection state={state} send={send} pending={pending}/>
    {!setupOnly && <>
    <section className="settings-section"><div className="setting-row"><div><h3>自动推进</h3><p>继续处理已交办、可推进的事项</p></div><Toggle label="自动推进" checked={!state.paused} disabled={pending} onChange={(value) => void act({ type: "pause", paused: !value }).catch(() => undefined)} /></div></section>
    <section className="settings-section schedule-section"><h3>定期查看</h3>
      <div className="setting-row"><div><strong>当天变化</strong><p>筛选需要关注和推进的事</p></div><div className="setting-controls"><select aria-label="当天巡检频率" value={settings.dailyMinutes} onChange={(event) => update("dailyMinutes", Number(event.target.value))}>{[5,15,30,60,120,240].map((value) => <option key={value} value={value}>{value < 60 ? `${value} 分钟` : `${value / 60} 小时`}</option>)}{![5,15,30,60,120,240].includes(settings.dailyMinutes) && <option value={settings.dailyMinutes}>{settings.dailyMinutes} 分钟</option>}</select><Toggle label="定期查看当天变化" checked={state.research.daily.enabled} disabled={pending} onChange={(value) => void act({ type: "research_schedule", kind: "daily", enabled: value, requestId: crypto.randomUUID() }).catch(() => undefined)} /></div></div>
      <div className="setting-row"><div><strong>背景资料</strong><p>重新梳理近期目标和工作背景</p></div><div className="setting-controls"><select aria-label="背景复查频率" value={settings.backgroundMinutes} onChange={(event) => update("backgroundMinutes", Number(event.target.value))}>{[60,360,720,1440,4320,10080].map((value) => <option key={value} value={value}>{value < 1440 ? `${value / 60} 小时` : `${value / 1440} 天`}</option>)}{![60,360,720,1440,4320,10080].includes(settings.backgroundMinutes) && <option value={settings.backgroundMinutes}>{settings.backgroundMinutes} 分钟</option>}</select><Toggle label="定期复查背景" checked={state.research.background.enabled} disabled={pending} onChange={(value) => void act({ type: "research_schedule", kind: "background", enabled: value, requestId: crypto.randomUUID() }).catch(() => undefined)} /></div></div>
      <div className="schedule-window"><label>查看时间<select aria-label="巡检日期" value={settings.days} onChange={(event) => update("days", event.target.value as ResearchSettings["days"])}><option value="china-workdays">法定工作日（含调休）</option><option value="weekdays">周一至周五</option><option value="everyday">每天</option></select></label><div className="time-window"><label><span className="sr-only">开始时间</span><input aria-label="开始时间" type="time" value={settings.start} onChange={(event) => update("start", event.target.value)} /></label><span>至</span><label><span className="sr-only">结束时间</span><input aria-label="结束时间" type="time" value={settings.end} onChange={(event) => update("end", event.target.value)} /></label></div></div>
      <div className="schedule-save"><span className="settings-hint">北京时间；手动操作随时可用。</span><Button variant="outline" size="sm" disabled={pending || JSON.stringify(settings) === JSON.stringify(state.research.settings)} onClick={() => void act({ type: "research_settings", requestId: crypto.randomUUID(), settings }).then(() => setSaved(true)).catch(() => undefined)}>{saved ? "已保存" : "保存时间安排"}</Button></div>
      {(["daily", "background"] as const).filter((kind) => state.research[kind].lastError).map((kind) => <div className="settings-notice" key={kind}>{kind === "daily" ? "当天巡检" : "背景调研"}上轮未完成，定时设置未改变。后续按设置的时间安排，也可手动开始。</div>)}
      {state.research.calendarError && <p className="error">{state.research.calendarError}</p>}
      <p className="settings-hint">电脑唤醒、本地服务运行时生效；没有新变化就不打扰。</p>
    </section>
    </>}
    {setupOnly && <p className="settings-hint setup-settings-hint">先连接 AI、整理背景。巡检时间和自动推进可以在进入工作台后调整。</p>}
    <details className="storage-details"><summary><FolderOpen size={15} />本地文件<ChevronRight size={14} /></summary><p>{state.runtime.workspace}</p><p>背景、卡片和资料都在这里，以文件保存。</p></details>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
