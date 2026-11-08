/** Public configuration shared by the AI settings panel and native IPC. Secrets are separate. */
export type AiSettings = { endpoint: string; model: string; commandTimeoutSeconds: number; chatOnly?: boolean };
export const defaultAiSettings: AiSettings = { endpoint: 'http://localhost:11434/v1', model: '', commandTimeoutSeconds: 120, chatOnly: false };
export function validateSettings(value: AiSettings): AiSettings {
  if (new TextEncoder().encode(value.endpoint).length > 2048 || /[\u0000-\u001f\u007f]/.test(value.endpoint)) throw Error('Invalid AI endpoint');
  const url = new URL(value.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Invalid AI endpoint');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Remote AI endpoints require HTTPS');
  const model = value.model.trim();
  if (!model || new TextEncoder().encode(model).length > 256 || /[\u0000-\u001f\u007f]/.test(model)) throw Error('Model must be 1–256 bytes without control characters');
  if (!Number.isInteger(value.commandTimeoutSeconds) || value.commandTimeoutSeconds < 1 || value.commandTimeoutSeconds > 3600) throw Error('Command timeout must be 1–3600 seconds');
  return { endpoint: url.href.replace(/\/+$/, ''), model, commandTimeoutSeconds: value.commandTimeoutSeconds, chatOnly: value.chatOnly ?? false };
}
