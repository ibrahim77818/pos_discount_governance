# POS Discount Governance (Odoo 20.0 — Community & Enterprise)

Percentage **and fixed-amount** discounts in the Point of Sale, rounded to the
cent across POS, `pos.order`, invoices and session entries; before/after-tax
policy; employee discount levels with supervisor override; server-side
re-validation; and a discount audit log on every order. English + Arabic (RTL).

## Supported versions
One branch per Odoo version in this repository: `16.0` (default), `17.0`,
`18.0`, `19.0`, `20.0`. This branch is for Odoo 20.0.

## Installation
1. Copy the `pos_discount_governance` folder into your addons path (or clone
   this branch: `git clone -b 20.0 https://github.com/ibrahim77818/pos_discount_governance`).
2. Restart Odoo, update the apps list and install **POS Discount Governance**
   (depends on `point_of_sale`, `pos_hr`, `pos_discount`), or run
   `odoo -d <db> -i pos_discount_governance`.
3. Upgrade later with `-u pos_discount_governance`.

## Configuration
*Point of Sale › Configuration › Settings › Discount Governance*

| Setting | Field | Default |
|---|---|---|
| Discount Tax Policy | `discount_tax_policy` | Before Tax |
| Allow Fixed Amount Discounts | `allow_fixed_discount` | on |
| Require Discount Authorization (+ method: Badge / PIN / Both) | `require_discount_auth`, `discount_auth_method` | off / PIN |
| Enforce Discount Levels (+ default level) | `enforce_discount_limits`, `default_discount_level_id` | on |
| On Server Violation | `discount_violation_action` | Reject the order |

Discount levels: *Point of Sale › Configuration › Discount Levels*; assign one
per employee on the employee form (HR Settings, next to the PIN). An employee
without a level gets the POS default level; with no default level, they are
unrestricted. Authorization requires *Log in with Employees* (pos_hr).

## How it works
* **Exact fixed discounts** — a fixed amount is converted to the exact line
  percentage that makes Odoo's own `compute_all` drop the rounded line total
  by that amount (`pos.order.line.discount` has full precision). Odoo 20
  invoice lines keep that full-precision discount too
  (e.g. 0.05 off 1000 × 10.05 → 10,049.95 everywhere).
* **Global discounts** — split over the order's tax groups with the
  largest-remainder method (parts sum exactly to the entered amount); each
  discount line's price is solved so its untaxed (before tax) or tax-included
  (after tax) total equals its share to the cent.
* **Zero-RPC checkout** — levels, employee levels, policy and auth flags are
  loaded once in `PosGlobalState._processData()`; every check is in memory.
* **One approval per discount** — every discounted line (and the global
  discount lines) carries the uid of the audit entry that authorized it. The
  server accepts a discount only under its own entry (same scope and
  product, server-verified proof) and never above the approved value; any
  other discount falls back to the cashier's own limits. The per-order amount
  cap is the highest cap among the authorities actually used.
* **Tamper resistance** — after a badge/PIN check the POS sends
  `sha1(method:secret:order_uid:log_uid:scope:product:mode:value)`. It can
  only be produced with the plain credential and breaks if any field is
  changed or reused on another line/order. Audit entries are created by the
  server only (POS users and managers have read access); `proof_verified`
  is never taken from input. Only Settings administrators can delete entries.
  pos_hr ships SHA-1 PIN hashes to the browser, so short PINs can still be
  brute-forced offline: prefer badges or *Badge + PIN*.
* **No gaps in order numbers** — in *Reject the order* mode the order is
  checked in memory before it is created.
* **Lockout** — 5 wrong credentials lock verification for 60 s for the whole
  session (not per popup).
* **Approver PINs** — an employee whose level can approve overrides must have
  a PIN; one without a PIN (existing data) only gets the default level when
  acting as cashier.
* **Payment gate** — the POS repeats the server rules before validating the
  payment, so governed orders do not get stuck in the sync queue.

## Go-live checklist
* Enable Odoo's *Restrict price modifications to managers* on each POS:
  otherwise the Price button can lower a unit price outside governance.
* Give a PIN to every employee with an approver level.

## Tests
```
odoo-bin -d <db> -i pos_discount_governance --test-tags /pos_discount_governance --stop-after-init
```
`test_discount_engine.py` covers fixed-amount rounding, before/after tax and
mixed-tax global splits; `test_discount_governance.py` covers tier
enforcement, supervisor escalation, forged/replayed proofs, audit log
persistence, invoice and session reconciliation.
