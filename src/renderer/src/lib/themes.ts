export interface Theme {
  id: string
  name: string
  sky: [string, string, string, string]
  nebula: [string, string]
  moon: string
  moonHalo: string
  grass: [string, string] | null
  blade: string
  accent: string
  firefly: string
  star: [string, string]
}

export const THEMES: Theme[] = [
  {
    id: 'midnight',
    name: 'Medianoche',
    sky: ['#0a1538', '#0d1b46', '#13265a', '#1b3470'],
    nebula: ['rgba(96,128,230,0.22)', 'rgba(120,90,200,0.12)'],
    moon: '#eef3ff',
    moonHalo: 'rgba(220,230,255,0.30)',
    grass: ['#10331f', '#081d12'],
    blade: 'rgba(40,110,60,0.5)',
    accent: '#5b8cff',
    firefly: '#ffe98a',
    star: ['#dce8ff', '#9fb4e6']
  },
  {
    id: 'aurora',
    name: 'Aurora',
    sky: ['#04141a', '#062028', '#08323a', '#0a4048'],
    nebula: ['rgba(60,220,170,0.20)', 'rgba(90,120,255,0.14)'],
    moon: '#eafff6',
    moonHalo: 'rgba(180,255,225,0.30)',
    grass: ['#0c3326', '#06190f'],
    blade: 'rgba(40,140,90,0.5)',
    accent: '#36d399',
    firefly: '#9bffd8',
    star: ['#d8fff2', '#8fe8c8']
  },
  {
    id: 'sunset',
    name: 'Ocaso',
    sky: ['#1a1030', '#341840', '#5a2448', '#7a3450'],
    nebula: ['rgba(255,140,90,0.22)', 'rgba(230,90,160,0.16)'],
    moon: '#ffeede',
    moonHalo: 'rgba(255,200,170,0.32)',
    grass: ['#2a1626', '#160a14'],
    blade: 'rgba(150,80,90,0.45)',
    accent: '#ff8a5c',
    firefly: '#ffd28a',
    star: ['#ffe8d8', '#e8b0a0']
  },
  {
    id: 'nebula',
    name: 'Nebulosa',
    sky: ['#08060f', '#0e0a1f', '#16102f', '#1d1640'],
    nebula: ['rgba(150,90,230,0.24)', 'rgba(80,120,255,0.16)'],
    moon: '#f3eeff',
    moonHalo: 'rgba(210,190,255,0.34)',
    grass: null,
    blade: 'rgba(120,90,200,0.4)',
    accent: '#a06bff',
    firefly: '#d6b6ff',
    star: ['#efe8ff', '#b9a8e6']
  },
  {
    id: 'noir',
    name: 'Noir',
    sky: ['#0a0c10', '#10131a', '#171b24', '#1e232e'],
    nebula: ['rgba(180,190,210,0.12)', 'rgba(120,130,150,0.08)'],
    moon: '#f2f4f8',
    moonHalo: 'rgba(220,225,235,0.26)',
    grass: ['#15181e', '#0a0c10'],
    blade: 'rgba(120,130,150,0.35)',
    accent: '#c7d0e0',
    firefly: '#e8edf5',
    star: ['#eef1f6', '#aab2c2']
  },
  {
    id: 'daybreak',
    name: 'Amanecer',
    sky: ['#16294f', '#234373', '#3a6398', '#6a9ac8'],
    nebula: ['rgba(255,220,150,0.20)', 'rgba(140,180,255,0.16)'],
    moon: '#fffdf0',
    moonHalo: 'rgba(255,245,200,0.34)',
    grass: ['#2a5a3a', '#16401f'],
    blade: 'rgba(70,150,90,0.5)',
    accent: '#3b6bf0',
    firefly: '#fff0a0',
    star: ['#ffffff', '#cfe0ff']
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    sky: ['#050507', '#08080c', '#0d0d14', '#14121c'],
    nebula: ['rgba(139,120,214,0.16)', 'rgba(90,80,140,0.10)'],
    moon: '#e9e6f5',
    moonHalo: 'rgba(200,190,230,0.26)',
    grass: ['#0e0d16', '#070609'],
    blade: 'rgba(110,95,150,0.32)',
    accent: '#8b78d6',
    firefly: '#cbb8ff',
    star: ['#e8e2ff', '#a99fc8']
  }
]

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) || THEMES[0]
}
