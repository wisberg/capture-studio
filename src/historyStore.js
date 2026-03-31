import { get, set, del } from "idb-keyval";

const HISTORY_KEY = "exportHistory:v1";

export function loadHistory() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
}

export function createPreviewKey(entryId, itemId, variant) {
  return `preview:${entryId}:${itemId}:${variant}`;
}

export function createZipKey(entryId) {
  return `zip:${entryId}`;
}

export async function storePreviewBlob(key, blob) {
  await set(key, blob);
}

export async function loadPreviewBlob(key) {
  return get(key);
}

export async function loadZipBlob(key) {
  return get(key);
}

export async function removePreviewBlob(key) {
  await del(key);
}

export async function removeStoredBlob(key) {
  await del(key);
}
