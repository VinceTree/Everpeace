import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { WebModel, WebState, WebTurn } from "../protocol.js";
import { action, connect, workbenchToken } from "./connection.js";
import { copy, type Language } from "./copy.js";
import { Assistant, Icon, Interaction, Message, ToolCard } from "./conversation.js";
import { Button } from "./upstream/Button.js";
import frame from "./upstream/AppFrame.module.css";
import sidebar from "./upstream/SidebarRoot.module.css";
import input from "./upstream/InputBar.module.css";
import hero from "./upstream/HeroShell.module.css";
import "./upstream/base.css";
import "./upstream/design-platform.css";
import "./upstream/corner-shape.css";
import "./upstream/gradient-shadow-text.css";
import "./upstream/scrollbar.css";
import "./upstream/focus.css";
import "./workbench.css";

const token = workbenchToken();
const languagePreference = localStorage.getItem("everpeace-language");
const initialTheme = localStorage.getItem("everpeace-theme");

function Workbench() {
  const [state, setState] = useState<WebState>();
  const [connected, setConnected] = useState(false);
  const [expired, setExpired] = useState(!token);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [showSidebar, setShowSidebar] = useState(() => matchMedia("(min-width: 768px)").matches);
  const [showSettings, setShowSettings] = useState(false);
  const [language, setLanguage] = useState<Language | undefined>(languagePreference === "en" || languagePreference === "zh-CN" ? languagePreference : undefined);
  const [dark, setDark] = useState(() => initialTheme ? initialTheme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  const transcript = useRef<HTMLDivElement>(null);
  const shouldFollow = useRef(true);
  const working = useRef(false);
  const locale = language ?? state?.language ?? (navigator.language.startsWith("zh") ? "zh-CN" : "en");
  const text = copy[locale];

  useLayoutEffect(() => {
    document.body.toggleAttribute("data-ds-dark-theme", dark);
    document.documentElement.lang = locale;
  }, [dark, locale]);

  useEffect(() => {
    if (!token) return;
    const auth = token;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const reconnect = await connect(auth, controller.signal, event => {
          if ("state" in event) {
            setState(event.state);
            setConnected(true);
          } else {
            setState(previous => previous?.turn?.id === event.turn.id ? { ...previous, turn: event.turn } : previous);
          }
        });
        if (!reconnect && !controller.signal.aborted) {
          setExpired(true);
          setState(undefined);
          return;
        }
      } catch { /* A broken stream is recovered from its initial snapshot. */ }
      if (!controller.signal.aborted) {
        setConnected(false);
        retry = setTimeout(() => void read(), 1000);
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(retry); };
  }, []);

  const sessionId = state?.sessionId;
  const turn = state?.turn;
  useLayoutEffect(() => {
    shouldFollow.current = true;
  }, [sessionId]);
  useLayoutEffect(() => {
    const view = transcript.current;
    if (view && shouldFollow.current) view.scrollTop = view.scrollHeight;
  }, [state]);

  async function perform(name: string, body: object): Promise<boolean> {
    if (!token || !connected || working.current) return false;
    working.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action(token, name, body);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      working.current = false;
      setPending(false);
    }
  }

  async function selectSession(id: string | null) {
    if (await perform("session", { sessionId: id })) {
      setDraft("");
      if (matchMedia("(max-width: 767px)").matches) setShowSidebar(false);
    }
  }

  async function send() {
    if (!state?.modelId || !draft.trim() || state.turn || state.blocked) return;
    const message = draft;
    shouldFollow.current = true;
    if (await perform("send", { prompt: message, sessionId: state.sessionId, modelId: state.modelId })) {
      setDraft(previous => previous === message ? "" : previous);
    }
  }

  function stop(active: WebTurn) {
    void perform("stop", { turnId: active.id });
  }

  const busy = !connected || pending;
  const navigatingDisabled = busy || !!turn || state?.blocked;
  const isEmpty = !state?.timeline.length && !turn?.entries.length && !turn;
  const current = state?.sessions.find(session => session.id === sessionId);
  const folder = state?.workspace.split(/[\\/]/u).filter(Boolean).at(-1) ?? state?.workspace;
  const messages = [...state?.timeline ?? [], ...turn?.entries ?? []];
  const runError = state?.error;
  const feedback = error ?? (runError && Object.hasOwn(text, runError) ? text[runError as keyof typeof text] : runError);

  return <div className={`${frame.frame} workbench`} data-sidebar={showSidebar ? "open" : "closed"}>
    {showSidebar && <>
      <button type="button" className="drawer-mask" aria-label={text.sidebar} onClick={() => setShowSidebar(false)} />
      <aside className={`${sidebar.root} workbench-sidebar`}>
        <div className={`${sidebar.logoRow} sidebar-heading`}>
          <strong className="wordmark">Everpeace</strong>
          <Button size="sm" aria-label={text.sidebar} title={text.sidebar} onClick={() => setShowSidebar(false)}><Icon name="panel-left-outline" /></Button>
        </div>
        <div className={sidebar.newSessionRow}>
          <button type="button" className={sidebar.newSession} disabled={navigatingDisabled} onClick={() => void selectSession(null)}>
            <span className={sidebar.newSessionContent}><Icon name="plus-outline" />{text.newSession}</span>
          </button>
        </div>
        <nav className={`${sidebar.scrollArea} session-list`} aria-label={text.sessions}>
          <div className="section-label">{text.sessions}</div>
          {state?.sessions.map(session => <button type="button" key={session.id} title={session.title} className="session-row"
            aria-current={session.id === sessionId ? "page" : undefined}
            disabled={navigatingDisabled} onClick={() => void selectSession(session.id)}>
            <Icon name="chevron-right-outline" /><span>{session.title || text.newSession}</span>
          </button>)}
          {state && !state.sessions.length && <div className="session-empty">{text.empty}</div>}
        </nav>
        <div className="sidebar-footer">
          {showSettings && <div className="preferences">
            <label>{text.theme}<select value={dark ? "dark" : "light"} onChange={event => {
              setDark(event.target.value === "dark");
              localStorage.setItem("everpeace-theme", event.target.value);
            }}><option value="light">{text.light}</option><option value="dark">{text.dark}</option></select></label>
            <label>{text.language}<select value={locale} onChange={event => {
              const next = event.target.value as Language;
              setLanguage(next);
              localStorage.setItem("everpeace-language", next);
            }}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
          </div>}
          <Button size="sm" aria-expanded={showSettings} onClick={() => setShowSettings(!showSettings)}
            icon={<Icon name="settings-outline" />}>{text.preferences}</Button>
        </div>
      </aside>
    </>}
    <main className={`${frame.centerCol} workspace-main`}>
      <header className="workspace-header">
        {!showSidebar && <Button size="sm" aria-label={text.sidebar} title={text.sidebar} onClick={() => setShowSidebar(true)}><Icon name="panel-left-outline" /></Button>}
        <span className="header-title">{current?.title}</span>
        {folder && <span className="workspace-label" title={state?.workspace}><Icon name="folder-open-outline" />{folder}</span>}
      </header>
      {isEmpty ? <div className="hero-workbench">
        <div className={hero.stack}><h1 className={hero.headline}>Everpeace</h1></div>
        {composer(true)}
        {status()}
      </div> : <>
        <div ref={transcript} className="transcript" role="log" aria-live="off" onScroll={event => {
          const view = event.currentTarget;
          shouldFollow.current = view.scrollHeight - view.clientHeight - view.scrollTop < 72;
        }}>
          <div className="messages">
            {messages.map((entry, index) => <Message key={`${sessionId}:${index}`} entry={entry} toolLabel={text.tool} />)}
            {turn?.tools.map(tool => <ToolCard key={tool.id} name={tool.name} status={text.running} />)}
            {turn?.delta && <Assistant text={turn.delta} />}
          </div>
        </div>
        <div className="composer-dock">
          {status()}
          {turn?.interaction && <Interaction key={turn.interaction.id} request={turn.interaction} disabled={busy || turn.stopping}
            text={text} answer={answer => void perform("answer", { turnId: turn.id, requestId: turn.interaction!.id, answer })} />}
          {composer(false)}
        </div>
      </>}
    </main>
  </div>;

  function status() {
    const notice = feedback ?? (expired ? text.linkRequired : !connected ? (state ? text.reconnecting : text.connecting)
      : !state?.models.length ? text.register : undefined);
    return notice && <div className={`connection-note${error || state?.blocked ? " error" : ""}`} role="status">{notice}</div>;
  }

  function composer(centered: boolean) {
    const canSend = !busy && !!state?.modelId && state.models.some(model => model.id === state.modelId) && !state.blocked;
    const providers = new Map<string, WebModel[]>();
    for (const model of state?.models ?? []) {
      const group = providers.get(model.provider);
      if (group) group.push(model);
      else providers.set(model.provider, [model]);
    }
    return <form className={`${input.root} ${centered ? input.hero : ""}`} onSubmit={(event: FormEvent) => { event.preventDefault(); void send(); }}>
      <div className={input.card}>
        <textarea className={`${input.input} draft`} aria-label={text.message} rows={centered ? 2 : 1}
          maxLength={28_000} placeholder={text.message} value={draft}
          disabled={!!turn?.interaction || expired || state?.blocked} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (canSend) void send();
          }} />
        <div className={input.row}>
          {turn && <span className="running-indicator" role="status">{turn.stopping ? text.stopping : text.running}</span>}
          <div className={input.trailing}>
            <select className={input.select} aria-label={text.model} disabled={navigatingDisabled || !state?.models.length}
              value={state?.modelId ?? ""} onChange={event => void perform("model", { modelId: event.target.value, sessionId: state?.sessionId ?? null })}>
              {!state?.modelId && <option value="">{text.model}</option>}
              {state?.modelId && !state.models.some(model => model.id === state.modelId) &&
                <option value={state.modelId}>{text.unavailable}</option>}
              {[...providers].map(([provider, models]) => <optgroup key={provider} label={provider}>
                {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
              </optgroup>)}
            </select>
            {turn ? <button type="button" className={input.primary} aria-label={text.stop} title={text.stop}
              disabled={busy || turn.stopping} onClick={() => stop(turn)}><Icon name="stop-fill" /></button>
              : <button type="submit" className={input.primary} aria-label={text.send} title={text.send}
                disabled={!canSend || !draft.trim()}><Icon name="send-outline" /></button>}
          </div>
        </div>
      </div>
    </form>;
  }
}

createRoot(document.getElementById("app")!).render(<Workbench />);
