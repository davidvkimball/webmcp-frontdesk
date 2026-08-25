import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async ({ site }) => {
  const baseUrl = site ? site.href.replace(/\/$/, '') : 'https://example.com';

  // Core pages (static, update when adding/removing pages)
  const pages = [
    { title: 'Home', path: '/' },
    { title: 'About', path: '/about/' },
    { title: 'Contact', path: '/contact/' },
  ];

  // Blog posts (dynamic, pulled from content collection)
  const blogPosts = await getCollection('blog', ({ data }) => !data.draft);
  const sortedPosts = blogPosts.sort((a, b) =>
    new Date(b.data.date).getTime() - new Date(a.data.date).getTime()
  );

  const lines = [
    '# REPLACE_ME - Site Name',
    '',
    'REPLACE_ME - one-line site description.',
    '',
    '## Pages',
    ...pages.map(p => `- [${p.title}](${baseUrl}${p.path})`),
  ];

  if (sortedPosts.length > 0) {
    lines.push('', '## Blog');
    for (const post of sortedPosts) {
      lines.push(`- [${post.data.title}](${baseUrl}/blog/${post.id}/)`);
    }
  }

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
