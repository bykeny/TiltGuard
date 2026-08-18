/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
    './src/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // Risk colors — §7 non-negotiable tokens. Used consistently across the
        // gauge, alerts, and push notification categories.
        risk: {
          stable: '#22c55e',
          elevated: '#eab308',
          critical: '#f97316',
          lockRequired: '#ef4444',
        },
      },
    },
  },
  plugins: [],
};
