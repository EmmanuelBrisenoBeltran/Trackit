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

  if (typeof module !== 'undefined' && module.exports) module.exports = venueCore;
  else root.venueCore = venueCore;
})(typeof window !== 'undefined' ? window : this);
