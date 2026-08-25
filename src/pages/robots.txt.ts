import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const sitemapUrl = new URL('sitemap-index.xml', site).href;
  const llmsUrl = new URL('llms.txt', site).href;

  const robotsTxt = `
User-agent: *
Allow: /

Disallow: /admin
Disallow: /admin/
Disallow: /thank-you/

Sitemap: ${sitemapUrl}

# LLM-readable site manifest
# https://llmstxt.org
# ${llmsUrl}
`.trim();

  return new Response(robotsTxt, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
