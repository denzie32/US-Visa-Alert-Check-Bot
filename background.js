const ALARM_NAME = "vac-slot-monitor";
const TARGET_HOST = "checkvisaslots.com";
const TARGET_PATH = "/latest-us-visa-availability/h-1b-regular/";
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;

function isTarget(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === TARGET_HOST && parsed.pathname.startsWith(TARGET_PATH);
  } catch {
    return false;
  }
}

async function getMonitor() {
  const { monitor } = await chrome.storage.local.get("monitor");
  return monitor || { active: false };
}

async function stopMonitor() {
  await chrome.storage.local.set({ monitor: { active: false } });
  await chrome.alarms.clear(ALARM_NAME);
}

async function recoverMonitorTab(monitor, reason) {
  const tab = await chrome.tabs.create({ url: TARGET_URL, active: false });
  await chrome.storage.local.set({
    monitor: { ...monitor, tabId: tab.id, url: TARGET_URL, lastIssue: null }
  });
  console.info(`Opened a replacement monitoring tab: ${reason}`);
}

async function reportMonitorIssue(monitor, issue) {
  if (monitor.lastIssue === issue) return;
  await chrome.storage.local.set({ monitor: { ...monitor, lastIssue: issue } });
  await notify("VAC monitoring will retry", issue);
}

async function restoreMonitorAlarm() {
  const monitor = await getMonitor();
  if (!monitor.active) return;
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (alarm?.periodInMinutes !== 3) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 3, periodInMinutes: 3 });
  }
}

async function notify(title, message) {
  await chrome.notifications.create(`vac-${Date.now()}`, {
    type: "basic",
    iconUrl: "icon.png",
    title,
    message
  });
}

async function soundAlert() {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play an audible alert when VAC availability changes."
      });
    }
    await chrome.runtime.sendMessage({ type: "PLAY_ALERT" });
  } catch (error) {
    console.error("Could not play the VAC availability alert sound:", error);
  }
}

function summarize(location) {
  return `${location.earliestDate}; ${location.slotsOnEarliestDate} slots on earliest date; ${location.totalDatesAvailable} total dates`;
}

function countIncreased(current, previous) {
  const currentCount = Number.parseInt(current, 10);
  const previousCount = Number.parseInt(previous, 10);
  return Number.isFinite(currentCount) && currentCount > 0 &&
    (!Number.isFinite(previousCount) || currentCount > previousCount);
}

function isPositiveAvailabilityChange(current, previous) {
  if (!previous) return true;
  if (
    countIncreased(current.totalDatesAvailable, previous.totalDatesAvailable) ||
    countIncreased(current.slotsOnEarliestDate, previous.slotsOnEarliestDate)
  ) {
    return true;
  }
  const currentDate = Date.parse(current.earliestDate);
  const previousDate = Date.parse(previous.earliestDate);
  return Number.isFinite(currentDate) &&
    Number.isFinite(previousDate) &&
    currentDate < previousDate;
}

async function handleSnapshot(tabId, result) {
  const monitor = await getMonitor();
  if (!monitor.active || monitor.tabId !== tabId) return;

  if (result?.error) {
    const reason = result.error === "blocked"
      ? "The site returned a 403/block page."
      : `Could not read VAC availability (${result.error}).`;
    await reportMonitorIssue(monitor, `${reason} Monitoring remains on and will retry.`);
    return;
  }

  if (!Array.isArray(result?.locations) || result.locations.length === 0) {
    await reportMonitorIssue(
      monitor,
      "No VAC rows were found. Monitoring remains on and will retry."
    );
    return;
  }

  const previousByLocation = new Map(
    (monitor.baseline || []).map((location) => [location.location, location])
  );
  const positiveChanges = result.locations.filter((location) =>
    isPositiveAvailabilityChange(location, previousByLocation.get(location.location))
  );

  await chrome.storage.local.set({
    monitor: { ...monitor, baseline: result.locations, lastIssue: null }
  });

  if (positiveChanges.length > 0 && monitor.baseline) {
    const details = positiveChanges.slice(0, 3).map((location) => {
      const previous = previousByLocation.get(location.location);
      return previous
        ? `${location.location}: ${summarize(previous)} → ${summarize(location)}`
        : `${location.location}: ${summarize(location)}`;
    });
    const extra = positiveChanges.length > 3 ? ` (+${positiveChanges.length - 3} more)` : "";
    await notify("New H-1B VAC availability", `${details.join(" | ")}${extra}`);
    await soundAlert();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    getMonitor().then(sendResponse);
    return true;
  }

  if (message?.type === "START_MONITOR") {
    (async () => {
      const tab = await chrome.tabs.get(message.tabId);
      if (!isTarget(tab.url)) throw new Error("Open the H-1B Regular availability page first.");
      const result = await chrome.tabs.sendMessage(tab.id, { type: "READ_AVAILABILITY" });
      if (result?.error) throw new Error(`The VAC table is not readable (${result.error}).`);
      if (!result?.locations?.length) throw new Error("No VAC rows were found in the availability table.");

      await chrome.storage.local.set({
        monitor: { active: true, tabId: tab.id, url: tab.url, baseline: result.locations }
      });
      await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 3, periodInMinutes: 3 });
      sendResponse({ ok: true });
    })().catch((error) => {
      const message = error.message || String(error);
      const userMessage = /receiving end does not exist|could not establish connection/i.test(message)
        ? "The page helper is not connected. Reload the visa page in this same browser, wait for it to finish loading, then try again."
        : message;
      sendResponse({ ok: false, error: userMessage });
    });
    return true;
  }

  if (message?.type === "STOP_MONITOR") {
    stopMonitor().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "PAGE_READY") {
    (async () => {
      const tabId = sender.tab?.id;
      const monitor = await getMonitor();
      if (!monitor.active || tabId !== monitor.tabId || !isTarget(sender.tab?.url)) return;
      const result = await chrome.tabs.sendMessage(tabId, { type: "READ_AVAILABILITY" });
      await handleSnapshot(tabId, result);
    })().catch((error) => {
      console.error("Could not check VAC availability:", error);
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  restoreMonitorAlarm().catch((error) => {
    console.error("Could not resume VAC monitoring after browser startup:", error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  restoreMonitorAlarm().catch((error) => {
    console.error("Could not restore the VAC monitoring alarm:", error);
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const monitor = await getMonitor();
  if (!monitor.active) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  try {
    const tab = await chrome.tabs.get(monitor.tabId);
    if (!isTarget(tab.url)) {
      await recoverMonitorTab(monitor, "the monitored tab navigated away");
      return;
    }
    await chrome.tabs.reload(monitor.tabId);
  } catch (error) {
    try {
      await recoverMonitorTab(monitor, `the monitored tab is unavailable: ${error.message}`);
    } catch (recoveryError) {
      console.error("Could not reopen the VAC monitoring tab:", recoveryError);
      await reportMonitorIssue(
        monitor,
        `Could not reopen the monitoring page: ${recoveryError.message || recoveryError}. Monitoring remains on and will retry.`
      );
    }
  }
});
