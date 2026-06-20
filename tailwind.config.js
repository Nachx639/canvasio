/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"Berkeley Mono"', '"JetBrains Mono"', '"SF Mono"', 'ui-monospace', 'Menlo', 'monospace'],
        sans: ['"Inter"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        serif: ['"Spectral"', 'Georgia', 'serif']
      },
      colors: {
        canvasio: {
          night: '#0b1326',
          deep: '#070d1c',
          panel: 'rgba(13, 20, 38, 0.72)',
          glass: 'rgba(18, 27, 48, 0.55)',
          border: 'rgba(120, 150, 220, 0.18)',
          accent: '#5b8cff',
          claude: '#d97757',
          codex: '#10a37f',
          cursor: '#7aa2ff'
        }
      },
      backdropBlur: {
        xl: '24px'
      },
      animation: {
        twinkle: 'twinkle 4s ease-in-out infinite',
        float: 'float 16s ease-in-out infinite'
      },
      keyframes: {
        twinkle: {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '1' }
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' }
        }
      }
    }
  },
  plugins: []
}
