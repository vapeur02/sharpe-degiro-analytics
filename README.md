# Sharpe: Portfolio Analytics for DEGIRO
<img width="1200" height="400" alt="ko-fi cover" src="https://github.com/user-attachments/assets/4cfe54e5-f2ee-4c5c-8ee0-274316fc15ec" />

**A private, local browser extension that overlays professional portfolio analytics directly onto your DEGIRO account.**
https://chromewebstore.google.com/detail/sharpe-portfolio-analytic/jfkggpahncfpbeeiiadiblbifjnbdlfp?hl=en-GB&utm_source=ext_sidebar

DEGIRO is a fantastic low-cost broker, but its native interface lacks deep insights into how your portfolio is actually performing. If you DCA (Dollar Cost Average) regularly, the default "Total P&L" gets heavily distorted by your cash deposits, making it impossible to benchmark your actual investment decisions.

I built **Sharpe** to fix this. It calculates your True Time-Weighted Returns (TWR), tracks realized P&L, and maps out your exact asset allocation, all done locally on your own machine.

---

## Features

### Performance

* **True Time-Weighted Returns (TWR):** Accurate performance charts that strip out the distorting effects of your cash deposits and withdrawals.
* **Cumulative or Daily:** One chart, two modes. See the full curve since inception, or switch to a bar per trading day to see exactly which days made your year.
* **Benchmark Overlays:** Compare against the **S&P 500**, **Euro Stoxx 50** and **Nasdaq 100**, anchored to the day your portfolio actually started.
* **Trade Markers:** Overlay every buy and sell onto the curve to see how your decisions landed.
* **Drag to Zoom:** Drag across any stretch of the chart to zoom into it.
* **Advanced Portfolio Analytics:** Professional-grade metrics calculated locally from your daily portfolio values, always for the window you are looking at:
    * **Annualised Return:** Dynamic annualised performance based on your selected viewing period.
    * **Alpha & Beta:** Measure your portfolio's exact outperformance (Alpha) and volatility (Beta) benchmarked against the S&P 500.
    * **Max Drawdown:** Track your largest peak-to-trough portfolio drop.
    * **Sharpe Ratio:** Understand your risk-adjusted returns.

### Holdings

* **Positions Table:** Weight bars, a 30-day sparkline per holding, and live P&L. Click any row to expand it in place for average cost, day P&L, return contribution, volatility and a full price chart with your trades marked on it.
* **Deep Allocation Analytics:** Visualize your portfolio breakdown by **Holdings**, **Geography**, **Asset Class** or **Currency**, and drill into any slice to see exactly which positions make it up.
* **Concentration Warning:** Get told when your top 3 holdings dominate the portfolio.
* **Realized P&L Tracking:** See your exact historical profits and losses from fully closed (sold) positions using FIFO cost-basis tracking.
* **Currency (FX) Effects:** Instantly see exactly how exchange rate movements are impacting your non-EUR assets.
* **Transparent Fee Tracking:** See exactly how much you are paying DEGIRO with a complete breakdown of Total Fees paid, split between trading commissions and FX conversion fees.

### Income

* **Dividend Income:** Every payment DEGIRO has ever credited you, totalled all-time and over the trailing 12 months, with a monthly chart and your yield on cost.
* **Expected Next Payments:** Sharpe reads the cadence of your own payment history and estimates what is coming and roughly when. Clearly labelled as an estimate, because issuers announce dividends, not extensions.
* **Per-Holding Breakdown:** Which positions actually pay you, ranked, with CSV export.

### Daily

* **Today's Movers:** Per-position daily change in % and €, weight, and contribution to the day's return, with the day's total P&L up top.
* **Three Views, One Card:** Read the same day as a **table**, a **contribution waterfall**, or a **heatmap** sized by weight and coloured by daily move.
* **Day Replay:** Pick any past trading day and see the whole tab as it was, rebuilt from your transaction history.
* **Daily Stats:** Winning streak, best and worst day of the month, average daily return and win rate.

### Insights

