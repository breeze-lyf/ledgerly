#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost:${PORT:-3000}${BASE_PATH:-/}}"
BASE_URL="${BASE_URL%/}/"
request() { curl -fsS "${BASE_URL}api/$1" "${@:2}"; }
request health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(JSON.parse(s).paypalMode!=="mock")throw Error("Smoke requires mock mode")})'
response=$(request chat -H 'Content-Type: application/json' -d '{"message":"Invoice Acme $800/month maintenance for 3 months"}')
id=$(node -e 'const d=JSON.parse(process.argv[1]);if(d.cards.length!==3||d.cards.some(c=>c.amount!==800))throw Error("Expected three $800 invoices");console.log(d.cards[0].id)' "$response")
request "invoices/$id/send" -H 'Content-Type: application/json' -d '{}' >/dev/null
request dev/simulate-webhook -H 'Content-Type: application/json' -d "{\"event_type\":\"INVOICING.INVOICE.PAID\",\"resource_id\":\"$id\"}" >/dev/null
request "invoices/$id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);if(i.status!=="PAID"||!i.timeline.length)throw Error("Payment not mirrored");console.log("PASS: health → 3 invoices → send → webhook → PAID + timeline")})'
