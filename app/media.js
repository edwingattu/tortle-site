import { supabase } from './auth.js';

// Optimized media helpers for Photo/Video + Voice
export function pickPhotoMime() {
  if (typeof document === 'undefined') return 'image/jpeg';
  const c = document.createElement('canvas');
  return c.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
}

export function pickVideoMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const m of cands) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  for (const m of cands) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export async function compressPhoto(fileOrBlob, maxEdge = 1600) {
  const blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob]);
  const mime = pickPhotoMime();
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const out = await new Promise((r) => canvas.toBlob(r, mime, 0.78));
    return out || blob;
  } catch {
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Same-session retry outbox: blobs can't survive reload, but a flaky-network
// failure shouldn't permanently strand a tile without its media_url.
export const mediaOutbox = [];
export async function flushMediaOutbox(engine) {
  if (!mediaOutbox.length) return;
  const done = [];
  for (const job of mediaOutbox) {
    try {
      const url = await uploadMedia(job.path, job.blob, job.blob.type);
      const acts = engine.getSnapshot().store.activities;
      const rec = acts.find((a) => a.id === job.id);
      if (rec) { rec.media_url = url; rec.media_path = job.path; }
      try { engine.persist(); } catch {}
      done.push(job);
    } catch (e) { console.warn('[media] retry failed', e?.message || e); }
  }
  for (const d of done) mediaOutbox.splice(mediaOutbox.indexOf(d), 1);
}

// Signed URLs: minted per view (1h), cached in memory until near-expiry.
// Storage paths (not URLs) are what sync carries — URLs never persist.
const signCache = new Map();
export async function signedUrl(path, expiresIn = 3600) {
  const hit = signCache.get(path);
  if (hit && hit.exp > Date.now() + 5 * 60 * 1000) return hit.url;
  const { data, error } = await supabase.storage.from('tortle-media').createSignedUrl(path, expiresIn);
  if (error) throw error;
  signCache.set(path, { url: data.signedUrl, exp: Date.now() + expiresIn * 1000 });
  return data.signedUrl;
}

// Back-compat: pre-privacy rows carry only a public media_url — derive the path.
export function pathFromActivity(a) {
  if (!a) return null;
  if (a.media_path) return a.media_path;
  const u = a.media_url || '';
  const m = u.match(/\/(?:tourtle|tortle)-media\/([^?]+)/);
  return m ? m[1] : null;
}

export function hasMedia(a) {
  return !!(a && (a.localUrl || a.media_path || a.media_url));
}

export async function uploadMedia(path, blob, contentType) {
  const { data, error } = await supabase.storage.from('tortle-media').upload(path, blob, {
    contentType: contentType || blob.type || 'application/octet-stream',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) throw error;
  const { data: pub } = supabase.storage.from('tortle-media').getPublicUrl(path);
  return pub?.publicUrl || data.path;
}
