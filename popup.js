const status = document.getElementById("status");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const historyList = document.getElementById("history");

function renderHistory(history = []) {
  historyList.replaceChildren();
  const entries = history.slice(-8).reverse();
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "note";
    empty.textContent = "No availability history yet.";
    historyList.append(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    const checkedAt = new Date(entry.checkedAt);
    time.dateTime = checkedAt.toISOString();
    time.textContent = checkedAt.toLocaleString();
    item.append(time);

    for (const location of (entry.locations || []).slice(0, 3)) {
      const detail = document.createElement("p");
      detail.className = "history-detail";
      detail.textContent = `${location.location}: ${location.earliestDate || "No date"}; ${location.slotsOnEarliestDate} slots; ${location.totalDatesAvailable} total dates`;
      item.append(detail);
    }

    if (entry.locations?.length > 3) {
      const more = document.createElement("p");
      more.className = "history-detail note";
      more.textContent = `And ${entry.locations.length - 3} more locations`;
      item.append(more);
    }
    historyList.append(item);
  }
}

async function renderStatus() {
  const monitor = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  renderHistory(monitor.history || []);
  status.textContent = monitor.active
    ? "Monitoring is on. Live page changes are checked immediately; the page reloads every 3 minutes as a fallback."
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
    status.textContent = result.ok
      ? "Monitoring started. Watching for live page changes; current VAC values are the baseline."
      : result.error;
    if (result.ok) await renderStatus();
  } catch (error) {
    status.textContent = `The extension background worker is not responding. At chrome://extensions or edge://extensions, reload this extension, then reload the visa page and try again. Details: ${error.message}`;
  }
});

stopButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_MONITOR" });
  await renderStatus();
});

renderStatus().catch((error) => {
  status.textContent = `The extension background worker is not responding. At chrome://extensions or edge://extensions, reload this extension, then reload the visa page. Details: ${error.message}`;
});
