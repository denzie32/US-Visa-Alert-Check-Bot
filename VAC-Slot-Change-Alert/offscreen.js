chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "PLAY_ALERT") return;

  const context = new AudioContext();
  const notes = [880, 660, 880];
  notes.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = context.currentTime + index * 0.35;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.18, startAt);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.23);
  });
  setTimeout(() => context.close(), 1300);
});
