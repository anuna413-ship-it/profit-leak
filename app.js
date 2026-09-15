/* ============================================================
   ProfitLeak — all logic in one file, vanilla JS, no build step.
   Section 1: calculation engine (pure functions, unit-tested
   separately — see calc-engine.js / test-calc.js in the repo).
   ============================================================ */

function toNumber(raw, warnings, context) {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return isNaN(raw) ? 0 : raw;
  let s = String(raw).trim();
  if (s === '') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,€£\s]/g, '');
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  if (s === '') return 0;
  const n = parseFloat(s);
  if (isNaN(n)) {
    if (warnings && context) warnings.push(`${context}: could not read "${raw}" as a number — treated as 0.`);
    return 0;
  }
  return neg ? -Math.abs(n) : n;
}

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const FIELD_SYNONYMS = {
  orderNumber: ['name', 'order', 'order number', 'order name', 'order id', 'ordernumber', 'orderid'],
  sku: ['lineitem sku', 'sku', 'variant sku', 'line item sku'],
  itemName: ['lineitem name', 'product', 'product name', 'item', 'line item name', 'title'],
  qty: ['lineitem quantity', 'quantity', 'qty', 'line item quantity'],
  price: ['lineitem price', 'price', 'unit price', 'line item price'],
  total: ['total', 'order total', 'grand total'],
  shipping: ['shipping', 'shipping cost', 'shipping charged'],
  taxes: ['taxes', 'tax', 'total tax'],
  discountAmount: ['discount amount', 'discount', 'discount total'],
  discountCode: ['discount code', 'coupon', 'promo code'],
  refundedAmount: ['refunded amount', 'refund amount', 'refund', 'refunded'],
  financialStatus: ['financial status', 'payment status', 'status'],
};

const FIELD_LABELS = {
  orderNumber: 'Order number',
  sku: 'Line item SKU',
  itemName: 'Line item name',
  qty: 'Line item quantity',
  price: 'Line item price',
  total: 'Order total',
  shipping: 'Shipping',
  taxes: 'Taxes',
  discountAmount: 'Discount amount',
  discountCode: 'Discount code',
  refundedAmount: 'Refunded amount',
  financialStatus: 'Financial status',
};

const REQUIRED_FIELDS = ['orderNumber', 'price', 'qty'];
const FIELD_ORDER = ['orderNumber', 'sku', 'itemName', 'qty', 'price', 'total', 'shipping', 'taxes', 'discountAmount', 'discountCode', 'refundedAmount', 'financialStatus'];

function autoMapColumns(headers) {
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping = {};
  for (const field of Object.keys(FIELD_SYNONYMS)) {
    let found = null;
    for (const syn of FIELD_SYNONYMS[field]) {
      const exact = normalized.find((h) => h.norm === syn);
      if (exact) {
        found = exact.raw;
        break;
      }
    }
    if (!found) {
      for (const syn of FIELD_SYNONYMS[field]) {
        const partial = normalized.find((h) => h.norm.includes(syn));
        if (partial) {
          found = partial.raw;
          break;
        }
      }
    }
    mapping[field] = found;
  }
  return mapping;
}

function groupOrders(rows, mapping) {
  const warnings = [];
  const orderMap = new Map();
  const orderIdsInSequence = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const orderIdRaw = mapping.orderNumber ? row[mapping.orderNumber] : null;
    const orderId = orderIdRaw ? String(orderIdRaw).trim() : '';
    if (!orderId) {
      if (Object.values(row).some((v) => String(v || '').trim() !== '')) {
        warnings.push(`Row ${rowNum}: no order number found — row skipped.`);
      }
      return;
    }

    let order = orderMap.get(orderId);
    if (!order) {
      order = {
        id: orderId,
        orderLevel: {
          total: mapping.total ? toNumber(row[mapping.total], warnings, `Row ${rowNum} (order ${orderId}) total`) : null,
          hasTotal: !!mapping.total,
          shipping: mapping.shipping ? toNumber(row[mapping.shipping], warnings, `Row ${rowNum} (order ${orderId}) shipping`) : 0,
          taxes: mapping.taxes ? toNumber(row[mapping.taxes], warnings, `Row ${rowNum} (order ${orderId}) taxes`) : 0,
          discountAmount: mapping.discountAmount ? toNumber(row[mapping.discountAmount], warnings, `Row ${rowNum} (order ${orderId}) discount`) : 0,
          discountCode: mapping.discountCode ? String(row[mapping.discountCode] || '').trim() : '',
          refundedAmount: mapping.refundedAmount ? toNumber(row[mapping.refundedAmount], warnings, `Row ${rowNum} (order ${orderId}) refund`) : 0,
          financialStatus: mapping.financialStatus ? String(row[mapping.financialStatus] || '').trim() : '',
        },
        lineItems: [],
      };
      orderMap.set(orderId, order);
      orderIdsInSequence.push(orderId);
    }

    const qtyRaw = mapping.qty ? row[mapping.qty] : 1;
    let qty = mapping.qty ? toNumber(qtyRaw, warnings, `Row ${rowNum} (order ${orderId}) quantity`) : 1;
    if (!qty || qty <= 0) {
      qty = 1;
      warnings.push(`Row ${rowNum} (order ${orderId}): missing or invalid quantity — assumed 1.`);
    }
    const price = mapping.price ? toNumber(row[mapping.price], warnings, `Row ${rowNum} (order ${orderId}) price`) : 0;
    const sku = mapping.sku ? String(row[mapping.sku] || '').trim() : '';
    const name = mapping.itemName ? String(row[mapping.itemName] || '').trim() : '';

    if (!sku && !name && !price && !mapping.qty) return;

    order.lineItems.push({ sku: sku || '(no sku)', name: name || sku || 'Unnamed item', qty, price });
  });

  const orders = orderIdsInSequence.map((id) => orderMap.get(id));
  return { orders, warnings };
}

