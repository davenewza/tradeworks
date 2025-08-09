/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: '#0C1446',
          red: '#F70B28',
          blue: '#3CC7F7',
          purple: '#AC4DFF',
          orange: '#FF8B00',
          green: '#93DB21',
          yellow: '#FFD500',
          grey: '#B3B3B3',
        }
      },
      fontFamily: {
        sans: [
          'Outfit',
          'ui-sans-serif',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'Noto Sans',
          'sans-serif'
        ]
      }
    },
  },
  plugins: [],
}
