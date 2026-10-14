(() => {
  const normalize = (value) => value.replace(/\s+/g, " ").trim();

  function readAvailability() {
    const pageText = normalize(document.body?.innerText || "");
    if (
      document.title.includes("403") ||
      /\b403 Forbidden\b/i.test(pageText) ||
      /This request was blocked/i.test(pageText)
    ) {
      return { error: "blocked" };
    }

    for (const table of document.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")];
      const headerRow = rows.find((row) =>
        [...row.querySelectorAll("th, td")].some((cell) =>
          /Visa Location/i.test(normalize(cell.innerText))
        )
      );
      if (!headerRow) continue;

      const headers = [...headerRow.querySelectorAll("th, td")].map((cell) =>
        normalize(cell.innerText).toLowerCase()
      );
      const locationIndex = headers.findIndex((text) => text.includes("visa location"));
      const earliestIndex = headers.findIndex((text) => text.includes("earliest date"));
      const earliestSlotsIndex = headers.findIndex((text) => text.includes("slots on earliest date"));
      const totalIndex = headers.findIndex((text) => text.includes("total dates available"));
      if ([locationIndex, earliestIndex, earliestSlotsIndex, totalIndex].some((index) => index < 0)) {
        continue;
      }

      const dataRows = rows.slice(rows.indexOf(headerRow) + 1);
      const locations = dataRows
        .map((row) => [...row.querySelectorAll("th, td")].map((cell) => normalize(cell.innerText)))
        .filter((cells) => cells[locationIndex] && /\bVAC\b/i.test(cells[locationIndex]))
        .map((cells) => ({
          location: cells[locationIndex],
          earliestDate: cells[earliestIndex] || "",
          slotsOnEarliestDate: cells[earliestSlotsIndex] || "",
          totalDatesAvailable: cells[totalIndex] || ""
        }))
        .sort((a, b) => a.location.localeCompare(b.location));

      if (locations.length === 0) return { error: "no-vac-rows" };
      return { locations };
    }

    return { error: "table-not-found" };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "READ_AVAILABILITY") {
      sendResponse(readAvailability());
    }
  });

  setTimeout(() => {
    chrome.runtime.sendMessage({ type: "PAGE_READY" });
  }, 1500);
})();