function computeOrderBase(order, config) {
  const lineItemsWithCost = order.lineItems.map((li) => {
    const override = config.skuCostOverrides.get(li.sku);
    const unitCost = override !== undefined ? override : (config.defaultCostPct / 100) * li.price;
    const lineRevenue = li.price * li.qty;
    const lineCost = unitCost * li.qty;
    return { ...li, unitCost, lineRevenue, lineCost, lineProfit: lineRevenue - lineCost };
  });

  const lineRevenueSum = lineItemsWithCost.reduce((s, li) => s + li.lineRevenue, 0);
  const cogs = lineItemsWithCost.reduce((s, li) => s + li.lineCost, 0);

  const ol = order.orderLevel;
  const grossRevenue = ol.hasTotal && ol.total !== null
    ? ol.total
    : lineRevenueSum + (ol.shipping || 0) + (ol.taxes || 0) - (ol.discountAmount || 0);

  const revenueAfterRefund = grossRevenue - (ol.refundedAmount || 0);
  let netRevenue = revenueAfterRefund;
  if (config.excludeTaxes) {
    const taxToSubtract = Math.min(ol.taxes || 0, Math.max(0, revenueAfterRefund));
    netRevenue = revenueAfterRefund - taxToSubtract;
  }

  const paymentFee = grossRevenue * (config.processingPct / 100) + config.processingFixed;
  const shippingCost = config.shippingCostPerOrder;
  const netProfitBeforeAd = netRevenue - cogs - paymentFee - shippingCost;

  return {
    id: order.id,
    orderLevel: ol,
    lineItems: lineItemsWithCost,
    itemCount: lineItemsWithCost.reduce((s, li) => s + li.qty, 0),
    grossRevenue,
    netRevenue,
    cogs,
    paymentFee,
    shippingCost,
    netProfitBeforeAd,
  };
}

function riskFromMargin(margin) {
  if (margin === null || margin === undefined || isNaN(margin)) return 'amber';
  if (margin >= 20) return 'green';
  if (margin >= 0) return 'amber';
  return 'red';
}

