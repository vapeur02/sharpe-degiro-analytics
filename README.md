# Sharpe: Portfolio Analytics for DEGIRO
<img width="1200" height="400" alt="ko-fi cover" src="https://github.com/user-attachments/assets/4cfe54e5-f2ee-4c5c-8ee0-274316fc15ec" />

**A free, private, and local browser extension that overlays professional portfolio analytics directly onto your DEGIRO account.**
https://chromewebstore.google.com/detail/sharpe-portfolio-analytic/jfkggpahncfpbeeiiadiblbifjnbdlfp?hl=en-GB&utm_source=ext_sidebar

DEGIRO is a fantastic low-cost broker, but its native interface lacks deep insights into how your portfolio is actually performing. If you DCA (Dollar Cost Average) regularly, the default "Total P&L" gets heavily distorted by your cash deposits, making it impossible to benchmark your actual investment decisions.

I built **Sharpe** to fix this. It calculates your True Time-Weighted Returns (TWR), tracks realized P&L, and maps out your exact asset allocation, all done locally on your own machine.

---

## Features

* **True Time-Weighted Returns (TWR):** Accurate performance charts that strip out the distorting effects of your cash deposits and withdrawals.
* **Advanced Portfolio Analytics:** Professional-grade metrics calculated locally based on your daily portfolio values:
    * **Annualised Return:** Dynamic annualised performance based on your selected viewing period.
    * **Alpha & Beta:** Measure your portfolio's exact outperformance (Alpha) and volatility (Beta) benchmarked against the S&P 500.
    * **Max Drawdown:** Track your largest peak-to-trough portfolio drop.
    * **Sharpe Ratio:** Understand your risk-adjusted returns.
* **Transparent Fee Tracking:** See exactly how much you are paying DEGIRO with a complete breakdown of Total Fees paid, split between trading commissions and FX conversion fees.
* **Realized P&L Tracking:** See your exact historical profits and losses from fully closed (sold) positions using FIFO cost-basis tracking.
* **Deep Allocation Analytics:** Visualize your portfolio breakdown by:
    *  Geography
    *  Asset Class
    *  Currency
* **Currency (FX) Effects:** Instantly see exactly how exchange rate movements are impacting your non-EUR assets.
<img width="1280" height="800" alt="Screenshot tiles" src="https://github.com/user-attachments/assets/8aa1dcbe-f5f5-449d-bdfa-6586cdeae5e4" />


---

## Privacy & Security First

When dealing with financial data, you should be paranoid. **Sharpe was built with absolute privacy and security as the foundational rule.** 1. **100% Local Calculation:** There are no databases, no server uploads, and no data harvesting. All calculations happen directly in your browser.
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

##Feedback & Bug Reports

DEGIRO frequently updates their platform, which can sometimes break the data extraction. If you notice a bug, a missing closed position, or a calculation error, please [open an issue]([Link to your github issues page]) here on GitHub!

If you want to support the development and maintenance of this free tool, you can buy me a coffee [https://ko-fi.com/sharpe_dev](https://ko-fi.com/sharpe_dev).

---
*Disclaimer: Sharpe is a community-built tool and is not affiliated with, endorsed by, or connected to DEGIRO or flatexDEGIRO Bank AG. All metrics are calculated locally for informational purposes only and do not constitute financial advice.*
