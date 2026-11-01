# Ledgerly

## Inspiration

Independent work comes with a second job: writing invoices, chasing payments, and checking which balances are still open. We wanted the financial follow-through to feel as direct as a conversation, while keeping the person in control of consequential actions.

## What it does

Ledgerly turns requests into invoice drafts and monthly series. A review card requires confirmation before sending. Payments appear in a live timeline, reconciliation answers who still owes money, and reminder drafts support friendly, firm, or final tones. Partial refunds show the remaining refundable balance and require confirmation.

The demo runs with realistic local fixtures and simulated PayPal payment events. A separate sandbox mode connects the same workflows to PayPal APIs. Mobile users can switch between chat and invoice details without navigating a long stacked page.

## How we built it

React and TypeScript power the workspace. Express exposes a prefix-aware API, SQLite stores invoices, actions, conversations, and events, and SSE delivers live updates. PayPal Agent Toolkit supplies financial tool definitions; Ledgerly routes validated operations through mock or sandbox PayPal clients. An optional OpenAI-compatible LLM performs tool selection. A deterministic interpreter keeps the core demo usable without an AI connection.

## Challenges

Financial intent needs more than a plausible answer. We separated draft creation from send confirmation, checked remaining refund balances, preserved action state, and made System replies distinct from AI inference. Another challenge was keeping proxy paths and SSE behavior consistent under `/paypal-agent/`. Browser checks also exposed the need for a usable mobile switch between chat and invoice context.

## Accomplishments

We built an end-to-end workflow from a three-month draft series through confirmation, payment events, reconciliation, dunning, and partial refunds. The project includes mock fixtures, API smoke checks, real-browser flow checks, and deployment preparation without requiring credentials to try the core experience.

## What we learned

A useful financial assistant must make its work inspectable: tool chips, review cards, persistent events, and explicit confirmation matter as much as language quality. Mock clients are valuable when they preserve production object shapes, and real browser checks catch interaction failures that API tests cannot.

## What's next

Add richer customer management, scheduled reminder policies, robust webhook event mapping and recovery, accounting exports, authentication and tenant isolation, and production operational monitoring. Live credentials and production financial operations need a separate readiness review.

## Built With

TypeScript, React, Vite, Node.js, Express, SQLite, better-sqlite3, PayPal REST APIs, PayPal Agent Toolkit, OpenAI-compatible LLM tool calling, Playwright, Chromium, nginx, systemd.