function computeAggregate(orders, config) {
  const bases = orders.map((o) => computeOrderBase(o, config));
  const n = bases.length;
  const adPerOrder = n > 0 ? config.totalAdSpend / n : 0;

  const orderMetrics = bases.map((m) => {
    const netProfit = m.netProfitBeforeAd - adPerOrder;
    const margin = m.netRevenue !== 0 ? (netProfit / m.netRevenue) * 100 : null;
    return {
      ...m,
      adAllocation: adPerOrder,
      netProfit,
      margin,
      isUnprofitable: netProfit < 0,
      risk: riskFromMargin(margin),
    };
  });

  const totals = orderMetrics.reduce(
    (acc, m) => {
      acc.netRevenue += m.netRevenue;
      acc.cogs += m.cogs;
      acc.paymentFee += m.paymentFee;
      acc.shippingCost += m.shippingCost;
      acc.adAllocation += m.adAllocation;
      acc.refunded += m.orderLevel.refundedAmount || 0;
      acc.discount += m.orderLevel.discountAmount || 0;
      acc.netProfit += m.netProfit;
      if (m.isUnprofitable) acc.unprofitableCount += 1;
      return acc;
    },
    { netRevenue: 0, cogs: 0, paymentFee: 0, shippingCost: 0, adAllocation: 0, refunded: 0, discount: 0, netProfit: 0, unprofitableCount: 0 }
  );
  totals.orderCount = n;
  totals.unprofitablePct = n > 0 ? (totals.unprofitableCount / n) * 100 : 0;
  totals.avgOrderValue = n > 0 ? totals.netRevenue / n : 0;
  totals.netMarginPct = totals.netRevenue !== 0 ? (totals.netProfit / totals.netRevenue) * 100 : 0;

  const productMap = new Map();
  for (const m of orderMetrics) {
    for (const li of m.lineItems) {
      const key = li.sku;
      let p = productMap.get(key);
      if (!p) {
        p = { sku: li.sku, name: li.name, unitsSold: 0, revenue: 0, cost: 0, profit: 0 };
        productMap.set(key, p);
      }
      p.unitsSold += li.qty;
      p.revenue += li.lineRevenue;
      p.cost += li.lineCost;
      p.profit += li.lineProfit;
    }
  }
  const products = Array.from(productMap.values()).map((p) => ({
    ...p,
    margin: p.revenue !== 0 ? (p.profit / p.revenue) * 100 : null,
    risk: riskFromMargin(p.revenue !== 0 ? (p.profit / p.revenue) * 100 : null),
  }));

  const discountMap = new Map();
  for (const m of orderMetrics) {
    const code = m.orderLevel.discountCode || '(no code)';
    const amt = m.orderLevel.discountAmount || 0;
    if (amt <= 0) continue;
    discountMap.set(code, (discountMap.get(code) || 0) + amt);
  }

  const shippingSubsidy = orderMetrics.reduce((s, m) => {
    const charged = m.orderLevel.shipping || 0;
    const diff = m.shippingCost - charged;
    return s + Math.max(0, diff);
  }, 0);

  const leaks = [];
  for (const m of orderMetrics) {
    if (m.isUnprofitable) {
      leaks.push({
        type: 'order',
        label: `Order ${m.id}`,
        amount: Math.abs(m.netProfit),
        detail: `Net loss of ${m.netProfit.toFixed(2)} on this order.`,
        action: `Review order ${m.id}: check its item costs, any discount applied, and whether shipping was underpriced.`,
      });
    }
  }
  for (const p of products) {
    if (p.profit < 0) {
      leaks.push({
        type: 'product',
        label: p.name || p.sku,
        amount: Math.abs(p.profit),
        detail: `This product has lost ${Math.abs(p.profit).toFixed(2)} in total across all orders.`,
        action: `Raise the price, renegotiate cost, or bundle "${p.name || p.sku}" — its unit economics are currently negative.`,
      });
    }
  }
  for (const [code, amt] of discountMap.entries()) {
    leaks.push({
      type: 'discount',
      label: `Discount code: ${code}`,
      amount: amt,
      detail: `${amt.toFixed(2)} in revenue given up through this code.`,
      action: `Cap usage, raise the minimum order value, or lower the percentage on "${code}".`,
    });
  }
  if (shippingSubsidy > 0) {
    leaks.push({
      type: 'shipping',
      label: 'Shipping subsidy',
      amount: shippingSubsidy,
      detail: `You're absorbing ${shippingSubsidy.toFixed(2)} more in real shipping cost than you charged customers.`,
      action: 'Raise your shipping rate or free-shipping threshold to reduce the gap between real cost and what customers pay.',
    });
  }
  if (totals.refunded > 0) {
    leaks.push({
      type: 'refund',
      label: 'Refunds',
      amount: totals.refunded,
      detail: `${totals.refunded.toFixed(2)} refunded this period.`,
      action: 'Look for a common cause (sizing, damage, description mismatch) behind refunded orders.',
    });
  }
  leaks.sort((a, b) => b.amount - a.amount);
  const topLeaks = leaks.slice(0, 5);

  const profitableRevenues = orderMetrics
    .filter((m) => !m.isUnprofitable)
    .map((m) => m.netRevenue)
    .sort((a, b) => a - b);
  let recommendedThreshold = null;
  if (profitableRevenues.length > 0) {
    const idx = Math.floor(0.25 * (profitableRevenues.length - 1));
    recommendedThreshold = Math.round(profitableRevenues[idx] / 5) * 5;
  }

  const contributionSum = totals.netRevenue - totals.cogs - totals.paymentFee - totals.shippingCost;
  const maxSafeDiscountPct = totals.netRevenue !== 0
    ? Math.max(0, Math.min(100, (contributionSum / totals.netRevenue) * 100))
    : 0;

  return {
    orderMetrics,
    products,
    totals,
    topLeaks,
    recommendedThreshold,
    maxSafeDiscountPct,
    shippingSubsidy,
  };
}

