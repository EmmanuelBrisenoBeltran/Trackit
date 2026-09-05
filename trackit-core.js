// ============================================================
// TRACKIT — Lógica venue-céntrica pura (sin DOM, sin red).
// La custodia del inventario es el LOCATION (venue), no la persona.
// El manager responde por todo el inventario de su venue vía
// Locations.Admin (WorkerID).
//
// Cargar en el <head> después de trackit-patch.js. También es
// requerible desde Node para pruebas (tests/core.test.js).
//
// Convenciones de estado (objetos planos del cliente):
//   state = { items, locations, workers, assignments }
//   item:      { id, name, barcode, location, status, isBulk, quantity, ... }
//   location:  { id, name, type, admin, barcode }   // admin = WorkerID
//   assignment:{ id, itemId, itemName, locationId, locationName, origin, date }
//
// Semántica de Status: 'Available' = en su base (Warehouse),
// 'Assigned' = trasladado a un venue, 'Archived' = hijo bulk devuelto.
// Las funciones MUTAN los objetos recibidos y devuelven un plan:
//   { changed: [items a persistir], created?: itemHijo, record?: fila
//     para Assignments, message: texto para history } | { error }
// ============================================================
(function (root) {
  'use strict';

  const venueCore = {
    isWarehouse(loc) { return !!loc && loc.type === 'Warehouse'; },

    warehouseOf(state) {
      return state.locations.find((l) => l.type === 'Warehouse') || null;
    },

    managerOf(state, loc) {
      if (!loc || !loc.admin) return null;
      return state.workers.find((w) => w.id === loc.admin) || null;
    },

    managerName(state, loc) {
      const m = this.managerOf(state, loc);
      return m ? ((m.fname || '') + ' ' + (m.lname || '')).trim() : null;
    },

    findVenueByCode(state, code) {
      return state.locations.find((l) => l.barcode === code || l.id === code) || null;
    },

    // Venues elegibles como destino para un item (excluye su ubicación actual).
    assignableVenues(state, item) {
      return state.locations.filter((l) => l.id !== item.location);
    },

    lastAssignmentFor(state, itemId) {
      const list = state.assignments || [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].itemId === itemId) return list[i];
      }
      return null;
    },

    // A dónde vuelve un item al devolverse: origen del último traslado,
    // si no, el primer Warehouse, si no, donde está.
    originFor(state, item) {
      const a = this.lastAssignmentFor(state, item.id);
      if (a && a.origin) return a.origin;
      const wh = this.warehouseOf(state);
      return wh ? wh.id : item.location;
    },

    _label(state, venue) {
      const mgr = this.managerName(state, venue);
      return venue.name + (mgr ? ' (mgr: ' + mgr + ')' : '');
    },

    // Master bulk = misma referencia (barcode) no trasladada.
    bulkMasterFor(state, item) {
      return state.items.find(
        (i) => i.barcode === item.barcode && i.isBulk && i.id !== item.id && i.status !== 'Assigned' && i.status !== 'Archived'
      ) || null;
    },

    // Hijos bulk activos de una referencia (para agrupar por venue).
    activeBulkCheckouts(state, barcode) {
      return state.items.filter((i) => i.barcode === barcode && i.isBulk && i.status === 'Assigned');
    },

    assignItem(state, item, venue, qty) {
      if (!item) return { error: 'Item not found' };
      if (!venue) return { error: 'Venue not found' };
      if (item.location === venue.id) return { error: 'Item is already at ' + venue.name };

      const origin = item.location || '';
      const today = new Date().toISOString().split('T')[0];

      if (item.isBulk) {
        qty = Math.floor(Number(qty));
        if (!Number.isFinite(qty) || qty < 1) return { error: 'Invalid quantity' };
        const avail = Number(item.quantity) || 0;
        if (qty > avail) return { error: 'Only ' + avail + ' available' };

        item.quantity = avail - qty;
        const child = Object.assign({}, item, {
          id: null, // lo fija el servidor al guardar
          isBulk: true,
          quantity: qty,
          location: venue.id,
          status: 'Assigned',
          assignedTo: null,
          created: today,
        });
        delete child.takingQty;
        delete child.returningQty;
        return {
          changed: [item],
          created: child,
          record: { itemId: null, itemName: item.name, locationId: venue.id, locationName: venue.name, origin, date: today },
          message: qty + 'x ' + item.name + ' assigned to ' + this._label(state, venue),
        };
      }

      item.location = venue.id;
      item.status = 'Assigned';
      item.assignedTo = null; // deprecado en el modelo venue-céntrico
      return {
        changed: [item],
        record: { itemId: item.id, itemName: item.name, locationId: venue.id, locationName: venue.name, origin, date: today },
        message: item.name + ' assigned to ' + this._label(state, venue),
      };
    },

    returnItem(state, item, qty) {
      if (!item) return { error: 'Item not found' };
      const origin = this.originFor(state, item);
      const originLoc = state.locations.find((l) => l.id === origin) || null;
      const originName = originLoc ? originLoc.name : 'inventory';
      const fromLoc = state.locations.find((l) => l.id === item.location) || null;
      const fromName = fromLoc ? fromLoc.name : 'unknown location';

      if (item.isBulk) {
        qty = Math.floor(Number(qty === undefined ? item.quantity : qty));
        const held = Number(item.quantity) || 0;
        if (!Number.isFinite(qty) || qty < 1 || qty > held) return { error: 'Invalid quantity' };
        const master = this.bulkMasterFor(state, item);

        if (qty < held) {
          item.quantity = held - qty;
          if (master) master.quantity = (Number(master.quantity) || 0) + qty;
          return {
            changed: master ? [item, master] : [item],
            message: qty + 'x ' + item.name + ' partially returned from ' + fromName + ' to ' + originName,
          };
        }

        item.status = 'Archived';
        item.quantity = 0;
        item.location = origin;
        item.assignedTo = null;
        if (master) master.quantity = (Number(master.quantity) || 0) + held;
        return {
          changed: master ? [item, master] : [item],
          message: held + 'x ' + item.name + ' returned from ' + fromName + ' to ' + originName,
        };
      }

      item.location = origin;
      item.status = 'Available';
      item.assignedTo = null;
      return {
        changed: [item],
        message: item.name + ' returned from ' + fromName + ' to ' + originName,
      };
    },

    // Guards de borrado.
    canDeleteWorker(state, workerId) {
      const managed = state.locations.filter((l) => l.admin === workerId);
      if (managed.length) {
        return { ok: false, reason: 'Worker is manager of: ' + managed.map((l) => l.name).join(', ') + '. Reassign first.' };
      }
      return { ok: true };
    },

    canDeleteLocation(state, locId) {
      const items = state.items.filter((i) => i.location === locId && i.status !== 'Archived');
      const workers = state.workers.filter((w) => w.location === locId);
      if (items.length || workers.length) {
        return { ok: false, reason: 'Location has ' + items.length + ' item(s) and ' + workers.length + ' worker(s). Move them first.' };
      }
      return { ok: true };
    },
  };

  // ══════════════════════════════════════════════════════════
  // LECTOR DE HOJAS (CSV / XLSX) — sin dependencias externas.
  // Un .xlsx es un ZIP de XML; lo abrimos con DecompressionStream
  // ('deflate-raw', nativo en Chrome/Safari/Firefox y Node 22+).
  // Evita cargar SheetJS por CDN (~900 KB + hash SRI que mantener).
  // Devuelve siempre { headers: [str], rows: [[str]] }.
  // ══════════════════════════════════════════════════════════
  const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeXml(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e.charAt(0) !== '#') return XML_ENT[e] !== undefined ? XML_ENT[e] : m;
      const code = e.charAt(1) === 'x' || e.charAt(1) === 'X'
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
  }

  // A→0, B→1, ... AA→26. Se usa para respetar columnas vacías.
  function colToIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Índice del ZIP leído desde el directorio central (los tamaños del
  // header local pueden venir en 0 si el escritor usó data descriptor).
  function zipIndex(buf) {
    const dv = new DataView(buf);
    const len = buf.byteLength;
    let eocd = -1;
    for (let i = len - 22; i >= 0 && i >= len - 22 - 65535; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('NOT_XLSX');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error('ZIP64_UNSUPPORTED');
    const entries = {};
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const cmtLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
      entries[name] = { method, compSize, localOff };
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return { dv, entries };
  }

  async function zipRead(buf, idx, name) {
    const e = idx.entries[name];
    if (!e) return null;
    const dv = idx.dv;
    if (dv.getUint32(e.localOff, true) !== 0x04034b50) throw new Error('NOT_XLSX');
    const nameLen = dv.getUint16(e.localOff + 26, true);
    const extraLen = dv.getUint16(e.localOff + 28, true);
    const start = e.localOff + 30 + nameLen + extraLen;
    const raw = new Uint8Array(buf, start, e.compSize);
    if (e.method === 0) return new TextDecoder().decode(raw);
    if (e.method !== 8) throw new Error('ZIP_METHOD_' + e.method);
    return new TextDecoder().decode(await inflateRaw(raw));
  }

  const sheetReader = {
    // Detecta el separador (Excel en locales ES exporta con ';').
    sniffDelimiter(text) {
      const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
      let best = ',', bestN = 0;
      [',', ';', '\t', '|'].forEach((d) => {
        const n = line.split(d).length - 1;
        if (n > bestN) { bestN = n; best = d; }
      });
      return best;
    },

    parseCsv(text, delim) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const d = delim || this.sniffDelimiter(text);
      const rows = [];
      let row = [], field = '', inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
          } else field += c;
          continue;
        }
        if (c === '"' && field === '') { inQuotes = true; continue; }
        if (c === d) { row.push(field); field = ''; continue; }
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        if (c === '\r') continue;
        field += c;
      }
      if (field !== '' || row.length) { row.push(field); rows.push(row); }
      return rows.map((r) => r.map((v) => String(v).trim()));
    },

    async parseXlsx(arrayBuffer) {
      const idx = zipIndex(arrayBuffer);
      // Primera hoja: el orden de <sheet> en workbook.xml manda; el rel
      // r:id nos da el archivo real dentro de xl/worksheets/.
      const wb = await zipRead(arrayBuffer, idx, 'xl/workbook.xml');
      let target = 'xl/worksheets/sheet1.xml';
      if (wb) {
        const first = wb.match(/<sheet\b[^>]*\/?>/);
        const rid = first && first[0].match(/r:id="([^"]+)"/);
        const rels = await zipRead(arrayBuffer, idx, 'xl/_rels/workbook.xml.rels');
        if (rid && rels) {
          const re = new RegExp('<Relationship[^>]*Id="' + rid[1] + '"[^>]*>');
          const rel = rels.match(re);
          const t = rel && rel[0].match(/Target="([^"]+)"/);
          if (t) target = 'xl/' + t[1].replace(/^\/?xl\//, '').replace(/^\//, '');
        }
      }
      const sheetXml = await zipRead(arrayBuffer, idx, target);
      if (!sheetXml) throw new Error('NO_SHEET');

      const ssXml = await zipRead(arrayBuffer, idx, 'xl/sharedStrings.xml');
      const shared = [];
      if (ssXml) {
        const items = ssXml.match(/<si>[\s\S]*?<\/si>|<si\/>/g) || [];
        items.forEach((si) => {
          const parts = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
          shared.push(decodeXml(parts.map((t) => t.replace(/<[^>]+>/g, '')).join('')));
        });
      }

      const rows = [];
      const rowTags = sheetXml.match(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || [];
      rowTags.forEach((rt) => {
        const out = [];
        const cells = rt.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || [];
        cells.forEach((ct) => {
          const refM = ct.match(/\sr="([A-Z]+)\d+"/);
          const at = refM ? colToIndex(refM[1]) : out.length;
          const typeM = ct.match(/\st="([^"]+)"/);
          const type = typeM ? typeM[1] : 'n';
          let val = '';
          if (type === 'inlineStr') {
            const parts = ct.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
            val = decodeXml(parts.map((t) => t.replace(/<[^>]+>/g, '')).join(''));
          } else {
            const vM = ct.match(/<v[^>]*>([\s\S]*?)<\/v>/);
            const rawV = vM ? decodeXml(vM[1]) : '';
            if (type === 's') {
              const i = parseInt(rawV, 10);
              val = shared[i] !== undefined ? shared[i] : '';
            } else if (type === 'b') {
              val = rawV === '1' ? 'TRUE' : 'FALSE';
            } else {
              val = rawV;
            }
          }
          while (out.length < at) out.push('');
          out[at] = String(val).trim();
        });
        rows.push(out);
      });
      return rows;
    },

    // Elige la fila de encabezados. NO es simplemente la primera con
    // contenido: los almacenes anteponen un título y a veces un bloque
    // de resumen ("Metric | Value") que es más angosto que la tabla real.
    // Criterio: la fila MÁS ANCHA de las primeras 30, exigiendo que sus
    // celdas sean etiquetas de texto y no una fila de datos numéricos.
    // En empate gana la más alta (la primera).
    findHeaderRow(clean) {
      const width = (r) => r.filter((c) => String(c).trim() !== '').length;
      const textiness = (r) => {
        const cells = r.filter((c) => String(c).trim() !== '');
        if (!cells.length) return 0;
        const text = cells.filter((c) => !/^-?[\d.,]+$/.test(String(c).trim())).length;
        return text / cells.length;
      };
      let best = 0, bestW = -1;
      const limit = Math.min(clean.length, 30);
      for (let i = 0; i < limit; i++) {
        // El encabezado no puede ser la última fila: no dejaría datos.
        if (clean.length > 1 && i === clean.length - 1) break;
        if (textiness(clean[i]) < 0.6) continue;
        const w = width(clean[i]);
        if (w > bestW) { bestW = w; best = i; }
      }
      return bestW <= 0 ? 0 : best;
    },

    toTable(rows) {
      const clean = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
      if (!clean.length) return { headers: [], rows: [] };
      const h = this.findHeaderRow(clean);
      const headers = clean[h].map((c, i) => String(c).trim() || 'Columna ' + (i + 1));
      const body = clean.slice(h + 1).map((r) => {
        const row = [];
        for (let i = 0; i < headers.length; i++) row.push(r[i] !== undefined ? String(r[i]).trim() : '');
        return row;
      });
      return { headers, rows: body.filter((r) => r.some((c) => c !== '')) };
    },
  };

  // ══════════════════════════════════════════════════════════
  // IMPORTACIÓN DE INVENTARIO — lógica pura y testeable.
  // Toma la tabla cruda del almacén y produce filas listas para
  // la hoja Items, más un reporte de omitidos/errores.
  // ══════════════════════════════════════════════════════════
  function norm(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  const IMPORT_FIELDS = [
    { key: 'Name',      label: 'Nombre del artículo', required: true,
      aliases: ['nombre', 'articulo', 'item', 'itemname', 'descripcion', 'description', 'producto', 'equipo', 'material', 'concepto'] },
    { key: 'Category',  label: 'Categoría',
      aliases: ['categoria', 'category', 'tipo', 'type', 'clase', 'familia', 'rubro'] },
    { key: 'Brand',     label: 'Marca / Modelo',
      aliases: ['marca', 'brand', 'modelo', 'model', 'marcamodelo', 'fabricante'] },
    { key: 'Serial',    label: 'Número de serie',
      aliases: ['serie', 'serial', 'numserie', 'numerodeserie', 'noserie', 'serialnumber', 'sn'] },
    { key: 'UID',       label: 'ID único (IMEI/MAC/Asset Tag)',
      aliases: ['uid', 'imei', 'mac', 'macaddress', 'assettag', 'activo', 'noactivo', 'etiqueta', 'tag', 'idunico'] },
    { key: 'UIDType',   label: 'Tipo de ID único',
      aliases: ['uidtype', 'tipoid', 'tipodeid', 'tipouid'] },
    { key: 'Barcode',   label: 'Código de barras existente',
      aliases: ['codigo', 'codigodebarras', 'barcode', 'codigobarras', 'sku', 'upc', 'ean'] },
    { key: 'Condition', label: 'Condición',
      aliases: ['condicion', 'condition', 'estado', 'estadofisico'] },
    { key: 'Quantity',  label: 'Cantidad',
      aliases: ['cantidad', 'quantity', 'qty', 'cant', 'existencia', 'existencias', 'stock', 'piezas', 'pzas', 'unidades'] },
    { key: 'Notes',     label: 'Notas',
      aliases: ['notas', 'notes', 'observaciones', 'comentarios', 'obs', 'remarks'] },
  ];

  const CATEGORIES = ['Equipment', 'Tools', 'Uniform', 'Supplies', 'Electronics', 'Other'];
  const CATEGORY_ALIASES = {
    equipo: 'Equipment', equipos: 'Equipment', equipment: 'Equipment', maquinaria: 'Equipment',
    herramienta: 'Tools', herramientas: 'Tools', tools: 'Tools', tool: 'Tools',
    uniforme: 'Uniform', uniformes: 'Uniform', uniform: 'Uniform', ropa: 'Uniform', vestuario: 'Uniform',
    insumo: 'Supplies', insumos: 'Supplies', suministros: 'Supplies', supplies: 'Supplies',
    consumible: 'Supplies', consumibles: 'Supplies', papeleria: 'Supplies',
    electronica: 'Electronics', electronico: 'Electronics', electronicos: 'Electronics',
    electronics: 'Electronics', electronic: 'Electronics', computo: 'Electronics',
    otro: 'Other', otros: 'Other', other: 'Other', varios: 'Other',
  };
  const CONDITIONS = ['New', 'Good', 'Fair', 'Poor'];
  const CONDITION_ALIASES = {
    nuevo: 'New', nueva: 'New', new: 'New', anuevo: 'New',
    bueno: 'Good', buena: 'Good', bien: 'Good', good: 'Good', operativo: 'Good', funcional: 'Good',
    regular: 'Fair', fair: 'Fair', usado: 'Fair', aceptable: 'Fair',
    malo: 'Poor', mala: 'Poor', poor: 'Poor', dañado: 'Poor', danado: 'Poor',
    descompuesto: 'Poor', pormantenimiento: 'Poor',
  };
  const UID_TYPES = ['IMEI', 'MAC', 'Asset Tag', 'License Key', 'Other'];

  const importCore = {
    FIELDS: IMPORT_FIELDS,
    CATEGORIES, CONDITIONS, UID_TYPES,

    // Adivina qué columna del archivo corresponde a cada campo de TrackIt.
    // Coincidencia exacta primero; después "contiene" (para "Nombre del
    // artículo", "Cant. total", etc.). Una columna no se usa dos veces.
    guessMapping(headers) {
      const normed = headers.map(norm);
      const used = {};
      const map = {};
      IMPORT_FIELDS.forEach((f) => {
        const cands = [norm(f.key)].concat(f.aliases);
        let hit = -1;
        for (let a = 0; a < cands.length && hit === -1; a++) {
          for (let i = 0; i < normed.length; i++) {
            if (!used[i] && normed[i] === cands[a]) { hit = i; break; }
          }
        }
        for (let a = 0; a < cands.length && hit === -1; a++) {
          if (cands[a].length < 4) continue;
          for (let i = 0; i < normed.length; i++) {
            if (!used[i] && normed[i].indexOf(cands[a]) !== -1) { hit = i; break; }
          }
        }
        if (hit !== -1) { map[f.key] = hit; used[hit] = true; }
      });
      return map;
    },

    canonCategory(v) {
      const n = norm(v);
      if (!n) return null;
      if (CATEGORY_ALIASES[n]) return CATEGORY_ALIASES[n];
      const exact = CATEGORIES.find((c) => norm(c) === n);
      return exact || null;
    },

    canonCondition(v) {
      const n = norm(v);
      if (!n) return null;
      if (CONDITION_ALIASES[n]) return CONDITION_ALIASES[n];
      const exact = CONDITIONS.find((c) => norm(c) === n);
      return exact || null;
    },

    // "1,250" / "1.250" / "12 pzas" / "3.0" → entero. null si no hay número.
    parseQty(v) {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      const raw = String(v).replace(/[^0-9.,-]/g, '').replace(/,/g, '');
      const n = parseFloat(raw);
      if (!Number.isFinite(n)) return null;
      return Math.max(1, Math.round(n));
    },

    // rows: [[str]] del archivo. mapping: { Name: 0, ... }.
    // opts: { location, locationType, org, defaultCategory, defaultCondition }
    normalizeRows(rows, mapping, opts) {
      opts = opts || {};
      const at = (row, key) => {
        const i = mapping[key];
        return i === undefined || i === null || i < 0 ? '' : String(row[i] == null ? '' : row[i]).trim();
      };
      // Status se DERIVA de la ubicación (modelo venue-céntrico):
      // en bodega está disponible; en un venue está asignado.
      const status = opts.locationType === 'Warehouse' ? 'Available' : 'Assigned';
      const candidates = [];
      const errors = [];
      rows.forEach((row, i) => {
        // sourceRow es 1-based sobre el cuerpo, para señalar la fila al usuario.
        const sourceRow = i + 1;
        if (!row.some((c) => String(c == null ? '' : c).trim() !== '')) return;
        const name = at(row, 'Name');
        if (!name) {
          errors.push({ sourceRow, reason: 'Sin nombre de artículo', row });
          return;
        }
        const qty = this.parseQty(at(row, 'Quantity'));
        const uid = at(row, 'UID');
        let uidType = at(row, 'UIDType');
        if (uid && !uidType) uidType = 'Asset Tag';
        if (uidType) {
          const m = UID_TYPES.find((t) => norm(t) === norm(uidType));
          uidType = m || 'Other';
        }
        candidates.push({
          sourceRow,
          Name: name,
          Category: this.canonCategory(at(row, 'Category')) || opts.defaultCategory || 'Other',
          Location: opts.location || '',
          Brand: at(row, 'Brand'),
          Serial: at(row, 'Serial'),
          Condition: this.canonCondition(at(row, 'Condition')) || opts.defaultCondition || 'Good',
          Status: status,
          AssignedTo: '',
          EventID: '',
          Notes: at(row, 'Notes'),
          UIDType: uidType,
          UID: uid,
          SourceBarcode: at(row, 'Barcode'),
          Quantity: qty === null ? 1 : qty,
          IsBulk: (qty !== null && qty > 1) ? 'TRUE' : 'FALSE',
          Org: opts.org || 'flex',
        });
      });
      return { candidates, errors };
    },

    // Omite duplicados por Serial / UID / código de barras de origen,
    // tanto contra el inventario ya cargado como dentro del propio archivo.
    dedupe(existingItems, candidates) {
      const seen = {};
      const put = (k, v, id) => { if (v) { const kk = k + ':' + norm(v); if (!seen[kk]) seen[kk] = id; } };
      (existingItems || []).forEach((it) => {
        put('serial', it.serial, it.id);
        put('uid', it.uid, it.id);
        put('barcode', it.barcode, it.id);
      });
      const toImport = [];
      const skipped = [];
      candidates.forEach((c) => {
        const keys = [];
        if (c.Serial) keys.push(['serial', c.Serial]);
        if (c.UID) keys.push(['uid', c.UID]);
        if (c.SourceBarcode) keys.push(['barcode', c.SourceBarcode]);
        let dup = null, dupKey = '';
        for (let i = 0; i < keys.length && !dup; i++) {
          const kk = keys[i][0] + ':' + norm(keys[i][1]);
          if (seen[kk]) { dup = seen[kk]; dupKey = keys[i][0]; }
        }
        if (dup) {
          skipped.push({ sourceRow: c.sourceRow, name: c.Name, reason: 'Ya existe (' + dupKey + ' coincide con ' + dup + ')', matchId: dup });
          return;
        }
        const tag = 'ROW' + c.sourceRow;
        keys.forEach((k) => { seen[k[0] + ':' + norm(k[1])] = tag; });
        toImport.push(c);
      });
      return { toImport, skipped };
    },

    // Fila lista para la hoja Items. El ID y el Barcode definitivo los
    // asigna quien llama (barcode TRK-#### correlativo del cliente).
    toSheetRow(c, barcode, created) {
      return {
        Name: c.Name, Barcode: barcode,
        Category: c.Category, Location: c.Location,
        Brand: c.Brand, Serial: c.Serial,
        Condition: c.Condition, Status: c.Status,
        AssignedTo: '', EventID: '',
        Notes: c.Notes, IsBulk: c.IsBulk, Quantity: c.Quantity,
        UIDType: c.UIDType, UID: c.UID,
        Org: c.Org, Created: created,
      };
    },
  };

  venueCore.sheets = sheetReader;
  venueCore.import = importCore;

  if (typeof module !== 'undefined' && module.exports) module.exports = venueCore;
  else root.venueCore = venueCore;
})(typeof window !== 'undefined' ? window : this);
