import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventRateLimiter } from '../src/collaboration/eventRateLimiter.js';

const WINDOW_MS = 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createEventRateLimiter', () => {
  it('accepte les événements jusqu à la limite puis refuse les suivants dans la fenêtre', () => {
    const isEventAllowed = createEventRateLimiter({ maxEvents: 3, windowMs: WINDOW_MS });

    const decisions = [1, 2, 3, 4, 5].map(() => isEventAllowed('utilisateur-1'));

    expect(decisions).toEqual([true, true, true, false, false]);
  });

  it('compte chaque clé séparément', () => {
    const isEventAllowed = createEventRateLimiter({ maxEvents: 1, windowMs: WINDOW_MS });

    expect(isEventAllowed('utilisateur-1')).toBe(true);
    expect(isEventAllowed('utilisateur-1')).toBe(false);
    expect(isEventAllowed('utilisateur-2')).toBe(true);
  });

  it('rouvre une fenêtre une fois le délai écoulé', () => {
    const isEventAllowed = createEventRateLimiter({ maxEvents: 1, windowMs: WINDOW_MS });
    isEventAllowed('utilisateur-1');
    expect(isEventAllowed('utilisateur-1')).toBe(false);

    vi.advanceTimersByTime(WINDOW_MS);

    expect(isEventAllowed('utilisateur-1')).toBe(true);
  });

  it('purge les fenêtres expirées pour ne pas accumuler les clés', () => {
    const isEventAllowed = createEventRateLimiter({ maxEvents: 5, windowMs: WINDOW_MS });
    for (let userId = 1; userId <= 50; userId += 1) {
      isEventAllowed(`utilisateur-${userId}`);
    }
    expect(isEventAllowed.countTrackedKeys()).toBe(50);

    vi.advanceTimersByTime(WINDOW_MS);
    isEventAllowed('utilisateur-actif');

    expect(isEventAllowed.countTrackedKeys()).toBe(1);
  });
});