/* ============================================================
   Section 2: embedded sample data.
   Duplicated from sample-orders.csv (kept byte-identical) so
   "Load sample data" works when index.html is opened directly
   via file:// — a fetch() of a sibling file is blocked by the
   browser's local-file CORS policy in that mode.
   ============================================================ */

const SAMPLE_CSV = `Name,Email,Financial Status,Fulfillment Status,Currency,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Created at,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Billing Province,Refunded Amount
#1001,ren@example.com,paid,fulfilled,USD,50.00,5.00,4.40,59.40,,0.00,2024-05-01,2,Classic Tee - Black / M,25.00,TSHIRT-BLK-M,CA,0.00
#1002,jae@example.com,paid,fulfilled,USD,70.00,0.00,6.30,69.30,WELCOME10,7.00,2024-05-02,1,Ceramic Mug,15.00,MUG-CERAMIC,CA,0.00
#1002,jae@example.com,paid,fulfilled,USD,70.00,0.00,6.30,69.30,WELCOME10,7.00,2024-05-02,1,Pullover Hoodie - Grey / L,55.00,HOODIE-GRY-L,CA,0.00
#1003,sam@example.com,paid,fulfilled,USD,24.00,5.00,2.32,31.32,,0.00,2024-05-02,3,Sticker Pack (5),8.00,STICKER-PACK,NY,0.00
#1004,lee@example.com,paid,fulfilled,USD,44.00,8.00,3.96,55.96,,0.00,2024-05-03,2,Lavender Candle,22.00,CANDLE-LAV,NY,0.00
#1005,kim@example.com,refunded,fulfilled,USD,18.00,5.00,1.84,24.84,,0.00,2024-05-03,1,Canvas Tote Bag,18.00,TOTE-CANVAS,TX,24.84
#1006,ari@example.com,paid,fulfilled,USD,63.00,0.00,5.67,56.07,SUMMER20,12.60,2024-05-04,1,Classic Tee - Black / M,25.00,TSHIRT-BLK-M,TX,0.00
#1006,ari@example.com,paid,fulfilled,USD,63.00,0.00,5.67,56.07,SUMMER20,12.60,2024-05-04,2,Ceramic Mug,15.00,MUG-CERAMIC,TX,0.00
#1006,ari@example.com,paid,fulfilled,USD,63.00,0.00,5.67,56.07,SUMMER20,12.60,2024-05-04,1,Sticker Pack (5),8.00,STICKER-PACK,TX,0.00
#1007,mo@example.com,paid,fulfilled,USD,20.00,5.00,2.25,27.25,,0.00,2024-05-05,1,Phone Case - iPhone 15,20.00,PHONECASE-IP15,WA,0.00
#1008,noor@example.com,paid,fulfilled,USD,28.00,5.00,2.97,35.97,,0.00,2024-05-05,1,Steel Water Bottle,28.00,WATERBOTTLE-STL,WA,0.00
#1009,pat@example.com,paid,fulfilled,USD,80.00,0.00,7.20,75.20,VIP15,12.00,2024-05-06,1,Pullover Hoodie - Grey / L,55.00,HOODIE-GRY-L,OR,0.00
#1009,pat@example.com,paid,fulfilled,USD,80.00,0.00,7.20,75.20,VIP15,12.00,2024-05-06,1,Classic Tee - Black / M,25.00,TSHIRT-BLK-M,OR,0.00
#1010,dee@example.com,paid,fulfilled,USD,22.00,5.00,2.43,29.43,,0.00,2024-05-07,1,Lavender Candle,22.00,CANDLE-LAV,OR,0.00
#1011,fen@example.com,partially_refunded,fulfilled,USD,46.00,5.00,4.59,55.59,,0.00,2024-05-07,2,Ceramic Mug,15.00,MUG-CERAMIC,CA,15.00
#1011,fen@example.com,partially_refunded,fulfilled,USD,46.00,5.00,4.59,55.59,,0.00,2024-05-07,2,Sticker Pack (5),8.00,STICKER-PACK,CA,15.00
#1012,gil@example.com,paid,fulfilled,USD,131.00,0.00,11.79,136.24,LOYAL5,6.55,2024-05-08,3,Classic Tee - Black / M,25.00,TSHIRT-BLK-M,NY,0.00
#1012,gil@example.com,paid,fulfilled,USD,131.00,0.00,11.79,136.24,LOYAL5,6.55,2024-05-08,2,Canvas Tote Bag,18.00,TOTE-CANVAS,NY,0.00
#1012,gil@example.com,paid,fulfilled,USD,131.00,0.00,11.79,136.24,LOYAL5,6.55,2024-05-08,1,Phone Case - iPhone 15,20.00,PHONECASE-IP15,NY,0.00
`;

