import type { Store } from '../models.js';
type Coordinates = { latitude: number; longitude: number };
export function distanceKm(a: Coordinates, b: Coordinates) {
  const r = Math.PI / 180,
    lat1 = Number(a.latitude) * r,
    lat2 = Number(b.latitude) * r;
  const x =
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(((Number(b.longitude) - Number(a.longitude)) * r) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
export function isStoreOpen(store: Pick<Store, 'timezone' | 'opens_at' | 'closes_at'>, date = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: store.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  const from = String(store.opens_at).slice(0, 5),
    to = String(store.closes_at).slice(0, 5);
  return from === to || (from < to ? time >= from && time < to : time >= from || time < to);
}
