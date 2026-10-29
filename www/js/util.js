/* GC Optimiser - data helpers: CSV/Excel/PDF/DOCX loading, PII redaction, retrieval, local insights. */
(function (root) {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const rows = []; let row = [], cur = '', q = false;
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length && !first.includes(',') ? ';' : (first.includes('\t') && !first.includes(',') ? '\t' : ',');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  // Build a typed table {columns, rows, types} from a 2D array whose first row is the header.
  function tableFromMatrix(matrix) {
    if (!matrix.length) return { columns: [], rows: [], types: {} };
    const seen = {};
    const columns = matrix[0].map((h, i) => {
      let name = String(h ?? '').trim() || `Column ${i + 1}`;
      if (seen[name]) name = `${name}_${++seen[name]}`; else seen[name] = 1;
      return name;
    });
    const raw = matrix.slice(1).map((r) => { const o = {}; columns.forEach((c, i) => { o[c] = r[i] === undefined ? null : r[i]; }); return o; });
    const types = {};
    columns.forEach((c) => {
      const vals = raw.map((r) => r[c]).filter((v) => v !== null && String(v).trim() !== '');
      const numeric = vals.length > 0 && vals.every((v) => typeof v === 'number' || (/^[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(String(v).trim())));
      types[c] = numeric ? 'number' : 'text';
    });
    const rows = raw.map((r) => {
      const o = {};
      columns.forEach((c) => {
        let v = r[c];
        if (v === null || (typeof v === 'string' && v.trim() === '')) o[c] = null;
        else if (types[c] === 'number') o[c] = typeof v === 'number' ? v : Number(String(v).replace(/[,%]/g, ''));
        else o[c] = typeof v === 'string' ? v.trim() : v;
      });
      return o;
    });
    return { columns, rows, types };
  }

  function stats(table, col) {
    const v = table.rows.map((r) => r[col]).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const n = v.length, mean = v.reduce((s, x) => s + x, 0) / n;
    const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
    const med = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    return { n, mean, sd, min: v[0], max: v[n - 1], median: med };
  }

  const fmt = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : Number(x.toPrecision(d)).toLocaleString('en-IN', { maximumFractionDigits: 6 }));

  /* -------- AI-safety helpers (ported) -------- */
  function redactPII(text) {
    return String(text)
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/(?<!\d)(?:\+?\d[\d ()-]{8,}\d)(?!\d)/g, '[REDACTED_PHONE]')
      .replace(/\b\d{12}\b/g, '[REDACTED_12_DIGIT_ID]')
      .replace(/\b\d{9,18}\b/g, '[REDACTED_LONG_ID]');
  }

  function safeJson(raw) {
    raw = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
    let v;
    try { v = JSON.parse(raw); } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('The AI response was not valid JSON. Try rephrasing the question.');
      v = JSON.parse(m[0]);
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('The AI response must be a JSON object.');
    return v;
  }

  function makeDataContext(tables) {
    const chunks = [];
    for (const [name, t] of Object.entries(tables)) {
      chunks.push(`TABLE: ${name}\nShape: ${t.rows.length} rows x ${t.columns.length} columns\nColumns and dtypes: ${t.columns.map((c) => `${c} (${t.types[c]})`).join(', ')}`);
      const head = t.rows.slice(0, 25).map((r) => t.columns.map((c) => (r[c] === null ? '' : r[c])).join(',')).join('\n');
      chunks.push(`Sample rows (maximum 25):\n${t.columns.join(',')}\n${head}`);
      const num = t.columns.filter((c) => t.types[c] === 'number');
      if (num.length) chunks.push('Numeric summary:\n' + num.map((c) => { const s = stats(t, c); return `${c}: count=${s.n} mean=${fmt(s.mean, 5)} std=${fmt(s.sd, 5)} min=${fmt(s.min, 5)} median=${fmt(s.median, 5)} max=${fmt(s.max, 5)}`; }).join('\n'));
    }
    return chunks.join('\n\n').slice(0, 14000);
  }

  function retrieveExcerpts(question, docs, limit = 6) {
    const chunks = [];
    for (const [name, raw] of Object.entries(docs)) {
      raw.split(/\n\s*\n|(?<=[.!?])\s{2,}/).map((p) => p.trim()).filter(Boolean).forEach((p, i) => chunks.push([name, i + 1, p]));
    }
    if (!chunks.length) return '';
    const toks = new Set((question.match(/[a-zA-Z0-9_]{3,}/g) || []).map((t) => t.toLowerCase()));
    let sel = chunks.map(([name, idx, para]) => {
      const words = new Set((para.match(/[a-zA-Z0-9_]{3,}/g) || []).map((t) => t.toLowerCase()));
      let hit = 0; toks.forEach((t) => { if (words.has(t)) hit++; });
      return { score: hit / Math.max(1, toks.size), name, idx, para };
    }).filter((x) => x.score > 0 || chunks.length <= 3);
    sel.sort((a, b) => b.score - a.score);
    sel = sel.slice(0, limit);
    return ('RETRIEVAL METHOD: lexical retrieval\n\n' + sel.map((x) => `SOURCE: ${x.name}, text segment ${x.idx}\n${x.para.slice(0, 1500)}`).join('\n\n')).slice(0, 9000);
  }

  function heuristicType(q) {
    q = q.toLowerCase();
    const has = (...w) => w.some((x) => q.includes(x));
    if (has('forecast', 'predict', 'next quarter', 'future sales', 'future demand', 'next month')) return 'forecasting';
    if (has('allocate', 'which branches', 'select branches', 'under a budget', 'choose initiatives', 'portfolio allocation')) return 'resource_allocation';
    if (has('assign', 'match workers', 'jobs to people')) return 'assignment';
    if (has('shortest route', 'travelling salesperson', 'traveling salesperson', 'tsp', 'route order')) return 'tsp';
    if (has('set cover', 'cover all', 'minimum number of locations')) return 'set_covering';
    if (has('inventory', 'lot sizing', 'order quantity', 'holding cost', 'replenishment')) return 'inventory_planning';
    if (has('stochastic', 'scenario probabilities', 'uncertain demand', 'two-stage')) return 'two_stage_stochastic';
    if (has('nonlinear', 'quadratic objective')) return 'nonlinear_programming';
    if (has('maximize', 'maximise', 'minimize', 'minimise', 'linear program', 'linear programming')) return 'linear_programming';
    if (has('compare scenarios', 'what if', 'scenario analysis')) return 'scenario_analysis';
    if (has('summarise data', 'summarize data', 'describe dataset', 'analyse data', 'analyze data')) return 'descriptive_analytics';
    return 'strategic_decision';
  }

  function localInsights(tables) {
    const out = [];
    for (const [name, t] of Object.entries(tables)) {
      const missing = t.rows.reduce((s, r) => s + t.columns.filter((c) => r[c] === null).length, 0);
      out.push(`<b>${esc(name)}</b>: ${t.rows.length.toLocaleString()} rows, ${t.columns.length} columns, ${missing.toLocaleString()} missing cells.`);
      t.columns.filter((c) => t.types[c] === 'number').slice(0, 6).forEach((c) => {
        const s = stats(t, c);
        if (s) out.push(`<code>${esc(c)}</code>: mean ${fmt(s.mean)}; median ${fmt(s.median)}; min ${fmt(s.min)}; max ${fmt(s.max)} (n=${s.n}).`);
      });
    }
    return out;
  }

  /* -------- File loading -------- */
  const loaded = {};
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error(`Could not load ${src}. Run "npm run vendor" before building.`));
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  async function loadFiles(fileList) {
    const tables = {}, docs = {}, errors = [];
    for (const file of fileList) {
      const name = file.name, ext = name.includes('.') ? name.toLowerCase().split('.').pop() : '';
      try {
        if (ext === 'csv' || ext === 'tsv') {
          tables[name] = tableFromMatrix(parseCSV(await file.text()));
        } else if (ext === 'xlsx' || ext === 'xls') {
          await loadScript('vendor/xlsx.full.min.js');
          const wb = root.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
          wb.SheetNames.forEach((sn) => {
            const m = root.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
            if (m.length) tables[`${name} · ${sn}`] = tableFromMatrix(m);
          });
        } else if (['txt', 'md', 'json', 'log'].includes(ext)) {
          docs[name] = (await file.text()).slice(0, 200000);
        } else if (ext === 'pdf') {
          await loadScript('vendor/pdf.min.js');
          root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
          const pdf = await root.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
          const pages = [];
          for (let i = 1; i <= Math.min(pdf.numPages, 80); i++) {
            const tc = await (await pdf.getPage(i)).getTextContent();
            pages.push(`[Page ${i}] ` + tc.items.map((it) => it.str).join(' '));
          }
          docs[name] = pages.join('\n\n').slice(0, 200000);
        } else if (ext === 'docx') {
          await loadScript('vendor/mammoth.browser.min.js');
          docs[name] = (await root.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value.slice(0, 200000);
        } else errors.push(`${name}: unsupported file type .${ext}`);
      } catch (e) { errors.push(`${name}: ${e.message || e}`); }
    }
    return { tables, docs, errors };
  }

  const API = { esc, parseCSV, tableFromMatrix, stats, fmt, redactPII, safeJson, makeDataContext, retrieveExcerpts, heuristicType, localInsights, loadFiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else { root.GC = root.GC || {}; root.GC.util = API; }
})(typeof window !== 'undefined' ? window : globalThis);
