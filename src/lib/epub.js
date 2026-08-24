// Minimal EPUB reader: enough to extract chapter text from typical EPUB 2/3
// books (compressed or not). Uses JSZip for the container.

import JSZip from 'jszip';
import { htmlToParagraphs } from './text.js';

function parseXml(str) {
  return new DOMParser().parseFromString(str, 'application/xml');
}

function resolvePath(base, href) {
  try {
    return new URL(href, base).pathname.replace(/^\/+/, '');
  } catch {
    // fall back to naive relative resolution
    const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
    let p = dir + href;
    // resolve ../ and ./
    const parts = [];
    for (const seg of p.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }
}

export async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file);

  // 1. container -> OPF path
  let opfPath;
  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const container = parseXml(await containerFile.async('string'));
    const rootfile = container.querySelector('rootfile');
    opfPath = rootfile && rootfile.getAttribute('full-path');
  }
  if (!opfPath) {
    // fallback: find the first .opf in the zip
    const candidates = Object.keys(zip.files).filter((n) => n.endsWith('.opf'));
    if (!candidates.length) throw new Error('Not a valid EPUB (no .opf found)');
    opfPath = candidates[0];
  }

  // 2. parse OPF
  const opfDoc = parseXml(await zip.file(opfPath).async('string'));
  const opfBase = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const titleEl = opfDoc.querySelector('metadata > title');
  const title = titleEl ? titleEl.textContent.trim() : file.name.replace(/\.epub$/i, '');
  const creatorEl = opfDoc.querySelector('metadata > creator');
  const author = creatorEl ? creatorEl.textContent.trim() : '';

  const manifest = new Map();
  for (const item of opfDoc.querySelectorAll('manifest > item')) {
    manifest.set(item.getAttribute('id'), item.getAttribute('href'));
  }

  // 3. walk spine, extract text per chapter
  const chapters = [];
  let chNum = 0;
  for (const itemref of opfDoc.querySelectorAll('spine > itemref')) {
    const href = manifest.get(itemref.getAttribute('idref'));
    if (!href) continue;
    const path = resolvePath(opfBase, href);
    const zipFile = zip.file(path) || zip.file(path.replace(/^\/+/, ''));
    if (!zipFile) continue;
    let html;
    try {
      html = await zipFile.async('string');
    } catch {
      continue; // image or binary item
    }
    if (!/<\s*(html|body|p|div|h[1-6])[\s>]/i.test(html)) continue;

    const paragraphs = htmlToParagraphs(html);
    if (!paragraphs.length) continue;
    chNum++;
    chapters.push({ title: `Chapter ${chNum}`, text: paragraphs.join('\n\n') });
  }

  if (!chapters.length) throw new Error('No readable text found in this EPUB.');
  return { title, author, chapters };
}