* **Portfolio Pulse:** Plain-language observations generated from your own figures. Concentration, risk-adjusted return trend, drawdown against your high-water mark. No advice, just what stands out.
* **Correlation Matrix:** Pearson correlation of daily returns across every holding, plus a weighted average correlation and a principal-component breakdown, so you can see whether your diversification is real or nominal.
* **Risk Analysis:** Daily **Value at Risk** by historical simulation at 90/95/99% confidence, plus stress tests against real historical crashes and hypothetical scenarios, with per-position impact.
* **Rate My Portfolio:** Answer five questions about your risk tolerance, horizon and goals, and get your portfolio graded against *your* objectives rather than a generic template.

### Watchlist

* **Favourites Tracking:** Performance, volatility, correlation to your portfolio and an SMA(50)/SMA(200) trend signal for everything on your DEGIRO watchlist, plus a comparison against how your actual portfolio did over the same window.

### Tax Reporting

* **Country-Specific Tables:** Generate the figures you need for filing in the **Netherlands**, **France**, **Germany** or **Belgium**, built from your own transaction and dividend history, exportable as a PDF.

*Sharpe is not a tax advisor and these tables are informational. Always check them against your own records before filing.*

### Everywhere

* **Privacy Mode:** One click blurs every monetary figure on screen, so you can open your portfolio in public or on a call.
* **Light & Dark Themes.**
* **CSV Exports:** Take the underlying numbers with you from the performance chart, allocation, positions, correlation matrix and dividends.

<img width="1280" height="800" alt="Screenshot tiles" src="https://github.com/user-attachments/assets/8aa1dcbe-f5f5-449d-bdfa-6586cdeae5e4" />

---

## Free & PRO

The core of Sharpe is free and always will be: the TWR performance chart and all of its metrics, benchmark overlays, allocation analytics, the positions table, closed-position and fee tracking, dividend income totals, daily stats and Portfolio Pulse.

**Sharpe PRO** unlocks the heavier analysis: Today's Movers, the Watchlist tab, per-position price charts, the correlation matrix, Risk Analysis, the full Rate My Portfolio breakdown, the per-holding dividend view, tax reporting and CSV exports. It is a one-off purchase that funds maintenance, and every calculation still happens locally on your machine.

---

## Privacy & Security First

When dealing with financial data, you should be paranoid. **Sharpe was built with absolute privacy and security as the foundational rule.**

1. **100% Local Calculation:** There are no databases, no server uploads, and no data harvesting. All calculations happen directly in your browser.
2. **Read-Only:** The extension only makes `GET` requests to DEGIRO's reporting endpoints to read your portfolio state. It cannot execute trades or modify your account.
3. **No External Dependencies:** Sharpe is built using 100% pure, vanilla JavaScript. There are no NPM packages, React frameworks, or obfuscated third-party libraries that could introduce supply-chain vulnerabilities.
4. **Manifest V3 Strictness:** Built on Google's modern Manifest V3 architecture, meaning remote code execution is strictly banned by the browser.

Feel free to audit the code yourself! Every file in this repository is exactly what gets bundled into the Chrome Web Store release.

---

## Installation

**The Easiest Way (Chrome Web Store):**
1. https://chromewebstore.google.com/detail/sharpe-portfolio-analytic/jfkggpahncfpbeeiiadiblbifjnbdlfp?hl=en-GB&utm_source=ext_sidebar
2. Pin the extension to your toolbar.
3. Log into `trader.degiro.nl` (or your local DEGIRO domain).
4. Open the extension to view your dashboard!

**For Developers (Load Unpacked):**
1. Clone or download this repository as a `.zip` and extract it.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the extracted folder.

*(Note: Firefox support is planned and coming soon!)*
<img width="1280" height="800" alt="description tile" src="https://github.com/user-attachments/assets/b80f9472-9c26-41dd-8536-84b02bbb9144" />

---

## Feedback & Bug Reports

DEGIRO frequently updates their platform, which can sometimes break the data extraction. If you notice a bug, a missing closed position, or a calculation error, please [open an issue](https://github.com/vapeur02/sharpe-degiro-analytics/issues) here on GitHub!

If you want to support the development and maintenance of this free tool, you can buy me a coffee at [ko-fi.com/sharpe_dev](https://ko-fi.com/sharpe_dev).

---
*Disclaimer: Sharpe is a community-built tool and is not affiliated with, endorsed by, or connected to DEGIRO or flatexDEGIRO Bank AG. All metrics are calculated locally for informational purposes only and do not constitute financial advice.*
