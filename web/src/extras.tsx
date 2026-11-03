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
