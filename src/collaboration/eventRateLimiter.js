export function createEventRateLimiter({ maxEvents, windowMs }) {
  const eventWindowsByKey = new Map();

  return function isEventAllowed(key) {
    const now = Date.now();
    const eventWindow = eventWindowsByKey.get(key);
    if (!eventWindow || now - eventWindow.startedAt >= windowMs) {
      eventWindowsByKey.set(key, { startedAt: now, eventCount: 1 });
      return true;
    }
    eventWindow.eventCount += 1;
    return eventWindow.eventCount <= maxEvents;
  };
}
