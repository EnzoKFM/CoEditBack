import { EventEmitter } from 'node:events';

export const accessChanges = new EventEmitter();

export function notifyAccessChanged() {
  accessChanges.emit('change');
}
