/**
 * Human-readable sizes, rates and durations.
 *
 * Separate from `ui/dom.js` because the loading and diagnostic code needs to
 * talk in gigabytes — model weights and storage quotas both live up there —
 * while the request log tops out at kilobytes. Keeping them apart means neither
 * formatter has to compromise, and this one is a pure module the unit suite can
 * cover properly.
 *
 * @module llm/format
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * Format a byte count, scaling up to gigabytes.
 *
 * Precision drops as the number grows: `1.25 GB` is useful, `1.2534 GB` is
 * noise, and `1253 MB` is harder to compare against a quota quoted in GB.
 *
 * @param {number|null|undefined} bytes
 * @returns {string} e.g. `612 MB`, `1.25 GB`, or `—` when unknown.
 */
export function formatSize(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} kB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 2 : 1)} GB`;
}

/**
 * Format a transfer rate.
 *
 * @param {number|null|undefined} bytesPerSecond
 * @returns {string} e.g. `4.2 MB/s`, or `—` when unknown.
 */
export function formatRate(bytesPerSecond) {
  if (
    bytesPerSecond === null ||
    bytesPerSecond === undefined ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  ) {
    return '—';
  }
  return `${formatSize(bytesPerSecond)}/s`;
}

/**
 * Format an elapsed duration precisely.
 *
 * @param {number|null|undefined} ms
 * @returns {string} e.g. `48 s`, `1 m 48 s`, `1 h 04 m`.
 */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} m`;
}

/**
 * Format a *predicted* remaining duration.
 *
 * Deliberately vaguer than {@link formatDuration}. An estimate quoted to the
 * second reads as a promise, and this one is extrapolated from a download rate
 * that changes minute to minute — so it rounds to a granularity it can defend
 * and says "about".
 *
 * @param {number|null|undefined} ms
 * @returns {string|null} `null` when there is nothing worth claiming.
 */
export function formatEta(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = ms / 1000;
  if (seconds < 10) return 'a few seconds left';
  if (seconds < 90) return `about ${Math.round(seconds / 10) * 10} seconds left`;
  const minutes = seconds / 60;
  if (minutes < 60) return `about ${Math.round(minutes)} minutes left`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0
    ? `about ${hours} ${hours === 1 ? 'hour' : 'hours'} left`
    : `about ${hours} h ${rest} m left`;
}
