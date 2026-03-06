/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        accent: "#228BE6",
        "accent-dark": "#1C7ED6",
        "cost-alert": "#E8590C",
        "status-success": "#2B8A3E",
        "status-error": "#E03131",
        "status-running": "#228BE6",
        "status-warning": "#E8590C",
      },
      fontSize: {
        base: "13px",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "SF Mono",
          "Monaco",
          "Inconsolata",
          "Fira Mono",
          "Droid Sans Mono",
          "Source Code Pro",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};
