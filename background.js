const ALARM_NAME = "vac-slot-monitor";
const MONITOR_INTERVAL_MINUTES = 80 / 60;
const RELEASE_REMINDER_ALARM = "vac-slot-release-reminder";
const PREDICTION_ALARM_NAME = "vac-slot-predicted-release";
const RELEASE_REMINDER_LEAD_MS = 2 * 60 * 1000;
const RELEASE_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_RELEASE_EVENTS_FOR_PREDICTION = 3;
const MAX_INTERVAL_DEVIATION = 0.35;
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
  const monitor = await getMonitor();
  await chrome.storage.local.set({ monitor: { ...monitor, active: false, predictedReleaseAt: null } });
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(PREDICTION_ALARM_NAME);
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
  if (Math.abs((alarm?.periodInMinutes || 0) - MONITOR_INTERVAL_MINUTES) > 0.01) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: MONITOR_INTERVAL_MINUTES,
      periodInMinutes: MONITOR_INTERVAL_MINUTES
    });
  }
}

async function clearReleaseReminder() {
  await chrome.alarms.clear(RELEASE_REMINDER_ALARM);
  await chrome.storage.local.remove("releaseReminder");
}

async function restoreReleaseReminder() {
  const { releaseReminder } = await chrome.storage.local.get("releaseReminder");
  if (!releaseReminder?.releaseAt) return;

  const releaseAt = Number(releaseReminder.releaseAt);
  if (!Number.isFinite(releaseAt) || releaseAt <= Date.now()) {
    await clearReleaseReminder();
    return;
  }

  const reminderAt = releaseAt - RELEASE_REMINDER_LEAD_MS;
  await chrome.alarms.create(RELEASE_REMINDER_ALARM, {
    when: Math.max(reminderAt, Date.now())
  });
}

function estimateNextReleases(releaseEvents, now = Date.now()) {
  const timesByLocation = new Map();
  for (const event of releaseEvents || []) {
    const observedAt = Number(event.observedAt);
    if (!Number.isFinite(observedAt) || observedAt <= now - RELEASE_HISTORY_WINDOW_MS || observedAt > now) {
      continue;
    }
    for (const location of new Set(event.locations || [])) {
      if (!timesByLocation.has(location)) timesByLocation.set(location, []);
      timesByLocation.get(location).push(observedAt);
    }
  }

  const predictions = [];
  for (const [location, times] of timesByLocation) {
    const recentTimes = [...new Set(times)].sort((a, b) => a - b);
    if (recentTimes.length < MIN_RELEASE_EVENTS_FOR_PREDICTION) continue;

    const intervals = recentTimes.slice(1).map((time, index) => time - recentTimes[index]);
    const orderedIntervals = [...intervals].sort((a, b) => a - b);
    const middle = Math.floor(orderedIntervals.length / 2);
    const medianInterval = orderedIntervals.length % 2 === 0
      ? (orderedIntervals[middle - 1] + orderedIntervals[middle]) / 2
      : orderedIntervals[middle];
    if (!Number.isFinite(medianInterval) || medianInterval <= 0) continue;
    if (intervals.some((interval) => Math.abs(interval - medianInterval) / medianInterval > MAX_INTERVAL_DEVIATION)) {
      continue;
    }

    const predictedAt = recentTimes.at(-1) + medianInterval;
    if (predictedAt > now) predictions.push({ location, predictedAt, eventCount: recentTimes.length });
  }
  return predictions.sort((a, b) => a.predictedAt - b.predictedAt);
}

async function updateReleasePrediction(monitor, releaseEvents) {
  const cutoff = Date.now() - RELEASE_HISTORY_WINDOW_MS;
  const recentEvents = (releaseEvents || [])
    .filter((event) => Number(event.observedAt) > cutoff)
    .slice(-100);
  const notifiedPredictions = new Set(monitor.notifiedPredictions || []);
  const predictions = estimateNextReleases(recentEvents).filter((prediction) =>
    !notifiedPredictions.has(`${prediction.location}:${prediction.predictedAt}`)
  );
  const updatedMonitor = {
    ...monitor,
    releaseEvents: recentEvents,
    predictedReleases: predictions
  };

  await chrome.storage.local.set({ monitor: updatedMonitor });
  await chrome.alarms.clear(PREDICTION_ALARM_NAME);
  if (monitor.active && predictions.length > 0) {
    await chrome.alarms.create(PREDICTION_ALARM_NAME, {
      when: Math.max(predictions[0].predictedAt - RELEASE_REMINDER_LEAD_MS, Date.now())
    });
  }
  return updatedMonitor;
}

async function restoreReleasePredictionAlarm() {
  const monitor = await getMonitor();
  await updateReleasePrediction(monitor, monitor.releaseEvents || []);
}

