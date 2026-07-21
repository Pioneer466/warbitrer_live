import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#07080d",
        panel: "#0e1017",
        shell: "#121520",
        edge: "#1d2131",
        cyan: "#1ce7cf",
        rose: "#ff627d",
        amber: "#ffb84f",
        lilac: "#8f7cff",
        mist: "#8f98b3",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(28,231,207,0.12), 0 18px 60px rgba(28,231,207,0.1)",
        warm: "0 0 0 1px rgba(255,184,79,0.14), 0 18px 50px rgba(255,184,79,0.12)",
      },
      backgroundImage: {
        noise: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.035) 1px, transparent 0)",
      },
      fontFamily: {
        display: ["Avenir Next", "Satoshi", "Segoe UI", "sans-serif"],
        mono: ["IBM Plex Mono", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
