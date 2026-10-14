# VAC Slot Change Alert

A local Chrome extension for the H-1B Regular availability page. It reads only rows whose Visa Location contains `VAC`, using the earliest date, slots on the earliest date, and total dates available as the comparison fields. The initial values become the baseline, so existing availability does not trigger an immediate alert. It alerts on a new VAC row, an increase in either availability count, or an earlier earliest date; decreases alone do not sound an alert.

The supplied cat image is used as the extension toolbar and notification icon.

## Install

1. Keep Chrome connected through your VPN, if that is how you normally access the page.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose this folder.
4. Open `https://checkvisaslots.com/latest-us-visa-availability/h-1b-regular/` in Chrome and wait for the availability table to appear.
5. Select the extension button and click **Start / reset baseline**. Allow notifications if Chrome asks.

After you start it, monitoring remains enabled until you stop it or the extension stops due to a 403/block page, unreadable VAC rows, or the monitored tab leaving the target page. It reloads that tab every three minutes. When a check detects one of those positive availability changes, it shows a notification and plays a sound. Detection may take up to three minutes plus the time the page takes to load; it cannot alert before the site publishes the slot or guarantee an instantaneous alert. The extension restores its three-minute alarm after a browser restart, but it cannot check while the browser is closed or the computer is asleep. Keep Chrome open, the tab available, the computer awake, and the volume on for continuous monitoring.

Monitoring stops and notifies you if the page returns a 403/block page, the VAC rows cannot be read, or the monitored tab is no longer on the target page. It does not attempt to bypass a block or retry automatically; inspect the page and restart manually when access is restored. Use the website in accordance with its terms.

## Troubleshooting

- **“The extension background worker is not responding”**: Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge), find the extension, choose **Reload**, then reload the visa page and reopen the extension popup. The extension must be installed in the same browser where the page is open.
- **“The page helper is not connected”**: Reload the visa page, wait for its table to finish loading, then try **Start / reset baseline** again.
- If Chrome or Edge reports an extension error, open its **Errors** panel and resolve that before starting the monitor.