async function notify(title, message) {
  const notificationId = `vac-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await chrome.notifications.create(notificationId, {
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

function snapshotKey(locations) {
  return JSON.stringify((locations || []).map((location) => ({
    location: location.location,
    earliestDate: location.earliestDate,
    slotsOnEarliestDate: location.slotsOnEarliestDate,
    totalDatesAvailable: location.totalDatesAvailable
  })));
}

function appendHistory(history, locations) {
  if (history.at(-1) && snapshotKey(history.at(-1).locations) === snapshotKey(locations)) {
    return history;
  }
  return [...history, { checkedAt: Date.now(), locations }].slice(-100);
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
  const history = snapshotKey(monitor.baseline) === snapshotKey(result.locations)
    ? (monitor.history || [])
    : appendHistory(monitor.history || [], result.locations);
  const releaseEvents = [...(monitor.releaseEvents || [])];
  if (positiveChanges.length > 0 && monitor.baseline) {
    releaseEvents.push({
      observedAt: Date.now(),
      locations: positiveChanges.map((location) => location.location)
    });
  }
  await updateReleasePrediction({
    ...monitor,
    baseline: result.locations,
    history,
    lastIssue: null
  }, releaseEvents);

  if (positiveChanges.length > 0 && monitor.baseline) {
    for (const location of positiveChanges) {
      const previous = previousByLocation.get(location.location);
      const details = previous
        ? `${summarize(previous)} → ${summarize(location)}`
        : summarize(location);
      await notify(`New H-1B VAC availability: ${location.location}`, details);
    }
    await soundAlert();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    getMonitor().then(sendResponse);
    return true;
  }

  if (message?.type === "GET_RELEASE_REMINDER") {
    chrome.storage.local.get("releaseReminder").then(({ releaseReminder }) => {
      sendResponse(releaseReminder || null);
    });
    return true;
  }

  if (message?.type === "SCHEDULE_RELEASE_REMINDER") {
    (async () => {
      const releaseAt = Number(message.releaseAt);
      if (!Number.isFinite(releaseAt) || releaseAt <= Date.now() + RELEASE_REMINDER_LEAD_MS) {
        sendResponse({ ok: false, error: "Choose a release time more than 2 minutes from now." });
        return;
      }

      await chrome.alarms.clear(RELEASE_REMINDER_ALARM);
      await chrome.storage.local.set({ releaseReminder: { releaseAt } });
      await chrome.alarms.create(RELEASE_REMINDER_ALARM, {
        when: releaseAt - RELEASE_REMINDER_LEAD_MS
      });
      sendResponse({ ok: true, releaseAt });
    })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "CANCEL_RELEASE_REMINDER") {
    clearReleaseReminder()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "START_MONITOR") {
    (async () => {
      const tab = await chrome.tabs.get(message.tabId);
      if (!isTarget(tab.url)) throw new Error("Open the H-1B Regular availability page first.");
      const result = await chrome.tabs.sendMessage(tab.id, { type: "READ_AVAILABILITY" });
      if (result?.error) throw new Error(`The VAC table is not readable (${result.error}).`);
      if (!result?.locations?.length) throw new Error("No VAC rows were found in the availability table.");

      const previousMonitor = await getMonitor();
      const history = appendHistory(previousMonitor.history || [], result.locations);
      await updateReleasePrediction({
        ...previousMonitor,
        active: true,
        tabId: tab.id,
        url: tab.url,
        baseline: result.locations,
        history
      }, previousMonitor.releaseEvents || []);
      await chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: MONITOR_INTERVAL_MINUTES,
        periodInMinutes: MONITOR_INTERVAL_MINUTES
      });
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
  restoreReleaseReminder().catch((error) => {
    console.error("Could not restore the slot release reminder:", error);
  });
  restoreReleasePredictionAlarm().catch((error) => {
    console.error("Could not restore the predicted release alert:", error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  restoreMonitorAlarm().catch((error) => {
    console.error("Could not restore the VAC monitoring alarm:", error);
  });
  restoreReleaseReminder().catch((error) => {
    console.error("Could not restore the slot release reminder:", error);
  });
  restoreReleasePredictionAlarm().catch((error) => {
    console.error("Could not restore the predicted release alert:", error);
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === PREDICTION_ALARM_NAME) {
    const monitor = await getMonitor();
    const now = Date.now();
    const predictions = monitor.predictedReleases || [];
    const duePredictions = predictions.filter((prediction) =>
      prediction.predictedAt > now && prediction.predictedAt <= now + RELEASE_REMINDER_LEAD_MS
    );
    const remainingPredictions = predictions.filter((prediction) =>
      prediction.predictedAt > now + RELEASE_REMINDER_LEAD_MS
    );
    await chrome.alarms.clear(PREDICTION_ALARM_NAME);
    if (!monitor.active) return;

    const notifiedPredictions = [
      ...(monitor.notifiedPredictions || []),
      ...duePredictions.map((prediction) => `${prediction.location}:${prediction.predictedAt}`)
    ].slice(-100);
    await chrome.storage.local.set({
      monitor: { ...monitor, predictedReleases: remainingPredictions, notifiedPredictions }
    });
    for (const prediction of duePredictions) {
      await notify(
        `Possible slot release: ${prediction.location}`,
        `A slot may appear in about 2 minutes, based on ${prediction.eventCount} recent availability increases for this location. This is an estimate, not a confirmed release time.`
      );
    }
    if (remainingPredictions.length > 0) {
      await chrome.alarms.create(PREDICTION_ALARM_NAME, {
        when: Math.max(remainingPredictions[0].predictedAt - RELEASE_REMINDER_LEAD_MS, Date.now())
      });
    }
    return;
  }

  if (alarm.name === RELEASE_REMINDER_ALARM) {
    const { releaseReminder } = await chrome.storage.local.get("releaseReminder");
    if (!releaseReminder?.releaseAt) return;

    if (Number(releaseReminder.releaseAt) > Date.now()) {
      await clearReleaseReminder();
      await notify(
        "Slot release in 2 minutes",
        "The slot is expected to be released in about 2 minutes. Be ready to check availability."
      );
    } else {
      await clearReleaseReminder();
    }
    return;
  }

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