/* ============================================================
   Section 3: application state + DOM wiring.
   ============================================================ */

const state = {
  headers: [],
  rows: [],
  mapping: {},
  fileName: '',
  lastResult: null,
  orderSort: { key: 'netProfit', dir: 'asc' },
  productSort: { key: 'profit', dir: 'asc' },
  orderFilter: 'all',
  orderSearch: '',
  productSearch: '',
};

const CURRENCY_LOCALE = {
  USD: { locale: 'en-US', currency: 'USD' },
  EUR: { locale: 'de-DE', currency: 'EUR' },
  GBP: { locale: 'en-GB', currency: 'GBP' },
  CAD: { locale: 'en-CA', currency: 'CAD' },
  AUD: { locale: 'en-AU', currency: 'AUD' },
};

function fmtMoney(n) {
  const cfg = CURRENCY_LOCALE[getConfig().currency] || CURRENCY_LOCALE.USD;
  try {
    return new Intl.NumberFormat(cfg.locale, { style: 'currency', currency: cfg.currency }).format(n || 0);
  } catch (e) {
    return `$${(n || 0).toFixed(2)}`;
  }
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${n.toFixed(1)}%`;
}

function el(id) { return document.getElementById(id); }

/* ---------- Landing: file upload / sample data ---------- */

el('btn-upload').addEventListener('click', () => el('file-input').click());
el('btn-sample').addEventListener('click', () => loadCsvText(SAMPLE_CSV, 'sample-orders.csv'));
el('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadCsvText(reader.result, file.name);
  reader.onerror = () => showMappingWarning(['Could not read that file. Please try again or use the sample data.']);
  reader.readAsText(file);
});

function loadCsvText(text, fileName) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (!parsed.data || parsed.data.length === 0) {
    showMappingWarning(['This file has no data rows to analyze.']);
    return;
  }
  state.headers = parsed.meta.fields || Object.keys(parsed.data[0]);
  state.rows = parsed.data;
  state.fileName = fileName;
  state.mapping = autoMapColumns(state.headers);

  el('landing').classList.add('hidden');
  el('setup').classList.remove('hidden');
  el('dashboard').classList.add('hidden');

  el('file-summary').textContent = `${fileName} — ${parsed.data.length} rows, ${state.headers.length} columns detected.`;
  renderMappingGrid();
  validateMapping();
}

/* ---------- Column mapping UI ---------- */

function renderMappingGrid() {
  const grid = el('mapping-grid');
  grid.innerHTML = '';
  for (const field of FIELD_ORDER) {
    const wrap = document.createElement('div');
    wrap.className = 'map-field';

    const label = document.createElement('label');
    label.setAttribute('for', `map-${field}`);
    const isRequired = REQUIRED_FIELDS.includes(field);
    label.innerHTML = `${FIELD_LABELS[field]}${isRequired ? '<span class="req">*</span>' : '<span class="opt">(optional)</span>'}`;
    wrap.appendChild(label);

    const select = document.createElement('select');
    select.id = `map-${field}`;
    select.dataset.field = field;

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— not mapped —';
    select.appendChild(noneOpt);

    for (const h of state.headers) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      if (state.mapping[field] === h) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      state.mapping[field] = select.value || null;
      validateMapping();
    });

    wrap.appendChild(select);
    grid.appendChild(wrap);
  }
}

function validateMapping() {
  const missing = REQUIRED_FIELDS.filter((f) => !state.mapping[f]);
  const runBtn = el('btn-run');
  const blocker = el('run-blocker');
  if (missing.length > 0) {
    runBtn.disabled = true;
    blocker.textContent = `Map required fields to continue: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}.`;
    showMappingWarning([]);
  } else {
    runBtn.disabled = false;
    blocker.textContent = '';
    if (!state.mapping.total) {
      showMappingWarning([`No "Order total" column mapped — revenue will be estimated as line items + shipping + tax − discount instead. Map a total column for the most accurate figures if your export has one.`]);
    } else {
      showMappingWarning([]);
    }
  }
}

function showMappingWarning(messages) {
  const box = el('mapping-warning');
  if (!messages || messages.length === 0) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `<strong>Heads up:</strong><ul>${messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`;
}

/* ---------- Config ---------- */

function getConfig() {
  const skuCostOverrides = new Map();
  const raw = el('cfg-sku-costs').value || '';
  raw.split('\n').forEach((line) => {
    const parts = line.split(',');
    if (parts.length >= 2) {
      const sku = parts[0].trim();
      const cost = parseFloat(parts[1]);
      if (sku && !isNaN(cost)) skuCostOverrides.set(sku, cost);
    }
  });

  return {
    defaultCostPct: parseFloat(el('cfg-cost-pct').value) || 0,
    processingPct: parseFloat(el('cfg-fee-pct').value) || 0,
    processingFixed: parseFloat(el('cfg-fee-fixed').value) || 0,
    shippingCostPerOrder: parseFloat(el('cfg-shipping-cost').value) || 0,
    totalAdSpend: parseFloat(el('cfg-ad-spend').value) || 0,
    excludeTaxes: el('cfg-exclude-taxes').checked,
    currency: el('cfg-currency').value,
    skuCostOverrides,
  };
}

/* ---------- Run analysis ---------- */

el('btn-run').addEventListener('click', runAnalysis);

function runAnalysis() {
  const config = getConfig();
  const { orders, warnings } = groupOrders(state.rows, state.mapping);

  if (orders.length === 0) {
    showMappingWarning(['No valid orders could be built from this file. Check that the order number column is mapped correctly.']);
    return;
  }

  const result = computeAggregate(orders, config);
  state.lastResult = result;
  state.warnings = warnings;

  el('setup').classList.add('hidden');
  el('dashboard').classList.remove('hidden');

  renderWarnings(warnings);
  renderSummaryCards(result);
  renderCharts(result);
  renderLeaks(result);
  renderRecommendations(result);
  renderOrdersTable(result);
  renderProductsTable(result);

  el('dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderWarnings(warnings) {
  const box = el('warnings-banner');
  if (!warnings || warnings.length === 0) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  const shown = warnings.slice(0, 20);
  const more = warnings.length - shown.length;
  box.innerHTML = `<strong>${warnings.length} data warning${warnings.length === 1 ? '' : 's'} while reading your file:</strong>
    <ul>${shown.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
    ${more > 0 ? `<p>+${more} more not shown.</p>` : ''}`;
}

/* ---------- Summary cards ---------- */

function renderSummaryCards(result) {
  const t = result.totals;
  const cards = [
    { label: 'Net revenue', value: fmtMoney(t.netRevenue) },
    { label: 'Cost of goods sold', value: fmtMoney(t.cogs) },
    { label: 'Payment fees', value: fmtMoney(t.paymentFee) },
    { label: 'Shipping cost', value: fmtMoney(t.shippingCost) },
    { label: 'Ad spend allocated', value: fmtMoney(t.adAllocation) },
    { label: 'Refunds', value: fmtMoney(t.refunded) },
    { label: 'Net profit', value: fmtMoney(t.netProfit), tone: t.netProfit >= 0 ? 'positive' : 'negative' },
    { label: 'Net margin', value: fmtPct(t.netMarginPct), tone: t.netMarginPct >= 0 ? 'positive' : 'negative' },
    { label: 'Unprofitable orders', value: `${t.unprofitableCount} (${t.unprofitablePct.toFixed(1)}%)`, tone: t.unprofitableCount > 0 ? 'negative' : 'positive' },
    { label: 'Average order value', value: fmtMoney(t.avgOrderValue) },
  ];
  el('summary-cards').innerHTML = cards.map((c) => `
    <div class="card ${c.tone || ''}">
      <div class="label">${escapeHtml(c.label)}</div>
      <div class="value">${c.value}</div>
    </div>`).join('');
}

/* ---------- Charts (Canvas, no libraries) ---------- */

function renderCharts(result) {
  drawProductBarChart(result.products);
  drawBreakdownPieChart(result.totals);
}

function drawProductBarChart(products) {
  const canvas = el('chart-products');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const sorted = [...products].sort((a, b) => b.profit - a.profit);
  const top = sorted.slice(0, 6);
  const bottom = sorted.slice(-2).filter((p) => p.profit < 0 && !top.includes(p));
  const bars = [...top, ...bottom].slice(0, 8);
  if (bars.length === 0) return;

  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.profit)), 1);
  const padding = { top: 16, right: 16, bottom: 60, left: 50 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;
  const zeroY = padding.top + chartH / 2;
  const barW = chartW / bars.length - 14;

  ctx.strokeStyle = '#e1e8e4';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, zeroY);
  ctx.lineTo(w - padding.right, zeroY);
  ctx.stroke();

  bars.forEach((b, i) => {
    const x = padding.left + i * (chartW / bars.length) + 7;
    const barH = (Math.abs(b.profit) / maxAbs) * (chartH / 2 - 6);
    const y = b.profit >= 0 ? zeroY - barH : zeroY;
    ctx.fillStyle = b.profit >= 0 ? '#0f8a5f' : '#c0392b';
    roundRectFill(ctx, x, y, barW, Math.max(barH, 1), 4);

    ctx.fillStyle = '#16211c';
    ctx.font = '11px Arial';
    ctx.textAlign = 'center';
    const label = truncateLabel(b.name || b.sku, 12);
    ctx.save();
    ctx.translate(x + barW / 2, h - padding.bottom + 14);
    ctx.rotate(-0.35);
    ctx.textAlign = 'right';
    ctx.fillText(label, 0, 0);
    ctx.restore();

    ctx.fillStyle = '#5c6b64';
    ctx.font = 'bold 10px Arial';
    ctx.textAlign = 'center';
    const valY = b.profit >= 0 ? y - 6 : y + barH + 14;
    ctx.fillText(fmtMoney(b.profit).replace(/\.00$/, ''), x + barW / 2, valY);
  });
}

function drawBreakdownPieChart(totals) {
  const canvas = el('chart-breakdown');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const segments = [
    { label: 'COGS', value: Math.max(0, totals.cogs), color: '#0f8a5f' },
    { label: 'Payment fees', value: Math.max(0, totals.paymentFee), color: '#1c7293' },
    { label: 'Shipping', value: Math.max(0, totals.shippingCost), color: '#b7791f' },
    { label: 'Ad spend', value: Math.max(0, totals.adAllocation), color: '#84b59f' },
    { label: 'Net profit', value: Math.max(0, totals.netProfit), color: '#21295c' },
  ].filter((s) => s.value > 0);

  const total = segments.reduce((s, x) => s + x.value, 0);
  const legend = el('breakdown-legend');
  legend.innerHTML = '';

  if (total <= 0) {
    ctx.fillStyle = '#5c6b64';
    ctx.font = '13px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough positive figures to chart.', w / 2, h / 2);
    return;
  }

  const cx = w / 2, cy = h / 2 - 10, r = Math.min(w, h) / 2 - 40;
  let angle = -Math.PI / 2;
  segments.forEach((s) => {
    const slice = (s.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    angle += slice;

    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}: ${fmtMoney(s.value)} (${((s.value / total) * 100).toFixed(1)}%)`;
    legend.appendChild(li);
  });
}

