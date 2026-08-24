// Export / import helpers shared by the library and the reader.

import { exportSnapshot, mergeImport } from './store.js';

// Trigger a browser download of the full data snapshot as a JSON file.
export function downloadData() {
  const blob = new Blob([JSON.stringify(exportSnapshot(), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `verba-data-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Read and merge an exported JSON file. Returns {booksAdded, pagesMerged,
// wordsAdvanced} so the caller can show a summary.
export async function importFromFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('File is not valid JSON.');
  }
  return mergeImport(data);
}

export function importSummary(stats) {
  const parts = [];
  if (stats.booksAdded) parts.push(`${stats.booksAdded} new book${stats.booksAdded === 1 ? '' : 's'} added`);
  if (stats.pagesMerged) parts.push(`${stats.pagesMerged} reading position${stats.pagesMerged === 1 ? '' : 's'} updated`);
  if (stats.wordsAdvanced) parts.push(`${stats.wordsAdvanced} word${stats.wordsAdvanced === 1 ? '' : 's'} advanced`);
  return parts.length ? `Import complete — ${parts.join(', ')}.` : 'Import complete — nothing new to import.';
}
