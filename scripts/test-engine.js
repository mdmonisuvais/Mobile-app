// Sanity tests for the solver engine: node scripts/test-engine.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const S = require('../www/js/solvers.js');
const U = require('../www/js/util.js');
const close = (a, b, t = 1e-6) => assert(Math.abs(a - b) <= t, `${a} !~ ${b}`);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

ok('LP max with <= constraints', () => {
  const r = S.solveLP({ variable_names: ['x', 'y'], objective_coefficients: [3, 5], objective_sense: 'max',
    constraints: [{ coefficients: [1, 0], sense: '<=', rhs: 4 }, { coefficients: [0, 2], sense: '<=', rhs: 12 }, { coefficients: [3, 2], sense: '<=', rhs: 18 }] });
  assert(r.success); close(r.objective_value, 36); close(r.variables.x, 2); close(r.variables.y, 6);
});
ok('LP min with >= and = constraints (diet style)', () => {
  const r = S.solveLP({ variable_names: ['a', 'b'], objective_coefficients: [2, 3], objective_sense: 'min',
    constraints: [{ coefficients: [1, 1], sense: '>=', rhs: 10 }, { coefficients: [1, -1], sense: '=', rhs: 2 }] });
  assert(r.success); close(r.objective_value, 2 * 6 + 3 * 4);
});
ok('LP infeasible / unbounded detection', () => {
  assert(!S.solveLP({ variable_names: ['x'], objective_coefficients: [1], constraints: [{ coefficients: [1], sense: '<=', rhs: 1 }, { coefficients: [1], sense: '>=', rhs: 2 }] }).success);
  const u = S.solveLP({ variable_names: ['x'], objective_coefficients: [1], objective_sense: 'max', constraints: [] });
  assert(!u.success && /unbounded/i.test(u.message));
});
ok('LP with bounds and negative lower bound', () => {
  const r = S.solveLP({ variable_names: ['x', 'y'], objective_coefficients: [1, 1], objective_sense: 'min', bounds: [[-5, 5], [-2, null]], constraints: [{ coefficients: [1, 1], sense: '>=', rhs: -3 }] });
  assert(r.success); close(r.objective_value, -3);
});
ok('knapsack matches brute force', () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ n: 'p' + i, v: (i * 37 % 17) + 3, c: (i * 53 % 11) + 2 }));
  const t = { columns: ['n', 'v', 'c'], rows, types: {} };
  const r = S.solveKnapsack(t, { name_column: 'n', value_column: 'v', cost_column: 'c', capacity: 30 });
  let best = 0; for (let m = 0; m < 1 << 14; m++) { let c = 0, v = 0; for (let i = 0; i < 14; i++) if (m >> i & 1) { c += rows[i].c; v += rows[i].v; } if (c <= 30 && v > best) best = v; }
  close(r.total_benefit, best); assert(r.total_cost <= 30);
});
ok('assignment (Hungarian) incl. rectangular', () => {
  const r = S.solveAssignment({ cost_matrix: [[4, 1, 3], [2, 0, 5], [3, 2, 2]] }); close(r.total_cost, 5);
  const r2 = S.solveAssignment({ cost_matrix: [[9, 2], [3, 8], [5, 1]] }); close(r2.total_cost, 4);
});
ok('TSP Held-Karp', () => {
  const D = [[0, 10, 15, 20], [10, 0, 35, 25], [15, 35, 0, 30], [20, 25, 30, 0]];
  const r = S.solveTSP({ distance_matrix: D }); close(r.total_distance, 80); assert.strictEqual(r.route[0], 0); assert.strictEqual(r.route.at(-1), 0); assert.strictEqual(new Set(r.route).size, 4);
});
ok('set cover', () => { const r = S.solveSetCover({ universe: ['a', 'b', 'c', 'd'], sets: [['a', 'b'], ['c', 'd'], ['a']] }); assert(r.success); assert.strictEqual(r.selected_set_indices.length, 2); });
ok('inventory Wagner-Whitin', () => {
  const r = S.solveInventory({ demands: [20, 50, 10, 50, 50, 10, 20, 40, 20, 30], fixed_order_cost: 100, holding_cost_per_unit_per_period: 1 });
  assert(r.success); close(r.setup_and_holding_cost, 580); // verified by brute force
});
ok('stochastic 2-stage', () => {
  const r = S.solveStochastic({ project_names: ['A', 'B', 'C'], first_stage_costs: [4, 3, 5], budget: 8, scenario_probabilities: [0.5, 0.5], scenario_returns: [[10, 6, 12], [4, 7, 3]], scenario_resource_weights: [2, 1, 3], scenario_capacities: [3, 2] });
  assert(r.success && r.selected_projects.length >= 1 && r.first_stage_cost <= 8);
});
ok('quadratic program', () => {
  const r = S.solveQuadratic({ variable_names: ['x', 'y'], linear_coefficients: [-2, -5], quadratic_matrix: [[2, 0], [0, 2]], objective_sense: 'min', constraints: [{ coefficients: [1, 1], sense: '<=', rhs: 3 }] });
  assert(r.success); close(r.variables.x, 0.75, 0.01); close(r.variables.y, 2.25, 0.01); // KKT: lambda=0.5
});

const csv = fs.readFileSync(path.join(__dirname, '../sample-data/sales_data.csv'), 'utf8');
const table = U.tableFromMatrix(U.parseCSV(csv));
ok('csv parsing and typing', () => { assert.strictEqual(table.rows.length, 36); assert.strictEqual(table.types.Sales, 'number'); assert.strictEqual(table.types.Month, 'text'); });
ok('forecast on sales_data.csv', () => {
  const r = S.solveForecast(table, { target_column: 'Sales', date_column: 'Month', horizon: 6, seasonal_period: 0 });
  assert(r.success); assert.strictEqual(r.forecast_table.length, 6); assert.strictEqual(r.forecast_table[0].date, '2026-01');
  assert.strictEqual(r.seasonal_period, 12);
  console.log('   ', r.solver, '| MAE', r.backtest_mae, 'MAPE', r.backtest_mape + '%', 'naive MAE', r.naive_mae);
  console.log('   ', r.forecast_table.map((f) => `${f.date}:${f.forecast}`).join(' '));
  assert(r.forecast_table[0].forecast > 100000 && r.forecast_table[0].forecast < 220000);
});
ok('resource allocation on a table', () => {
  const r = S.solveStructured('resource_allocation', { value_column: 'Sales', cost_column: 'Marketing_Spend', name_column: 'Month', capacity: 50000 }, { t: table });
  assert(r.success && r.total_cost <= 50000);
});
ok('PII redaction + safeJson', () => {
  assert(!/@/.test(U.redactPII('mail me a.b@x.com or +91 79073 27621')));
  assert.strictEqual(U.safeJson('```json\n{"a":1}\n```').a, 1);
});
console.log(`\n${n} tests passed`);