function roundRectFill(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
}

function truncateLabel(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ---------- Leaks ---------- */

function renderLeaks(result) {
  const box = el('leaks-list');
  if (result.topLeaks.length === 0) {
    box.innerHTML = `<p class="muted">No significant profit leaks detected in this data — nice work.</p>`;
    return;
  }
  box.innerHTML = result.topLeaks.map((leak, i) => `
    <div class="leak-item">
      <div class="leak-rank">${i + 1}</div>
      <div class="leak-main">
        <div class="leak-label">${escapeHtml(leak.label)}</div>
        <div class="leak-detail">${escapeHtml(leak.detail)}</div>
        <div class="leak-action">${escapeHtml(leak.action)}</div>
      </div>
      <div class="leak-amount">${fmtMoney(leak.amount)}</div>
    </div>`).join('');
}

/* ---------- Recommendations ---------- */

function renderRecommendations(result) {
  el('reco-threshold').textContent = result.recommendedThreshold !== null
    ? fmtMoney(result.recommendedThreshold)
    : 'Not enough profitable orders to estimate';
  el('reco-discount').textContent = `${result.maxSafeDiscountPct.toFixed(1)}%`;
}

/* ---------- Orders table ---------- */

function renderOrdersTable(result) {
  let rows = result.orderMetrics.map((m) => ({
    ...m,
    refund: m.orderLevel.refundedAmount || 0,
  }));

  if (state.orderFilter === 'profitable') rows = rows.filter((r) => !r.isUnprofitable);
  if (state.orderFilter === 'unprofitable') rows = rows.filter((r) => r.isUnprofitable);
  if (state.orderSearch) {
    const q = state.orderSearch.toLowerCase();
    rows = rows.filter((r) => r.id.toLowerCase().includes(q));
  }

  rows = sortRows(rows, state.orderSort);

  const tbody = el('orders-tbody');
  const emptyMsg = el('orders-empty');
  if (rows.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.classList.remove('hidden');
  } else {
    emptyMsg.classList.add('hidden');
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.id)}</td>
        <td>${r.itemCount}</td>
        <td>${fmtMoney(r.netRevenue)}</td>
        <td>${fmtMoney(r.cogs)}</td>
        <td>${fmtMoney(r.paymentFee)}</td>
        <td>${fmtMoney(r.shippingCost)}</td>
        <td>${fmtMoney(r.adAllocation)}</td>
        <td>${fmtMoney(r.refund)}</td>
        <td>${fmtMoney(r.netProfit)}</td>
        <td>${fmtPct(r.margin)}</td>
        <td><span class="risk-pill risk-${r.risk}">${r.risk}</span></td>
      </tr>`).join('');
  }
  updateSortHeaders('orders-table', state.orderSort);
}

/* ---------- Products table ---------- */

function renderProductsTable(result) {
  let rows = [...result.products];
  if (state.productSearch) {
    const q = state.productSearch.toLowerCase();
    rows = rows.filter((r) => r.sku.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q));
  }
  rows = sortRows(rows, state.productSort);

  const tbody = el('products-tbody');
  const emptyMsg = el('products-empty');
  if (rows.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.classList.remove('hidden');
  } else {
    emptyMsg.classList.add('hidden');
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.sku)}</td>
        <td>${escapeHtml(r.name || '')}</td>
        <td>${r.unitsSold}</td>
        <td>${fmtMoney(r.revenue)}</td>
        <td>${fmtMoney(r.cost)}</td>
        <td>${fmtMoney(r.profit)}</td>
        <td>${fmtPct(r.margin)}</td>
        <td><span class="risk-pill risk-${r.risk}">${r.risk}</span></td>
      </tr>`).join('');
  }
  updateSortHeaders('products-table', state.productSort);
}

