/* GC Optimiser - mobile UI */
(function () {
  'use strict';
  const { solvers: S, util: U, ai: AI } = window.GC;
  const { esc, fmt } = U;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const APP_VERSION = '1.0.0';

  const SAMPLE_CSV = `Month,Sales,Units_Sold,Marketing_Spend,Average_Price
2023-01,82000,820,6000,100
2023-02,85000,840,6200,101
2023-03,93000,910,6800,102
2023-04,88000,850,6500,104
2023-05,95000,910,7000,104
2023-06,98000,930,7200,105
2023-07,92000,870,6800,106
2023-08,102000,960,7600,106
2023-09,108000,1010,8000,107
2023-10,120000,1110,9000,108
2023-11,135000,1230,10500,110
2023-12,158000,1420,12500,111
2024-01,96000,930,6800,103
2024-02,99000,950,7000,104
2024-03,108000,1020,7600,106
2024-04,103000,970,7300,106
2024-05,112000,1040,8000,108
2024-06,116000,1070,8300,108
2024-07,109000,1000,7800,109
2024-08,121000,1100,8700,110
2024-09,129000,1160,9200,111
2024-10,144000,1280,10500,112
2024-11,161000,1410,12000,114
2024-12,188000,1610,14500,117
2025-01,111000,1040,7500,107
2025-02,115000,1070,7800,108
2025-03,126000,1150,8500,110
2025-04,120000,1090,8100,110
2025-05,131000,1170,9000,112
2025-06,136000,1200,9400,113
2025-07,128000,1120,8800,114
2025-08,142000,1230,9800,115
2025-09,151000,1300,10400,116
2025-10,168000,1420,11800,118
2025-11,188000,1560,13500,120
2025-12,219000,1780,16000,123`;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const state = {
    tables: {}, docs: {}, sources: {}, // sources: fileName -> {tables:[], docs:[]}
    runs: store.get('gc_runs', []), current: null,
    apiKey: store.get('gc_key', ''), model: store.get('gc_model', 'gpt-4o-mini'),
  };
  const registry = new Map(); let regId = 0;
  const reg = (v) => { const id = ++regId; registry.set(id, v); return id; };

  /* ------------------------------- UI helpers ------------------------------- */
  let toastTimer;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
  function busy(on, msg) { $('#busy').hidden = !on; if (msg) $('#busyMsg').textContent = msg; }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const str = (x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x));
  const label = (t) => String(t || 'other').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const cell = (v) => (typeof v === 'number' ? fmt(v, 7) : esc(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v));

  async function shareText(title, text) {
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (P && P.Share) {
      try { await P.Share.share({ title, text, dialogTitle: title }); return; } catch (e) { if (e && /cancel/i.test(String(e.message || e))) return; }
    }
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch (e) { toast('Sharing is not available on this device'); }
  }

  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'data') renderData();
    if (name === 'history') renderHistory();
    if (name === 'tools') renderToolForm();
    window.scrollTo({ top: 0 });
  }

  /* -------------------------------- Rendering -------------------------------- */
  const metric = (k, v) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
  const alertBox = (cls, html) => `<div class="alert ${cls}">${html}</div>`;
  const ul = (items) => (items.length ? `<ul class="plain">${items.map((i) => `<li>${esc(str(i))}</li>`).join('')}</ul>` : '');

  function tableHTML(columns, rows) {
    const numCol = columns.map((c) => rows.some((r) => typeof r[c] === 'number'));
    return `<div class="tbl-wrap"><table><thead><tr>${columns.map((c, i) => `<th class="${numCol[i] ? 'n' : ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c, i) => `<td class="${numCol[i] ? 'n' : ''}">${cell(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  const objTable = (rows) => (rows.length ? tableHTML(Object.keys(rows[0]), rows) : '');

  const compact = (v) => { const a = Math.abs(v); return a >= 1e7 ? (v / 1e7).toFixed(1) + 'Cr' : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (v / 1e3).toFixed(0) + 'k' : a >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v * 10) / 10); };

  function lineChart(history, fc) {
    const W = 340, H = 210, L = 44, R = 10, T = 12, B = 26;
    const hv = history.map((p) => p.value), n = hv.length + fc.length;
    const all = [...hv, ...fc.map((f) => f.lower), ...fc.map((f) => f.upper)];
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || 1; lo = Math.max(0, lo - pad); hi += pad;
    const x = (i) => L + (i / Math.max(1, n - 1)) * (W - L - R), y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const hp = hv.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const fp = [`${x(hv.length - 1).toFixed(1)},${y(hv[hv.length - 1]).toFixed(1)}`, ...fc.map((f, i) => `${x(hv.length + i).toFixed(1)},${y(f.forecast).toFixed(1)}`)].join(' ');
    const upper = fc.map((f, i) => `${x(hv.length + i).toFixed(1)},${y(f.upper).toFixed(1)}`);
    const lower = fc.map((f, i) => `${x(hv.length + i).toFixed(1)},${y(f.lower).toFixed(1)}`).reverse();
    const band = [`${x(hv.length - 1).toFixed(1)},${y(hv[hv.length - 1]).toFixed(1)}`, ...upper, ...lower].join(' ');
    let grid = '';
    for (let g = 0; g <= 4; g++) { const v = lo + ((hi - lo) * g) / 4, yy = y(v); grid += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="currentColor" opacity=".12"/><text x="${L - 6}" y="${yy + 3}" text-anchor="end">${compact(v)}</text>`; }
    const labs = [[0, history[0].date], [Math.floor((n - 1) / 2), (history.concat(fc.map((f) => ({ date: f.date }))))[Math.floor((n - 1) / 2)].date], [n - 1, fc[fc.length - 1].date]];
    const xl = labs.map(([i, d], k) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${esc(d)}</text>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Forecast chart"><g style="color:var(--ink)">${grid}</g>
      <polygon points="${band}" fill="#f59e0b" opacity=".18"/>
      <polyline points="${hp}" fill="none" stroke="#0d9488" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${fp}" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-dasharray="5 4" stroke-linejoin="round"/>
      <line x1="${x(hv.length - 1)}" x2="${x(hv.length - 1)}" y1="${T}" y2="${H - B}" stroke="currentColor" opacity=".25" stroke-dasharray="2 3" style="color:var(--ink)"/>${xl}</svg>
      <div class="small muted"><span style="color:#0d9488">●</span> History &nbsp; <span style="color:#f59e0b">●</span> Forecast with 80% range</div>`;
  }

  function renderSolver(sr) {
    let h = '<div class="h2">Calculated result</div>';
    if (sr.success === false) {
      h += alertBox('err', esc(sr.message || 'The solver did not find a feasible solution.'));
      if (sr.solver) h += `<p class="small muted">${esc(sr.solver)}</p>`;
      if (sr.uncovered_elements && sr.uncovered_elements.length) h += `<p class="small">Uncovered: ${esc(sr.uncovered_elements.join(', '))}</p>`;
      return h + (sr.note ? `<p class="hint">${esc(sr.note)}</p>` : '');
    }
    h += alertBox('ok', `Completed using: <b>${esc(sr.solver || 'deterministic solver')}</b>`);
    if (sr.forecast_table) {
      const csv = 'date,forecast,lower_80,upper_80\n' + sr.forecast_table.map((f) => `${f.date},${f.forecast},${f.lower},${f.upper}`).join('\n');
      h += lineChart(sr.history, sr.forecast_table);
      h += '<div class="metrics">' + metric('History points', sr.history_points) +
        (sr.seasonal_period ? metric('Seasonality', `${sr.seasonal_period}-period`) : metric('Seasonality', 'None')) +
        (sr.backtest_mae !== null && sr.backtest_mae !== undefined ? metric(`Hold-out MAE (${sr.holdout_periods} periods)`, fmt(sr.backtest_mae, 5)) : '') +
        (sr.backtest_mape !== null && sr.backtest_mape !== undefined ? metric('Hold-out MAPE', sr.backtest_mape + '%') : '') +
        (sr.naive_mae !== null && sr.naive_mae !== undefined ? metric('Naive baseline MAE', fmt(sr.naive_mae, 5)) : '') + '</div>';
      h += objTable(sr.forecast_table.map((f) => ({ Period: f.date, [`Forecast ${sr.target_name}`]: f.forecast, 'Low (80%)': f.lower, 'High (80%)': f.upper })));
      h += `<div class="row gap"><button class="btn ghost sm" data-share-csv="${reg(csv)}">Share forecast CSV</button></div>`;
    } else if (sr.selected) {
      h += '<div class="metrics">' + metric('Total benefit', fmt(sr.total_benefit, 7)) + metric('Budget used', `${fmt(sr.total_cost, 7)} / ${fmt(sr.capacity, 7)}`) + metric('Items selected', sr.selected.length) + '</div>' + objTable(sr.selected);
    } else if (sr.variables) {
      if (sr.objective_value !== undefined) h += '<div class="metrics">' + metric('Objective value', fmt(sr.objective_value, 8)) + '</div>';
      h += tableHTML(['Variable', 'Value'], Object.entries(sr.variables).map(([k, v]) => ({ Variable: k, Value: v })));
    } else if (sr.schedule) {
      h += '<div class="metrics">' + metric('Total cost', fmt(sr.total_cost, 8)) + metric('Setup + holding', fmt(sr.setup_and_holding_cost, 8)) + '</div>' + objTable(sr.schedule);
    } else if (sr.assignments) {
      h += '<div class="metrics">' + metric('Total cost', fmt(sr.total_cost, 8)) + '</div>' + objTable(sr.assignments);
    } else if (sr.route) {
      h += '<div class="metrics">' + metric('Total distance', fmt(sr.total_distance, 8)) + '</div><p><b>Route:</b> ' + sr.route.join(' → ') + '</p>';
    } else if (sr.selected_set_indices) {
      h += `<p><b>Selected sets (0-indexed):</b> ${sr.selected_set_indices.join(', ') || 'none'}</p>`;
    } else if (sr.selected_projects) {
      h += '<div class="metrics">' + metric('Expected return', fmt(sr.expected_scenario_return, 8)) + metric('First-stage cost', fmt(sr.first_stage_cost, 8)) + '</div>' +
        `<p><b>Select:</b> ${esc(sr.selected_projects.join(', ') || 'none')}</p>` +
        objTable(sr.scenario_outcomes.map((o) => ({ Scenario: o.scenario, Probability: o.probability, Return: o.return, Deployment: Object.entries(o.deployment).map(([k, v]) => `${k}: ${v}`).join('; ') })));
    } else h += `<pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(sr, null, 2))}</pre>`;
    if (sr.note) h += `<p class="hint">${esc(sr.note)}</p>`;
    return h;
  }

  function renderAI(ai) {
    let h = `<div class="h2">${esc(ai.decision_question || 'Interpreted business decision')}</div>`;
    if (ai.executive_summary) h += `<p>${esc(ai.executive_summary)}</p>`;
    const facts = arr(ai.known_facts);
    if (facts.length) h += `<div class="h2">What the analysis knows</div>${ul(facts)}`;
    if (ai.recommended_method) h += `<div class="h2">Recommended method</div><p>${esc(str(ai.recommended_method))}</p>`;
    const miss = arr(ai.missing_inputs);
    h += `<div class="h2">Missing inputs</div>` + (miss.length ? miss.map((m) => alertBox('warn', esc(str(m)))).join('') : alertBox('ok', 'No critical missing inputs identified - still validate the assumptions.'));
    const as = arr(ai.assumptions); if (as.length) h += `<div class="h2">Assumptions</div>${ul(as)}`;
    const steps = arr(ai.analysis_steps); if (steps.length) h += `<details><summary>Analysis workflow</summary><ol class="plain">${steps.map((s) => `<li>${esc(str(s))}</li>`).join('')}</ol></details>`;
    const recs = arr(ai.recommendations);
    if (recs.length) h += `<div class="h2">Recommendations</div>` + recs.map((r, i) => `<div class="reco"><div class="n">${i + 1}</div><div>${esc(str(r))}</div></div>`).join('');
    const risks = arr(ai.risks_and_checks); if (risks.length) h += `<div class="h2">Risks and validation checks</div>${ul(risks)}`;
    const src = arr(ai.source_notes); if (src.length) h += `<details><summary>Sources and data references</summary>${ul(src)}</details>`;
    return h;
  }

  function summaryText(run) {
    const L = [`GC Optimiser analysis · ${run.timestamp}`, `Question: ${run.question}`, `Problem type: ${label(run.problem_type)}`];
    if (run.ai) {
      if (run.ai.executive_summary) L.push('', 'Summary: ' + run.ai.executive_summary);
      arr(run.ai.recommendations).forEach((r, i) => L.push(`${i + 1}. ${str(r)}`));
      if (arr(run.ai.missing_inputs).length) L.push('', 'Missing inputs:', ...arr(run.ai.missing_inputs).map((m) => '- ' + str(m)));
    }
    const sr = run.solver_result;
    if (sr) {
      L.push('', `Solver: ${sr.solver || ''}${sr.success === false ? ' (failed: ' + sr.message + ')' : ''}`);
      if (sr.forecast_table) sr.forecast_table.forEach((f) => L.push(`${f.date}: ${f.forecast} (${f.lower}–${f.upper})`));
      else { const c = { ...sr }; delete c.history; L.push(JSON.stringify(c, null, 1)); }
    }
    L.push('', 'Decision-support output: validate before acting.');
    return L.join('\n');
  }

  function renderRun(run) {
    const box = $('#results');
    if (!run) { box.innerHTML = ''; return; }
    let h = `<div class="card"><div class="row between"><span class="pill">${esc(label(run.problem_type))}</span><span class="small muted">${esc(run.timestamp)}</span></div>`;
    h += `<p class="small muted" style="margin:8px 0 0">${esc(run.question)}</p>`;
    if (run.file_errors && run.file_errors.length) h += run.file_errors.map((e) => alertBox('warn', esc(e))).join('');
    if (run.stats && run.stats.tables) h += '<div class="metrics">' + metric('Tables', run.stats.tables) + metric('Rows', run.stats.rows.toLocaleString()) + metric('Columns', run.stats.cols) + metric('Documents', run.stats.docs) + '</div>';
    if (run.ai) h += renderAI(run.ai);
    else if (run.ai_error) h += alertBox('err', 'AI analysis could not be completed: ' + esc(run.ai_error)) + alertBox('info', 'Showing the on-device fallback instead. Check your key and connection in Settings.');
    else if (!state.apiKey || run.offline) h += alertBox('info', 'AI reasoning is off, so this used on-device routing only. Add an OpenAI key in Settings for full natural-language analysis, or use the Solvers tab for direct calculations.');
    if (run.auto_note) h += alertBox('info', esc(run.auto_note));
    if (run.solver_result) h += renderSolver(run.solver_result);
    else if (run.solver_error) h += alertBox('warn', 'The problem was interpreted, but a calculation could not be run: ' + esc(run.solver_error)) + '<p class="hint">The AI interpretation is not a verified mathematical solution. Supply the missing data or constraints, or rephrase.</p>';
    else h += alertBox('info', 'No deterministic solver was run. This may be a strategic, descriptive or scenario question, or it needs more explicit numeric inputs.');
    if (run.local_insights && run.local_insights.length) h += `<details><summary>Local data profile</summary><ul class="plain small">${run.local_insights.map((i) => `<li>${i}</li>`).join('')}</ul></details>`;
    if (run.doc_context) h += `<details><summary>Retrieved document excerpts</summary><pre class="small" style="white-space:pre-wrap">${esc(run.doc_context)}</pre></details>`;
    h += `<div class="row gap"><button class="btn ghost sm grow" data-share-run="1">Share summary</button><button class="btn ghost sm grow" data-share-json="1">Export JSON</button></div>`;
    h += '<p class="hint">GC Optimiser is a decision-support prototype. Forecasts are not guarantees; high-impact decisions need human approval.</p></div>';
    box.innerHTML = h;
  }

  /* --------------------------------- Analysis --------------------------------- */
  function guessForecastColumns(t) {
    const isDateLike = (c) => { const v = t.rows.map((r) => r[c]).filter((x) => x !== null); return v.length >= 2 && t.types[c] === 'text' && v.every((x) => /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?/.test(String(x)) || !Number.isNaN(Date.parse(x))); };
    const date = t.columns.find(isDateLike);
    const nums = t.columns.filter((c) => t.types[c] === 'number');
    const target = nums.find((c) => /sales|revenue|demand|amount|units|orders|volume|income/i.test(c)) || nums[0];
    return date && target ? { date, target } : null;
  }

  function autoSolve(run, q) {
    if (run.problem_type !== 'forecasting' || !Object.keys(state.tables).length) return;
    const [name, t] = Object.entries(state.tables)[0];
    const g = guessForecastColumns(t);
    if (!g) { run.solver_error = 'No date column and numeric column could be identified automatically. Use the Solvers tab to choose them.'; return; }
    const m = q.match(/(\d{1,2})\s*(?:more\s*)?(?:months?|periods?|weeks?|days?|quarters?|years?)/i);
    const horizon = m ? Math.min(60, Math.max(1, parseInt(m[1], 10))) : 6;
    try {
      run.solver_result = S.solveForecast(t, { table_name: name, target_column: g.target, date_column: g.date, horizon, seasonal_period: 0 });
      run.auto_note = `Columns were chosen automatically (not by AI): date = "${g.date}", target = "${g.target}", horizon = ${horizon}. Use the Solvers tab to change them.`;
    } catch (e) { run.solver_error = e.message; }
  }

  async function analyse() {
    const q = $('#question').value.trim();
    if (!q) { toast('Enter a business decision question first.'); return; }
    busy(true, state.apiKey ? 'Reading context and asking the AI…' : 'Analysing on-device…');
    await nextFrame();
    try {
      const dataCtx = U.makeDataContext(state.tables), docCtx = U.retrieveExcerpts(q, state.docs);
      const tv = Object.values(state.tables);
      const run = {
        id: Date.now(), question: q, timestamp: new Date().toLocaleString(), solver_result: null, ai: null,
        stats: { tables: tv.length, rows: tv.reduce((s, t) => s + t.rows.length, 0), cols: tv.reduce((s, t) => s + t.columns.length, 0), docs: Object.keys(state.docs).length },
      };
      if (state.apiKey) {
        try {
          const ai = await AI.askAI({ question: q, dataContext: dataCtx, docContext: docCtx, apiKey: state.apiKey, model: state.model });
          run.ai = ai; run.problem_type = String(ai.problem_type || 'other');
          try { const sr = S.solveStructured(run.problem_type, ai.solver_spec, state.tables); if (sr) run.solver_result = sr; } catch (e) { run.solver_error = e.message; }
        } catch (e) { run.ai_error = e.message; run.problem_type = U.heuristicType(q); autoSolve(run, q); }
      } else { run.offline = true; run.problem_type = U.heuristicType(q); autoSolve(run, q); }
      run.local_insights = U.localInsights(state.tables);
      run.doc_context = docCtx;
      state.current = run;
      state.runs.unshift(run); state.runs = state.runs.slice(0, 10);
      if (!store.set('gc_runs', state.runs)) { state.runs = state.runs.slice(0, 3); store.set('gc_runs', state.runs); }
      renderRun(run);
      setTimeout(() => $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } catch (e) { toast('Something went wrong: ' + (e.message || e)); } finally { busy(false); }
  }

  /* ----------------------------------- Files ----------------------------------- */
  function renderContext() {
    const names = Object.keys(state.sources);
    const nt = Object.keys(state.tables).length, nd = Object.keys(state.docs).length;
    $('#ctxSummary').textContent = names.length ? `${nt} table${nt === 1 ? '' : 's'} · ${nd} document${nd === 1 ? '' : 's'}` : 'No files attached';
    $('#fileChips').innerHTML = names.map((n) => `<span class="chip file">${esc(n)}<button data-remove-file="${esc(n)}" aria-label="Remove ${esc(n)}">×</button></span>`).join('');
  }

  async function ingest(files) {
    if (!files.length) return;
    busy(true, 'Reading files…'); await nextFrame();
    try {
      for (const f of files) {
        const r = await U.loadFiles([f]);
        Object.assign(state.tables, r.tables); Object.assign(state.docs, r.docs);
        if (Object.keys(r.tables).length || Object.keys(r.docs).length) state.sources[f.name] = { tables: Object.keys(r.tables), docs: Object.keys(r.docs) };
        r.errors.forEach((e) => toast(e));
      }
      renderContext(); renderData();
      toast('Files added');
    } finally { busy(false); }
  }

  function removeFile(name) {
    const s = state.sources[name]; if (!s) return;
    s.tables.forEach((k) => delete state.tables[k]); s.docs.forEach((k) => delete state.docs[k]);
    delete state.sources[name]; renderContext(); renderData(); renderToolForm();
  }

  function addSample() {
    const t = U.tableFromMatrix(U.parseCSV(SAMPLE_CSV));
    state.tables['sales_data.csv'] = t; state.sources['sales_data.csv'] = { tables: ['sales_data.csv'], docs: [] };
    renderContext(); renderData(); renderToolForm();
    toast('Sample sales data loaded');
  }

  /* ------------------------------------ Data tab ------------------------------------ */
  function renderData() {
    const box = $('#dataView');
    const tn = Object.entries(state.tables), dn = Object.entries(state.docs);
    let h = `<div class="card"><div class="row gap" style="margin-top:0"><button class="btn primary grow" id="dataAdd">Add files</button><button class="btn ghost" id="dataSample">Sample data</button></div></div>`;
    if (!tn.length && !dn.length) h += `<div class="empty"><div class="big">🗂️</div><p>No data loaded yet.<br>Add CSV or Excel tables for calculations, or PDF / DOCX / text for context.</p></div>`;
    tn.forEach(([name, t]) => {
      h += `<div class="card"><span class="h">${esc(name)}</span><p class="small muted" style="margin:0 0 6px">${t.rows.length.toLocaleString()} rows × ${t.columns.length} columns</p><div class="chips" style="margin-top:4px">${t.columns.map((c) => `<span class="chip" style="cursor:default">${esc(c)} <span class="muted">${t.types[c] === 'number' ? '#' : 'Aa'}</span></span>`).join('')}</div>`;
      h += `<details><summary>Preview (first 40 rows)</summary>${tableHTML(t.columns, t.rows.slice(0, 40))}</details>`;
      const nums = t.columns.filter((c) => t.types[c] === 'number');
      if (nums.length) h += `<details><summary>Numeric summary</summary>${tableHTML(['Column', 'Mean', 'Median', 'Min', 'Max', 'Std'], nums.map((c) => { const s = U.stats(t, c); return { Column: c, Mean: s.mean, Median: s.median, Min: s.min, Max: s.max, Std: s.sd }; }))}</details>`;
      h += '</div>';
    });
    dn.forEach(([name, text]) => { h += `<div class="card"><span class="h">${esc(name)}</span><p class="small muted" style="margin:0">${text.length.toLocaleString()} characters of text</p><details><summary>Preview</summary><pre class="small" style="white-space:pre-wrap">${esc(text.slice(0, 1500))}${text.length > 1500 ? '…' : ''}</pre></details></div>`; });
    box.innerHTML = h;
  }

  /* ------------------------------------ History ------------------------------------ */
  function renderHistory() {
    const box = $('#historyView');
    if (!state.runs.length) { box.innerHTML = '<div class="empty"><div class="big">🕘</div><p>Your recent analyses (last 10) appear here.</p></div>'; return; }
    box.innerHTML = state.runs.map((r, i) => `<button class="hist-item" data-open-run="${i}"><span class="pill">${esc(label(r.problem_type))}</span> <span class="small muted">${esc(r.timestamp)}</span><div class="q">${esc(r.question)}</div></button>`).join('') +
      '<button class="btn danger" id="clearHistory" style="width:100%">Clear history</button>';
  }

  /* ------------------------------------ Solver lab ------------------------------------ */
  const TOOLS = {
    forecasting: { label: 'Forecast (time series)', table: true },
    resource_allocation: { label: 'Budget allocation (knapsack)', table: true },
    linear_programming: { label: 'Linear programming', example: { variable_names: ['ProductA', 'ProductB'], objective_coefficients: [40, 30], objective_sense: 'max', constraints: [{ coefficients: [2, 1], sense: '<=', rhs: 100 }, { coefficients: [1, 2], sense: '<=', rhs: 80 }, { coefficients: [1, 0], sense: '>=', rhs: 5 }] } },
    assignment: { label: 'Assignment (Hungarian)', example: { cost_matrix: [[9, 2, 7], [3, 6, 4], [5, 8, 1]] } },
    tsp: { label: 'Shortest route (TSP, ≤15 stops)', example: { distance_matrix: [[0, 12, 29, 22, 13], [12, 0, 19, 3, 25], [29, 19, 0, 21, 23], [22, 3, 21, 0, 4], [13, 25, 23, 4, 0]] } },
    set_covering: { label: 'Set covering', example: { universe: ['A', 'B', 'C', 'D', 'E', 'F'], sets: [['A', 'B', 'C'], ['C', 'D'], ['D', 'E', 'F'], ['A', 'F']] } },
    inventory_planning: { label: 'Inventory lot sizing', example: { demands: [20, 50, 10, 50, 50, 10, 20, 40, 20, 30], fixed_order_cost: 100, holding_cost_per_unit_per_period: 1, unit_cost: 5 } },
    two_stage_stochastic: { label: 'Two-stage stochastic (projects)', example: { project_names: ['Alpha', 'Beta', 'Gamma'], first_stage_costs: [4, 3, 5], budget: 8, scenario_probabilities: [0.5, 0.5], scenario_returns: [[10, 6, 12], [4, 7, 3]], scenario_resource_weights: [2, 1, 3], scenario_capacities: [3, 2] } },
    nonlinear_programming: { label: 'Quadratic programming', example: { variable_names: ['x', 'y'], linear_coefficients: [-2, -5], quadratic_matrix: [[2, 0], [0, 2]], objective_sense: 'min', constraints: [{ coefficients: [1, 1], sense: '<=', rhs: 3 }], bounds: [[0, null], [0, null]] } },
  };
  let toolType = 'forecasting';

  function colOptions(t, kind, selected) {
    return t.columns.filter((c) => kind === 'any' || (kind === 'number' ? t.types[c] === 'number' : t.types[c] !== 'number'))
      .map((c) => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');
  }

  function renderToolForm() {
    const sel = $('#toolType');
    if (!sel.options.length) {
      sel.innerHTML = Object.entries(TOOLS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
      sel.value = toolType;
    }
    toolType = sel.value;
    const tool = TOOLS[toolType], box = $('#toolForm');
    $('#toolExample').style.display = tool.table ? 'none' : '';
    if (tool.table) {
      const names = Object.keys(state.tables);
      if (!names.length) { box.innerHTML = '<div class="alert info" style="margin-top:12px">This solver needs a table. <button class="btn sm ghost" id="toolSample" style="margin-left:6px">Load sample data</button></div>'; return; }
      const tn = ($('#toolTable') && state.tables[$('#toolTable').value]) ? $('#toolTable').value : names[0];
      const t = state.tables[tn], g = toolType === 'forecasting' ? guessForecastColumns(t) : null;
      let h = `<label class="lbl" for="toolTable">Table</label><select id="toolTable">${names.map((n) => `<option ${n === tn ? 'selected' : ''} value="${esc(n)}">${esc(n)}</option>`).join('')}</select>`;
      if (toolType === 'forecasting') {
        h += `<label class="lbl" for="fcDate">Date column</label><select id="fcDate">${colOptions(t, 'any', g && g.date)}</select>
        <label class="lbl" for="fcTarget">Value to forecast</label><select id="fcTarget">${colOptions(t, 'number', g && g.target)}</select>
        <label class="lbl" for="fcHorizon">Periods ahead (1–60)</label><input id="fcHorizon" type="number" inputmode="numeric" min="1" max="60" value="6">
        <label class="lbl" for="fcSeason">Seasonal period</label><select id="fcSeason"><option value="0">Auto-detect</option><option value="4">4 (quarterly)</option><option value="7">7 (weekly)</option><option value="12">12 (monthly)</option></select>`;
      } else {
        const nums = t.columns.filter((c) => t.types[c] === 'number');
        h += `<label class="lbl" for="kName">Item name column</label><select id="kName"><option value="">(row number)</option>${colOptions(t, 'any')}</select>
        <label class="lbl" for="kValue">Benefit column</label><select id="kValue">${colOptions(t, 'number', nums[0])}</select>
        <label class="lbl" for="kCost">Cost column</label><select id="kCost">${colOptions(t, 'number', nums[1] || nums[0])}</select>
        <label class="lbl" for="kCap">Budget / capacity</label><input id="kCap" type="number" inputmode="decimal" placeholder="e.g. 100">`;
      }
      box.innerHTML = h;
    } else if (!$('#toolJson') || box.dataset.type !== toolType) {
      box.dataset.type = toolType;
      box.innerHTML = `<label class="lbl" for="toolJson">Problem spec (JSON)</label><textarea id="toolJson" class="code" spellcheck="false" autocapitalize="off">${esc(JSON.stringify(tool.example, null, 2))}</textarea><p class="hint">Edit the numbers to match your problem. Matrices are zero-indexed in the result.</p>`;
    }
    if (tool.table) box.dataset.type = toolType;
  }

  function runTool() {
    const tool = TOOLS[toolType]; let spec;
    try {
      if (tool.table) {
        const table_name = $('#toolTable') && $('#toolTable').value;
        if (!table_name) { toast('Load a table first.'); return; }
        spec = toolType === 'forecasting'
          ? { table_name, date_column: $('#fcDate').value, target_column: $('#fcTarget').value, horizon: parseInt($('#fcHorizon').value || '6', 10), seasonal_period: parseInt($('#fcSeason').value, 10) }
          : { table_name, name_column: $('#kName').value || null, value_column: $('#kValue').value, cost_column: $('#kCost').value, capacity: $('#kCap').value };
        if (toolType === 'resource_allocation' && $('#kCap').value === '') { toast('Enter a budget or capacity.'); return; }
      } else spec = JSON.parse($('#toolJson').value);
    } catch (e) { $('#toolResults').innerHTML = `<div class="card">${alertBox('err', 'The JSON is not valid: ' + esc(e.message))}</div>`; return; }
    try {
      const sr = S.solveStructured(toolType, spec, state.tables);
      $('#toolResults').innerHTML = `<div class="card">${renderSolver(sr)}</div>`;
    } catch (e) { $('#toolResults').innerHTML = `<div class="card">${alertBox('err', esc(e.message || String(e)))}</div>`; }
    setTimeout(() => $('#toolResults').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }

  /* ------------------------------------ Settings ------------------------------------ */
  function updateAIBadge() { const b = $('#aiBadge'); b.textContent = state.apiKey ? 'AI on' : 'AI off'; b.className = 'badge ' + (state.apiKey ? 'on' : 'off'); }
  function keyStatus(msg, cls) { const el = $('#keyStatus'); el.textContent = msg; el.style.color = cls === 'err' ? 'var(--danger)' : cls === 'ok' ? 'var(--ok)' : ''; }

  /* ------------------------------------ Wiring ------------------------------------ */
  function init() {
    $('#about').textContent = `GC Optimiser mobile v${APP_VERSION}. On-device solvers: simplex LP, knapsack, forecasting, assignment, TSP, set covering, inventory DP, stochastic and quadratic programs. AI routing uses your OpenAI key.`;
    $('#examples').innerHTML = [
      'Forecast monthly sales for the next 6 months using the uploaded sales data.',
      'Select the best initiatives under a budget of 100 to maximise total benefit.',
      'Help me decide where to open new branches using growth, cost and credit-risk evidence.',
      'Compare the current plan with a 10% cost-reduction scenario and explain trade-offs.',
    ].map((t) => `<button class="chip" data-example="${esc(t)}">${esc(t)}</button>`).join('');
    $('#apiKey').value = state.apiKey; $('#model').value = state.model;
    updateAIBadge(); renderContext(); renderToolForm();
    const saved = store.get('gc_question', ''); if (saved) $('#question').value = saved;

    $('#nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) switchTab(b.dataset.tab); });
    $('#question').addEventListener('input', (e) => store.set('gc_question', e.target.value));
    $('#addFilesBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', async (e) => { const f = [...e.target.files]; e.target.value = ''; await ingest(f); });
    $('#sampleBtn').addEventListener('click', addSample);
    $('#runBtn').addEventListener('click', analyse);
    $('#clearBtn').addEventListener('click', () => { $('#question').value = ''; store.del('gc_question'); state.current = null; renderRun(null); });
    $('#toolType').addEventListener('change', () => { $('#toolForm').dataset.type = ''; renderToolForm(); });
    $('#toolForm').addEventListener('change', (e) => { if (e.target.id === 'toolTable') renderToolForm(); });
    $('#toolRun').addEventListener('click', runTool);
    $('#toolExample').addEventListener('click', () => { const t = TOOLS[toolType]; if (t.example && $('#toolJson')) $('#toolJson').value = JSON.stringify(t.example, null, 2); });

    $('#toggleKey').addEventListener('click', () => { const i = $('#apiKey'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('#toggleKey').textContent = show ? 'Hide' : 'Show'; });
    $('#saveKey').addEventListener('click', () => {
      state.apiKey = $('#apiKey').value.trim(); state.model = $('#model').value.trim() || 'gpt-4o-mini';
      store.set('gc_key', state.apiKey); store.set('gc_model', state.model); updateAIBadge();
      keyStatus(state.apiKey ? 'Saved on this device.' : 'No key saved - AI is off.', state.apiKey ? 'ok' : '');
      toast('Settings saved');
    });
    $('#testKey').addEventListener('click', async () => {
      const k = $('#apiKey').value.trim(); if (!k) { keyStatus('Enter a key first.', 'err'); return; }
      keyStatus('Checking…'); try { await AI.testKey(k); keyStatus('Key accepted by OpenAI.', 'ok'); } catch (e) { keyStatus(e.message, 'err'); }
    });
    $('#importKey').addEventListener('click', () => $('#keyFile').click());
    $('#keyFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const m = (await f.text()).match(/sk-[A-Za-z0-9_\-]{20,}/);
        if (!m) { keyStatus('No OpenAI key (starting with sk-) found in that file.', 'err'); return; }
        state.apiKey = m[0]; state.model = $('#model').value.trim() || 'gpt-4o-mini';
        store.set('gc_key', state.apiKey); store.set('gc_model', state.model); $('#apiKey').value = state.apiKey; updateAIBadge();
        keyStatus('Key imported and saved on this device.', 'ok'); toast('AI is on');
      } catch (err) { keyStatus('Could not read that file.', 'err'); }
    });
    $('#removeKey').addEventListener('click', () => { state.apiKey = ''; store.del('gc_key'); $('#apiKey').value = ''; updateAIBadge(); keyStatus('Key removed from this device.', 'ok'); });

    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-example],[data-remove-file],[data-open-run],[data-share-run],[data-share-json],[data-share-csv],#dataAdd,#dataSample,#toolSample,#clearHistory');
      if (!t) return;
      if (t.dataset.example !== undefined) { $('#question').value = t.dataset.example; store.set('gc_question', t.dataset.example); }
      else if (t.dataset.removeFile !== undefined) removeFile(t.dataset.removeFile);
      else if (t.dataset.openRun !== undefined) { const r = state.runs[+t.dataset.openRun]; state.current = r; $('#question').value = r.question; switchTab('analyze'); renderRun(r); }
      else if (t.dataset.shareRun !== undefined) { if (state.current) shareText('GC Optimiser analysis', summaryText(state.current)); }
      else if (t.dataset.shareJson !== undefined) { if (state.current) { const c = { ...state.current }; delete c.doc_context; shareText('GC Optimiser analysis (JSON)', JSON.stringify(c, null, 2)); } }
      else if (t.dataset.shareCsv !== undefined) shareText('Forecast CSV', registry.get(+t.dataset.shareCsv));
      else if (t.id === 'dataAdd') $('#fileInput').click();
      else if (t.id === 'dataSample' || t.id === 'toolSample') addSample();
      else if (t.id === 'clearHistory') { state.runs = []; store.del('gc_runs'); renderHistory(); }
    });

    if (state.current) renderRun(state.current);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
