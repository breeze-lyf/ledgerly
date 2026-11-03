import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { PayPage, AutopilotPanel, FinancePanel, OutcomesStrip, RetainersPanel, describeAction } from "./extras";
declare global {
  interface Window {
    __BASE_PATH__: string;
  }
}
const session = localStorage.getItem("ledgerly-session") || crypto.randomUUID();
localStorage.setItem("ledgerly-session", session);
const base = window.__BASE_PATH__ || import.meta.env.BASE_URL;
async function api(path: string, body?: unknown) {
  const r = await fetch(
    base + "api/" + path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(body as any), session_id: session }),
        },
  );
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Request failed");
  return d;
}
const money = (n: number, c = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n);
type Invoice = {
  id: string;
  client: string;
  amount: number;
  currency: string;
  status: string;
  due_date: string;
  created_at: string;
  paid_at?: string;
  paid_amount?: number;
  data: string;
  timeline?: any[];
};
function App() {
  const [cash, Cash] = useState<any>({});
  const [health, H] = useState<any>({});
  const [loading, Loading] = useState(true);
  const [sideTab, SideTab] = useState("invoices");
  const [orders, Orders] = useState<any[]>([]);
  const [rows, R] = useState<Invoice[]>([]);
  const [selected, S] = useState<Invoice | null>(null);
  const [messages, M] = useState<any[]>([]);
  const [input, I] = useState("");
  const [busy, B] = useState(false);
  const [error, E] = useState("");
  const [mode, Mode] = useState("fallback");
  const [panel, Panel] = useState("chat");
  const [completed, Completed] = useState<string[]>([]);
  const [dark, D] = useState(false);
  const [tick, Tick] = useState(0);
  const [toast, Toast] = useState("");
  const [flash, Flash] = useState("");
  function switchPanel(next: string) {
    Panel(next);
    if (window.matchMedia("(max-width: 850px)").matches)
      requestAnimationFrame(() => document.querySelector(".mobile-tabs")?.scrollIntoView({ block: "start" }));
  }
  async function refresh() {
    const r = await api("invoices");
    R(r);
    Orders(await api("orders"));
    Cash(await api("cashflow"));
    Loading(false);
  }
  useEffect(() => {
    api("health")
      .then(H)
      .catch((e) => E(e.message));
    refresh().catch((e) => E(e.message));
    api("messages?session_id=" + session)
      .then(M)
      .catch(() => {});
    const stream = new EventSource(base + "api/stream");
    stream.onmessage = (m) => {
      Tick((t) => t + 1);
      try {
        const e = JSON.parse(m.data);
        if (/PAID_VIA_PAYPAL|INVOICING\.INVOICE\.PAID|SYNC\.PAID/.test(e.event_type || "")) {
          Toast("💸 Payment received via PayPal" + (e.data?.amount ? " · " + money(Number(e.data.amount), e.data.currency || "USD") : ""));
          Flash(e.invoice_id || "");
          setTimeout(() => Toast(""), 6000);
        }
      } catch { /* heartbeat */ }
      refresh().catch(() => {});
    };
    return () => stream.close();
  }, []);
  useEffect(() => {
    if (selected)
      api("invoices/" + selected.id)
        .then((i) => { S(i); switchPanel("invoices"); })
        .catch((e) => E(e.message));
  }, [rows]);
  useEffect(() => {
    document
      .querySelector(".conversation")
      ?.scrollTo({ top: 999999, behavior: "instant" });
  }, [messages, busy]);
  async function send(text = input) {
    if (!text.trim() || busy) return;
    I("");
    E("");
    M((m) => [...m, { role: "user", content: text }]);
    B(true);
    try {
      const d = await api("chat", { message: text });
      M((m) => [
        ...m,
        {
          role: "assistant",
          content: d.reply,
          cards: d.cards,
          traces: d.traces,
          notice: d.notice,
        },
      ]);
      Mode(d.mode);
      await refresh();
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  }
  async function act(name: string) {
    if (!selected) return;
    B(true);
    E("");
    try {
      if (name === "remind") {
        B(false);
        switchPanel("chat");
        await send("Draft a friendly reminder for " + selected.id);
        return;
      }
      if (name === "paid")
        await api("dev/simulate-webhook", {
          event_type: "INVOICING.INVOICE.PAID",
          resource_id: selected.id,
        });
      else {
        switchPanel("chat");
        const cards = await api("invoices/" + selected.id + "/" + name, {});
        M((m) => [
          ...m,
          { role: "assistant", content: "Review the details below.", cards },
        ]);
      }
      await refresh();
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  }
  async function cardAction(path: string, body: any = {}) {
    B(true);
    E("");
    try {
      const d = await api(path, body);
      Mode(d.mode || "system");
      Completed((ids) => [...ids, path.split("/")[1]]);
      M((m) => [
        ...m,
        {
          role: "assistant",
          content: "Action completed.",
          cards: d.cards || d,
        },
      ]);
      await refresh();
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  }
  const mockId = location.pathname.match(/\/mock-pay\/([^/]+)/)?.[1];
  const [paid, P] = useState(false);
  if (mockId && health.paypalMode === "mock")
    return (
      <div className="checkout">
        <div className="brand">
          <img className="logo-img" src={base + "ledgerly-mark.svg"} alt="" width={35} height={35} /> Ledgerly <span>× PayPal</span>
        </div>
        {paid && (
          <img className="paid-seal" src={base + "ledgerly-seal.svg"} alt="Paid" width={120} height={120} />
        )}
        <h1>
          A little payment.
          <br />A big thank you.
        </h1>
        <p>This is a simulated checkout. No money will move.</p>
        <button
          disabled={paid || busy}
          onClick={async () => {
            B(true);
            try {
              await api("mock-pay/" + mockId, {});
              P(true);
            } catch (e) {
              E((e as Error).message);
            } finally {
              B(false);
            }
          }}
        >
          {paid ? "✓ Payment complete" : "Pay now"}
        </button>
        <p>{error}</p>
        <a href={base}>Back to Ledgerly →</a>
      </div>
    );
  return (
    <div className={dark ? "app dark" : "app"} aria-busy={busy}>
      <header>
        <a className="brand" href={base}>
          <img className="logo-img" src={base + "ledgerly-mark.svg"} alt="" width={35} height={35} /> Ledgerly
          <span className="beta">EARLY ACCESS</span>
        </a>
        <div className="header-right">
          <span className="mode">
            <i /> PayPal: {health.paypalMode || "…"}
          </span>
          <span className="mode">
            ✦ AI:{" "}
            {mode === "system" ? "System" : mode === "llm" ? "LLM" : health.llm ? "LLM ready" : "fallback"}
          </span>
          <button
            className="icon"
            onClick={() => D(!dark)}
            aria-label="Toggle theme"
          >
            {dark ? "☀" : "☾"}
          </button>
          <span className="avatar">BL</span>
        </div>
      </header>
      <main>
        <section className="intro">
          <div>
            <div className="eyebrow">YOUR FREELANCE FINANCES, SIMPLIFIED</div>
            <h1>Good work deserves to get paid.</h1>
            <p>Create, track, and follow up on invoices. Just ask.</p>
          </div>
          <span className="powered">
            Powered by <b>PayPal</b>
          </span>
        </section>
        <section className="stats" aria-label="Cashflow dashboard">
          {[
            ["Outstanding", cash.outstanding, "Open invoice balances"],
            ["Overdue", cash.overdue_amount, "Follow-up opportunities"],
            ["Next 7 days", cash.expected_next_7_days, "Expected by due date"],
            ["Unpaid count", cash.unpaid_count, "Sent, unpaid invoices"],
          ].map(([label,value,note],n) => <div key={label}><span>{label}{n<3 ? " · USD" : " · USD invoices"}</span><strong>{value === undefined ? "—" : n===3 ? value : money(Number(value))}</strong><small>{note}</small></div>)}
        </section>
        <p className="cashflow-caption">Local PayPal mirror · Received this month: {money(cash.received_this_month || 0)} USD · Forecasts use invoice due dates.</p>
        <OutcomesStrip tick={tick} />
        {toast && <div className="toast" role="status">{toast}</div>}
        <nav className="mobile-tabs" aria-label="Workspace panels">
          <button aria-pressed={panel === "chat"} onClick={() => switchPanel("chat")}>Chat</button>
          <button aria-pressed={panel === "invoices"} onClick={() => switchPanel("invoices")}>Invoices</button>
        </nav>
        <div className={"workspace show-" + panel}>
          <section className="chat panel">
            <div className="panel-heading">
              <div>
                <span className="assistant-icon">✦</span>
                <b>Ledgerly assistant</b>
              </div>
              <span className="online">● Ready to help</span>
            </div>
            <div className="conversation">
              <div className="welcome">
                <div className="welcome-symbol">✦</div>
                <h2>Less chasing. More creating.</h2>
                <p>
                  Tell me who to invoice, what for, and how much.
                  <br />
                  I’ll take it from there.
                </p>
              </div>
              {messages.map((m, n) => (
                <div key={n} className={"message " + m.role}>
                  {m.role === "assistant" && (
                    <span className="mini-logo">✦</span>
                  )}
                  <div>
                    <div className="bubble">{m.content}</div>
                    {m.notice && (
                      <p role="status" className="notice">
                        {m.notice}
                      </p>
                    )}
                    {m.traces?.map((t: any, k: number) => (
                      <small className="tool-chip" key={k}>
                        {t.source === "paypal-agent-toolkit"
                          ? "PayPal Agent Toolkit"
                          : "Ledgerly"}{" "}
                        · {t.tool} · {t.executor}
                      </small>
                    ))}
                    {m.cards?.map((c: any, j: number) =>
                      c.kind === "pending_action" ? (
                        <div className="chat-card" key={j}>
                          <b>{c.label}</b>
                          <p>
                            {describeAction(c.name, c.args)}
                          </p>
                          <button
                            disabled={busy || completed.includes(c.id)}
                            onClick={() =>
                              cardAction(`actions/${c.id}/confirm`)
                            }
                          >
                            {completed.includes(c.id) ? "Completed" : "Confirm"}
                          </button>{" "}
                          <button
                            disabled={busy || completed.includes(c.id)}
                            className="secondary"
                            onClick={() => cardAction(`actions/${c.id}/cancel`)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : c.kind === "recurring_choice" ? (
                        <div className="chat-card" key={j}><b>{c.text}</b>
                          <p>Retainer subscription: the client approves once in PayPal and is billed automatically each month. Invoice series: one invoice per month that they pay individually.</p>
                          <button disabled={busy} onClick={() => send(`Set up a retainer for ${c.args.client_name} $${c.args.amount}/month for ${c.args.months} months as a PayPal subscription${c.args.client_email ? " " + c.args.client_email : ""}`)}>Retainer subscription</button>{" "}
                          <button disabled={busy} className="secondary" onClick={() => send(`Invoice ${c.args.client_name}${c.args.client_email ? " " + c.args.client_email : ""} $${c.args.amount} for ${c.args.months} months`)}>Invoice series</button>
                        </div>
                      ) : c.kind === "retainer" ? (
                        <div className="chat-card" key={j}><b>Retainer · {c.client} · {money(c.amount, c.currency)}/month × {c.months}</b>
                          <p>{c.status.replaceAll("_", " ")} · {c.cycles_paid}/{c.months} paid · PayPal subscription {c.subscription_id}</p>
                          {c.status === "APPROVAL_PENDING" && c.approve_url && <a href={c.approve_url} target="_blank" rel="noreferrer">Send this approval link to your client ↗</a>}
                        </div>
                      ) : c.kind === "toolkit_result" ? (
                        <div className="chat-card" key={j}><b>PayPal · {c.tool.replaceAll("_", " ")}</b>
                          <p>{c.tool === "list_disputes" ? `${(c.result.items || []).length} dispute(s)` : c.tool === "list_transactions" ? `${(c.result.transaction_details || []).length} transaction(s)` : c.result.status || "Result"}</p>
                          <details><summary>Raw response</summary><pre>{JSON.stringify(c.result, null, 2).slice(0, 3000)}</pre></details>
                        </div>
                      ) : c.kind === "collections" ? (
                        <div className="chat-card summary" key={j}>
                          <b>Collections plan · {c.rows.length} candidates</b>
                          {c.rows.map((r:any) => <p key={r.id}><b>{r.client}</b> · {money(r.outstanding,r.currency)}<br/><small>{r.id} · {r.soon_due ? "Soon due" : `${r.overdue_days} days overdue`} · Proposed tone: {r.tone}{!r.eligible ? " · Follow-up scheduled" : ""}</small></p>)}
                          {!c.rows.length && <p>No invoices need collecting right now.</p>}
                          <small>{c.description}</small>
                        </div>
                      ) : c.kind === "cashflow" ? (
                        <div className="chat-card" key={j}><b>Cashflow this month</b>{c.by_currency.map((g:any)=><p key={g.currency}>{g.currency} · Receivables {money(g.receivables_this_month,g.currency)} · Received {money(g.received_this_month,g.currency)}<br/>Overdue {money(g.overdue_amount,g.currency)} · Next 7 days {money(g.expected_next_7_days,g.currency)} · {g.unpaid_count} unpaid</p>)}<small>Client risk is heuristic. Based on the local PayPal mirror.</small></div>
                      ) : c.kind === "summary" ? (
                        <div className="chat-card summary" key={j}>
                          <b>{c.query} invoices</b>
                          <table>
                            <thead>
                              <tr>
                                <th>Client</th>
                                <th>Amount</th>
                                <th>Status</th>
                                <th>Due</th>
                              </tr>
                            </thead>
                            <tbody>
                              {c.rows.map((r: any) => (
                                <tr key={r.id}>
                                  <td>{r.client}</td>
                                  <td>{money(r.amount, r.currency)}</td>
                                  <td>{r.status}</td>
                                  <td>{r.due_date}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {!c.rows.length && <p>No matching invoices.</p>}
                          <p>
                            {Object.entries(c.totals)
                              .map(([currency, value]) =>
                                money(Number(value), currency),
                              )
                              .join(" · ")}
                          </p>
                          <small>{c.description}</small>
                        </div>
                      ) : c.kind === "draft" ? (
                        <div className="chat-card" key={j}>
                          <b>{c.subject}</b>
                          <p>{c.body}</p>
                          <button
                            disabled={busy}
                            onClick={() =>
                              cardAction(`invoices/${c.invoice_id}/remind`, {
                                subject: c.subject,
                                message: c.body,
                                tone: c.tone,
                              })
                            }
                          >
                            Review reminder
                          </button>
                        </div>
                      ) : c.kind === "payment_link" ? (
                        <a
                          key={j}
                          className="chat-card"
                          href={c.approve_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open payment link ↗
                        </a>
                      ) : c.kind === "payment" ? (
                        <div className="chat-card" key={j}><b>Payment {c.id}</b><p>{c.status} · Refunded {money(c.refunded || 0, c.currency)}</p></div>
                      ) : c.client ? (
                        <button
                          className="chat-card"
                          key={j}
                          onClick={() =>
                            api("invoices/" + c.id)
                              .then((i) => { S(i); switchPanel("invoices"); })
                              .catch((e) => E(e.message))
                          }
                        >
                          <span>▤ {c.client}</span>
                          <b>{money(c.amount, c.currency)}</b>
                          <small>
                            {c.status} · Due {c.due_date}
                          </small>
                        </button>
                      ) : c.text ? (
                        <div className="chat-card" key={j}>
                          {c.text}
                        </div>
                      ) : null,
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <div role="status" className="thinking">
                  ✦ <span className="dots">● ● ●</span> Working on it…
                </div>
              )}
            </div>
            <div className="composer">
              <div className="chips">
                {[
                  "Invoice Acme billing@acme.example $800/month maintenance for 3 months",
                  "What needs collecting?",
                  "Run collections",
                  "Cashflow this month",
                ].map((p, n) => (
                  <button key={p} disabled={busy} onClick={() => send(p)}>
                    {
                      [
                        "＋ Invoice Acme",
                        "What needs collecting?",
                        "Run collections",
                        "Cashflow this month",
                      ][n]
                    }
                  </button>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <input
                  aria-label="Message Ledgerly"
                  placeholder="Ask Ledgerly to invoice, remind, or track a payment…"
                  value={input}
                  onChange={(e) => I(e.target.value)}
                />
                <button
                  disabled={busy || !input.trim()}
                  aria-label="Send message"
                >
                  {busy ? "◌" : "↑"}
                </button>
              </form>
              <small>
                You're in control. Draft invoices are reviewed before sending.
              </small>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
            </div>
          </section>
          <aside className="panel invoices">
            <div className="panel-heading actions"><button aria-pressed={sideTab === "finance"} onClick={() => SideTab("finance")}>Finance employee</button><button aria-pressed={sideTab === "invoices"} onClick={() => SideTab("invoices")}>Invoices</button><button aria-pressed={sideTab === "orders"} onClick={() => SideTab("orders")}>Orders & payments</button><button aria-pressed={sideTab === "autopilot"} onClick={() => SideTab("autopilot")}>Autopilot</button><button aria-pressed={sideTab === "retainers"} onClick={() => SideTab("retainers")}>Retainers</button></div>
            <div className="client-risks"><b>Client risk <small>· heuristic</small></b>
              {cash.by_currency?.flatMap((g:any)=>g.by_client).filter((c:any)=>c.outstanding>0).map((c:any)=><div key={c.client+c.currency} title={c.note}><span>{c.client} <small>{money(c.outstanding,c.currency)}</small></span><span className={"risk "+c.risk}>{c.risk}</span></div>)}
              {!cash.by_currency?.some((g:any)=>g.by_client.some((c:any)=>c.outstanding>0)) && <p>No outstanding client balances.</p>}
            </div>
            {sideTab === "invoices" && <>
            <div className="panel-heading">
              <b>
                {selected ? "Invoice details" : "Your invoices"}{" "}
                <span className="count">{rows.length}</span>
              </b>
              <button
                className="text-button"
                onClick={() => {
                  S(null);
                  refresh();
                }}
              >
                {selected ? "← All invoices" : "↻ Refresh"}
              </button>
            </div>
            {selected ? (
              <div className="details">
                <div className="detail-top">
                  <span className={"badge " + selected.status + (flash === selected.id ? " flash" : "")}>
                    {selected.status.replaceAll("_", " ")}
                  </span>
                  <h2>{selected.client}</h2>
                  <strong>{money(selected.amount, selected.currency)}</strong>
                  <p>Due {selected.due_date}</p>
                  <code>{selected.id}</code>
                  {(selected as any).pay_link && selected.status !== "DRAFT" && <div className="paylink"><span>Client pay link:</span><a href={(selected as any).pay_link} target="_blank" rel="noreferrer">Open pay page ↗</a><button className="text-button" onClick={() => navigator.clipboard.writeText((selected as any).pay_link).catch(() => E("Could not copy link"))}>Copy</button></div>}
                </div>
                <div className="actions">
                  {selected.status === "DRAFT" && (
                    <button disabled={busy} onClick={() => act("send")}>
                      Review send ↗
                    </button>
                  )}
                  {["SENT", "PARTIALLY_PAID"].includes(selected.status) && (
                    <>
                      <button disabled={busy} onClick={() => act("remind")}>
                        Send reminder
                      </button>
                      <button disabled={busy} onClick={() => act("record-payment")}>
                        Record payment
                      </button>
                      {health.paypalMode === "mock" && (
                        <button disabled={busy} onClick={() => act("paid")}>
                          Simulate paid
                        </button>
                      )}
                    </>
                  )}
                  {["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"].includes(selected.status) && (
                    <button disabled={busy} onClick={() => act("refund")}>
                      Review full refund
                    </button>
                  )}
                  {["DRAFT", "SENT", "PARTIALLY_PAID"].includes(
                    selected.status,
                  ) && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => act("cancel")}
                    >
                      Cancel invoice
                    </button>
                  )}
                </div>
                <h4>ACTIVITY</h4>
                <div className="timeline">
                  {selected.timeline?.map((e) => (
                    <div key={e.id}>
                      <i />
                      <b>
                        {e.event_type
                          .replaceAll("_", " ")
                          .replaceAll(".", " · ")}
                      </b>
                      <small>
                        {new Date(
                          e.created_at +
                            "Z".repeat(!e.created_at.endsWith("Z") ? 1 : 0),
                        ).toLocaleString()}
                      </small>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="invoice-list">
                {loading ? (
                  <div className="skeleton">
                    Loading invoices…
                    <p />
                    <p />
                    <p />
                  </div>
                ) : rows.length === 0 ? (
                  <div className="empty">
                    <span>▤</span>
                    <h3>A fresh start.</h3>
                    <p>
                      Your first invoice is one message away.
                      <br />
                      Try “Invoice Acme $800”.
                    </p>
                  </div>
                ) : (
                  rows.map((i) => (
                    <button
                      className="invoice-row"
                      key={i.id}
                      onClick={() =>
                        api("invoices/" + i.id)
                          .then((i) => { S(i); switchPanel("invoices"); })
                          .catch((e) => E(e.message))
                      }
                    >
                      <span className="client-icon">
                        {i.client.slice(0, 1)}
                      </span>
                      <div>
                        <b>{i.client}</b>
                        <small>Due {i.due_date}</small>
                      </div>
                      <div className="invoice-amount">
                        <b>{money(i.amount, i.currency)}</b>
                        <span className={"badge " + i.status + (flash === i.id ? " flash" : "")}>
                          {i.status.replaceAll("_", " ")}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
            </>}
            {sideTab === "finance" && <FinancePanel tick={tick} onError={E} />}
            {sideTab === "autopilot" && <AutopilotPanel tick={tick} onError={E} />}
            {sideTab === "retainers" && <RetainersPanel tick={tick} onError={E} onCards={(cards) => M((m) => [...m, { role: "assistant", content: "Review the retainer, then confirm or cancel. Nothing is created at PayPal until you confirm.", cards }])} />}
            {sideTab === "orders" && <div className="details order-list">
              <h3>Orders & payments <span className="count">{orders.length}</span></h3>
              {!orders.length && <p>No payment links yet.</p>}
              {orders.map(o => <div className="chat-card" key={o.id}>
                <b>{o.description}</b><p>{money(o.amount, o.currency)} <span className={"badge " + o.status}>{o.status}</span></p>
                <code>{o.id}</code>
                {o.capture_id && <p>Payment {o.capture_id} · {o.payment?.status}</p>}
                {o.refunded > 0 && <p>Refunded {money(o.refunded, o.currency)}</p>}
                <div className="actions">
                  {o.approve_url && <><a href={o.approve_url} target="_blank" rel="noreferrer">Approve ↗</a><button onClick={() => navigator.clipboard.writeText(o.approve_url).catch(() => E("Could not copy link"))}>Copy approval link</button></>}
                  {o.capture_id && o.amount > o.refunded && <button disabled={busy} onClick={() => {
                    const value = window.prompt("Refund amount (confirmation follows)", (o.amount - o.refunded).toFixed(2));
                    if (value !== null) {
                      const amount = Number(value);
                      if (!Number.isFinite(amount) || amount <= 0) { E("Enter a positive refund amount"); return; }
                      cardAction(`orders/${o.id}/refund`, { amount });
                    }
                  }}>Refund</button>}
                </div>
                <details><summary>Payment timeline</summary>{o.timeline.map((e: any) => <p key={e.id}>{e.event_type} · {e.created_at}</p>)}</details>
              </div>)}
            </div>}
            <div className="panel-foot">
              ♧ Connected to PayPal · Updates in real time
            </div>
          </aside>
        </div>
        <footer>
          LEDGERLY <span>Built for independent minds.</span>
          <span>PayPal AI Hackathon · 2026</span>
        </footer>
      </main>
    </div>
  );
}
const payMatch = location.pathname.slice(base.length - 1).match(/^\/pay\/([^/]+)/);
createRoot(document.getElementById("root")!).render(payMatch ? <PayPage refId={decodeURIComponent(payMatch[1])} /> : <App />);
