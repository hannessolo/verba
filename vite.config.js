import { defineConfig } from 'vite';

// Relative base so the built app works from any mount path — in particular
// GitHub Pages (https://<user>.github.io/<repo>/). The app uses hash routing,
// so no server-side rewrites are needed either.
export default defineConfig({
  base: './',
});
