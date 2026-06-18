'use strict';

/**
 * protocol/client.js — BedrockProtocolClient (bedrock-protocol backend)
 *
 * Uses bedrock-protocol for all transport/auth/login/encryption.
 * Our state machine, reconnect, and automation layers wrap on top.
 */

const EventEmitter  = require('events');
const bedrock       = require('bedrock-protocol');
const path          = require('path');
const dns           = require('dns').promises;
const { randomUUID } = require('crypto');

const TESTED_LATEST_VERSION = '1.26.20';
const INPUT_TICK_INTERVAL_MS = 50;
const TICK_SYNC_INTERVAL_MS = 1000;

class BedrockProtocolClient extends EventEmitter {
  constructor(config, stateManager) {
    super();
    this.config  = config;
    this.state   = stateManager;
    this._client = null;
    this._connected = false;
    this._activeVersion = null;
    this._inputTimer = null;
    this._tickSyncTimer = null;
    this._clientTick = 0n;
    this._lastInputError = null;
    this._gameplayInput = null;
    // Input flags merged into every player_auth_input frame until cleared
    // (e.g. holding `using_item` true for the duration of an eat). Kept separate
    // from _gameplayInput so it never clobbers movement set by the gameplay layer.
    this._persistentInputData = {};
    this._pendingAuthFrames = [];
    this._pendingTeleportAck = false;
    this._nextStackRequestId = 1;
    // Currently-open server container (chest GUI etc.), or null. Populated from
    // container_open and kept in sync from inventory_content/inventory_slot.
    this._openContainer = null;
    // Bedrock client ItemStackRequest ids are odd negative, decrementing.
    this._nextSellRequestId = -1;
    this._hasMoveCorrection = false;
    this._lastCorrectionAt = 0;
    this._lastCorrectionTick = null;
    this._lastCorrectionPosition = null;
    // Prevent unhandled error crashes — our _wireEvents adds specific handlers
    this.on('error', () => {});
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect() {
    const { address, port, version } = this.config.server;
    const authMode = this.config.auth?.mode || 'offline';

    // Clean up any previous client
    this._destroyClient();

    this.state.setStatus('connecting');

    // ── Resolve hostname to IP ─────────────────────────────────────────────
    // jsp-raknet does NOT resolve DNS — it splits the hostname string by '.'
    // and writes garbage bytes in OCR2's server-address field, causing the
    // server to silently drop the packet. We must pass a real IPv4 address.
    let resolvedHost = address;
    try {
      const lookup = await dns.lookup(address, { family: 4 });
      resolvedHost = lookup.address;
      console.log(`[Client] Resolved ${address} → ${resolvedHost}`);
    } catch (e) {
      console.warn(`[Client] DNS lookup failed for ${address}, using as-is:`, e.message);
    }

    const isReconnect = this._hasConnectedOnce === true;
    this._hasConnectedOnce = true;

    const opts = {
      host:           resolvedHost,
      port:           port || 19132,
      // "latest" means the newest version this bot can serialize correctly.
      version:        this._resolveVersion(version),
      offline:        authMode !== 'microsoft',
      username:       this.config.auth?.username || 'BedrockBot',
      // prismarine-auth token cache (cached after first login)
      profilesFolder: path.join(process.cwd(), '.auth_cache'),
      raknetBackend:  this.config.protocol?.raknetBackend || 'raknet-native',
      skipPing:       isReconnect,
      // Raise bedrock-protocol's internal connect timeout to 30s
      connectTimeout: 30_000,
    };

    console.log(`[Client] Connecting to ${address}:${port || 19132} [${opts.offline ? 'offline' : 'microsoft'}] v${opts.version}`);

    this._activeVersion = opts.version;
    this._client = bedrock.createClient(opts);
    this._wireEvents();

    // Resolve when spawned, reject on error/kick/timeout
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        removeListeners();
        fn(val);
      };

      const removeListeners = () => {
        this.removeListener('_spawn',  onSpawn);
        this.removeListener('_error',  onError);
        this.removeListener('_kicked', onKick);
      };

      const onSpawn  = ()    => settle(resolve, undefined);
      const onError  = (e)   => settle(reject, e instanceof Error ? e : new Error(String(e)));
      const onKick   = (r)   => settle(reject, new Error(`Kicked: ${r}`));

      this.once('_spawn',  onSpawn);
      this.once('_error',  onError);
      this.once('_kicked', onKick);

      // 5-minute outer timeout (covers device code auth + RakNet handshake)
      setTimeout(() => settle(reject, new Error('Connection timed out (300s)')), 300_000);
    });
  }

  async sendChat(message) {
    if (!this._connected || !this._client) throw new Error('Not connected');
    const payload = {
      type:              'chat',
      needs_translation: false,
      source_name:       this._client.username || this.config.auth?.username || '',
      message:           String(message),
      xuid:              '',
      platform_chat_id:  '',
    };

    if (this._isAtLeast('1.21.130')) {
      payload.category = 'authored';
      payload.chat = payload.message;
      payload.whisper = '';
      payload.announcement = '';
      payload.has_filtered_message = false;
    } else {
      payload.filtered_message = '';
    }

    this._client.queue('text', payload);
  }

  async sendCommand(command) {
    if (!this._connected || !this._client) throw new Error('Not connected');
    const bare = command.replace(/^\//, '');

    const origin = {
      type:       'player',
      uuid:       randomUUID(),
      request_id: randomUUID(),
    };

    if (this._isAtLeast('1.21.130')) {
      origin.player_entity_id = 0n;
    }

    this._client.queue('command_request', {
      command:    '/' + bare,
      origin,
      internal:   false,
      version:    this._commandVersionField(),
    });
  }

  getActiveVersion() {
    return this._activeVersion || this.config.server?.version || TESTED_LATEST_VERSION;
  }

  getClient() {
    return this._client;
  }

  setGameplayInputState(input = null) {
    this._gameplayInput = input ? { ...input } : null;
  }

  clearGameplayInputState() {
    this._gameplayInput = null;
  }

  /**
   * Hold (or release) the "use item" input — how the client eats/drinks on
   * 1.21.80+. While active, every player_auth_input frame carries
   * using_item: true, so the server runs the eat animation to completion.
   * @param {boolean} active
   */
  setUsingItem(active) {
    if (active) {
      this._persistentInputData.using_item = true;
    } else {
      delete this._persistentInputData.using_item;
    }
  }

  queueAuthInputFrame(frame = {}) {
    this._pendingAuthFrames.push(frame);
  }

  async sendPlayerAction(action, position = null, face = 0, resultPosition = null) {
    if (!this._connected || !this._client) throw new Error('Not connected');
    const pos = this._normaliseBlockPos(position);
    this._client.queue('player_action', {
      runtime_entity_id: this.state.player?.entityRuntimeId || 0n,
      action,
      position: pos,
      result_position: this._normaliseBlockPos(resultPosition || pos),
      face,
    });
  }

  async sendSwing() {
    if (!this._connected || !this._client) throw new Error('Not connected');
    this._client.queue('animate', {
      action_id: 'swing_arm',
      runtime_entity_id: this.state.player?.entityRuntimeId || 0n,
    });
  }

  async selectHotbarSlot(slot) {
    if (!this._connected || !this._client) throw new Error('Not connected');
    const selected = Number(slot);
    if (!Number.isInteger(selected) || selected < 0 || selected > 8) {
      throw new Error(`Invalid hotbar slot: ${slot}`);
    }

    const slots = this.state.inventory?.slots || [];
    const item = slots[selected]?.raw || slots[selected] || { network_id: 0 };

    this._client.queue('player_hotbar', {
      selected_slot: selected,
      window_id: 'inventory',
      select_slot: true,
    });
    this._client.queue('mob_equipment', {
      runtime_entity_id: this.state.player?.entityRuntimeId || 0n,
      item,
      slot: selected,
      selected_slot: selected,
      window_id: 'inventory',
    });
    this.state.inventory.heldSlot = selected;
  }

  async sendItemUseOnBlock({ position, face = 1, clickPos, blockRuntimeId = 0 } = {}) {
    if (!this._connected || !this._client) throw new Error('Not connected');

    const data = this._buildUseItemData({
      actionType: 'click_block',
      position,
      face,
      clickPos,
      blockRuntimeId,
      clientPrediction: 'success',
    });

    if (this._isAtLeast('1.21.80') && this.config.gameplay?.interaction?.usePlayerAuthInput === true) {
      this.queueAuthInputFrame({
        inputData: { item_interact: true },
        transaction: {
          legacy: { legacy_request_id: 0 },
          actions: [],
          data,
        },
      });
      this._sendPlayerAuthInput();
      return;
    }

    this._sendInventoryTransactionUse(data);
  }

  _sendInventoryTransactionUse(data) {
    this._client.queue('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: data,
      },
    });
  }

  async sendBlockBreakAction(action, position, face = 1) {
    if (!this._connected || !this._client) throw new Error('Not connected');

    if (this._isAtLeast('1.21.80')) {
      this.queueAuthInputFrame({
        inputData: { block_action: true },
        blockAction: [{ action, position: this._normaliseBlockPos(position), face }],
      });
      this._sendPlayerAuthInput();
      return;
    }

    await this.sendPlayerAction(action, position, face);
  }

  async sendMineStackRequest() {
    if (!this._connected || !this._client) throw new Error('Not connected');
    if (!this._isAtLeast('1.21.80')) return;

    this.queueAuthInputFrame({
      inputData: { item_stack_request: true },
      itemStackRequest: this._buildMineStackRequest(),
    });
    this._sendPlayerAuthInput();
    return this._nextStackRequestId - 1;
  }

  async sendFinalMinePrediction(position, face = 1) {
    if (!this._connected || !this._client) throw new Error('Not connected');
    if (!this._isAtLeast('1.21.80')) {
      await this.sendPlayerAction('predict_break', position, face);
      return null;
    }

    const pos = this._normaliseBlockPos(position);
    const request = this._buildMineStackRequest();
    this.queueAuthInputFrame({
      inputData: { block_action: true, item_stack_request: true },
      blockAction: [
        { action: 'continue_break', position: pos, face },
        { action: 'predict_break', position: pos, face },
      ],
      itemStackRequest: request,
    });
    this._sendPlayerAuthInput();
    return request.request_id;
  }

  // ── Container / item-stack helpers ───────────────────────────────────────────

  /** The currently-open server container, or null. */
  getOpenContainer() {
    return this._openContainer;
  }

  /**
   * Close the open container the way pressing ESC does (client-initiated close).
   * @param {number|string} [windowId]  Defaults to the tracked open container.
   */
  async closeContainer(windowId = null) {
    if (!this._connected || !this._client) throw new Error('Not connected');
    const oc = this._openContainer;
    const wid = windowId ?? oc?.windowId;
    if (wid === null || wid === undefined) return false;

    this._client.queue('container_close', {
      window_id:   wid,
      window_type: oc?.windowType ?? 'container',
      server:      false, // false = client-initiated (ESC)
    });
    // Clear eagerly so a fast next cycle never sees this (now-closing) GUI as
    // open before the server's own container_close arrives.
    this._openContainer = null;
    return true;
  }

  /**
   * Send an ItemStackRequest with the given actions and return its request id.
   * Request ids are odd negative integers (Bedrock client convention).
   * @param {Array<object>} actions
   * @returns {number} request_id
   */
  async sendItemStackRequest(actions) {
    if (!this._connected || !this._client) throw new Error('Not connected');
    const requestId = this._nextSellRequestId;
    this._nextSellRequestId -= 2; // keep odd + negative

    this._client.queue('item_stack_request', {
      // custom_names + cause are required by the schema — omitting them throws a
      // SizeOf error at encode time (verified against the 1.26.20 serializer).
      requests: [{ request_id: requestId, actions, custom_names: [], cause: 'chat_public' }],
    });
    return requestId;
  }

  async disconnect(reason = 'User disconnect') {
    this._connected = false;
    this._stopPlayKeepAlive();
    this._destroyClient();
    this.state.setStatus('disconnected');
    this.state.setDisconnectReason(reason);
    this.emit('disconnected', { reason });
  }

  cleanup() {
    this._connected = false;
    this._stopPlayKeepAlive();
    this._destroyClient();
  }

  isConnected()  { return this._connected; }
  getState()     { return this._connected ? 'connected' : 'disconnected'; }
  getMtu()       { return 1400; }
  onReconnect()  { /* nothing extra */ }

  // ── Internal helpers ───────────────────────────────────────────────────────

  _destroyClient() {
    this._stopPlayKeepAlive();
    if (this._client) {
      try { this._client.removeAllListeners(); } catch {}
      try { this._client.close(); } catch {}
      this._client = null;
    }
  }

  _resolveVersion(version) {
    if (!version || version === 'latest') return TESTED_LATEST_VERSION;
    return version;
  }

  _commandVersionField() {
    return this._isAtLeast('1.21.130') ? '52' : 52;
  }

  _isAtLeast(minVersion) {
    const current = this._parseVersion(this._activeVersion || this.config.server?.version || TESTED_LATEST_VERSION);
    const minimum = this._parseVersion(minVersion);

    for (let i = 0; i < Math.max(current.length, minimum.length); i++) {
      const a = current[i] || 0;
      const b = minimum[i] || 0;
      if (a > b) return true;
      if (a < b) return false;
    }

    return true;
  }

  _parseVersion(version) {
    const resolved = this._resolveVersion(version);
    return String(resolved).split('.').map((part) => Number.parseInt(part, 10) || 0);
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  _startPlayKeepAlive() {
    this._stopPlayKeepAlive();
    this._clientTick = 0n;
    this._lastInputError = null;

    this._inputTimer = setInterval(() => {
      this._sendPlayerAuthInput();
    }, INPUT_TICK_INTERVAL_MS);

    if (this._usesLegacyTickSync()) {
      this._tickSyncTimer = setInterval(() => {
        this._sendTickSync();
      }, TICK_SYNC_INTERVAL_MS);
    }

    this._sendTickSync();
    this._sendPlayerAuthInput();
  }

  _stopPlayKeepAlive() {
    if (this._inputTimer) {
      clearInterval(this._inputTimer);
      this._inputTimer = null;
    }
    if (this._tickSyncTimer) {
      clearInterval(this._tickSyncTimer);
      this._tickSyncTimer = null;
    }
  }

  _sendTickSync() {
    if (!this._connected || !this._client) return;
    if (!this._usesLegacyTickSync()) return;

    try {
      this._client.queue('tick_sync', {
        request_time: BigInt(Date.now()),
        response_time: 0n,
      });
    } catch (e) {
      this._logKeepAliveError('tick_sync', e);
    }
  }

  _sendPlayerAuthInput() {
    if (!this._connected || !this._client) return;
    if (!this._isAtLeast('1.21.80')) return;

    const player = this.state.player || {};
    const input = this._gameplayInput || {};
    const pending = this._pendingAuthFrames.shift() || {};
    const pos = this._normaliseVec3(input.position || player.position, { x: 0, y: 80, z: 0 });
    const pitch = Number(input.pitch ?? player.rotation?.pitch ?? player.rotation?.x ?? 0);
    const yaw = Number(input.yaw ?? player.rotation?.yaw ?? player.rotation?.z ?? 0);
    const moveVector = this._normaliseVec2(input.moveVector, { x: 0, z: 0 });
    const rawMoveVector = this._normaliseVec2(input.rawMoveVector || input.moveVector, moveVector);
    const inputData = {
      ...(this._persistentInputData || {}),
      ...(input.inputData || {}),
      ...(pending.inputData || {}),
    };
    if (this._pendingTeleportAck) {
      inputData.handled_teleport = true;
      this._pendingTeleportAck = false;
    }
    const delta = this._normaliseVec3(input.delta, { x: 0, y: 0, z: 0 });
    const tick = this._clientTick++;

    try {
      const payload = {
        pitch,
        yaw,
        position: pos,
        move_vector: moveVector,
        head_yaw: yaw,
        input_data: inputData,
        input_mode: 'mouse',
        play_mode: 'normal',
        interaction_model: 'crosshair',
        interact_rotation: { x: pitch, z: yaw },
        tick,
        delta,
        analogue_move_vector: moveVector,
        camera_orientation: this._cameraOrientation(pitch, yaw),
        raw_move_vector: rawMoveVector,
      };

      if (pending.transaction) payload.transaction = pending.transaction;
      if (pending.itemStackRequest) payload.item_stack_request = pending.itemStackRequest;
      if (pending.blockAction) payload.block_action = pending.blockAction;

      this._client.queue('player_auth_input', payload);
    } catch (e) {
      this._logKeepAliveError('player_auth_input', e);
    }
  }

  _normaliseVec3(value, fallback) {
    return {
      x: Number.isFinite(Number(value?.x)) ? Number(value.x) : fallback.x,
      y: Number.isFinite(Number(value?.y)) ? Number(value.y) : fallback.y,
      z: Number.isFinite(Number(value?.z)) ? Number(value.z) : fallback.z,
    };
  }

  _normaliseVec2(value, fallback) {
    return {
      x: Number.isFinite(Number(value?.x)) ? Number(value.x) : fallback.x,
      z: Number.isFinite(Number(value?.z)) ? Number(value.z) : fallback.z,
    };
  }

  _sameRuntimeId(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a) === String(b);
  }

  // WindowID decodes via a mapper, so a window may surface as a string ('first')
  // or a raw number (unmapped ids). Compare loosely so both forms match.
  _sameWindow(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a) === String(b);
  }

  _normaliseBlockPos(value) {
    return {
      x: Math.floor(Number(value?.x) || 0),
      y: Math.floor(Number(value?.y) || 0),
      z: Math.floor(Number(value?.z) || 0),
    };
  }

  _isFiniteVec3(value) {
    return Number.isFinite(Number(value?.x)) &&
      Number.isFinite(Number(value?.y)) &&
      Number.isFinite(Number(value?.z));
  }

  _vecDistanceSq(a, b) {
    if (!this._isFiniteVec3(a) || !this._isFiniteVec3(b)) return Infinity;
    const dx = Number(a.x) - Number(b.x);
    const dy = Number(a.y) - Number(b.y);
    const dz = Number(a.z) - Number(b.z);
    return dx * dx + dy * dy + dz * dz;
  }

  _packetTick(value) {
    if (value === undefined || value === null) return null;
    try {
      return typeof value === 'bigint' ? value : BigInt(value);
    } catch {
      return null;
    }
  }

  _isBogusOriginPosition(position) {
    const current = this.state.player?.position;
    if (!this._isFiniteVec3(position) || !this._isFiniteVec3(current)) return false;

    const candidateNearOrigin = Math.abs(Number(position.x)) < 8 && Math.abs(Number(position.z)) < 8;
    const currentInRealWorld = Math.abs(Number(current.x)) > 1000 || Math.abs(Number(current.z)) > 1000;
    return candidateNearOrigin && currentInRealWorld;
  }

  _isPlausibleCorrectionPosition(position) {
    if (!this._isFiniteVec3(position)) return false;
    if (this._isBogusOriginPosition(position)) return false;

    const current = this.state.player?.position;
    if (!this._isFiniteVec3(current)) return true;

    // Movement prediction corrections are not server teleports. If one suddenly
    // decodes hundreds of blocks away, it is stale/misdecoded and should not
    // become the gameplay position.
    return this._vecDistanceSq(position, current) < 128 * 128;
  }

  _isStaleMoveAfterCorrection(packet) {
    if (!this._hasMoveCorrection || !this._lastCorrectionPosition) return false;

    const tick = this._packetTick(packet.tick);
    if (tick !== null && this._lastCorrectionTick !== null && tick <= this._lastCorrectionTick) {
      return true;
    }

    const age = Date.now() - this._lastCorrectionAt;
    const distanceFromCorrection = this._vecDistanceSq(packet.position, this._lastCorrectionPosition);
    if (this._gameplayInput && age < 3000 && distanceFromCorrection > 0.25) return true;

    // DonutSMP/Geyser can repeat the pre-correction position as a teleport for a
    // short time. Real teleports are usually larger and should still be accepted.
    return age < 3000 && distanceFromCorrection > 0.25 && distanceFromCorrection < 64;
  }

  _buildUseItemData({ actionType, position, face, clickPos, blockRuntimeId, clientPrediction }) {
    const player = this.state.player || {};
    const blockPos = this._normaliseBlockPos(position);
    return {
      action_type: actionType,
      trigger_type: 'player_input',
      block_position: blockPos,
      face,
      hotbar_slot: Number(this.state.inventory?.heldSlot || 0),
      held_item: this._getHeldItem(),
      // Bedrock item-use transactions carry the head/eye position. Sending
      // feet position causes DonutSMP/Geyser to silently ignore block clicks.
      player_pos: this._eyePosition(player.position),
      click_pos: this._normaliseVec3(clickPos, { x: 0.5, y: 0.5, z: 0.5 }),
      block_runtime_id: Number(blockRuntimeId || 0),
      client_prediction: clientPrediction,
      client_cooldown_state: 'off',
    };
  }

  _getHeldItem() {
    const slots = this.state.inventory?.slots || [];
    const heldSlot = Number(this.state.inventory?.heldSlot || 0);
    const item = slots[heldSlot] || null;
    if (!item || Number(item.network_id ?? item.networkId ?? 0) === 0) {
      return { network_id: 0 };
    }
    return item.raw || item;
  }

  _buildMineStackRequest() {
    const heldSlot = Number(this.state.inventory?.heldSlot || 0);
    const held = this._getHeldItem();
    const requestId = this._nextStackRequestId++;
    return {
      request_id: requestId,
      actions: [{
        type_id: 'mine_block',
        hotbar_slot: heldSlot,
        predicted_durability: this._predictedMineDurability(held),
        network_id: this._readItemStackId(held),
      }],
      custom_names: [],
      cause: 'chat_public',
    };
  }

  _eyePosition(position) {
    const pos = this._normaliseVec3(position, { x: 0, y: 80, z: 0 });
    return {
      x: pos.x,
      y: pos.y + 1.62,
      z: pos.z,
    };
  }

  _readItemStackId(item) {
    const value = item?.stack_id ?? item?.stackId ?? item?.stack_net_id ?? item?.stackNetId;
    if (value && typeof value === 'object') {
      return Number(value.id ?? value.stack_id ?? value.stackId ?? value.value ?? 0) || 0;
    }
    return Number(value ?? item?.network_id ?? item?.networkId ?? 0) || 0;
  }

  _readItemDurability(item) {
    const nbtDamage = item?.extra?.nbt?.nbt?.value?.Damage?.value ??
      item?.raw?.extra?.nbt?.nbt?.value?.Damage?.value;
    const damage = Number(nbtDamage ?? item?.metadata ?? item?.damage ?? 0);
    return Number.isFinite(damage) ? damage : 0;
  }

  _predictedMineDurability(item) {
    if (!item || Number(item.network_id ?? item.networkId ?? 0) === 0) return 0;
    return this._readItemDurability(item) + 1;
  }

  _cameraOrientation(pitch, yaw) {
    const pitchRad = pitch * Math.PI / 180;
    const yawRad = yaw * Math.PI / 180;
    const cosPitch = Math.cos(pitchRad);

    return {
      x: -Math.sin(yawRad) * cosPitch,
      y: -Math.sin(pitchRad),
      z: Math.cos(yawRad) * cosPitch,
    };
  }

  _logKeepAliveError(packetName, error) {
    const message = error?.message || String(error);
    const key = `${packetName}:${message}`;
    if (this._lastInputError === key) return;

    this._lastInputError = key;
    console.warn(`[Client] Keepalive ${packetName} failed: ${message}`);
  }

  _usesLegacyTickSync() {
    return !this._isAtLeast('1.20.81');
  }

  _toSignedI64(value) {
    if (Array.isArray(value) || (value && typeof value === 'object' && 0 in value && 1 in value)) {
      const unsigned = (BigInt(value[0]) << 32n) | BigInt.asUintN(32, BigInt(value[1]));
      return BigInt.asIntN(64, unsigned);
    }

    const raw = typeof value === 'bigint' ? value : BigInt(value);
    return BigInt.asIntN(64, raw);
  }

  _networkLatencyResponseTimestamp(value) {
    const scale = BigInt(this.config.protocol?.networkStackLatencyScale || 1);
    return BigInt.asUintN(64, this._toSignedI64(value) * scale);
  }

  _wireEvents() {
    const c = this._client;

    // Swallow unhandled errors on the bedrock client itself
    c.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      // Don't log or re-emit harmless NBT packet-decode noise (chunk/entity data
      // the library can't parse). Tags 103/116 are ASCII chars misread as NBT IDs.
      const msg = e.message;
      const isNbtNoise = (
        /Invalid tag:\s*\d+\s*>\s*\d+/.test(msg) ||
        /Missing characters in string/.test(msg) ||
        /Read error for undefined/.test(msg)
      );
      if (isNbtNoise) return;
      console.error('[Client] Error:', msg);
      this.emit('error', e);
      this.emit('_error', e);
    });

    c.on('connect', () => {
      console.log('[Client] RakNet connected — login sequence starting');
      this.state.setStatus('connected');
      this.emit('connected');
    });

    c.on('login', () => {
      console.log('[Client] Login accepted');
      this.state.setStatus('logged_in');
      this.emit('loggedIn');
    });

    c.on('spawn', () => {
      console.log('[Client] ✓ Spawned — bot is PLAYING');
      this._connected = true;
      this.state.setStatus('playing');
      this._startPlayKeepAlive();
      this.emit('spawn');
      this.emit('_spawn');
    });

    c.on('start_game', (packet) => {
      console.log('[Client] start_game received');
      this._hasMoveCorrection = false;
      this._lastCorrectionAt = 0;
      this._lastCorrectionTick = null;
      this._lastCorrectionPosition = null;
      if (this.state.player) {
        this.state.player.entityRuntimeId = packet.runtime_entity_id;
        if (packet.player_position) {
          this.state.player.position = this._normaliseVec3(packet.player_position, this.state.player.position);
        }
        if (packet.rotation) {
          this.state.player.rotation = {
            pitch: Number(packet.rotation.x ?? 0),
            yaw: Number(packet.rotation.z ?? 0),
          };
        }
      }
      this.emit('gameStart', packet);
    });

    c.on('text', (packet) => {
      this.emit('chat', {
        type:    packet.type,
        sender:  packet.source_name,
        message: packet.message,
      });
    });

    c.on('update_attributes', (packet) => {
      for (const attr of (packet.attributes || [])) {
        if (attr.name === 'minecraft:health') {
          if (this.state.player) this.state.player.health = attr.current;
          this.emit('health', attr.current);
        }
      }
    });

    c.on('move_player', (packet) => {
      if (this._sameRuntimeId(packet.runtime_id, this.state.player?.entityRuntimeId)) {
        const isTeleport = packet.mode === 'teleport' || packet.mode === 'reset';
        const shouldUpdatePosition =
          this.state.player &&
          !this._isBogusOriginPosition(packet.position) &&
          !this._isStaleMoveAfterCorrection(packet) &&
          (!this._hasMoveCorrection || isTeleport);

        if (shouldUpdatePosition) {
          this.state.player.position = packet.position;
          this.state.player.rotation = {
            pitch: Number(packet.pitch ?? this.state.player.rotation?.pitch ?? 0),
            yaw: Number(packet.yaw ?? this.state.player.rotation?.yaw ?? 0),
          };
        }
        if (isTeleport) {
          this._pendingTeleportAck = true;
        }
        this.emit('move', packet.position);
      }
    });

    c.on('correct_player_move_prediction', (packet) => {
      if (packet.prediction_type === 'player' && this.state.player && this._isPlausibleCorrectionPosition(packet.position)) {
        this._hasMoveCorrection = true;
        this._lastCorrectionAt = Date.now();
        this._lastCorrectionTick = this._packetTick(packet.tick);
        this._lastCorrectionPosition = this._normaliseVec3(packet.position, this.state.player.position);
        this.state.player.position = this._lastCorrectionPosition;
        this.state.player.onGround = Boolean(packet.on_ground);
        if (packet.rotation) {
          this.state.player.rotation = {
            pitch: Number(packet.rotation.x ?? this.state.player.rotation?.pitch ?? 0),
            yaw: Number(packet.rotation.z ?? this.state.player.rotation?.yaw ?? 0),
          };
        }
      }
      this.emit('moveCorrection', packet);
    });

    c.on('set_entity_motion', (packet) => {
      if (this._sameRuntimeId(packet.runtime_entity_id, this.state.player?.entityRuntimeId) && this.state.player) {
        this.state.player.velocity = packet.velocity;
      }
      this.emit('entityMotion', packet);
    });

    c.on('level_chunk', (packet) => {
      this.emit('levelChunk', packet);
    });

    c.on('update_block', (packet) => {
      this.emit('updateBlock', packet);
    });

    c.on('block_event', (packet) => {
      this.emit('blockEvent', packet);
    });

    c.on('container_open', (packet) => {
      this._openContainer = {
        windowId:    packet.window_id,
        windowType:  packet.window_type,
        runtimeId:   packet.runtime_entity_id,
        coordinates: packet.coordinates,
        slots:       [],
        openedAt:    Date.now(),
      };
      this.emit('containerOpen', this._openContainer);
    });

    c.on('container_close', (packet) => {
      const closed = this._openContainer;
      this._openContainer = null;
      this.emit('containerClose', { windowId: packet.window_id, server: packet.server, container: closed });
    });

    c.on('inventory_content', (packet) => {
      const slots = (packet.input || []).map((item) => ({ ...item, raw: item }));
      if (packet.window_id === 'inventory' || packet.window_id === 0) {
        this.state.setInventory(slots, this.state.inventory?.heldSlot || 0);
      } else if (this._openContainer && this._sameWindow(packet.window_id, this._openContainer.windowId)) {
        // Full content of the open server container (e.g. sell GUI).
        this._openContainer.slots = slots;
        this._openContainer.container = packet.container;
        this.emit('containerContent', { windowId: packet.window_id, slots, container: packet.container });
      }
      this.emit('inventoryContent', packet);
    });

    c.on('inventory_slot', (packet) => {
      if (packet.window_id === 'inventory' || packet.window_id === 0) {
        const slots = [...(this.state.inventory?.slots || [])];
        slots[Number(packet.slot)] = { ...(packet.item || {}), raw: packet.item };
        this.state.setInventory(slots, this.state.inventory?.heldSlot || 0);
      } else if (this._openContainer && this._sameWindow(packet.window_id, this._openContainer.windowId)) {
        const idx = Number(packet.slot);
        this._openContainer.slots[idx] = { ...(packet.item || {}), raw: packet.item };
        this.emit('containerSlot', { windowId: packet.window_id, slot: idx, item: packet.item });
      }
      this.emit('inventorySlot', packet);
    });

    c.on('player_hotbar', (packet) => {
      if (Number.isFinite(Number(packet.selected_slot))) {
        this.state.inventory.heldSlot = Number(packet.selected_slot);
      }
      this.emit('playerHotbar', packet);
    });

    c.on('item_stack_response', (packet) => {
      this.emit('itemStackResponse', packet);
    });

    c.on('network_chunk_publisher_update', (packet) => {
      this.emit('chunkPublisherUpdate', packet);
    });

    c.on('add_item_entity', (packet) => {
      this.emit('addItemEntity', packet);
    });

    c.on('take_item_entity', (packet) => {
      this.emit('takeItemEntity', packet);
    });

    c.on('network_stack_latency', (packet) => {
      if (packet.needs_response || packet.from_server || this.config.protocol?.networkStackLatencyScale) {
        try {
          c.write('network_stack_latency', {
            timestamp: this._networkLatencyResponseTimestamp(packet.timestamp),
            needs_response: 0,
          });
        } catch (e) {
          this._logKeepAliveError('network_stack_latency', e);
        }
      }
    });

    c.on('kick', (reason) => {
      const msg = this._extractDisconnectReason(reason, 'Kicked');
      console.warn('[Client] Kicked:', msg);
      this._connected = false;
      this._stopPlayKeepAlive();
      this.state.setDisconnectReason(msg);
      this.emit('kicked', { message: msg });
      this.emit('_kicked', msg);
    });

    c.on('disconnect', (info) => {
      const reason = this._extractDisconnectReason(info, 'Disconnected');
      console.warn('[Client] Disconnected:', reason);
      this._connected = false;
      this._stopPlayKeepAlive();
      this.state.setStatus('disconnected');
      this.state.setDisconnectReason(reason);
      this.emit('disconnected', { reason });
    });

    c.on('close', () => {
      if (this._connected) {
        this._connected = false;
        this._stopPlayKeepAlive();
        this.state.setStatus('disconnected');
        this.emit('disconnected', { reason: 'Connection closed' });
      }
    });

    c.on('packet', (pkt) => this.emit('packet', pkt));
  }

  _extractDisconnectReason(value, fallback) {
    if (typeof value === 'string' && value.trim()) return value;
    if (!value || typeof value !== 'object') return fallback;

    const candidates = [
      value.message,
      value.filtered_message,
      value.reason,
      value.error,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() && candidate !== 'unknown') {
        return candidate;
      }
    }

    if (typeof value.reason === 'string' && value.reason.trim()) return value.reason;
    return fallback;
  }
}

module.exports = { BedrockProtocolClient };
