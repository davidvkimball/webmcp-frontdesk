import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // REPLACE_ME once the Netlify site is created and the name is known.
  site: 'https://clarks-creek-plumbing.netlify.app',
  adapter: netlify(),
  trailingSlash: 'always',
  integrations: [sitemap()],
});
