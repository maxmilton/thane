import { signal } from 'thane';
import { expose } from './expose.js';

/** Store signals that list rows subscribe to (L1, L2). The spec counts their live subscribers. */
export const l1Tick = signal(0);
export const l2Tick = signal(0);

expose('store', { l1Tick, l2Tick });
