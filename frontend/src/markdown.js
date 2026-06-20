import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

// Renders assistant chat text as sanitized HTML. The model's own output is
// trusted in spirit (it's the configured provider talking back to the user)
// but may echo untrusted content (tool/command output, pasted text), so the
// markdown-to-HTML result is run through DOMPurify before ever reaching
// innerHTML.
export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ''));
}
