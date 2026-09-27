/** Server-shaped V0 config. Thresholds stay in one place so they can later move to Supabase. */
export const CONFIG = {
  h3Resolution: 9,
  dwellThresholdMs: 3 * 60 * 1000,
  activityBoostMs: 90 * 1000,
  outingInactivityMs: 2 * 60 * 60 * 1000,
  maxRenderCells: 2800,
  // Semantic tiles: unlocked at 30% of members, mastered at 50% (same
  // counter — unlocked members — two bars, applied recursively every level).
  // Minimums keep tiny areas from skipping tiers (unlock needs 2, master 3).
  areaUnlockFraction: 0.3,
  areaUnlockMin: 2,
  areaMasteredFraction: 0.5,
  areaMasteredMin: 3,
  implausibleSpeedMps: 55,
  weakAccuracyM: 85,
  smoothWindow: 5,
  simulateStepMeters: 95,
  // Cloud sync: push outbox this often + on page hide; pulls on launch.
  syncIntervalMs: 30_000,
  syncBatchCells: 500,
  mapStyle: 'https://tiles.openfreemap.org/styles/positron',
  // No default user location: the map boots on a neutral wide view and the
  // location gate is the sole granter. Nothing silently falls back anywhere.
  defaultZoom: 14.51,
  coverageRingK: 12,
  // City-core precompute: gridDisk radius around the base cell cached once,
  // viewport slices served from it. k=45 -> 6,211 cells ≈ 650 km² (GHMC core).
  cityCacheK: 45,
  nominatimUrl: 'https://nominatim.openstreetmap.org/reverse',
  supabaseUrl: 'https://ftfcwxifezbzlfdbhxqy.supabase.co',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ0ZmN3eGlmZXpiemxmZGJoeHF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MDA3MzUsImV4cCI6MjEwNTM3NjczNX0.HfXq80w9kJdrbZQYRh5EbfUSUpsNM6y9iJj8vct2T34',
  appUrl: 'https://www.gruffy.in',
};

export const CATEGORIES = [
  { id: 'sightseeing', label: 'Sightseeing & Heritage', short: 'Heritage', icon: 'landmark' },
  { id: 'dining', label: 'Dining', short: 'Dining', icon: 'dining' },
  { id: 'nature', label: 'Nature & Outdoors', short: 'Nature', icon: 'nature' },
  { id: 'sports', label: 'Sports & Adventure', short: 'Sports', icon: 'sports' },
  { id: 'events', label: 'Events', short: 'Events', icon: 'events' },
  { id: 'nightlife', label: 'Nightlife', short: 'Nightlife', icon: 'nightlife' },
  { id: 'wellness', label: 'Wellness', short: 'Wellness', icon: 'wellness' },
  { id: 'travel', label: 'Travel', short: 'Travel', icon: 'travel' },
];

export const CATEGORY_COLORS = {
  sightseeing: '#c9853a',
  dining: '#d85a3a',
  nature: '#2f8f62',
  sports: '#2a69aa',
  events: '#6e66a9',
  nightlife: '#3d2f6b',
  wellness: '#4aa3a8',
  travel: '#173668',
};

/** Real street-level walk through Begumpet → Necklace Road for the + simulator. */
export const DEMO_WALK = [
  [78.4867, 17.4375],
  [78.4841, 17.4358],
  [78.4812, 17.4341],
  [78.4784, 17.4322],
  [78.4758, 17.4301],
  [78.4739, 17.4278],
  [78.4732, 17.4254],
  [78.4736, 17.4234],
  [78.4755, 17.4222],
  [78.4782, 17.4216],
  [78.4810, 17.4219],
  [78.4836, 17.4233],
  [78.4858, 17.4256],
  [78.4874, 17.4284],
  [78.4879, 17.4314],
  [78.4869, 17.4346],
];
