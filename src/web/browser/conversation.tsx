import { memo, useState, type ReactNode } from "react";
import { Marked, Renderer } from "marked";
import type { WebInteraction, WebMessage } from "../protocol.js";
import type { Copy } from "./copy.js";
import { artwork } from "./upstream/icons.js";
import { Button } from "./upstream/Button.js";
import { UserMessageBubble } from "./upstream/UserMessageBubble.js";
import approval from "./upstream/ApprovalPanel.module.css";
import markdown from "./upstream/AssistantMarkdown.module.css";
import row from "./upstream/ToolRow.module.css";
import details from "./upstream/ToolDetails.module.css";

export function Icon({ name }: { name: keyof typeof artwork }) {
  // These assets are static MIT-licensed artwork. Conversation text never enters this markup.
  return <span className="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: artwork[name].svg(1.3) }} />;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.image = ({ text }) => escapeHtml(text);
renderer.link = function ({ href, tokens }) {
  const label = this.parser.parseInline(tokens);
  let url: URL;
  try { url = new URL(href); } catch { return label; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return label;
  return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
};
const marked = new Marked({ renderer });

export const Assistant = memo(function Assistant({ text }: { text: string }) {
  const body = marked.parse(text, { async: false });
  return <article className={markdown.root}><div className="markdown" dangerouslySetInnerHTML={{ __html: body }} /></article>;
});

export function ToolCard({ name, output, status }: { name: string; output?: string; status?: string }) {
  const label = <>
    <Icon name="code-outline" /><span className={row.title}>{name}</span>
    {status && <><span className={row.sep} /><span className={row.summary}>{status}</span></>}
  </>;
  if (output === undefined) return <div className="tool-line tool-running">{label}</div>;
  let content = output;
  try { content = JSON.stringify(JSON.parse(output), null, 2); }
  catch { /* Tool output can be plain text or a truncated JSON result. */ }
  return <details className={row.root}>
    <summary className="tool-line">{label}<span className="tool-chevron"><Icon name="chevron-right-outline" /></span></summary>
    <div className={details.root}><pre className="tool-output">{content}</pre></div>
  </details>;
}

export const Message = memo(function Message({ entry, toolLabel }: { entry: WebMessage; toolLabel: string }) {
  if (entry.webTurnOutcome || entry.webSkillName) return null;
  if (entry.kind === "assistant") return <Assistant text={entry.text} />;
  if (entry.kind === "user") return <div className="user-row"><UserMessageBubble>{entry.text}</UserMessageBubble></div>;
  if (entry.kind === "tool") {
    const newline = entry.text.indexOf("\n");
    return newline === -1 ? <ToolCard name={toolLabel} status={entry.text} output={entry.text} />
      : <ToolCard name={entry.text.slice(0, newline)} output={entry.text.slice(newline + 1)} />;
  }
  if (entry.kind === "output") return <ToolCard name={toolLabel} output={entry.text} />;
  return <div className={entry.kind === "error" ? "run-note error" : "run-note"}>{entry.text}</div>;
});

// The card layout comes from DeepSeek Harness ApprovalCard. The caller owns
// the request identity, abort lifetime and one-shot decision on the server.
function DecisionCard({ title, label, children, actions }: {
  title?: string;
  label: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return <section className={approval.root} aria-label={label}>
    <div className={approval.card}>
      <div className={approval.strip}><span className="warning-dot" />{label}</div>
      <div className={approval.body}>
        {title && <div className={approval.headline}>{title}</div>}
        {children}
      </div>
      <div className={approval.actionRow}>{actions}</div>
    </div>
  </section>;
}

export function Interaction({ request, disabled, answer, text }: {
  request: WebInteraction;
  disabled: boolean;
  answer(value: boolean | Record<string, string>): void;
  text: Copy;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  if (request.kind === "approval") {
    return <DecisionCard title={request.tool} label={text.approval} actions={<>
      <Button variant="outline" className={approval.reject} disabled={disabled} onClick={() => answer(false)}>{text.deny}</Button>
      <Button variant="primary" disabled={disabled} onClick={() => answer(true)}>{text.allow}</Button>
    </>}><pre className="approval-command">{request.prompt}</pre></DecisionCard>;
  }
  if (request.kind !== "question") return null;
  return <form onSubmit={event => { event.preventDefault(); answer(values); }}>
    <DecisionCard label={text.question} actions={
      <Button type="submit" variant="primary" disabled={disabled || request.questions.some(({ id }) => !Object.hasOwn(values, id) || !values[id]?.trim())}>{text.answer}</Button>
    }>
      {request.questions.map(question => <fieldset key={question.id} className="question">
        <legend>{question.question}</legend>
        <div className="question-options">
          {question.options.map(option => <Button key={option.label} size="sm" variant={values[question.id] === option.label ? "primary" : "outline"}
            title={option.description} aria-pressed={values[question.id] === option.label}
            disabled={disabled} onClick={() => setValues(previous => ({ ...previous, [question.id]: option.label }))}>{option.label}</Button>)}
        </div>
        <input aria-label={`${text.customAnswer} — ${question.header}`} placeholder={text.customAnswer}
          maxLength={4096} disabled={disabled} value={Object.hasOwn(values, question.id) ? values[question.id] : ""}
          onChange={event => setValues(previous => ({ ...previous, [question.id]: event.target.value }))} />
      </fieldset>)}
    </DecisionCard>
  </form>;
}