/* ---------- Sorting helpers ---------- */

function sortRows(rows, sortSpec) {
  const { key, dir } = sortSpec;
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av = a[key], bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      av = String(av ?? '').toLowerCase();
      bv = String(bv ?? '').toLowerCase();
      if (av < bv) return -1 * factor;
      if (av > bv) return 1 * factor;
      return 0;
    }
    av = av === null || av === undefined || isNaN(av) ? -Infinity : av;
    bv = bv === null || bv === undefined || isNaN(bv) ? -Infinity : bv;
    return (av - bv) * factor;
  });
}

function updateSortHeaders(tableId, sortSpec) {
  const table = el(tableId);
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === sortSpec.key) {
      th.classList.add(sortSpec.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function wireSortableTable(tableId, sortState, renderFn) {
  el(tableId).querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        sortState.dir = 'desc';
      }
      renderFn(state.lastResult);
    });
  });
}
wireSortableTable('orders-table', state.orderSort, renderOrdersTable);
wireSortableTable('products-table', state.productSort, renderProductsTable);

/* ---------- Filters / search ---------- */

el('order-filter').addEventListener('change', (e) => {
  state.orderFilter = e.target.value;
  renderOrdersTable(state.lastResult);
});
el('order-search').addEventListener('input', (e) => {
  state.orderSearch = e.target.value.trim();
  renderOrdersTable(state.lastResult);
});
el('product-search').addEventListener('input', (e) => {
  state.productSearch = e.target.value.trim();
  renderProductsTable(state.lastResult);
});

