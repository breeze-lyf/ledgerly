import React, { useEffect, useRef, useState } from "react";
const base = (window as any).__BASE_PATH__ || import.meta.env.BASE_URL;
async function api(path: string, body?: unknown) {
  const r = await fetch(base + "api/" + path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Request failed");
  return d;
}
const money = (n: number, c = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(n || 0);
const when = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").toLocaleString();

/** Public client pay page: PayPal JS SDK Smart Buttons (sandbox) → Orders v2 → capture. */
export function PayPage({ refId }: { refId: string }) {
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState("");
  const [state, setState] = useState("loading");
  const box = useRef<HTMLDivElement>(null);
  const load = () => api("pay/" + encodeURIComponent(refId)).then((d) => { setInfo(d); setState(d.payable ? "ready" : "done"); }).catch((e) => { setError(e.message); setState("error"); });
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (state !== "ready" || !info?.paypal?.client_id || !box.current) return;
    const id = "paypal-sdk";
    const render = () => {
      const paypal = (window as any).paypal;
      if (!paypal || !box.current) return;
      box.current.innerHTML = "";
      paypal.Buttons({
        style: { layout: "vertical", shape: "rect", label: "pay" },
        createOrder: async () => (await api(`pay/${encodeURIComponent(refId)}/order`, {})).id,
        onApprove: async (data: any) => {
          setState("capturing");
          try { const d = await api(`pay/${encodeURIComponent(refId)}/capture`, { order_id: data.orderID }); setInfo(d); setState("paid"); }
          catch (e: any) { setError(e.message); setState("ready"); }
        },
        onError: (e: any) => setError(String(e?.message || e)),
      }).render(box.current);
    };
    if (document.getElementById(id)) { render(); return; }
    const s = document.createElement("script");
    s.id = id;
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(info.paypal.client_id)}&currency=${info.currency}&intent=capture&components=buttons&enable-funding=card`;
    s.onload = render; s.onerror = () => setError("Could not load PayPal checkout");
    document.head.appendChild(s);
  }, [state, info]);
  async function mockPay() {
    setState("capturing");
    const o = await api(`pay/${encodeURIComponent(refId)}/order`, {});
    await api("mock-pay/" + o.id, {});
    setInfo(await api("pay/" + encodeURIComponent(refId))); setState("paid");
  }
  return <div className="paypage">
    <div className="paycard">
      <div className="paybrand"><b><img className="logo-img" src={base + "ledgerly-mark.svg"} alt="" width={28} height={28} />LEDGERLY</b><span>Secure invoice payment · PayPal {info?.paypal?.mode === "mock" ? "mock" : "sandbox"}</span></div>
      {state === "loading" && <p>Loading invoice…</p>}
      {state === "error" && <p className="payerror">{error}</p>}
      {info && <>
        <p className="muted">Invoice {info.invoice_number || info.invoice_id} · for {info.client}</p>
        <h1>{money(info.payable ? info.balance : info.amount, info.currency)}</h1>
        <p className="muted">{info.status === "PAID" ? "Paid in full" : `Due ${info.due_date}`}{info.balance !== info.amount && info.status !== "PAID" ? ` · of ${money(info.amount, info.currency)}` : ""}</p>
        {info.items?.length > 0 && <table className="payitems"><tbody>{info.items.map((x: any, n: number) => <tr key={n}><td>{x.name}{Number(x.quantity) > 1 ? ` × ${x.quantity}` : ""}</td><td>{money(Number(x.unit_amount) * Number(x.quantity || 1), info.currency)}</td></tr>)}</tbody></table>}
        {state === "ready" && info.paypal.mode === "sandbox" && <div ref={box} className="paybuttons" />}
        {state === "ready" && info.paypal.mode === "mock" && <button className="mockpay" onClick={() => mockPay().catch((e) => setError(e.message))}>Pay (mock PayPal)</button>}
        {state === "capturing" && <p>Confirming your payment with PayPal…</p>}
        {(state === "paid" || state === "done") && info.status === "PAID" && <img className="paid-seal" src={base + "ledgerly-seal.svg"} alt="Paid" width={120} height={120} />}
        {(state === "paid" || state === "done") && <div className={"paydone " + info.status}><b>{info.status === "PAID" ? "✓ Payment received — thank you!" : `Invoice status: ${info.status.replaceAll("_", " ")}`}</b><p>{info.status === "PAID" ? "PayPal confirmed the capture; the freelancer's dashboard updated instantly." : "This invoice can't be paid online right now."}</p></div>}
        {error && state !== "error" && <p className="payerror">{error}</p>}
        <p className="paynote">Sandbox demo — no real money moves. Log in with a PayPal sandbox <i>personal</i> account or use a sandbox test card.</p>
      </>}
    </div>
  </div>;
}

export function OutcomesStrip({ tick }: { tick: number }) {
  const [o, setO] = useState<any>(null);
  useEffect(() => { api("outcomes").then(setO).catch(() => {}); }, [tick]);
  if (!o) return null;
  const rec = Object.entries(o.recovered_after_reminder || {}).map(([c, v]) => money(v as number, c)).join(" + ") || money(0);
  return <section className="outcomes" aria-label="Measured outcomes">
    <div><span>Avg days sent → paid</span><strong>{o.avg_days_sent_to_paid ?? "—"}</strong><small>{o.days_to_paid_sample} paid invoice(s)</small></div>
    <div><span>Recovered after reminder</span><strong>{rec}</strong><small>{o.paid_after_reminder} of {o.reminded_invoices} reminded paid</small></div>
    <div><span>Paid via PayPal checkout</span><strong>{money(o.paid_via_paypal_checkout.amount)}</strong><small>{o.paid_via_paypal_checkout.count} capture(s) on the pay page</small></div>
    <div><span>On-time rate</span><strong>{o.on_time_rate === null ? "—" : o.on_time_rate + "%"}</strong><small>Autopilot reminders: {o.autopilot_reminders_sent}</small></div>
  </section>;
}

export function AutopilotPanel({ tick, onError }: { tick: number; onError: (m: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const load = () => api("autopilot").then((x) => { setD(x); setDraft((p: any) => p || x.policy); }).catch((e) => onError(e.message));
  useEffect(() => { load(); }, [tick]);
  if (!d) return <div className="details"><p>Loading autopilot…</p></div>;
  const p = d.policy;
  const save = async (patch: any) => { setBusy(true); try { const np = await api("autopilot/policy", patch); setDraft(np); await load(); } catch (e: any) { onError(e.message); } finally { setBusy(false); } };
  const num = (k: string, label: string, hint = "") => <label className="apfield">{label}<input type="number" value={draft?.[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /><small>{hint}</small></label>;
  return <div className="details autopilot">
    <div className="aphead">
      <div><h3>Collections autopilot</h3><small>Scans → checks guardrails → LLM writes the note → sends via PayPal remind API → logs every decision.</small></div>
      <button className={"aptoggle " + (p.enabled ? "on" : "off")} disabled={busy} onClick={() => save({ enabled: !p.enabled })}>{p.enabled ? "● ON" : "○ OFF"}</button>
    </div>
    <div className="apgrid">
      {num("approval_threshold", "Human approval above ($)", "Larger balances wait for you")}
      {num("max_reminders_per_invoice", "Max reminders / invoice")}
      {num("max_reminders_per_run", "Max sends / run")}
      {num("max_reminders_per_day", "Max sends / 24h")}
      {num("min_days_between", "Min days between")}
      {num("interval_minutes", "Run every (min)")}
      {num("quiet_start", "Quiet from (hour)")}
      {num("quiet_end", "Quiet until (hour)", "Client time · " + p.timezone)}
    </div>
    <div className="actions">
      <button disabled={busy} onClick={() => save(draft)}>Save guardrails</button>
      <button disabled={busy} className="secondary" onClick={async () => { setBusy(true); try { await api("autopilot/run", {}); await load(); } catch (e: any) { onError(e.message); } finally { setBusy(false); } }}>{busy ? "Running…" : "Run once now"}</button>
    </div>
    {d.approvals.length > 0 && <><h4>WAITING FOR YOUR APPROVAL</h4>{d.approvals.map((a: any) => <div className="chat-card approval" key={a.activity_id}>
      <b>{a.client} · {money(a.amount, a.currency)} · {a.tone}</b><p><i>{a.subject}</i></p><p>{a.message}</p><small>Written by {a.author} · above {money(a.threshold)} threshold</small>
      <div className="actions"><button disabled={busy} onClick={async () => { setBusy(true); try { await api("autopilot/approvals/" + a.activity_id, {}); await load(); } catch (e: any) { onError(e.message); } finally { setBusy(false); } }}>Approve & send</button>
      <button className="secondary" disabled={busy} onClick={() => api("autopilot/approvals/" + a.activity_id, { decision: "reject" }).then(load)}>Reject</button></div>
    </div>)}</>}
    <McpApprovals tick={tick} onError={onError} />
    <h4>AGENT ACTIVITY</h4>
    <div className="aplog">
      {!d.activity.length && <p>No autopilot runs yet.</p>}
      {d.activity.map((a: any) => <div key={a.id} className={"aprow " + a.kind + (a.decision.startsWith("sent") ? " sent" : a.decision.startsWith("needs") ? " hold" : "")}>
        <small>{when(a.created_at)}</small>
        <b>{a.detail.client ? `${a.detail.client}: ` : ""}{a.decision}</b>
        {a.detail.message && <details><summary>{a.detail.subject || "Message"} · {a.detail.author}</summary><p>{a.detail.message}</p>{a.detail.pay_link && <p><a href={a.detail.pay_link} target="_blank" rel="noreferrer">{a.detail.pay_link}</a></p>}</details>}
      </div>)}
    </div>
  </div>;
}

/** Actions proposed by external agents over MCP; nothing moves until a human confirms here. */
export function McpApprovals({ tick, onError }: { tick: number; onError: (m: string) => void }) {
  const [d, setD] = useState<any>(null);
  const load = () => api("mcp/pending").then(setD).catch((e) => onError(e.message));
  useEffect(() => { load(); }, [tick]);
  if (!d) return null;
  const act = (id: string, op: string) => api(`actions/${id}/${op}`, { session_id: d.session_id }).then(load).catch((e) => onError(e.message));
  return <>
    <h4>EXTERNAL AGENT APPROVALS (MCP)</h4>
    {!d.actions.length && <p className="muted"><small>No proposals from MCP clients. {d.enabled ? "Remote MCP endpoint is on." : "Run `npm run mcp` locally to connect Claude Desktop or Cursor."}</small></p>}
    {d.actions.map((a: any) => <div className="chat-card approval" key={a.id}>
      <b>{describeAction(a.name, a.args)}</b><small>Proposed by an MCP client</small>
      <div className="actions"><button onClick={() => act(a.id, "confirm")}>Confirm</button><button className="secondary" onClick={() => act(a.id, "cancel")}>Cancel</button></div>
    </div>)}
  </>;
}
export function describeAction(name: string, a: any) {
  if (name === "create_retainer") return `Start retainer: ${a.client_name} · ${money(a.amount, a.currency)}/month × ${a.months}`;
  if (name === "cancel_retainer") return `Cancel retainer ${a.retainer_id}${a.client ? " · " + a.client : ""}`;
  if (name === "refund") return `Refund ${a.amount ? money(a.amount, a.currency) : "remaining balance"} · ${a.invoice_id || a.order_id}`;
  if (name === "remind_invoice") return `Remind ${a.invoice_id} · ${a.tone || "friendly"}`;
  return `Send ${a.invoice_ids?.length || 1} draft invoice(s)`;
}

/** Retainers = PayPal Subscriptions (Product → Plan → Subscription); client approves once, PayPal bills monthly. */
export function RetainersPanel({ tick, onError, onCards }: { tick: number; onError: (m: string) => void; onCards: (cards: any[]) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<any>({ client_name: "", client_email: "", amount: "", months: "3" });
  const [busy, setBusy] = useState(false);
  const load = () => api("retainers").then(setRows).catch((e) => onError(e.message));
  useEffect(() => { load(); }, [tick]);
  const run = async (fn: () => Promise<any>) => { setBusy(true); try { const r = await fn(); if (Array.isArray(r)) onCards(r); await load(); } catch (e: any) { onError(e.message); } finally { setBusy(false); } };
  return <div className="details retainers">
    <h3>Retainers</h3>
    <small>Monthly PayPal subscriptions. Your client approves once; PayPal bills each month and Ledgerly tracks every payment from webhooks.</small>
    <div className="apgrid">
      <label className="apfield">Client<input value={f.client_name} onChange={(e) => setF({ ...f, client_name: e.target.value })} /></label>
      <label className="apfield">Client email<input value={f.client_email} onChange={(e) => setF({ ...f, client_email: e.target.value })} /></label>
      <label className="apfield">Monthly amount ($)<input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
      <label className="apfield">Months<input type="number" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} /></label>
    </div>
    <div className="actions"><button disabled={busy || !f.client_name || !(Number(f.amount) > 0)} onClick={() => run(() => api("retainers", { ...f, amount: Number(f.amount), months: Number(f.months), client_email: f.client_email || undefined }))}>Propose retainer</button></div>
    {!rows.length && <p className="muted">No retainers yet. Try “Bill Acme $800/month for 3 months” in chat.</p>}
    {rows.map((r) => <div className={"chat-card retainer " + r.status.toLowerCase()} key={r.id}>
      <b>{r.client} · {money(r.amount, r.currency)}/month × {r.months}</b>
      <p><span className="badge">{r.status.replaceAll("_", " ")}</span> {r.cycles_paid}/{r.months} paid · collected {money(r.collected, r.currency)}{r.failed_payments ? ` · ${r.failed_payments} failed` : ""}</p>
      <small>{r.id} · PayPal subscription {r.subscription_id}</small>
      <div className="actions">
        {r.status === "APPROVAL_PENDING" && r.approve_url && <><a href={r.approve_url} target="_blank" rel="noreferrer">Client approval link ↗</a><button className="secondary" onClick={() => navigator.clipboard?.writeText(r.approve_url)}>Copy</button></>}
        <button className="secondary" disabled={busy} onClick={() => run(() => api(`retainers/${r.id}/sync`, {}))}>Sync from PayPal</button>
        {!["CANCELLED", "EXPIRED"].includes(r.status) && <button className="secondary" disabled={busy} onClick={() => run(() => api(`retainers/${r.id}/cancel`, {}))}>Cancel…</button>}
      </div>
    </div>)}
  </div>;
}

/** Finance employee: multi-step approval cards proposed from GitHub + email signals. */
const KIND: Record<string, [string, string]> = { signal: ["👀", "noticed"], plan: ["🧠", "decided"], decision: ["✅", "you approved"], step: ["⚡", "did"], hold: ["🔒", "funds"], payout: ["💸", "paid out"],
  dispute: ["🛡️", "defended"], memory: ["📒", "learned"], negotiation: ["🤝", "negotiated"], project: ["📁", "set up"], error: ["⚠️", "needs help"] };
export function FinancePanel({ tick, onError }: { tick: number; onError: (m: string) => void }) {
  const [plans, setPlans] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [log, setLog] = useState<any[]>([]);
  const [week, setWeek] = useState<any>(null);
  const [nego, setNego] = useState<Record<string, any>>({});
  const [token, setToken] = useState<{ id: string; token: string } | null>(null);
  const [busy, setBusy] = useState("");
  const load = () => Promise.all([api("finance/plans"), api("finance/projects"), api("finance/activity"), api("finance/weekly")]).then(async ([p, j, a, w]) => {
    setPlans(p); setProjects(j); setLog(a); setWeek(w);
    const n = await Promise.all(j.map((x: any) => api("finance/projects/" + x.id + "/negotiation").catch(() => null)));
    setNego(Object.fromEntries(j.map((x: any, i: number) => [x.id, n[i]])));
  }).catch((e) => onError(e.message));
  useEffect(() => { load(); }, [tick]);
  const decide = async (id: string, decision: string) => { setBusy(id); try { await api("finance/plans/" + id, { decision }); } catch (e: any) { onError(e.message); } setBusy(""); load(); };
  const issue = async (id: string) => { try { setToken({ id, ...(await api("finance/projects/" + id + "/client-token", {})) }); } catch (e: any) { onError(e.message); } };
  const icon: Record<string, string> = { done: "✓", waiting: "…", failed: "✕", pending: "○", skipped: "–" };
  const cur = (pid: string) => projects.find((p) => p.id === pid)?.currency || "USD";
  const pending = plans.filter((p) => p.status === "pending" || p.status === "failed");
  const done = plans.filter((p) => p.status === "executed").slice(0, 4);
  const total = (p: any) => p.kind === "dispute" ? `${p.dispute?.amount?.value} ${p.dispute?.amount?.currency_code}` : money(p.steps.filter((s: any) => s.type === "capture_hold" || s.type === "invoice").reduce((a: number, s: any) => a + (s.amount || 0), 0), cur(p.project_id));
  const card = (p: any) => <div key={p.id} className={"plan-card " + p.status + (p.kind === "dispute" ? " dispute" : "")}>
    {p.status === "executed" && <img className="seal" src={base + "ledgerly-seal.svg"} alt="Done" width={64} height={64} />}
    <div className="plan-head"><strong>{p.kind === "dispute" ? "🛡️ " : ""}{p.headline}</strong><span className="badge">{p.status === "pending" ? "needs your OK" : p.status}</span></div>
    <p className="muted">{projects.find((x) => x.id === p.project_id)?.title} · {Math.round(p.detection.confidence * 100)}% confident ({p.detection.method === "llm" ? "AI + rules" : "rules"})</p>
    <p>{p.detection.rationale}</p>
    {p.memory && <p className={"memory-chip " + p.memory.strategy}>📒 {p.memory.strategy === "trusted" ? "Trusted payer" : p.memory.strategy === "hold_first" ? "Hold-first client" : "Standard terms"} · {p.memory.why} · net-{p.memory.terms_days}</p>}
    {p.kind === "dispute" && <p><a href={base + "api/finance/disputes/" + p.dispute.id + "/evidence.pdf"} target="_blank" rel="noreferrer">📄 Open the evidence pack (PDF)</a></p>}
    <details><summary>Evidence I used ({p.evidence.length})</summary><ul>{p.evidence.map((e: any) => <li key={e.id}>{e.source === "github" ? "GitHub" : "Email"} · {e.title} <span className="muted">{e.actor} · {when(e.at)}</span>{e.url && <> · <a href={e.url} target="_blank" rel="noreferrer">open</a></>}</li>)}</ul></details>
    <ol className="plan-steps">{p.steps.map((s: any) => <li key={s.id} className={s.status}><span>{icon[s.status] || "○"}</span> {s.label}{s.result?.funding_link && <> · <a href={s.result.funding_link} target="_blank" rel="noreferrer">funding link</a></>}{s.error && <em className="error"> — {s.error}</em>}</li>)}</ol>
    {(p.status === "pending" || p.status === "failed") && <div className="actions">
      <button className="primary" disabled={busy === p.id} onClick={() => decide(p.id, "approve")}>{p.status === "failed" ? "Retry" : p.kind === "dispute" ? "Approve defense" : `Approve all · ${total(p)}`}</button>
      {p.status === "pending" && <button disabled={busy === p.id} onClick={() => decide(p.id, "reject")}>Reject</button>}
    </div>}
  </div>;
  const last = log[0];
  return <div className="details finance">
    <section className="colleague">
      <img src={base + "ledgerly-mark.svg"} alt="" width={44} height={44} />
      <div><strong>Ledgerly, your finance employee</strong>
        <p className="muted"><span className="live-dot" />Watching {projects.filter((p) => p.repo).length} repos and your inbox{last ? ` · last acted ${when(last.created_at)}` : ""}</p></div>
    </section>
    {week && <section className="week" title={week.assumption.note}>
      <div><b>{Object.entries(week.collected).map(([c, v]) => money(v as number, c)).join(" + ") || money(0, "USD")}</b><span>collected this week</span></div>
      <div><b>{week.ai_actions}</b><span>actions I took</span></div>
      <div><b>{week.human_approvals}</b><span>times you clicked</span></div>
      <div><b>{week.hours_saved} h*</b><span>saved (est.)</span></div>
    </section>}
    {week && <p className="muted tiny">* Estimate: {Object.entries(week.assumption.minutes_per_action).filter(([, m]) => (m as number) > 0).map(([k, m]) => `${k.replace(/_/g, " ")} ${m}m`).join(", ")}. Our assumption, not measured.</p>}
    <h4>Needs your OK {pending.length > 0 && <span className="count">{pending.length}</span>}</h4>
    {pending.length === 0 && <p className="muted">Nothing to approve. I'm watching GitHub and your inbox for delivered, client-approved work.</p>}
    {pending.map(card)}
    <h4>What I noticed and did</h4>
    <ol className="feed">{log.slice(0, 20).map((l) => { const [ic, verb] = KIND[l.kind] || ["•", l.kind]; return <li key={l.id} className={"k-" + l.kind}><span className="ic">{ic}</span><div><small>{verb} · {when(l.created_at)}</small><p>{l.message}</p></div></li>; })}</ol>
    {done.length > 0 && <><h4>Done</h4>{done.map(card)}</>}
    <h4>Projects</h4>
    <ul className="projects">{projects.map((j) => <li key={j.id}>
      <div><strong>{j.title}</strong> · {j.client} · {j.milestones.filter((m: any) => m.status === "released").length}/{j.milestones.length} milestones released · {j.hold?.status === "active" ? `${money(j.hold.amount - j.hold.captured, j.currency)} held at PayPal` : j.hold?.status ? `hold ${j.hold.status}` : <a href={base + "hold/" + j.id} target="_blank" rel="noreferrer">client funding link</a>}</div>
      {nego[j.id]?.rounds?.length > 0 && <div className="nego"><small>🤝 Agent-to-agent terms {nego[j.id].status === "agreed" ? "· agreed" : ""}</small>
        {nego[j.id].rounds.map((r: any) => <div key={r.offer_id}><p className="them">Client's agent: {r.ask.discount_pct}% off, {r.ask.deposit_pct}% held, net-{r.ask.net_days}{r.note ? ` — “${r.note}”` : ""}</p>
          <p className="us">Ledgerly: {r.reply.decision === "accepted" ? "Accepted" : "Counter"}: {r.reply.terms.discount_pct}% off, {r.reply.terms.deposit_pct}% held, net-{r.reply.terms.net_days}{r.reply.reasons.length ? ` (${r.reply.reasons.join("; ")})` : ""}</p></div>)}</div>}
      <button className="secondary" onClick={() => issue(j.id)}>Let the client's agent negotiate</button>
      {token?.id === j.id && <p className="tiny">Give this to the client's agent (MCP at <code>/mcp/client</code>): <code>{token!.token}</code></p>}
    </li>)}</ul>
  </div>;
}

/** Client hold page: PayPal JS SDK with intent=authorize. Funds are held (up to 29 days) and captured per approved milestone. */
export function HoldPage({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState("");
  const [state, setState] = useState("loading");
  const box = useRef<HTMLDivElement>(null);
  const id = encodeURIComponent(projectId);
  const load = () => api("hold/" + id).then((d) => { setInfo(d); setState(d.hold?.status === "active" || d.hold?.status === "captured" ? "held" : "ready"); }).catch((e) => { setError(e.message); setState("error"); });
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (state !== "ready" || info?.paypal?.mode !== "sandbox" || !info.paypal.client_id || !box.current) return;
    const render = () => {
      const paypal = (window as any).paypal; if (!paypal || !box.current) return;
      box.current.innerHTML = "";
      paypal.Buttons({ style: { layout: "vertical", label: "pay" },
        createOrder: async () => (await api(`hold/${id}/order`, {})).id,
        onApprove: async (data: any) => { setState("authorizing"); try { await api(`hold/${id}/authorize`, { order_id: data.orderID }); await load(); } catch (e: any) { setError(e.message); setState("ready"); } },
        onError: (e: any) => setError(String(e?.message || e)) }).render(box.current);
    };
    if (document.getElementById("paypal-sdk-auth")) { render(); return; }
    const s = document.createElement("script"); s.id = "paypal-sdk-auth";
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(info.paypal.client_id)}&currency=${info.currency}&intent=authorize&components=buttons&enable-funding=card`;
    s.onload = render; s.onerror = () => setError("Could not load PayPal checkout"); document.head.appendChild(s);
  }, [state, info]);
  async function mockHold() {
    setState("authorizing");
    try { const o = await api(`hold/${id}/order`, {}); await api("mock-pay/" + o.id, {}); await api(`hold/${id}/authorize`, { order_id: o.id }); await load(); } catch (e: any) { setError(e.message); setState("ready"); }
  }
  return <div className="paypage"><div className="paycard">
    <div className="paybrand"><b><img className="logo-img" src={base + "ledgerly-mark.svg"} alt="" width={28} height={28} />LEDGERLY</b><span>Milestone funding · PayPal {info?.paypal?.mode === "sandbox" ? "sandbox" : "mock"}</span></div>
    {state === "loading" && <p>Loading…</p>}
    {error && <p className="payerror">{error}</p>}
    {info && <>
      <p className="muted">{info.title} · for {info.client}</p>
      <h1>{money(info.amount, info.currency)}</h1>
      <p className="muted">Authorize now; you are charged only as each milestone is delivered and you approve it. The hold lasts up to 29 days, and anything not captured is released back to you. This is a PayPal payment authorization, not an escrow service.</p>
      <ul className="milestones">{info.milestones.map((m: any) => <li key={m.id}>{m.status === "released" ? "✓" : "○"} {m.title} <span>{money(m.amount, info.currency)}</span></li>)}</ul>
      {state === "held" && <p className="paid">Funds held · {money(info.hold.captured, info.currency)} captured so far</p>}
      {state === "ready" && info.paypal.mode === "sandbox" && <div ref={box} />}
      {state === "ready" && info.paypal.mode !== "sandbox" && <button className="primary" onClick={mockHold}>Authorize (mock)</button>}
      {state === "authorizing" && <p>Authorizing with PayPal…</p>}
    </>}
  </div></div>;
}
