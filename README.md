# ProfitLeak

A privacy-friendly, browser-only tool for Shopify merchants. Upload your
Orders CSV export and ProfitLeak tells you which orders, products, discount
codes, and shipping decisions are quietly losing you money — without your
data ever leaving your browser tab.

No backend. No login. No database. No API keys. No Shopify API access.
Just `index.html`, opened in a browser.

---

## Architecture

Plain HTML/CSS/vanilla JavaScript, one page, no build step, no framework.

- **Parsing**: [Papa Parse](https://www.papaparse.com/) (loaded from
  `cdnjs.cloudflare.com`) turns the uploaded CSV into an array of row
  objects, headers auto-detected.
- **Column mapping**: a normalizer matches your CSV's actual headers
  (`Name`, `Lineitem sku`, `Total`, etc., or whatever your export calls
  them) against a synonym list, pre-fills a mapping UI, and lets you
  override any guess with a dropdown.
- **Order grouping**: Shopify's standard export puts one row per line item
  and *repeats* order-level fields (Total, Shipping, Taxes, Discount
  Amount, Refunded Amount) on every row belonging to that order. The
  grouping step reads those order-level fields **only from the first row
  of each order**, so a 3-line order never triples its shipping cost or
  discount in the totals — only line-item fields (SKU, quantity, price)
  are summed across rows.
