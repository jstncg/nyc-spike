import { defineConfig } from 'vite';

// VITE_BASE=/nyc-spike/ for GitHub Pages project sites; default root for Cloudflare Pages, Vercel, or a custom domain.
export default defineConfig({ base: process.env.VITE_BASE || '/' });
