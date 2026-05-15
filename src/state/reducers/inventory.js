'use strict';

/**
 * state/reducers/inventory.js
 * Processes INVENTORY_CONTENT packets → updates inventory slots in state.
 *
 * UI and automation READ state only — they never write to protocol state directly.
 */

const { InventorySerializer, ContainerID } = require('../../protocol/serializers/inventory');

class InventoryReducer {
  constructor(stateManager) {
    this.state = stateManager;
  }

  /**
   * Process an INVENTORY_CONTENT payload.
   * @param {Buffer} buf
   */
  reduce(buf) {
    try {
      const { containerId, slots } = InventorySerializer.deserialize(buf);
      this._applyContainer(containerId, slots);
    } catch (e) {
      console.warn('[InventoryReducer] Parse error:', e.message);
    }
  }

  _applyContainer(containerId, slots) {
    switch (containerId) {
      case ContainerID.INVENTORY:
      case ContainerID.PLAYER:
        this.state.setInventory(slots, this.state.inventory.heldSlot);
        break;
      case ContainerID.HOTBAR:
        // Hotbar = first 9 slots of inventory
        const current = [...(this.state.inventory.slots || [])];
        for (let i = 0; i < Math.min(slots.length, 9); i++) {
          current[i] = slots[i];
        }
        this.state.setInventory(current, this.state.inventory.heldSlot);
        break;
      case ContainerID.OFFHAND:
        this.state.inventory.offhand = slots[0] || null;
        this.state.emit('inventoryUpdate', this.state.inventory);
        break;
      case ContainerID.ARMOR:
        this.state.inventory.armor = slots;
        this.state.emit('inventoryUpdate', this.state.inventory);
        break;
      default:
        // Other containers (chests, furnaces) — not tracked in player state
        this.state.emit('containerUpdate', { containerId, slots });
        break;
    }
  }

  /**
   * Update the held item slot index (from PLAYER_HOTBAR packet).
   * @param {number} slotIndex
   */
  reduceHeldSlot(slotIndex) {
    this.state.inventory.heldSlot = slotIndex;
    this.state.emit('heldSlotUpdate', slotIndex);
  }

  // ── Read helpers (for automation) ────────────────────────────────────────

  getSlots()     { return this.state.inventory.slots || []; }
  getHeldSlot()  { return this.state.inventory.heldSlot || 0; }
  getHeldItem()  { return this.getSlots()[this.getHeldSlot()] || null; }

  findBestFood() {
    return InventorySerializer.findBestFood(this.getSlots());
  }

  hasFood() {
    return this.findBestFood() !== null;
  }
}

module.exports = { InventoryReducer };
