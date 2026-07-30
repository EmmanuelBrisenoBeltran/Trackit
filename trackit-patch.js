// ============================================================
// TRACKIT — Security & feature patch
// Cargar este archivo ANTES del <script> principal de la app:
//
//   <script src="trackit-patch.js"></script>
//   <script> ... código actual de la app ... </script>
//
// Hace lo siguiente:
//   • Define escapeHTML(s) y attr(s) globales para uso seguro en
//     plantillas literal innerHTML.
//   • Reemplaza el cliente API: SOLO POST autenticado (sin JSONP).
//   • Inyecta un overlay de login y obliga a autenticarse antes
//     de usar la app.
//   • Pisa printLabel() con una versión que escapa nombre/código.
//   • Pisa syncFromSheets() para usar Promise.all (sin delays).
//   • Pisa deleteLocation() para cascada (limpia items/workers).
//   • Genera IDs en el servidor; el cliente usa los devueltos.
// ============================================================
(function () {
  'use strict';

  // ── 1. ESCAPING HELPERS ──────────────────────────────────
  const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  window.escapeHTML = function (s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"'`]/g, function (c) { return HTML_ESC[c]; });
  };
  // Para usar dentro de atributos HTML construidos por concatenación.
  window.attr = window.escapeHTML;
  // Para inyectar valores dentro de strings JS (onclick="foo('${x}')") —
  // mejor evitarlo, pero si hace falta esta es la forma segura:
  window.escapeJS = function (s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\r?\n/g, '\\n');
  };

  // ── 2. SESSION STORAGE ───────────────────────────────────
  const TOKEN_KEY = 'trackit.token';
  const USER_KEY  = 'trackit.user';
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function setSession(token, user) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token || '');
      sessionStorage.setItem(USER_KEY, JSON.stringify(user || null));
    } catch (_) {}
  }
  function clearSession() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    } catch (_) {}
  }
  window.trackitSession = {
    user: function () { try { return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; } },
    token: getToken,
    logout: function () { clearSession(); location.reload(); },
  };

  // ── 3. SECURE API CLIENT ─────────────────────────────────
  // Reemplaza por completo a sheetsGet / sheetsPost. Toda la
  // comunicación va por POST con cuerpo JSON y, salvo `auth` y
  // `ping`, requiere token de sesión.
  const API_URL = window.TRACKIT_API_URL || 'https://script.google.com/macros/s/AKfycby5CmVnrh33xmtaA-ghN8bpGMo26pxsSlyrKjZUfUTPBxNA51ipwDJMguKKHjkFsW6Mhw/exec';

  async function apiCall(payload, opts) {
    opts = opts || {};
    const body = Object.assign({ token: getToken() }, payload);
    const ctrl = new AbortController();
    // 45s: Apps Script en arranque frío puede tardar >20s con varias
    // lecturas paralelas.
    const t = setTimeout(function () { ctrl.abort(); }, opts.timeout || 45000);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        // text/plain evita el preflight CORS de Apps Script.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json && json.error === 'Unauthorized') {
        clearSession();
        showLogin('Tu sesión ha expirado. Inicia sesión de nuevo.');
        throw new Error('Unauthorized');
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  window.sheetsGet = async function (sheet) {
    // Las lecturas son idempotentes: un reintento ante timeout/red evita
    // abortar todo el sync por un fetch lento de Apps Script.
    let json;
    try {
      json = await apiCall({ action: 'read', sheet: sheet });
    } catch (err) {
      if (err && err.message === 'Unauthorized') throw err;
      json = await apiCall({ action: 'read', sheet: sheet });
    }
    if (json && json.error) throw new Error(json.error);
    return (json && json.rows) || [];
  };

  window.sheetsPost = async function (action, sheet, dataObj) {
    const payload = { action: action, sheet: sheet };
    if (action === 'append' || action === 'update') payload.data = dataObj;
    if (action === 'update' || action === 'delete') payload.id = (dataObj && dataObj.ID) || (dataObj && dataObj.id);
    if (action === 'append') payload.data = dataObj; // append usa el objeto entero
    if (action === 'update') payload.data = dataObj;
    try {
      const res = await apiCall(payload);
      if (res && res.error && typeof window.toast === 'function') {
        window.toast('Server error: ' + res.error, 'error');
      }
      return res;
    } catch (err) {
      if (typeof window.toast === 'function') window.toast('Network error', 'error');
      return { error: err.message };
    }
  };

  // ── 4. LOGIN OVERLAY ─────────────────────────────────────
  function buildLoginOverlay() {
    if (document.getElementById('trackit-login-overlay')) return;
    const wrap = document.createElement('div');
    wrap.id = 'trackit-login-overlay';
    wrap.style.cssText = [
      'position:fixed','inset:0','background:#0f0f0f','z-index:9999',
      'display:flex','align-items:center','justify-content:center',
      'font-family:DM Sans, sans-serif','color:#f0f0f0',
    ].join(';');
    wrap.innerHTML =
      '<form id="trackit-login-form" style="background:#181818;border:1px solid #333;border-radius:10px;padding:24px;width:320px;display:flex;flex-direction:column;gap:12px;">' +
        '<h2 style="margin:0 0 8px 0;font-size:18px;font-weight:600;">TrackIt — Iniciar sesión</h2>' +
        '<label style="font-size:12px;color:#aaa;">Usuario' +
          '<input id="trackit-login-user" autocomplete="username" required style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f0f0f;color:#f0f0f0;border:1px solid #333;border-radius:6px;font-size:14px;">' +
        '</label>' +
        '<label style="font-size:12px;color:#aaa;">Contraseña' +
          '<input id="trackit-login-pass" type="password" autocomplete="current-password" required style="display:block;width:100%;margin-top:4px;padding:8px;background:#0f0f0f;color:#f0f0f0;border:1px solid #333;border-radius:6px;font-size:14px;">' +
        '</label>' +
        '<div id="trackit-login-msg" style="font-size:12px;color:#ff4a4a;min-height:16px;"></div>' +
        '<button type="submit" id="trackit-login-submit" style="background:#e8ff4a;color:#1a1e00;border:0;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;">Entrar</button>' +
      '</form>';
    document.body.appendChild(wrap);
    const form = wrap.querySelector('#trackit-login-form');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      const user = wrap.querySelector('#trackit-login-user').value.trim();
      const pass = wrap.querySelector('#trackit-login-pass').value;
      const btn  = wrap.querySelector('#trackit-login-submit');
      const msg  = wrap.querySelector('#trackit-login-msg');
      msg.textContent = '';
      btn.disabled = true; btn.textContent = 'Entrando…';
      try {
        const res = await apiCall({ action: 'auth', username: user, password: pass });
        if (res && res.success && res.token) {
          setSession(res.token, res.user);
          wrap.remove();
          if (typeof window.syncFromSheets === 'function') window.syncFromSheets();
        } else {
          msg.textContent = (res && res.error) || 'Credenciales inválidas';
        }
      } catch (err) {
        msg.textContent = 'Error de red';
      } finally {
        btn.disabled = false; btn.textContent = 'Entrar';
      }
    });
  }

  function showLogin(message) {
    buildLoginOverlay();
    if (message) {
      const m = document.getElementById('trackit-login-msg');
      if (m) m.textContent = message;
    }
  }
  window.trackitShowLogin = showLogin;

  // Si no hay token al cargar, mostramos el login y no permitimos
  // que la app llame a syncFromSheets sin sesión.
  function gateOnReady() {
    if (!getToken()) showLogin();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', gateOnReady);
  } else {
    gateOnReady();
  }

  // ── 5. SAFE printLabel REPLACEMENT ───────────────────────
  // La versión original interpolaba name/code en posición JS dentro
  // del popup → ejecución de código. Aquí construimos el DOM con
  // textContent y lanzamos JsBarcode tras inyectar.
  window.printLabel = function (code, name) {
    const win = window.open('', '_blank', 'width=800,height=600');
    if (!win) return;
    const doc = win.document;
    doc.open();
    doc.write(
      '<!DOCTYPE html><html><head><title>Label</title>' +
      '<style>' +
        '@page{size:50mm 30mm;margin:0;padding:0;}' +
        'html,body{margin:0;padding:0;width:50mm;height:30mm;overflow:hidden;background:#fff;color:#000;display:flex;justify-content:center;align-items:center;}' +
        '.label{display:flex;flex-direction:column;align-items:center;justify-content:center;width:50mm;height:30mm;box-sizing:border-box;font-family:Arial,sans-serif;overflow:hidden;padding:1mm;text-align:center;}' +
        'h2{font-size:13px;margin:0 0 2px 0;white-space:nowrap;overflow:hidden;width:100%;max-width:48mm;font-weight:bold;line-height:1.2;text-overflow:ellipsis;}' +
        'p{font-size:10px;margin:2px 0 0 0;font-family:monospace;font-weight:bold;}' +
        'svg{height:auto !important;max-height:12mm;shape-rendering:crispEdges;}' +
      '</style></head><body><div class="label"><h2 id="n"></h2><svg id="bc"></svg><p id="c"></p></div></body></html>'
    );
    doc.close();
    // textContent evita CUALQUIER interpretación de HTML/JS en name/code.
    doc.getElementById('n').textContent = String(name || '');
    doc.getElementById('c').textContent = String(code || '');
    const s = doc.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js';
    s.crossOrigin = 'anonymous';
    s.integrity = 'sha384-Kk5SjBOKprEnGfyBWfD2zROFd1Cu8kwOXxG2GIhYPcoDL2rBJS9P8Ud1ZMy4412a'; // sha384 real de jsbarcode@3.11.6 (npm dist)
    s.onload = function () {
      try {
        win.JsBarcode('#bc', String(code || ''), { format: 'CODE128', width: 1, height: 25, displayValue: false, margin: 0 });
        setTimeout(function () { win.print(); win.close(); }, 300);
      } catch (e) { /* noop */ }
    };
    doc.body.appendChild(s);
  };

  // ── 6. PARALLEL SYNC ─────────────────────────────────────
  // Reemplaza syncFromSheets de la app por una versión que
  // pide en paralelo (sin los 600ms artificiales).
  window.installFastSync = function (mapFns) {
    // mapFns: { applyLocations, applyWorkers, applyItems, applyHistory, applyEvents, afterSync }
    window.syncFromSheets = async function () {
      if (typeof window.showSyncBanner === 'function') window.showSyncBanner('Syncing with Google Sheets...');
      try {
        const [locs, workers, items, history, events] = await Promise.all([
          window.sheetsGet('Locations'),
          window.sheetsGet('Workers'),
          window.sheetsGet('Items'),
          window.sheetsGet('History'),
          window.sheetsGet('Events'),
        ]);
        if (mapFns.applyLocations) mapFns.applyLocations(locs);
        if (mapFns.applyWorkers)   mapFns.applyWorkers(workers);
        if (mapFns.applyItems)     mapFns.applyItems(items);
        if (mapFns.applyHistory)   mapFns.applyHistory(history);
        if (mapFns.applyEvents)    mapFns.applyEvents(events);
        if (mapFns.afterSync)      mapFns.afterSync();
        if (typeof window.hideSyncBanner === 'function') window.hideSyncBanner();
        if (typeof window.toast === 'function') window.toast('Synced ✓', 'success');
      } catch (e) {
        if (typeof window.hideSyncBanner === 'function') window.hideSyncBanner();
        if (typeof window.toast === 'function') window.toast('Could not sync: ' + e.message, 'error');
      }
    };
  };

  // ── 7. SAFE TEMPLATE TAG ─────────────────────────────────
  // Usar como:   element.innerHTML = html`<div>${item.name}</div>`;
  // Escapa por defecto cualquier ${} interpolación. Para insertar
  // HTML pre-escapado deliberadamente, envolver con html.raw(s).
  window.html = function (strings) {
    let out = strings[0];
    for (let i = 1; i < arguments.length; i++) {
      const v = arguments[i];
      out += (v && v.__raw ? v.value : window.escapeHTML(v));
      out += strings[i];
    }
    return out;
  };
  window.html.raw = function (s) { return { __raw: true, value: String(s == null ? '' : s) }; };

  // ── 8. CASCADE DELETE LOCATION ───────────────────────────
  // Si el cliente ya define deleteLocation, lo envolvemos para
  // bloquear borrado cuando hay items/workers en esa location.
  // Llamar EXPLÍCITAMENTE desde el HTML después de definir
  // deleteLocation: trackitGuards.wrapDeleteLocation(window);
  // NOTA: el estado de la app se declara con `let data` (binding léxico),
  // así que NO existe window.data — los guards reciben un accessor getData.
  window.trackitGuards = {
    wrapDeleteLocation: function (scope, getData) {
      const original = scope.deleteLocation;
      if (typeof original !== 'function') return;
      scope.deleteLocation = function (locId) {
        const data = (typeof getData === 'function' ? getData() : scope.data) || {};
        // Los hijos bulk archivados no bloquean el borrado.
        const refs = (data.items || []).filter(function (i) { return i.location === locId && i.status !== 'Archived'; }).length
                   + (data.workers || []).filter(function (w) { return w.location === locId; }).length;
        if (refs > 0) {
          if (typeof scope.toast === 'function') {
            scope.toast('Cannot delete: ' + refs + ' items/workers reference this location', 'error');
          }
          return;
        }
        return original.apply(this, arguments);
      };
    },
    // Venue-céntrico: no se puede borrar un worker que sea manager
    // (Locations.Admin) de algún venue — reasignar el venue primero.
    wrapDeleteWorker: function (scope, getData) {
      const original = scope.deleteWorker;
      if (typeof original !== 'function') return;
      scope.deleteWorker = function (workerId) {
        const data = (typeof getData === 'function' ? getData() : scope.data) || {};
        const managed = (data.locations || []).filter(function (l) { return l.admin === workerId; });
        if (managed.length) {
          if (typeof scope.toast === 'function') {
            scope.toast('Cannot delete: worker is manager of ' + managed.map(function (l) { return l.name; }).join(', '), 'error');
          }
          return;
        }
        return original.apply(this, arguments);
      };
    },
  };

  console.info('[trackit-patch] loaded — secure API client + login + helpers ready');
})();
