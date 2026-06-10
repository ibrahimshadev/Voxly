import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html);
}
