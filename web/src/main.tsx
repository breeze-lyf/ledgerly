import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
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
  data: string;
  timeline?: any[];
};
function App() {
  const [health, H] = useState<any>({});
  const [loading, Loading] = useState(true);
  const [rows, R] = useState<Invoice[]>([]);
  const [selected, S] = useState<Invoice | null>(null);
  const [messages, M] = useState<any[]>([]);
  const [input, I] = useState("");
  const [busy, B] = useState(false);
  const [error, E] = useState("");
  const [mode, Mode] = useState("fallback");
  const [dark, D] = useState(false);
  async function refresh() {
    const r = await api("invoices");
    R(r);
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
    stream.onmessage = () => {
      refresh().catch(() => {});
    };
    return () => stream.close();
  }, []);
  useEffect(() => {
    if (selected)
      api("invoices/" + selected.id)
        .then(S)
        .catch((e) => E(e.message));
  }, [rows]);
  useEffect(() => {
    document
      .querySelector(".conversation")
      ?.scrollTo({ top: 999999, behavior: "smooth" });
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
        await send("Draft a friendly reminder for " + selected.id);
        return;
      }
      if (name === "paid")
        await api("dev/simulate-webhook", {
          event_type: "INVOICING.INVOICE.PAID",
          resource_id: selected.id,
        });
      else {
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
  if (mockId)
    return (
      <div className="checkout">
        <div className="brand">
          ◈ Ledgerly <span>× PayPal</span>
        </div>
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
  const outstanding = rows.filter((i) =>
    ["DRAFT", "SENT", "PARTIALLY_PAID"].includes(i.status),
  );
  const paidRows = rows.filter(
    (i) =>
      i.status === "PAID" &&
      i.paid_at?.slice(0, 7) === new Date().toISOString().slice(0, 7),
  );
  return (
    <div className={dark ? "app dark" : "app"} aria-busy={busy}>
      <header>
        <a className="brand" href={base}>
          <span className="logo">↗</span> Ledgerly
          <span className="beta">EARLY ACCESS</span>
        </a>
        <div className="header-right">
          <span className="mode">
            <i /> PayPal: {health.paypalMode || "…"}
          </span>
          <span className="mode">
            ✦ AI:{" "}
            {mode === "llm" ? "LLM" : health.llm ? "LLM ready" : "fallback"}
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
        <section className="stats">
          <div>
            <span>Outstanding · USD</span>
            <strong>
              {money(
                outstanding
                  .filter((i) => i.currency === "USD")
                  .reduce((s, i) => s + i.amount, 0),
              )}
            </strong>
            <small>
              {outstanding.length} open invoices across all currencies
            </small>
          </div>
          <div>
            <span>Paid this month · USD</span>
            <strong>
              {money(
                paidRows
                  .filter((i) => i.currency === "USD")
                  .reduce((s, i) => s + i.amount, 0),
              )}
              <em>↗</em>
            </strong>
            <small>{paidRows.length} invoices paid this month</small>
          </div>
          <div className="stat-note">
            <div className="spark">✦</div>
            <div>
              <b>Your admin, on autopilot.</b>
              <p>
                You do the work.
                <br />
                Ledgerly handles the paperwork.
              </p>
            </div>
          </div>
        </section>
        <div className="workspace">
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
                            {c.name === "refund"
                              ? `Refund ${c.args.amount || "remaining balance"}`
                              : `Send ${c.args.invoice_ids?.length || 1} draft invoice(s)`}
                          </p>
                          <button
                            disabled={busy}
                            onClick={() =>
                              cardAction(`actions/${c.id}/confirm`)
                            }
                          >
                            Confirm
                          </button>{" "}
                          <button
                            disabled={busy}
                            className="secondary"
                            onClick={() => cardAction(`actions/${c.id}/cancel`)}
                          >
                            Cancel
                          </button>
                        </div>
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
                              })
                            }
                          >
                            Send reminder
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
                      ) : c.client ? (
                        <button
                          className="chat-card"
                          key={j}
                          onClick={() =>
                            api("invoices/" + c.id)
                              .then(S)
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
                  "Invoice Acme $800/month maintenance for 3 months",
                  "Who hasn't paid this month?",
                  "Send a reminder to Acme",
                  "Refund $200 to Acme",
                ].map((p, n) => (
                  <button key={p} disabled={busy} onClick={() => send(p)}>
                    {
                      [
                        "＋ Invoice Acme",
                        "◷ Unpaid invoices",
                        "↗ Remind Acme",
                        "↶ Refund $200",
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
                  <span className={"badge " + selected.status}>
                    {selected.status.replaceAll("_", " ")}
                  </span>
                  <h2>{selected.client}</h2>
                  <strong>{money(selected.amount, selected.currency)}</strong>
                  <p>Due {selected.due_date}</p>
                  <code>{selected.id}</code>
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
                      {health.paypalMode === "mock" && (
                        <button disabled={busy} onClick={() => act("paid")}>
                          Simulate paid
                        </button>
                      )}
                    </>
                  )}
                  {["PAID", "PARTIALLY_PAID"].includes(selected.status) && (
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
                          .then(S)
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
                        <span className={"badge " + i.status}>
                          {i.status.replaceAll("_", " ")}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
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
createRoot(document.getElementById("root")!).render(<App />);
