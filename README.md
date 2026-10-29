# GC Optimiser (Android)

Mobile port of the GC Optimiser Streamlit app: an AI business decision-intelligence engine that classifies a business question, uses your data as evidence, and runs deterministic solvers for the numbers.

Built with [Capacitor](https://capacitorjs.com/) and plain JavaScript. The APK is built by GitHub Actions on every push to `main`.

## Get the APK

Open the **Releases** page of this repo and download `GC-Optimiser.apk` from the latest build (or the `GC-Optimiser-apk` artifact on the Actions run). It is debug-signed, so on the phone allow "Install unknown apps" for the app you download it with.

## Features

- **Analyse tab**: ask a question in plain language, attach files, get an interpreted decision, assumptions, missing inputs, recommendations and a solver-backed result.
- **Solvers tab**: run any solver directly, no AI or internet needed: forecasting, budget allocation (knapsack), linear programming (simplex), assignment (Hungarian), TSP (exact, up to 15 stops), set covering, inventory lot sizing (Wagner-Whitin), two-stage stochastic selection, quadratic programming.
- **Data tab**: CSV, Excel, PDF, DOCX and text files, with previews and numeric summaries. Tables feed the solvers; documents are searched for relevant excerpts.
- **History**, share summary / forecast CSV through the Android share sheet.
- **Privacy**: emails, phone numbers and long IDs are redacted before text goes to the AI; only 25 sample rows plus a numeric summary of each table are sent; AI output is never executed.

Without an API key the app still routes common questions on-device (for example it auto-configures a forecast from a date column and a sales-like column).

## AI key

Open **Settings** and paste your own OpenAI API key. It is stored only on the device and sent only to `api.openai.com`. Never commit a key to this repo; anything bundled in an APK can be extracted.

## Develop

```bash
npm install
npm test                 # solver engine tests (Node)
npm run vendor           # copy xlsx / pdf.js / mammoth into www/vendor
npx cap add android      # generates the android/ project
python3 scripts/make_icons.py android/app/src/main/res
npx cap sync android
cd android && ./gradlew assembleDebug
```

You can also open `www/index.html` through any static server to try the UI in a desktop browser.

## Differences from the Streamlit version

- Forecasting uses a linear trend with multiplicative seasonality (chosen by hold-out error) instead of SARIMAX, and shows an 80% range and a naive-baseline comparison.
- Quadratic programming uses a penalty-gradient method instead of SciPy SLSQP; two-stage stochastic and knapsack use exact enumeration / branch and bound instead of MILP.
- Document retrieval is lexical (no embedding model on the phone).
