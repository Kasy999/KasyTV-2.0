/** Kasy TV PWA – entry point. */
import { store } from './core/store.js';
import { db, requestPersistence } from './core/db.js';
import { initInputMode, inputMode } from './core/input-mode.js';
import { initPerformance } from './core/performance.js';
import { initFocus, focusFirst } from './core/focus.js';
import { bus } from './core/events.js';
import { isIOS, isStandalone } from './core/util.js';
import { initTextStyles } from './services/text-style.js';
import { daysSinceBackup, exportBackup } from './services/backup.js';
import { mountApp, showBanner } from './app.js';
import { toast } from './components/toast.js';

// replaceChildren for older TV browsers (Chromium < 86), and everywhere: skip null/false entries instead of
// rendering them as the text "null" (conditional UI parts like `cond ? button : null`).
{
  const nativeReplace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...nodes) {
    const list = nodes.filter((n) => n !== null && n !== undefined && n !== false);
    if (nativeReplace) return nativeReplace.apply(this, list);
    while (this.firstChild) this.removeChild(this.firstChild);
    for (const n of list) this.append(n);
    return undefined;
  };
}

async function boot() {
  await db.open();
  await store.init();
  initInputMode();
  initPerformance();
  initTextStyles();

  const root = document.getElementById('app');
  const { banner } = mountApp(root);
  initFocus(root);
  document.documentElement.classList.remove('boot');
  if (inputMode.isTV()) requestAnimationFrame(() => focusFirst(root));

  registerServiceWorker();
  hints(banner);

  // Installed PWAs get persistent storage more easily (Safari/Chrome) – ask once quietly.
  if (isStandalone()) requestPersistence();

  window.addEventListener('online', () => toast('Wieder online', { kind: 'success' }));
  window.addEventListener('offline', () => toast('Offline – gespeicherte Inhalte bleiben verfügbar', { kind: 'warn', duration: 5000 }));
}

/**
 * Service worker only for the offline start from the homescreen. No update prompt: a new version is fetched
 * by the browser in the background and simply used at the next start.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const run = () => navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => console.warn('[sw]', e));
  if (document.readyState === 'complete') setTimeout(run, 500);
  else window.addEventListener('load', run);
}

function hints(banner) {
  // iOS in Safari (not installed): how to add to the homescreen.
  if (isIOS() && !isStandalone() && !sessionStorage.getItem('kasy.hint.install')) {
    sessionStorage.setItem('kasy.hint.install', '1');
    showBanner(banner, { text: 'Tipp: Über „Teilen“ → „Zum Home-Bildschirm“ wird Kasy TV zur App – mit Vollbild und Offline-Start.', iconName: 'download' });
  }
  // Backup reminder (Safari wipes data of web apps after a while without use).
  const hasData = (store.get('iptv.sources') || []).length || store.get('jellyfin.token');
  if (store.get('backup.remind') && hasData && daysSinceBackup() > 14) {
    showBanner(banner, {
      text: daysSinceBackup() === Infinity ? 'Deine Einstellungen sind noch nicht gesichert.' : 'Letzte Sicherung ist über 14 Tage alt.',
      actionLabel: 'Jetzt sichern',
      iconName: 'save',
      onAction: async (el) => {
        const how = await exportBackup({ includePlaylists: true, includeCredentials: true });
        if (how !== 'cancelled') {
          el.remove();
          toast('Sicherung erstellt', { kind: 'success' });
        }
      },
    });
  }
  bus.on('backup:imported', () => toast('Einstellungen wiederhergestellt', { kind: 'success' }));
}

boot().catch((e) => {
  console.error(e);
  document.documentElement.classList.remove('boot');
  document.getElementById('app').textContent = 'Kasy TV konnte nicht starten: ' + e.message;
});
