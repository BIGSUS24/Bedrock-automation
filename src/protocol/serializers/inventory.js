'use strict';

/**
 * inventory.js — Bedrock Inventory / ContainerSetContent deserializer
 *
 * Packet 0x31 (InventoryContent / ContainerSetContent):
 *   container_id : byte
 *   count        : varuint
 *   slots[]      :
 *     id         : int16LE  (0 = empty)
 *     [if id != 0]
 *       count    : byte
 *       damage   : int16LE
 *       has_nbt  : int16LE  (0 = no nbt, -1 = nbt follows)
 *       [nbt data if has_nbt != 0]
 *
 * ContainerID values:
 *   INVENTORY=0  OFFHAND=1  ARMOR=2  HOTBAR=26  PLAYER=27  ...
 *
 * InventorySlot (simplified — no full NBT parsing):
 *   { id, count, damage, nbtRaw }
 */

const { readVarint } = require('../../transport/packet_router');

const ContainerID = {
  INVENTORY: 0,
  OFFHAND:   1,
  ARMOR:     2,
  HOTBAR:    26,
  PLAYER:    27,
  CREATIVE:  124,
};

class InventorySerializer {
  /**
   * Deserialize an InventoryContent / ContainerSetContent payload.
   * @param {Buffer} buf  (after packet ID consumed)
   * @returns {{ containerId: number, slots: InventorySlot[] }}
   */
  static deserialize(buf) {
    let off = 0;
    if (buf.length < 1) return { containerId: 0, slots: [] };

    const containerId = buf.readUInt8(off++);

    const countR = readVarint(buf, off); off += countR.bytesRead;
    const count  = countR.value;

    const slots = [];
    for (let i = 0; i < count && off < buf.length; i++) {
      const slot = this._readSlot(buf, off);
      slots.push(slot.slot);
      off += slot.bytesRead;
    }

    return { containerId, slots };
  }

  static _readSlot(buf, offset) {
    let off = offset;

    if (off + 2 > buf.length) return { slot: { id: 0, count: 0, damage: 0, nbtRaw: null }, bytesRead: 0 };

    const id = buf.readInt16LE(off); off += 2;

    if (id === 0) {
      return { slot: { id: 0, count: 0, damage: 0, nbtRaw: null }, bytesRead: off - offset };
    }

    const count  = buf.readUInt8(off++);
    const damage = buf.readInt16LE(off); off += 2;

    let nbtRaw = null;
    if (off + 2 <= buf.length) {
      const hasNbt = buf.readInt16LE(off); off += 2;
      if (hasNbt !== 0 && off < buf.length) {
        // Skip NBT data — find the end by counting bytes
        // For simplicity we store raw bytes from here
        nbtRaw = buf.slice(off);
        off = buf.length; // consume rest (simplified; real parsing requires NBT decoder)
      }
    }

    return {
      slot:      { id, count, damage, nbtRaw },
      bytesRead: off - offset,
    };
  }

  /**
   * Returns true if the given slot has a food item.
   * This is based on vanilla Bedrock item IDs (approximate; not exhaustive).
   */
  static isFood(slot) {
    if (!slot || slot.id <= 0) return false;
    // Bedrock food item ID ranges (approximate for 1.21.x)
    // 260–282 = vanilla foods (Apple, Mushroom Stew, Bread, etc.)
    // 391–400 = seeds/vegetables
    return (slot.id >= 260 && slot.id <= 282) ||
           (slot.id >= 297 && slot.id <= 300) ||
           slot.id === 391 || slot.id === 392 || slot.id === 393;
  }

  /**
   * Find the best food slot in a slots array.
   * Returns { slotIndex, slot } or null.
   */
  static findBestFood(slots) {
    let best = null;
    for (let i = 0; i < slots.length; i++) {
      if (this.isFood(slots[i])) {
        if (!best || slots[i].id > best.slot.id) {
          best = { slotIndex: i, slot: slots[i] };
        }
      }
    }
    return best;
  }
}

module.exports = { InventorySerializer, ContainerID };
