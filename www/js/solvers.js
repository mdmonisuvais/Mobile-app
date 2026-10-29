/* GC Optimiser - deterministic solvers (JavaScript port of the Streamlit/SciPy engine).
 * Works in the browser (window.GC.solvers) and in Node (module.exports) for tests.
 * AI-generated code is never executed: the AI only proposes a JSON spec that these functions validate.
 */
(function (root) {
  'use strict';

  const num = (v, label = 'value') => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') throw new Error(`${label} must be numeric.`);
    const x = Number(v);
    if (!Number.isFinite(x)) throw new Error(`${label} must be a finite number.`);
    return x;
  };
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const round = (x, d = 8) => Math.round(x * 10 ** d) / 10 ** d;

  /* ------------------------------ Simplex (LP) ------------------------------ */
  // maximise c.x subject to rows [{a, op, rhs}], x >= 0. Two-phase tableau simplex with Bland's rule.
  function simplex(c, rows) {
    const n = c.length, m = rows.length;
    const R = rows.map((r) => {
      let a = r.a.slice(), op = r.op, rhs = r.rhs;
      if (rhs < 0) { a = a.map((v) => -v); rhs = -rhs; op = op === '<=' ? '>=' : op === '>=' ? '<=' : '='; }
      return { a, op, rhs };
    });
    let nSlack = 0, nArt = 0;
    R.forEach((r) => { if (r.op === '<=') nSlack++; else if (r.op === '>=') { nSlack++; nArt++; } else nArt++; });
    const N = n + nSlack + nArt, artStart = n + nSlack;
    const T = [], basis = [];
    let si = n, ai = artStart;
    R.forEach((r) => {
      const row = new Array(N + 1).fill(0);
      for (let j = 0; j < n; j++) row[j] = r.a[j];
      row[N] = r.rhs;
      if (r.op === '<=') { row[si] = 1; basis.push(si); si++; }
      else if (r.op === '>=') { row[si] = -1; si++; row[ai] = 1; basis.push(ai); ai++; }
      else { row[ai] = 1; basis.push(ai); ai++; }
      T.push(row);
    });
    const pivot = (pr, pc) => {
      const pv = T[pr][pc];
      for (let j = 0; j <= N; j++) T[pr][j] /= pv;
      for (let i = 0; i < m; i++) {
        if (i === pr) continue;
        const f = T[i][pc];
        if (Math.abs(f) > 1e-13) for (let j = 0; j <= N; j++) T[i][j] -= f * T[pr][j];
      }
      basis[pr] = pc;
    };
    const run = (cost, allowed) => {
      for (let iter = 0; iter < 20000; iter++) {
        let enter = -1;
        for (let j = 0; j < N; j++) {
          if (!allowed(j)) continue;
          let d = cost[j];
          for (let i = 0; i < m; i++) d -= cost[basis[i]] * T[i][j];
          if (d > 1e-9) { enter = j; break; }
        }
        if (enter < 0) return 'optimal';
        let leave = -1, best = Infinity;
        for (let i = 0; i < m; i++) {
          if (T[i][enter] > 1e-9) {
            const ratio = T[i][N] / T[i][enter];
            if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && leave >= 0 && basis[i] < basis[leave])) { best = ratio; leave = i; }
          }
        }
        if (leave < 0) return 'unbounded';
        pivot(leave, enter);
      }
      return 'iteration_limit';
    };
    if (nArt > 0) {
      const cost1 = new Array(N).fill(0);
      for (let j = artStart; j < N; j++) cost1[j] = -1;
      run(cost1, () => true);
      let infeas = 0;
      for (let i = 0; i < m; i++) if (basis[i] >= artStart) infeas += T[i][N];
      if (infeas > 1e-7) return { status: 'infeasible' };
      for (let i = 0; i < m; i++) {
        if (basis[i] >= artStart) {
          for (let j = 0; j < artStart; j++) if (Math.abs(T[i][j]) > 1e-9) { pivot(i, j); break; }
        }
      }
    }
    const cost2 = new Array(N).fill(0);
    for (let j = 0; j < n; j++) cost2[j] = c[j];
    const status = run(cost2, (j) => j < artStart);
    if (status !== 'optimal') return { status };
    const x = new Array(n).fill(0);
    for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][N];
    return { status: 'optimal', x };
  }

  function solveLP(spec) {
    const names = spec.variable_names || [];
    const c = (spec.objective_coefficients || []).map((v) => num(v, 'objective coefficient'));
    if (!c.length || c.length !== names.length || new Set(names).size !== names.length)
      throw new Error('LP needs a unique name and objective coefficient for each variable.');
    const sense = String(spec.objective_sense || 'max').toLowerCase();
    if (!['max', 'min'].includes(sense)) throw new Error('Objective sense must be max or min.');
    const n = c.length;
    let bounds = spec.bounds;
    if (bounds && bounds.length) {
      if (bounds.length !== n) throw new Error('Provide one bound pair per variable.');
      bounds = bounds.map((b) => [b[0] === null || b[0] === undefined ? null : num(b[0]), b[1] === null || b[1] === undefined ? null : num(b[1])]);
    } else bounds = Array.from({ length: n }, () => [0, null]);
    // substitute x_i = offset_i + sum(coef * y_col)
    const map = [];
    let ny = 0;
    const extra = [];
    bounds.forEach(([lo, hi], i) => {
      if (lo !== null) {
        map.push({ off: lo, cols: [[ny, 1]] });
        if (hi !== null) { if (hi < lo) throw new Error('Upper bound below lower bound.'); extra.push({ col: ny, rhs: hi - lo }); }
        ny++;
      } else if (hi !== null) { map.push({ off: hi, cols: [[ny, -1]] }); ny++; }
      else { map.push({ off: 0, cols: [[ny, 1], [ny + 1, -1]] }); ny += 2; }
    });
    const rows = [];
    for (const con of spec.constraints || []) {
      const a = (con.coefficients || []).map((v) => num(v, 'constraint coefficient'));
      if (a.length !== n) throw new Error('Constraint coefficient count does not match variables.');
      let op = con.sense || '<=';
      if (op === '<') op = '<='; if (op === '>') op = '>=';
      if (!['<=', '>=', '='].includes(op)) throw new Error('Constraint sense must be <=, >=, or =.');
      let rhs = num(con.rhs, 'constraint RHS');
      const ay = new Array(ny).fill(0);
      a.forEach((ai, i) => { rhs -= ai * map[i].off; map[i].cols.forEach(([col, k]) => { ay[col] += ai * k; }); });
      rows.push({ a: ay, op, rhs });
    }
    extra.forEach(({ col, rhs }) => { const a = new Array(ny).fill(0); a[col] = 1; rows.push({ a, op: '<=', rhs }); });
    const sign = sense === 'max' ? 1 : -1;
    const cy = new Array(ny).fill(0);
    c.forEach((ci, i) => map[i].cols.forEach(([col, k]) => { cy[col] += sign * ci * k; }));
    const res = simplex(cy, rows);
    const solver = 'Two-phase simplex (linear programming)';
    if (res.status === 'infeasible') return { success: false, solver, message: 'The constraints are infeasible - no solution satisfies all of them.' };
    if (res.status === 'unbounded') return { success: false, solver, message: 'The problem is unbounded - the objective can improve without limit. Add a constraint.' };
    if (res.status !== 'optimal') return { success: false, solver, message: 'The simplex iteration limit was reached.' };
    const x = map.map((mm) => mm.off + sum(mm.cols.map(([col, k]) => k * res.x[col])));
    const variables = {};
    names.forEach((nm, i) => { variables[nm] = round(x[i]); });
    return {
      success: true, solver, objective_value: round(sum(c.map((ci, i) => ci * x[i]))), variables,
      note: 'Continuous linear programming solution; integer restrictions are not inferred.',
    };
  }

  /* ------------------------- Resource allocation (0/1) ------------------------ */
  function knapsackBB(values, costs, cap) {
    const idx = values.map((_, i) => i).filter((i) => values[i] > 0)
      .sort((a, b) => values[b] / (costs[b] || 1e-12) - values[a] / (costs[a] || 1e-12));
    let best = 0, bestSet = [], nodes = 0;
    const cur = [];
    const bound = (k, w, v) => {
      let r = cap - w, b = v;
      for (let t = k; t < idx.length; t++) {
        const i = idx[t];
        if (costs[i] <= r) { r -= costs[i]; b += values[i]; }
        else { b += costs[i] > 0 ? (values[i] * r) / costs[i] : 0; break; }
      }
      return b;
    };
    const LIMIT = 4e6;
    const dfs = (k, w, v) => {
      if (++nodes > LIMIT) return;
      if (v > best) { best = v; bestSet = cur.slice(); }
      if (k >= idx.length || bound(k, w, v) <= best + 1e-12) return;
      const i = idx[k];
      if (w + costs[i] <= cap + 1e-9) { cur.push(i); dfs(k + 1, w + costs[i], v + values[i]); cur.pop(); }
      dfs(k + 1, w, v);
    };
    dfs(0, 0, 0);
    return { best, set: bestSet, complete: nodes <= LIMIT };
  }

  function solveKnapsack(table, spec) {
    const vc = spec.value_column, cc = spec.cost_column;
    if (!table.columns.includes(vc) || !table.columns.includes(cc))
      throw new Error('The solver specification referenced a column not present in the selected table.');
    const capacity = num(spec.capacity, 'capacity');
    if (capacity < 0) throw new Error('Capacity cannot be negative.');
    const nameCol = table.columns.includes(spec.name_column) ? spec.name_column : null;
    const items = [];
    table.rows.forEach((r, i) => {
      const v = Number(r[vc]), c = Number(r[cc]);
      if (r[vc] === null || r[cc] === null || r[vc] === '' || r[cc] === '' || !Number.isFinite(v) || !Number.isFinite(c) || c < 0) return;
      items.push({ name: nameCol ? String(r[nameCol]) : `Row ${i + 1}`, benefit: v, cost: c });
    });
    if (!items.length) throw new Error('No valid rows with numeric benefit and non-negative cost were found.');
    const res = knapsackBB(items.map((x) => x.benefit), items.map((x) => x.cost), capacity);
    const chosen = res.set.map((i) => items[i]);
    return {
      success: true,
      solver: res.complete ? 'Exact 0/1 knapsack (branch and bound)' : 'Knapsack branch and bound (search limit reached - best found)',
      selected: chosen, total_benefit: round(sum(chosen.map((x) => x.benefit))), total_cost: round(sum(chosen.map((x) => x.cost))), capacity,
      note: 'Optimal for the stated 0/1 model. Result quality depends on whether benefit and cost columns reflect the real decision.',
    };
  }

  /* ------------------------------- Forecasting ------------------------------- */
  function linfit(ys, ts) {
    const n = ys.length; let st = 0, sy = 0, stt = 0, sty = 0;
    for (let i = 0; i < n; i++) { st += ts[i]; sy += ys[i]; stt += ts[i] * ts[i]; sty += ts[i] * ys[i]; }
    const den = n * stt - st * st;
    const slope = den === 0 ? 0 : (n * sty - st * sy) / den;
    return { slope, intercept: (sy - slope * st) / n };
  }

  // Linear trend x multiplicative seasonal index (period m; m<2 means no seasonality).
  function fitTrendSeasonal(y, m) {
    const n = y.length, t = y.map((_, i) => i);
    let s = new Array(Math.max(m, 1)).fill(1);
    let fit = linfit(y, t);
    if (m >= 2 && n >= 2 * m && y.every((v) => v > 0)) {
      for (let it = 0; it < 3; it++) {
        const ratios = Array.from({ length: m }, () => []);
        for (let i = 0; i < n; i++) { const tr = fit.intercept + fit.slope * i; if (tr > 0) ratios[i % m].push(y[i] / tr); }
        s = ratios.map((r) => (r.length ? sum(r) / r.length : 1));
        const mean = sum(s) / m; s = s.map((v) => v / mean);
        fit = linfit(y.map((v, i) => v / s[i % m]), t);
      }
    } else m = 0;
    return { fit, s, m, predict: (i) => Math.max(0, (fit.intercept + fit.slope * i) * (m ? s[i % m] : 1)) };
  }

  function monthsBetween(a, b) { return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()); }
  function fmtDate(d, monthly) {
    const p = (x) => String(x).padStart(2, '0');
    return monthly ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}` : `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }

  function solveForecast(table, spec) {
    const target = spec.target_column, dateCol = spec.date_column;
    if (!table.columns.includes(target) || !table.columns.includes(dateCol)) throw new Error('Forecast specification references a missing date or target column.');
    const horizon = parseInt(spec.horizon ?? 4, 10);
    if (!(horizon >= 1 && horizon <= 60)) throw new Error('Forecast horizon must be between 1 and 60 periods.');
    const groupCol = spec.group_column, groupVal = spec.group_value;
    const bucket = new Map();
    for (const r of table.rows) {
      if (groupCol && table.columns.includes(groupCol) && groupVal !== null && groupVal !== undefined && String(r[groupCol]) !== String(groupVal)) continue;
      const ts = Date.parse(String(r[dateCol]).length === 7 ? `${r[dateCol]}-01` : r[dateCol]);
      const v = Number(r[target]);
      if (!Number.isFinite(ts) || r[target] === null || r[target] === '' || !Number.isFinite(v)) continue;
      const b = bucket.get(ts) || { s: 0, n: 0 }; b.s += v; b.n++; bucket.set(ts, b);
    }
    const pts = [...bucket.entries()].sort((a, b) => a[0] - b[0]).map(([ts, b]) => ({ ts, y: b.s / b.n }));
    if (pts.length < 2) throw new Error('At least two distinct dates with numeric observations are required.');
    const y = pts.map((p) => p.y), n = y.length;
    const dates = pts.map((p) => new Date(p.ts));
    const monthly = dates.every((d) => d.getUTCDate() === 1) && n >= 3 && dates.slice(1).every((d, i) => monthsBetween(dates[i], d) >= 1);
    const gaps = pts.slice(1).map((p, i) => (p.ts - pts[i].ts) / 864e5).sort((a, b) => a - b);
    const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 30;
    const stepMonths = monthly ? Math.max(1, Math.round(monthsBetween(dates[0], dates[n - 1]) / (n - 1))) : 0;
    let guess = parseInt(spec.seasonal_period || 0, 10) || 0;
    if (guess < 2) {
      if (monthly && stepMonths === 1) guess = 12; else if (monthly && stepMonths === 3) guess = 4;
      else if (!monthly && medGap === 1) guess = 7; else if (!monthly && medGap === 7) guess = 52;
    }
    // choose seasonal vs non-seasonal by hold-out error
    const h = Math.max(1, Math.min(horizon, Math.floor(n / 4)));
    const candidates = [0]; if (guess >= 2) candidates.push(guess);
    const evaln = candidates.map((m) => {
      if (n - h < 3 || (m >= 2 && n - h < 2 * m)) return { m, mae: Infinity, errs: [] };
      const model = fitTrendSeasonal(y.slice(0, n - h), m);
      if (m >= 2 && !model.m) return { m, mae: Infinity, errs: [] };
      const errs = [];
      for (let i = 0; i < h; i++) errs.push(y[n - h + i] - model.predict(n - h + i));
      return { m, mae: sum(errs.map(Math.abs)) / h, errs };
    });
    evaln.sort((a, b) => a.mae - b.mae);
    const chosen = evaln[0].mae === Infinity ? { m: 0, mae: null, errs: [] } : evaln[0];
    const model = fitTrendSeasonal(y, chosen.m);
    const mUsed = model.m;
    const sigma = chosen.errs.length ? Math.sqrt(sum(chosen.errs.map((e) => e * e)) / chosen.errs.length)
      : Math.sqrt(sum(y.map((v, i) => (v - model.predict(i)) ** 2)) / n);
    // naive baseline on the same hold-out (last observed value / seasonal naive)
    let naiveMae = null;
    if (chosen.errs.length) {
      const e = [];
      for (let i = 0; i < h; i++) {
        const base = mUsed >= 2 && n - h - mUsed + i >= 0 ? y[n - h - mUsed + i] : y[n - h - 1];
        e.push(Math.abs(y[n - h + i] - base));
      }
      naiveMae = sum(e) / h;
    }
    const future = [];
    const last = dates[n - 1];
    for (let k = 1; k <= horizon; k++) {
      let d;
      if (monthly) d = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + stepMonths * k, 1));
      else d = new Date(last.getTime() + medGap * k * 864e5);
      const p = model.predict(n - 1 + k);
      const w = 1.2816 * sigma * Math.sqrt(k);
      future.push({ date: fmtDate(d, monthly), forecast: round(p, 2), lower: round(Math.max(0, p - w), 2), upper: round(p + w, 2) });
    }
    const mape = chosen.errs.length ? (sum(chosen.errs.map((e, i) => Math.abs(e) / Math.abs(y[n - h + i] || 1))) / h) * 100 : null;
    return {
      success: true,
      solver: mUsed ? `Linear trend with multiplicative seasonality (period ${mUsed})` : 'Linear trend baseline',
      forecast_table: future, history: pts.map((p, i) => ({ date: fmtDate(dates[i], monthly), value: round(p.y, 2) })),
      target_name: target, history_points: n, backtest_mae: chosen.mae === null ? null : round(chosen.mae, 2),
      backtest_mape: mape === null ? null : round(mape, 2), naive_mae: naiveMae === null ? null : round(naiveMae, 2),
      holdout_periods: chosen.errs.length ? h : 0, seasonal_period: mUsed,
      note: 'Forecasts are estimates, not causal explanations. The 80% range comes from hold-out error and is indicative only. Validate against your own business baseline.',
    };
  }

  /* ------------------------------ Quadratic program ------------------------------ */
  function solveQuadratic(spec) {
    const names = spec.variable_names || [];
    const n = names.length;
    const c = (spec.linear_coefficients || []).map((v) => num(v, 'linear coefficient'));
    const Q = (spec.quadratic_matrix || []).map((r) => r.map((v) => num(v, 'quadratic coefficient')));
    if (n < 1 || c.length !== n || new Set(names).size !== n || Q.length !== n || Q.some((r) => r.length !== n))
      throw new Error('Quadratic optimisation needs unique variable names, n linear coefficients and an n x n quadratic matrix.');
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (Math.abs(Q[i][j] - Q[j][i]) > 1e-8) throw new Error('Quadratic matrix must be symmetric.');
    const sense = String(spec.objective_sense || 'min').toLowerCase();
    if (!['min', 'max'].includes(sense)) throw new Error('Objective sense must be min or max.');
    const sg = sense === 'min' ? 1 : -1;
    const cons = (spec.constraints || []).map((k) => {
      const a = (k.coefficients || []).map((v) => num(v, 'constraint coefficient'));
      if (a.length !== n) throw new Error('Each constraint must have one coefficient per variable.');
      if (!['<=', '>=', '='].includes(k.sense || '<=')) throw new Error('Constraint sense must be <=, >=, or =.');
      return { a, op: k.sense || '<=', rhs: num(k.rhs, 'constraint RHS') };
    });
    const bounds = (spec.bounds && spec.bounds.length ? spec.bounds : names.map(() => [0, null])).map((b) => [b[0] ?? -Infinity, b[1] ?? Infinity]);
    if (bounds.length !== n) throw new Error('Provide one bound pair per variable.');
    const f = (x) => { let q = 0; for (let i = 0; i < n; i++) { let r = 0; for (let j = 0; j < n; j++) r += Q[i][j] * x[j]; q += x[i] * r; } return sg * (0.5 * q + sum(c.map((ci, i) => ci * x[i]))); };
    const grad = (x) => x.map((_, i) => { let r = c[i]; for (let j = 0; j < n; j++) r += Q[i][j] * x[j]; return sg * r; });
    const viol = (x) => cons.map((k) => { const v = sum(k.a.map((ai, i) => ai * x[i])) - k.rhs; return k.op === '<=' ? Math.max(0, v) : k.op === '>=' ? Math.max(0, -v) : v; });
    const clamp = (x) => x.map((v, i) => Math.min(bounds[i][1], Math.max(bounds[i][0], v)));
    let bestX = null, bestVal = Infinity, bestViol = Infinity;
    const starts = [];
    starts.push(bounds.map(([lo, hi]) => (Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo + 1 : Number.isFinite(hi) ? hi - 1 : 0)));
    for (let s = 0; s < 4; s++) starts.push(bounds.map(([lo, hi]) => { const l = Number.isFinite(lo) ? lo : -10, h = Number.isFinite(hi) ? hi : l + 20; return l + Math.random() * (h - l); }));
    for (const x0 of starts) {
      let x = clamp(x0.slice());
      for (const mu of [10, 100, 1e3, 1e4, 1e5, 1e6]) {
        const pen = (z) => f(z) + mu * sum(viol(z).map((v) => v * v));
        const pgrad = (z) => {
          const g = grad(z), vv = viol(z);
          cons.forEach((k, ci) => { if (vv[ci] !== 0) k.a.forEach((ai, i) => { g[i] += 2 * mu * vv[ci] * ai * (k.op === '>=' ? -1 : 1); }); });
          return g;
        };
        let step = 1 / (1 + mu);
        for (let it = 0; it < 1500; it++) {
          const g = pgrad(x), fx = pen(x);
          let s2 = step * 4, moved = false;
          for (let ls = 0; ls < 30; ls++) {
            const xn = clamp(x.map((v, i) => v - s2 * g[i]));
            if (pen(xn) < fx - 1e-14) { x = xn; step = s2; moved = true; break; }
            s2 /= 2;
          }
          if (!moved) break;
        }
      }
      const v = Math.max(0, ...viol(x).map(Math.abs));
      const val = f(x);
      if (v < 1e-4 && (bestX === null || val < bestVal || bestViol > 1e-4)) { bestX = x; bestVal = val; bestViol = v; }
      else if (bestX === null && v < bestViol) { bestViol = v; }
    }
    const solver = 'Penalty gradient method (quadratic objective, linear constraints)';
    if (!bestX) return { success: false, solver, message: 'No feasible point was found. Check the constraints and bounds.', note: 'This local solver may fail on infeasible or non-convex models.' };
    const variables = {}; names.forEach((nm, i) => { variables[nm] = round(bestX[i], 6); });
    return {
      success: true, solver, objective_value: round(0.5 * (() => { let q = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) q += bestX[i] * Q[i][j] * bestX[j]; return q; })() + sum(c.map((ci, i) => ci * bestX[i])), 6), variables,
      note: 'Local nonlinear result, not a guarantee of global optimality. Constraints are enforced to about 1e-4. Validate feasibility; for non-convex models try several formulations.',
    };
  }

  /* ----------------------------- Inventory lot sizing ----------------------------- */
  function solveInventory(spec) {
    const demand = (spec.demands || []).map((x) => num(x, 'period demand'));
    if (!demand.length || demand.some((x) => x < 0)) throw new Error('Inventory planning requires a non-empty list of non-negative period demands.');
    const setup = num(spec.fixed_order_cost, 'fixed order cost');
    const holding = num(spec.holding_cost_per_unit_per_period, 'holding cost');
    const unit = num(spec.unit_cost ?? 0, 'unit cost');
    if (Math.min(setup, holding, unit) < 0) throw new Error('Order, holding and unit costs must be non-negative.');
    const n = demand.length;
    const dp = new Array(n + 1).fill(Infinity), prev = new Array(n + 1).fill(-1);
    dp[0] = 0;
    for (let end = 1; end <= n; end++) for (let start = 0; start < end; start++) {
      let carry = 0; for (let k = start; k < end; k++) carry += demand[k] * (k - start) * holding;
      const cost = dp[start] + setup + carry;
      if (cost < dp[end]) { dp[end] = cost; prev[end] = start; }
    }
    const orders = new Array(n).fill(0);
    for (let end = n; end > 0;) { const st = prev[end]; orders[st] = sum(demand.slice(st, end)); end = st; }
    const purchase = sum(demand) * unit;
    return {
      success: true, solver: 'Exact dynamic-programming lot sizing (Wagner-Whitin)',
      schedule: demand.map((d, i) => ({ period: i + 1, demand: d, order_quantity: orders[i] })),
      setup_and_holding_cost: round(dp[n], 4), estimated_purchase_cost: round(purchase, 4), total_cost: round(dp[n] + purchase, 4),
      note: 'Assumes deterministic demand, no shortages, no opening inventory, constant unit cost, fixed order cost and linear holding cost. Lead times and capacity limits are not modelled.',
    };
  }

  /* ------------------------------ Two-stage stochastic ------------------------------ */
  function solveStochastic(spec) {
    const names = spec.project_names || [];
    const n = names.length;
    const costs = (spec.first_stage_costs || []).map((v) => num(v, 'first-stage cost'));
    const probs = (spec.scenario_probabilities || []).map((v) => num(v, 'scenario probability'));
    const rets = (spec.scenario_returns || []).map((r) => r.map((v) => num(v, 'scenario return')));
    const w = (spec.scenario_resource_weights || []).map((v) => num(v, 'resource weight'));
    const caps = (spec.scenario_capacities || []).map((v) => num(v, 'scenario capacity'));
    const budget = num(spec.budget, 'budget');
    const s = probs.length;
    if (n < 1 || new Set(names).size !== n || costs.length !== n || w.length !== n) throw new Error('Provide unique project names and one cost and resource weight per project.');
    if (rets.length !== s || rets.some((r) => r.length !== n) || caps.length !== s) throw new Error('Scenario returns must be an S x N matrix and each scenario needs one capacity.');
    if ([...costs, ...w, ...caps, ...probs, budget].some((v) => v < 0)) throw new Error('Costs, weights, capacities, budget and probabilities must be non-negative.');
    if (Math.abs(sum(probs) - 1) > 1e-5) throw new Error('Scenario probabilities must sum to 1.');
    if (n > 18) throw new Error('This on-device solver supports up to 18 projects.');
    let best = null;
    for (let mask = 0; mask < 1 << n; mask++) {
      let cost = 0; for (let i = 0; i < n; i++) if (mask & (1 << i)) cost += costs[i];
      if (cost > budget + 1e-9) continue;
      const dep = []; let exp = 0;
      for (let si = 0; si < s; si++) {
        const y = new Array(n).fill(0); let cap = caps[si];
        const order = []; for (let i = 0; i < n; i++) if (mask & (1 << i) && rets[si][i] > 0) order.push(i);
        order.sort((a, b) => rets[si][b] / (w[b] || 1e-12) - rets[si][a] / (w[a] || 1e-12));
        for (const i of order) { if (w[i] === 0) y[i] = 1; else { const f = Math.min(1, cap / w[i]); y[i] = Math.max(0, f); cap -= w[i] * y[i]; } }
        dep.push(y); exp += probs[si] * sum(y.map((yi, i) => yi * rets[si][i]));
      }
      if (!best || exp > best.exp + 1e-12) best = { mask, exp, dep, cost };
    }
    if (!best) return { success: false, solver: 'Two-stage scenario model', message: 'No project selection fits within the budget.' };
    return {
      success: true, solver: 'Two-stage scenario model (exact enumeration + fractional deployment)',
      selected_projects: names.filter((_, i) => best.mask & (1 << i)), first_stage_cost: round(best.cost), expected_scenario_return: round(best.exp),
      scenario_outcomes: best.dep.map((y, si) => ({ scenario: si + 1, probability: probs[si], return: round(sum(y.map((v, i) => v * rets[si][i]))), deployment: Object.fromEntries(names.map((nm, i) => [nm, round(y[i], 4)])) })),
      note: 'Prototype formulation: binary first-stage selection, fractional scenario deployment, one resource capacity per scenario. Confirm it matches the business process.',
    };
  }

  /* -------------------------------- Assignment (Hungarian) -------------------------------- */
  function solveAssignment(spec) {
    const M = spec.cost_matrix;
    if (!Array.isArray(M) || !M.length || !Array.isArray(M[0]) || M.some((r) => r.length !== M[0].length)) throw new Error('Assignment requires a rectangular numeric cost matrix.');
    const cost = M.map((r) => r.map((v) => num(v, 'cost')));
    let n = cost.length, m = cost[0].length, tr = false, a = cost;
    if (n > m) { a = cost[0].map((_, j) => cost.map((r) => r[j])); [n, m] = [m, n]; tr = true; }
    const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const pairs = [];
    for (let j = 1; j <= m; j++) if (p[j]) { const r = p[j] - 1, c = j - 1; pairs.push(tr ? { row: c, column: r } : { row: r, column: c }); }
    pairs.sort((x, y) => x.row - y.row);
    pairs.forEach((pr) => { pr.cost = cost[pr.row][pr.column]; });
    return { success: true, solver: 'Hungarian assignment algorithm', assignments: pairs, total_cost: round(sum(pairs.map((x) => x.cost))), note: 'Rows and columns are zero-indexed; map them to real entities before acting.' };
  }

  /* ------------------------------- TSP (Held-Karp) ------------------------------- */
  function solveTSP(spec) {
    const D = spec.distance_matrix;
    if (!Array.isArray(D) || D.length < 2 || D.some((r) => !Array.isArray(r) || r.length !== D.length)) throw new Error('TSP requires a square distance matrix with at least two locations.');
    const d = D.map((r) => r.map((v) => { const x = num(v, 'distance'); if (x < 0) throw new Error('Distances must be non-negative.'); return x; }));
    const n = d.length;
    if (n > 15) throw new Error('Exact TSP on-device supports up to 15 locations.');
    const k = n - 1, N = 1 << k;
    const dp = new Float64Array(N * k).fill(Infinity), par = new Int8Array(N * k).fill(-1);
    for (let j = 0; j < k; j++) dp[(1 << j) * k + j] = d[0][j + 1];
    for (let mask = 1; mask < N; mask++) for (let j = 0; j < k; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * k + j]; if (cur === Infinity) continue;
      for (let t = 0; t < k; t++) {
        if (mask & (1 << t)) continue;
        const nm = mask | (1 << t), val = cur + d[j + 1][t + 1];
        if (val < dp[nm * k + t]) { dp[nm * k + t] = val; par[nm * k + t] = j; }
      }
    }
    let bestJ = 0, bestC = Infinity;
    for (let j = 0; j < k; j++) { const c = dp[(N - 1) * k + j] + d[j + 1][0]; if (c < bestC) { bestC = c; bestJ = j; } }
    const route = [0]; const rev = []; let mask = N - 1, j = bestJ;
    while (j >= 0) { rev.push(j + 1); const pj = par[mask * k + j]; mask ^= 1 << j; j = pj; }
    route.push(...rev.reverse(), 0);
    return { success: true, solver: 'Exact TSP (Held-Karp dynamic programming)', route, total_distance: round(bestC), note: 'Route indices are zero-based; map them to real locations before use.' };
  }

  /* -------------------------------- Set covering (greedy) -------------------------------- */
  function solveSetCover(spec) {
    const universe = new Set((spec.universe || []).map(String));
    const sets = (spec.sets || []).map((s) => new Set(s.map(String)));
    const remaining = new Set(universe), chosen = [];
    while (remaining.size) {
      let gain = 0, idx = -1;
      sets.forEach((s, i) => { let g = 0; s.forEach((e) => { if (remaining.has(e)) g++; }); if (g > gain) { gain = g; idx = i; } });
      if (idx < 0) break;
      chosen.push(idx); sets[idx].forEach((e) => remaining.delete(e));
    }
    return { success: remaining.size === 0, solver: 'Greedy set-cover approximation', selected_set_indices: chosen, uncovered_elements: [...remaining].sort(), message: remaining.size ? 'Some elements cannot be covered by any set.' : undefined, note: 'Greedy is not guaranteed minimal; validate coverage.' };
  }

  /* ------------------------------------ Dispatcher ------------------------------------ */
  function pickTable(tables, spec) {
    const names = Object.keys(tables);
    if (!names.length) throw new Error('This analysis requires an uploaded tabular dataset.');
    const t = spec.table_name ? tables[spec.table_name] : tables[names[0]];
    if (!t) throw new Error('The specified table was not found.');
    return t;
  }

  function solveStructured(problemType, spec, tables) {
    if (!spec || typeof spec !== 'object') return null;
    switch (problemType) {
      case 'linear_programming': return solveLP(spec);
      case 'nonlinear_programming': return solveQuadratic(spec);
      case 'inventory_planning': case 'dynamic_programming': return solveInventory(spec);
      case 'two_stage_stochastic': return solveStochastic(spec);
      case 'resource_allocation': return solveKnapsack(pickTable(tables, spec), spec);
      case 'forecasting': return solveForecast(pickTable(tables, spec), spec);
      case 'assignment': return solveAssignment(spec);
      case 'tsp': return solveTSP(spec);
      case 'set_covering': return solveSetCover(spec);
      default: return null;
    }
  }

  const API = { solveLP, solveKnapsack, solveForecast, solveQuadratic, solveInventory, solveStochastic, solveAssignment, solveTSP, solveSetCover, solveStructured };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else { root.GC = root.GC || {}; root.GC.solvers = API; }
})(typeof window !== 'undefined' ? window : globalThis);
