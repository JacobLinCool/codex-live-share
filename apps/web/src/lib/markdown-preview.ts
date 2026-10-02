import DOMPurify from 'dompurify';
import { marked } from 'marked';
import * as Y from 'yjs';
import { blobsOf, filesOf, isBlobRef, normalizeSharedPath } from '@codex-live-share/protocol';
import { t } from './i18n';

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};

/** Resolve an image URL within the shared folder, never the editor's web root. */
export function resolveImagePath(markdownPath: string, source: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(source.trim().split(/[?#]/u, 1)[0] ?? '').replaceAll('\\', '/');
  } catch {
    return null;
  }
  if (!path || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(path)) return null;
  const parts = path.startsWith('/') ? [] : markdownPath.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return normalizeSharedPath(parts.join('/'));
}

/** Owns DOM and object URLs for one preview, including late-arriving image bytes. */
export function mountMarkdownPreview(element: HTMLElement, text: Y.Text, path: string, doc: Y.Doc): () => void {
  const files = filesOf(doc);
  const blobs = blobsOf(doc);
  let urls: string[] = [];
  const render = () => {
    // Sanitize before introducing trusted, locally generated object URLs. Strip
    // responsive sources so they cannot override the resolved shared image.
    const fragment = DOMPurify.sanitize(marked.parse(text.toString(), { async: false }), {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ['source'],
      FORBID_ATTR: ['srcset'],
    });
    const nextUrls: string[] = [];
    const imageUrls = new Map<string, string>();
    for (const image of fragment.querySelectorAll('img')) {
      const source = image.getAttribute('src') ?? '';
      // Embedded images already work without a network request or a shared file.
      if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml|avif|bmp|x-icon)[;,]/iu.test(source)) continue;
      const imagePath = resolveImagePath(path, source);
      const type = imagePath ? IMAGE_TYPES[imagePath.split('.').at(-1)!.toLowerCase()] : undefined;
      const value = imagePath ? files.get(imagePath) : undefined;
      const bytes = isBlobRef(value) ? blobs.get(value.hash) : undefined;
      const content = bytes ?? (value instanceof Y.Text && type === 'image/svg+xml' ? value.toString() : undefined);
      if (imagePath && type && content !== undefined) {
        let url = imageUrls.get(imagePath);
        if (!url) {
          url = URL.createObjectURL(new Blob([content as BlobPart], { type }));
          nextUrls.push(url);
          imageUrls.set(imagePath, url);
        }
        image.setAttribute('src', url);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'image-unavailable';
        placeholder.setAttribute('role', 'img');
        placeholder.textContent = t('imageUnavailable', { image: image.getAttribute('alt') || source });
        placeholder.title = source;
        image.replaceWith(placeholder);
      }
    }
    element.replaceChildren(fragment);
    for (const url of urls) URL.revokeObjectURL(url);
    urls = nextUrls;
  };
  // afterTransaction sees file references and bytes together. Deep changes also
  // include SVG text edits; unrelated plans/transcripts do not rebuild previews.
  const onTransaction = (transaction: Y.Transaction) => {
    const changed = new Set<unknown>(transaction.changedParentTypes.keys());
    if (changed.has(text) || changed.has(files) || changed.has(blobs)) render();
  };
  doc.on('afterTransaction', onTransaction);
  render();
  return () => {
    doc.off('afterTransaction', onTransaction);
    element.replaceChildren();
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
  };
}
