/** Seed device library (R-24). Order here is the library order used by palettes and schedules. */
export interface SeedCategory {
  name: string;
  color: string;
  types: { code: string; name: string }[];
}

export const SEED_LIBRARY: SeedCategory[] = [
  {
    name: 'Audio',
    color: '#1f6fd1',
    types: [
      { code: 'SPK', name: 'In-ceiling speaker' },
      { code: 'IWS', name: 'In-wall speaker' },
      { code: 'SUB', name: 'Subwoofer' },
      { code: 'OSP', name: 'Outdoor speaker' },
      { code: 'VOL', name: 'Volume control' },
    ],
  },
  {
    name: 'Video',
    color: '#7a3fc2',
    types: [
      { code: 'TV', name: 'TV' },
      { code: 'TVARC', name: 'TV/ARC' },
      { code: 'PRJ', name: 'Projector' },
      { code: 'SBR', name: 'Soundbar' },
    ],
  },
  {
    name: 'Control',
    color: '#d12f2f',
    types: [
      { code: 'KPD', name: 'Keypad' },
      { code: 'TS', name: 'Touchscreen' },
      { code: 'TSTAT', name: 'Thermostat' },
      { code: 'SHD', name: 'Shade' },
      { code: 'SEN', name: 'Sensor' },
    ],
  },
  {
    name: 'Network',
    color: '#1e8f4e',
    types: [
      { code: 'DMRC', name: 'Demarc' },
      { code: 'WAP', name: 'Wireless AP' },
      { code: 'DATA', name: 'Data drop' },
      { code: 'RACK', name: 'Equipment rack' },
    ],
  },
  {
    name: 'Security',
    color: '#e07a10',
    types: [
      { code: 'CAM', name: 'Camera' },
      { code: 'DBL', name: 'Video doorbell' },
      { code: 'LCK', name: 'Smart lock' },
    ],
  },
  {
    name: 'Other',
    color: '#6b7280',
    types: [{ code: 'NOTE', name: 'Note' }],
  },
];

/** Logo color spectrum (R-62). */
export const SPECTRUM = [
  '#d80060',
  '#d83030',
  '#f07800',
  '#f0a800',
  '#a8c018',
  '#1a8a4a',
  '#009078',
  '#00a8d8',
  '#0078a8',
  '#781878',
];