/* ---------- Export ---------- */

el('btn-export').addEventListener('click', () => {
  if (!state.lastResult) return;
  const rows = state.lastResult.orderMetrics.map((m) => ({
    Order: m.id,
    Items: m.itemCount,
    Revenue: m.netRevenue.toFixed(2),
    COGS: m.cogs.toFixed(2),
    PaymentFees: m.paymentFee.toFixed(2),
    ShippingCost: m.shippingCost.toFixed(2),
    AdAllocation: m.adAllocation.toFixed(2),
    Refunded: (m.orderLevel.refundedAmount || 0).toFixed(2),
    NetProfit: m.netProfit.toFixed(2),
    MarginPct: m.margin !== null ? m.margin.toFixed(2) : '',
    Risk: m.risk,
  }));
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'profitleak-analysis.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

/* ---------- Delete all imported data ---------- */

el('btn-delete').addEventListener('click', () => {
  if (!confirm('This clears all imported data from this session. Continue?')) return;
  state.headers = [];
  state.rows = [];
  state.mapping = {};
  state.fileName = '';
  state.lastResult = null;
  state.warnings = [];
  el('file-input').value = '';
  el('dashboard').classList.add('hidden');
  el('setup').classList.add('hidden');
  el('landing').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------- Misc ---------- */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- Expose key internals on window ----------
   Harmless in production; makes the app easy to poke from the
   console and enables headless smoke testing. ---------- */
window.state = state;
window.el = el;
window.runAnalysis = runAnalysis;
window.getConfig = getConfig;
