// Event intake: GitHub webhooks (HMAC-verified) and inbound email (token-gated) become normalized work signals.
// All intake content is untrusted data: it is stored and later classified, never executed as instructions.
import { createHmac, timingSafeEqual } from "node:crypto";
import { addSignal, projectForEmail, projectForRepo } from "./store.js";

export function verifyGithubSignature(raw: Buffer | undefined, header: string | undefined, secret = process.env.GITHUB_WEBHOOK_SECRET) {
  if (!secret || !raw || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
export function verifyIntakeToken(header: string | undefined, token = process.env.INTAKE_TOKEN) {
  if (!token || !header) return false;
  const got = Buffer.from(header.replace(/^Bearer\s+/i, "")), want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Returns the stored signal(s) or a reason the event was ignored.
export function ingestGithub(event: string, delivery: string, p: any) {
  const repo = String(p?.repository?.full_name || "").toLowerCase();
  if (event === "ping") return { ignored: "ping" };
  if (!repo) return { ignored: "no repository" };
  const proj = projectForRepo(repo);
  const base = { source: "github" as const, project_id: proj?.id ?? null };
  if (event === "pull_request" && p.action === "closed" && p.pull_request?.merged) {
    const pr = p.pull_request;
    return (addSignal({ ...base, source_key: `gh:${repo}:pr:${pr.number}:merged`, kind: "pr_merged", actor: pr.user?.login || "", title: `PR #${pr.number} merged: ${pr.title}`, body: String(pr.body || ""), url: pr.html_url || "", occurred_at: pr.merged_at || new Date().toISOString(),
      data: { repo, number: pr.number, labels: (pr.labels || []).map((l: any) => l.name), additions: pr.additions, deletions: pr.deletions, changed_files: pr.changed_files, base: pr.base?.ref, delivery } }));
  }
  if (event === "issues" && p.action === "closed") {
    const i = p.issue;
    return (addSignal({ ...base, source_key: `gh:${repo}:issue:${i.number}:closed`, kind: "issue_closed", actor: p.sender?.login || "", title: `Issue #${i.number} closed: ${i.title}`, body: String(i.body || ""), url: i.html_url || "", occurred_at: i.closed_at || new Date().toISOString(), data: { repo, number: i.number, labels: (i.labels || []).map((l: any) => l.name), delivery } }));
  }
  if (event === "release" && p.action === "published") {
    const r = p.release;
    return (addSignal({ ...base, source_key: `gh:${repo}:release:${r.id}`, kind: "release_published", actor: r.author?.login || "", title: `Release ${r.tag_name}: ${r.name || ""}`.trim(), body: String(r.body || ""), url: r.html_url || "", occurred_at: r.published_at || new Date().toISOString(), data: { repo, tag: r.tag_name, delivery } }));
  }
  return { ignored: `${event}${p?.action ? "." + p.action : ""} not tracked` };
}

// Strips quoted history and signatures so the classifier sees only the new message.
export function newestText(text: string) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From: /.test(l) || l.trim() === "--") break;
    if (!l.startsWith(">")) out.push(l);
  }
  return out.join("\n").trim().slice(0, 4000);
}
export function ingestEmail(m: any) {
  const from = String(m?.from || "").match(/[^<\s"]+@[^>\s"]+/)?.[0]?.toLowerCase();
  if (!from) throw Error("from address required");
  const messageId = String(m.message_id || m.messageId || "").slice(0, 300);
  if (!messageId) throw Error("message_id required");
  const proj = projectForEmail(from);
  return (addSignal({ source: "email", source_key: "email:" + messageId, project_id: proj?.id ?? null, kind: "email_received", actor: from, title: String(m.subject || "(no subject)"), body: newestText(String(m.text || "")), url: "", occurred_at: m.date ? new Date(m.date).toISOString() : new Date().toISOString(), data: { to: m.to || "", message_id: messageId } }));
}