- **Calculation engine**: pure functions (no DOM access) that take grouped
  orders + your cost/fee inputs and produce per-order and per-product
  financials. Kept separate from rendering so it can be (and was) unit
  tested independently — see [Testing](#testing--qa) below.
- **Rendering**: vanilla DOM manipulation — summary cards, two Canvas
  charts (bar + pie, hand-drawn with the 2D context, no chart library),
  sortable/filterable/searchable tables, and a ranked leaks list.
- **Everything lives in memory for the session.** Nothing is written to
  `localStorage`, `sessionStorage`, cookies, or any server. Reloading the
  tab clears everything; the "Delete all imported data" button clears it
  on demand without a reload.

### Why the sample CSV is duplicated inside `app.js`

The app must work when `index.html` is opened directly as a `file://`
URL, with no local server. In that mode, browsers block `fetch()` of a
sibling file (`sample-orders.csv`) as a cross-origin request. So the
"Load sample data" button uses a byte-identical copy of the CSV embedded
as a string constant in `app.js`, and `sample-orders.csv` ships alongside
it as a plain, downloadable reference/example file.

---

## Formulas (exact, as implemented)

Let one **order** consist of order-level fields (`Total`, `Shipping`,
`Taxes`, `Discount Amount`, `Discount Code`, `Refunded Amount`,
`Financial Status` — each read once) and one or more **line items**
(`SKU`, `Name`, `Quantity`, `Price` — summed across the order's rows).

**Per line item:**
```
unit_cost   = per-SKU override if provided, else (default_cost_pct / 100) × price
line_revenue = price × quantity
line_cost    = unit_cost × quantity
line_profit  = line_revenue − line_cost
```

**Per order — gross revenue:**
```
if "Order total" column is mapped:
    gross_revenue = Total
else (fallback, clearly shown as a warning in the UI):
    gross_revenue = Σ(line_revenue) + shipping − discount_amount + taxes
```

**Per order — net revenue** (refunds subtracted first; tax exclusion is
capped so it never subtracts more tax than the revenue that remains after
a refund — this avoids double-subtracting tax on a fully refunded order,
a bug caught during testing and described below):
```
revenue_after_refund = gross_revenue − refunded_amount
if "exclude taxes" is checked:
    tax_to_subtract = min(taxes, max(0, revenue_after_refund))
    net_revenue = revenue_after_refund − tax_to_subtract
else:
    net_revenue = revenue_after_refund
```

**Per order — costs:**
```
cogs           = Σ(line_cost) for that order's line items
payment_fee    = gross_revenue × (processing_pct / 100) + processing_fixed_fee
shipping_cost  = your entered real per-order shipping cost (flat)
ad_allocation  = total_ad_spend ÷ number_of_orders   (spread evenly — a simple
                 allocation model, not attribution; labeled as such in the UI)
```

**Per order — profit:**
```
net_profit = net_revenue − cogs − payment_fee − shipping_cost − ad_allocation
margin_pct = net_profit / net_revenue × 100   (— if net_revenue is 0)
unprofitable = net_profit < 0
risk = green if margin_pct ≥ 20, amber if 0 ≤ margin_pct < 20, red if margin_pct < 0
```

**Aggregates** are plain sums/averages of the per-order figures above:
net revenue, COGS, payment fees, shipping cost, ad spend, refunds, net
profit, net margin %, unprofitable count/%, average order value.

**Product-level profit** aggregates `line_revenue`/`line_cost`/`line_profit`
across every order for each SKU.

**Top 5 profit leaks**: a single ranked list built from five kinds of
candidate leaks — each unprofitable order (by loss size), each product
with negative total profit, each discount code (by total discount given),
a "shipping subsidy" entry (real shipping cost minus what was charged to
the customer, summed only where merchant absorbed the difference), and a
refunds entry (total refunded) — sorted by dollar amount, top 5 shown,
each with a plain-language recommended action.

**Recommended free-shipping threshold** (explicitly labeled an
*evidence-based estimate*, never "optimal"): the 25th-percentile net
revenue value among currently-profitable orders, rounded to the nearest
$5. Rationale: setting the free-shipping cutoff near the low end of what
profitable orders already spend avoids extending free shipping to the
smaller orders that tend to be unprofitable, without needing every order
above the line.

**Maximum safe discount %** (also labeled an estimate): the aggregate
contribution-margin ratio — `(net_revenue − cogs − payment_fee −
shipping_cost) / net_revenue`, summed across all orders, expressed as a
percentage and clamped to 0–100%. This excludes allocated ad spend (a
fixed period cost, not a per-order variable one) and represents roughly
how much discount headroom exists before an average order stops covering
its direct costs.

**Currency selector** changes number formatting (`Intl.NumberFormat`)
only. ProfitLeak does not perform currency conversion — a note in the UI
tells the merchant to match the selector to their CSV's actual currency.

---

## File-by-file explanation

| File | Purpose |
|---|---|
| `index.html` | Page structure: landing screen, CSV upload / sample-data buttons, column-mapping panel, cost/fee config form, and the results dashboard (cards, charts, leaks, recommendations, orders table, products table). |
| `styles.css` | All styling — light background, dark text, green accent, responsive grid layout, risk-level pill colors, table and card styling. No frameworks. |
| `app.js` | Everything else: the calculation engine (CSV-row → grouped orders → financial metrics), the embedded sample dataset, column auto-mapping, all DOM rendering, the two Canvas charts, sorting/filtering/search, CSV export, and the delete-data control. |
| `sample-orders.csv` | A realistic 12-order / 19-row sample export (multi-line orders, a discount code, a full refund, a partial refund, varying margins) for the "Load sample data" button and as a reference for the expected column format. |
| `README.md` | This file. |

---

## Testing & QA

The calculation engine was written as pure functions with no DOM access
specifically so it could be unit tested outside the browser before being
embedded in `app.js`. During development this surfaced **one real bug**,
which was fixed before shipping:

> **Bug found:** a fully-refunded order was double-subtracting tax — once
> directly, and again as part of the refunded amount (which already
> included that tax) — producing a net revenue *below* zero for an order
> that should net to exactly zero. **Fix:** tax exclusion is now capped at
> the revenue remaining after the refund is subtracted (see the net
> revenue formula above).

15 of 18 engine tests and all 12 smoke-test checks passed on the first
run; the refund-related failure above was the only regression found, and
it was fixed and re-verified.

**Test cases exercised** (paraphrased from the actual test suite used
during development):

1. Parsing plain numbers (`"12.5"` → `12.5`)
2. Parsing currency-formatted strings (`"$1,234.50"` → `1234.5`)
3. Blank/null/undefined values parse as `0`, not an error
4. Negative numbers, including accounting-style `(5.25)` → `-5.25`
5. Unreadable garbage (`"N/A"`) parses as `0` and logs a warning, never invents a value
6. Column auto-mapping correctly matches standard Shopify header names
7. **A 3-line-item order collapses into one order**, with Total/Shipping/Taxes read once — not tripled
8. **A fully refunded order nets to a loss** (COGS, fees, and shipping were still incurred even though revenue was refunded)
9. A heavy discount can flip an order from profitable to unprofitable
10. A per-SKU cost override applies only to that SKU; other SKUs keep using the default %
11. A blank quantity defaults to 1 and is logged as a warning, never silently guessed without a trace
12. Advertising spend is allocated evenly across all orders and the per-order allocations sum back to the total entered
13. A row with no order number is skipped (and warned about), never merged into a phantom order
14. Product-level profit correctly aggregates the same SKU appearing across multiple orders
15. Unprofitable order count and percentage are computed correctly
16. Revenue correctly falls back to `line items + shipping + tax − discount` when no "Order total" column is mapped
17. The top-leaks list is sorted descending by dollar amount and capped at 5
18. The recommended free-shipping threshold is `null` (not a fabricated number) when there are no profitable orders to base it on

A second, separate **headless browser smoke test** (using jsdom to
actually load `index.html` + `app.js` and simulate clicks) verified the
full user flow end to end: loading sample data → column auto-mapping →
running analysis → correct order count (12 orders from 19 CSV rows) →
correct order-level deduplication → summary cards, charts, and tables
all rendering without a JavaScript error → sorting, filtering, and search
all updating the table correctly → CSV export not throwing → currency
switching not throwing → "Delete all imported data" fully resetting
state. All checks passed.

*(The engine test script and smoke test script used during development
are not included in this delivery — only the 5 files that make up the
running app are. If you'd like those test scripts included for future
regression testing, ask and they can be added as a 6th/7th file.)*

---

## Running it

**Option A — just open it:**
Double-click `index.html`, or drag it into a browser tab. Everything
works, including "Load sample data" (the sample is embedded in `app.js`
for this reason).

**Option B — local static server** (only needed if you want your browser
to treat it as a proper origin, e.g. for testing):
```bash
cd profitleak
python3 -m http.server 8080
# then open http://localhost:8080
```

**Deploying for free:**
- **GitHub Pages**: push these files to a repo, enable Pages on the
  `main` branch (root), done.
- **Cloudflare Pages**: connect the repo (or drag-and-drop the folder in
  the dashboard) with no build command and `/` as the output directory.

## Testing it yourself

1. Open the app and click **"Load sample data instead."**
2. Confirm the column mapping panel auto-filled (Order number → `Name`,
   Line item price → `Lineitem price`, Order total → `Total`, etc.).
3. Leave the default cost/fee assumptions or adjust them, then click
   **"Run analysis."**
4. You should see 12 orders (grouped from the sample's 19 CSV rows),
   with order `#1005` (a full refund) showing as a loss, and the
   discount-code orders (`#1006`, `#1009`, `#1012`) visibly affected by
   their discounts in the orders table.
5. Try the order search (e.g. search `1005`), the profitable/unprofitable
   filter, sorting any column by clicking its header, exporting results,
   and "Delete all imported data" to confirm it returns you to a clean
   landing screen.
6. To test with your own data: export **Orders** from Shopify Admin
   (Orders → Export), upload that CSV, adjust the column mapping if any
   field wasn't auto-detected, enter your real cost/fee numbers, and run
   the analysis.

---

## Known limitations (by design, for an MVP)

- Advertising cost is allocated **evenly per order**, not attributed to
  specific campaigns/orders — a simple model, clearly labeled as such.
- The real shipping cost is a single flat number you enter per order, not
  parsed from carrier data — Shopify order exports don't include actual
  carrier cost.
- Currency selection is display formatting only, not conversion.
- The recommended free-shipping threshold and max safe discount are
  heuristics based on your uploaded period's data, not a guaranteed
  optimum — this is stated directly in the UI, not just here.
- No tax jurisdiction logic — the exclude-taxes toggle simply subtracts
  whatever is in your mapped Taxes column.
