export function createEventRateLimiter({ maxEvents, windowMs }) {
  const eventWindowsByKey = new Map();
  let lastPurgeAt = Date.now();

  function purgeExpiredWindows(now) {
    lastPurgeAt = now;
    for (const [key, eventWindow] of eventWindowsByKey) {
      if (now - eventWindow.startedAt >= windowMs) {
        eventWindowsByKey.delete(key);
      }
    }
  }

  function isEventAllowed(key) {
    const now = Date.now();
    if (now - lastPurgeAt >= windowMs) {
      purgeExpiredWindows(now);
    }
    const eventWindow = eventWindowsByKey.get(key);
    if (!eventWindow || now - eventWindow.startedAt >= windowMs) {
      eventWindowsByKey.set(key, { startedAt: now, eventCount: 1 });
      return true;
    }
    eventWindow.eventCount += 1;
    return eventWindow.eventCount <= maxEvents;
  }

  isEventAllowed.countTrackedKeys = () => eventWindowsByKey.size;
  return isEventAllowed;
}
