const status = document.getElementById("status");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");

async function renderStatus() {
  const monitor = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  status.textContent = monitor.active
    ? "Monitoring is on. The selected H-1B page is checked every 3 minutes."
    : "Not monitoring.";
}

startButton.addEventListener("click", async () => {
  status.textContent = "Reading VAC rows and setting the baseline…";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    status.textContent = "Could not identify the active tab.";
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({ type: "START_MONITOR", tabId: tab.id });
    status.textContent = result.ok ? "Monitoring started. Current VAC values are the baseline." : result.error;
  } catch (error) {
    status.textContent = `The extension background worker is not responding. At chrome://extensions or edge://extensions, reload this extension, then reload the visa page and try again. Details: ${error.message}`;
  }
});

stopButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_MONITOR" });
  status.textContent = "Monitoring stopped.";
});

renderStatus().catch((error) => {
  status.textContent = `The extension background worker is not responding. At chrome://extensions or edge://extensions, reload this extension, then reload the visa page. Details: ${error.message}`;
});
