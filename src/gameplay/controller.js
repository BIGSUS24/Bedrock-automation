'use strict';

const EventEmitter = require('events');
const { WorldTracker, distanceSq, keyOf } = require('./world_tracker');
const { Pathfinder, blockPos, centerOf } = require('./pathfinder');

// Bedrock 1.26.20 registry for item name lookups and block material data
let _mcdata = null;
function getMcData() {
  if (!_mcdata) {
    try { _mcdata = require('minecraft-data')('bedrock_1.26.20'); }
    catch { _mcdata = null; }
  }
  return _mcdata;
}

const DEFAULTS = {
  movement: {
    speed: 4.0,
    tickMs: 50,
    arrivalRadius: 0.35,
    pathArrivalRadius: 0.6,
    maxNodes: 4096,
    positionReadyTimeout: 3000,
    useServerCorrections: true,
  },
  pull: {
    searchRadius: 32,
    yRadius: 8,
    interactRange: 4.5,
    confirmationTimeout: 1500,
    preferWaypoints: true,
    allowedBlocks: [
      'spruce_trapdoor',
      'oak_trapdoor',
      'birch_trapdoor',
      'jungle_trapdoor',
      'acacia_trapdoor',
      'dark_oak_trapdoor',
      'mangrove_trapdoor',
      'cherry_trapdoor',
      'bamboo_trapdoor',
      'crimson_trapdoor',
      'warped_trapdoor',
      'wooden_trapdoor',
      'trapdoor',
    ],
    deniedBlocks: [
      'copper_trapdoor',
      'exposed_copper_trapdoor',
      'weathered_copper_trapdoor',
      'oxidized_copper_trapdoor',
      'waxed_copper_trapdoor',
      'waxed_exposed_copper_trapdoor',
      'waxed_weathered_copper_trapdoor',
      'waxed_oxidized_copper_trapdoor',
    ],
  },
  mining: {
    searchRadius: 24,
    yRadius: 24,
    interactRange: 4.5,
    confirmationTimeout: 3500,
    maxBlocksPerCommand: 16,
    collectDrops: true,
    collectRadius: 8,
    requireInventoryGain: true,
    inventoryGainTimeout: 5000,
    autoSelectTool: true,
    standYOffsets: [0, 1, -1, 2, -2],
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeDefaults(config) {
  const gameplay = config?.gameplay || {};
  return {
    movement: { ...DEFAULTS.movement, ...(gameplay.movement || {}) },
    pull: { ...DEFAULTS.pull, ...(gameplay.pull || {}) },
    mining: { ...DEFAULTS.mining, ...(gameplay.mining || {}) },
  };
}

function yawPitchTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const horiz = Math.sqrt(dx * dx + dz * dz) || 0.0001;
  return {
    yaw: Math.atan2(-dx, dz) * 180 / Math.PI,
    pitch: -Math.atan2(dy, horiz) * 180 / Math.PI,
  };
}

function emptyItem(item) {
  return !item || Number(item.network_id ?? item.networkId ?? 0) === 0 || Number(item.count ?? 0) === 0;
}

function itemCount(item) {
  if (emptyItem(item)) return 0;
  const count = Number(item.count ?? item.stack_count ?? item.stackCount ?? 1);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

class GameplayController extends EventEmitter {
  constructor(config, protocol, state, world = null) {
    super();
    this.config = config || {};
    this.protocol = protocol;
    this.state = state;
    this.options = mergeDefaults(config);
    this.world = world || new WorldTracker(config, protocol, state);
    this.pathfinder = new Pathfinder(this.world, { maxNodes: this.options.movement.maxNodes });
    this._activeTask = null;
    this._stopRequested = false;
    this._serverMoveCount = 0;
    this._serverCorrectionCount = 0;
    this._onServerMove = () => {
      this._serverMoveCount++;
    };
    this._onServerCorrection = () => {
      this._serverCorrectionCount++;
    };
    this.world.attach();
    this.protocol?.on?.('move', this._onServerMove);
    this.protocol?.on?.('moveCorrection', this._onServerCorrection);
  }

  stop() {
    this._stopRequested = true;
    this.protocol?.clearGameplayInputState?.();
    if (this._onServerMove) this.protocol?.removeListener?.('move', this._onServerMove);
    if (this._onServerCorrection) this.protocol?.removeListener?.('moveCorrection', this._onServerCorrection);
    this.world.detach();
  }

  async pull(options = {}) {
    return this._exclusive('pull', async () => {
      this._ensureReady();
      await this._waitForPositionReady();
      const target = this._findPullTarget(options);
      if (!target) {
        const stats = this.world.getStats();
        return {
          ok: false,
          message: `No pearl pull trapdoor found. World state: ${stats.loadedChunks} chunks loaded, ${stats.blockUpdates} block updates tracked. Configure waypoints in config gameplay.pull.waypoints for known trapdoor positions.`,
        };
      }

      console.log(`[PULL] Target: ${target.block?.name || 'unknown'} at ${this._fmt(target.position)}` +
        (target.configured ? ' (from config waypoint)' : ' (found in world)'));

      // Navigate to standing position
      const stand = target.standPosition || this._standPositionFor(target.position);
      target.standPosition = stand;
      console.log(`[PULL] Navigating to stand position ${this._fmt(stand)}...`);
      await this.navigateTo(stand, { radius: this.options.movement.pathArrivalRadius });

      const actualPos = this.state.player?.position || stand;
      console.log(`[PULL] Arrived at ${this._fmt(actualPos)}`);

      // Check if we're actually within interaction range
      const interactRange = this.options.pull.interactRange || 4.5;
      const eye = { x: actualPos.x, y: actualPos.y + 1.62, z: actualPos.z };
      const blockCenter = { x: target.position.x + 0.5, y: target.position.y + 0.5, z: target.position.z + 0.5 };
      const reachDist = Math.sqrt(distanceSq(eye, blockCenter));
      if (reachDist > interactRange) {
        console.log(`[PULL] Too far from trapdoor! Distance=${reachDist.toFixed(2)} > max ${interactRange}. Bot is at Y=${actualPos.y.toFixed(1)}, trapdoor at Y=${target.position.y}`);
        return {
          ok: false,
          message: `Cannot reach trapdoor at ${this._fmt(target.position)} — distance ${reachDist.toFixed(1)} exceeds max reach ${interactRange}. Bot position: ${this._fmt(actualPos)}. You may need to navigate closer or configure a better waypoint.`,
          target,
        };
      }

      // Face the target block
      await this.faceBlock(target.position);
      await sleep(100); // Extra settle time for look direction

      // Read current block state — this is critical for the interaction packet
      const before = this.world.getBlock(target.position);
      const beforeRuntime = Number(before?.runtimeId ?? target.runtimeId ?? 0);
      console.log(`[PULL] Block state before interaction: runtime=${beforeRuntime}, name=${before?.block?.name || 'unknown'}`);

      // Determine face direction
      const face = target.face ?? this._faceForStand(actualPos, target.position);

      // Try up to 3 interaction attempts
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[PULL] Interaction attempt ${attempt}/${maxAttempts} (face=${face})...`);

        const confirmation = this._waitForInteractionConfirmation(
          target.position, before,
          this.options.pull.confirmationTimeout || 2000,
        );

        await this.protocol.sendSwing?.();
        await this.protocol.sendItemUseOnBlock({
          position: target.position,
          face,
          clickPos: target.clickPos || { x: 0.5, y: 0.5, z: 0.5 },
          blockRuntimeId: beforeRuntime,
        });

        const confirmed = await confirmation;

        if (confirmed.ok) {
          // Double-check: re-read the block to see if it actually changed
          await sleep(200);
          const after = this.world.getBlock(target.position);
          const afterRuntime = Number(after?.runtimeId ?? 0);
          const stateChanged = afterRuntime !== beforeRuntime;
          console.log(`[PULL] Block state after interaction: runtime=${afterRuntime}, name=${after?.block?.name || 'unknown'}, changed=${stateChanged}`);

          return {
            ok: true,
            verifiedBy: confirmed.kind,
            stateChanged,
            message: `Trapdoor interaction confirmed at ${this._fmt(target.position)} by ${confirmed.kind}. ` +
              `Block runtime: ${beforeRuntime} → ${afterRuntime}. ` +
              `Pearl teleport requires external observation if the pulled player is not this bot.`,
            target,
          };
        }

        console.log(`[PULL] Attempt ${attempt} timed out — no server confirmation received.`);

        if (attempt < maxAttempts) {
          // Re-face and try again with slight delay
          await this.faceBlock(target.position);
          await sleep(300);
        }
      }

      return {
        ok: false,
        message: `Interaction packet sent ${maxAttempts} times to ${target.block?.name || 'target'} at ${this._fmt(target.position)}, but NO server block state change was observed. The interaction likely failed on the server side.`,
        target,
      };
    });
  }

  async mine(query, options = {}) {
    if (!query) return { ok: false, message: 'Usage: .mine <block/ore> [count]' };
    if (query === 'stop') {
      this._stopRequested = true;
      return { ok: true, message: 'Mining stop requested.' };
    }

    return this._exclusive('mine', async () => {
      this._ensureReady();
      await this._waitForPositionReady();
      this._stopRequested = false;
      const maxBlocks = Number(options.count || this.options.mining.maxBlocksPerCommand || 1);
      const mined = [];
      const errors = [];
      const failedTargets = new Set();

      while (!this._stopRequested && mined.length < maxBlocks) {
        if (this.isInventoryFull()) {
          return { ok: mined.length > 0, message: 'Inventory is full; mining stopped.', mined, errors };
        }

        const targets = this._findMineTargets(query, mined, failedTargets);
        if (!targets.length) {
          return {
            ok: mined.length > 0,
            message: mined.length ? 'No more matching target blocks found.' : `No loaded target block found for "${query}".`,
            mined,
            errors,
          };
        }

        let madeProgress = false;
        for (const target of targets) {
          if (this._stopRequested || mined.length >= maxBlocks) break;
          try {
            const result = await this.mineBlock({ ...target, query });
            if (!result.ok) {
              errors.push(result.message);
              failedTargets.add(keyOf(target.position));
              continue;
            }
            mined.push(result.target || target);
            madeProgress = true;
            break;
          } catch (e) {
            errors.push(e.message);
            failedTargets.add(keyOf(target.position));
          }
        }

        if (!madeProgress) {
          return {
            ok: mined.length > 0,
            message: errors[errors.length - 1] || `No reachable target block found for "${query}".`,
            mined,
            errors,
          };
        }
      }

      return {
        ok: mined.length > 0,
        message: this._stopRequested ? 'Mining stopped by request.' : `Mined ${mined.length} block(s).`,
        mined,
        errors,
      };
    });
  }

  async mineBlock(target) {
    const blockName = target.block?.name || 'unknown';
    console.log(`[MINE] Starting to mine ${blockName} at ${this._fmt(target.position)}`);

    const beforeInventory = this._inventorySnapshot();
    await this._ensureMiningHeldItem(target.block);

    let stand = null;
    let face = this._mineFaceFrom(this.state.player?.position, target.position);
    if (face === null) {
      stand = this._mineStandPositionFor(target.position);
      if (!stand) {
        return { ok: false, message: `No reachable standing position found for ${blockName} at ${this._fmt(target.position)}.` };
      }
      console.log(`[MINE] Navigating to stand position ${this._fmt(stand)}...`);
      await this.navigateTo(stand, { radius: this.options.movement.pathArrivalRadius });
      face = this._mineFaceFrom(this.state.player?.position, target.position);
      if (face === null) {
        return {
          ok: false,
          message: `Reached stand point for ${blockName} at ${this._fmt(target.position)}, but target is not visible/reachable.`,
        };
      }
    }

    await this.faceBlock(target.position);
    await sleep(50);

    // Use block hardness for break time, with better defaults
    const breakMs = this._breakDurationMs(target.block);
    console.log(`[MINE] Breaking ${blockName} (face=${face}, breakMs=${breakMs})...`);

    // Start breaking
    await this.protocol.sendSwing?.();
    await this.protocol.sendBlockBreakAction?.('start_break', target.position, face);

    // Continue breaking with arm swings
    const start = Date.now();
    const swingInterval = 350; // Swing arm every 350ms like vanilla
    let lastSwing = start;
    while (Date.now() - start < breakMs) {
      if (this._stopRequested) {
        await this.protocol.sendBlockBreakAction?.('abort_break', target.position, face);
        return { ok: false, message: 'Mining stopped by request.' };
      }
      await sleep(this.options.movement.tickMs);
      // Send continue_break every tick so server tracks progress
      await this.protocol.sendBlockBreakAction?.('continue_break', target.position, face);
      if (Date.now() - lastSwing >= swingInterval) {
        await this.protocol.sendSwing?.();
        lastSwing = Date.now();
      }
      // Keep facing the block during mining
      await this.faceBlock(target.position);
    }

    // Set up confirmation listener BEFORE sending the finish packet
    const changed = this._waitForBlockMined(target.position, target, this.options.mining.confirmationTimeout);

    // Send the finish/predict break
    let stackRequestId = null;
    if (this.protocol.sendFinalMinePrediction) {
      stackRequestId = await this.protocol.sendFinalMinePrediction(target.position, face);
    } else {
      await this.protocol.sendBlockBreakAction?.('predict_break', target.position, face);
      stackRequestId = await this.protocol.sendMineStackRequest?.();
    }

    const stackResponse = stackRequestId
      ? this._waitForItemStackResponse(stackRequestId, this.options.mining.confirmationTimeout)
      : Promise.resolve(null);

    // Wait for block change confirmation
    const confirmation = await changed;
    if (!confirmation.ok) {
      console.log(`[MINE] No block-break confirmation for ${blockName} at ${this._fmt(target.position)} — server did not acknowledge the break.`);
      // Send abort to clean up
      await this.protocol.sendBlockBreakAction?.('abort_break', target.position, face).catch(() => {});
      return { ok: false, message: `No server block-break confirmation for ${blockName} at ${this._fmt(target.position)}.` };
    }

    console.log(`[MINE] Block break confirmed for ${blockName} at ${this._fmt(target.position)}`);

    const response = await stackResponse;
    if (response && response.ok === false) {
      console.log(`[MINE] Server rejected item-stack request for ${blockName}`);
      return {
        ok: false,
        message: `Server rejected mine item-stack request for ${blockName} at ${this._fmt(target.position)}.`,
        target,
        confirmation,
        stackResponse: response,
      };
    }

    // Collect drops by walking to the broken block position (now air — bot can fall into it)
    if (this.options.mining.collectDrops) {
      const blockCenter = centerOf(target.position);
      const drop = this.world.findNearestItem(blockCenter, this.options.mining.collectRadius);
      const collectTarget = drop?.position || blockCenter;
      console.log(`[MINE] Collecting drops at ${this._fmt(collectTarget)}...`);
      try {
        await this.navigateTo(collectTarget, { radius: 1.2, allowSameBlock: true });
      } catch (navErr) {
        // Navigation might fail if the broken block is in a pit — try walking to XZ only
        console.log(`[MINE] Navigation to drop failed (${navErr.message}), trying XZ approach...`);
        try {
          const xzTarget = { x: collectTarget.x, y: this.state.player?.position?.y || collectTarget.y, z: collectTarget.z };
          await this._walkTo(xzTarget, 1.2);
        } catch { /* best effort */ }
      }
      await sleep(1500); // Wait for item pickup — server may delay
    }

    // Verify inventory gain
    let inventoryGain = null;
    if (this.options.mining.requireInventoryGain) {
      inventoryGain = await this._waitForInventoryGain(beforeInventory, this.options.mining.inventoryGainTimeout);
      if (!inventoryGain.ok) {
        console.log(`[MINE] Block was broken but no inventory gain detected. Item may not have been picked up, but block IS gone.`);
        // Still count as success — the block is confirmed broken by the server
        // The item just wasn't collected (e.g., fell into a pit)
        return {
          ok: true,
          message: `Mined ${blockName} at ${this._fmt(target.position)} (block broken, but drop may not have been collected).`,
          target,
          confirmation,
          inventoryGain: { ok: false, note: 'Block broken but item not collected' },
        };
      }
      console.log(`[MINE] Inventory gain confirmed: +${inventoryGain.delta.total} items`);
    }

    return {
      ok: true,
      message: `Mined ${blockName} at ${this._fmt(target.position)}.`,
      target,
      confirmation,
      inventoryGain,
    };
  }

  async navigateTo(target, options = {}) {
    this._ensureReady();
    const radius = options.radius ?? this.options.movement.arrivalRadius;
    const start = this.state.player?.position || { x: 0, y: 0, z: 0 };
    const startBlock = blockPos(start);
    const shouldMoveDirect = options.allowSameBlock || !this._canStandAt(startBlock);
    const path = shouldMoveDirect ? [target] : this.pathfinder.findPath(start, target);

    for (const point of path) {
      await this._walkTo(point, radius);
    }

    this.protocol.clearGameplayInputState?.();
    return path;
  }

  async faceBlock(pos) {
    const playerPos = this.state.player?.position || { x: 0, y: 0, z: 0 };
    const eye = { x: playerPos.x, y: playerPos.y + 1.62, z: playerPos.z };
    const target = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
    const rot = yawPitchTo(eye, target);
    this.state.setRotation(rot.yaw, rot.pitch);
    this.protocol.setGameplayInputState?.({
      position: playerPos,
      yaw: rot.yaw,
      pitch: rot.pitch,
      moveVector: { x: 0, z: 0 },
      inputData: {},
    });
    await sleep(this.options.movement.tickMs);
  }

  isInventoryFull() {
    const inv = this.state.inventory || {};
    const size = Number(inv.size || 36);
    const slots = inv.slots || [];
    let occupied = 0;
    for (let i = 0; i < size; i++) {
      if (!emptyItem(slots[i])) occupied++;
    }
    return occupied >= size;
  }

  _findPullTarget(options = {}) {
    if (options.position) {
      return this._targetFromPosition(options.position, options);
    }

    const origin = this.state.player?.position || { x: 0, y: 0, z: 0 };
    const waypoints = this.world.getPullWaypoints();
    if (waypoints.length && this.options.pull.preferWaypoints !== false) {
      waypoints.sort((a, b) => distanceSq(a.position, origin) - distanceSq(b.position, origin));
      return this._targetFromPosition(waypoints[0].position, waypoints[0]);
    }

    const traps = this.world.findTrapdoors(origin, this.options.pull.searchRadius, {
      allowedBlocks: this.options.pull.allowedBlocks,
      deniedBlocks: this.options.pull.deniedBlocks,
    });
    if (traps.length) return { ...traps[0] };

    if (waypoints.length) {
      waypoints.sort((a, b) => distanceSq(a.position, origin) - distanceSq(b.position, origin));
      return this._targetFromPosition(waypoints[0].position, waypoints[0]);
    }

    return null;
  }

  _findMineTargets(query, mined, failedTargets = new Set()) {
    const origin = this.state.player?.position || { x: 0, y: 0, z: 0 };
    const minedKeys = new Set(mined.map((entry) => keyOf(entry.position)));
    const candidates = this.world.findMineTargets(query, origin, this.options.mining.searchRadius)
      .filter((entry) => {
        if (minedKeys.has(keyOf(entry.position))) return false;
        if (failedTargets.has(keyOf(entry.position))) return false;
        if (entry.block?.diggable === false) return false;
        if (this._canMineFromCurrent(entry.position)) return true;
        return Boolean(this._mineStandPositionFor(entry.position, { allowFallback: false }));
      });
    candidates.sort((a, b) => {
      const aReachable = this._canMineFromCurrent(a.position) ? 0 : 1;
      const bReachable = this._canMineFromCurrent(b.position) ? 0 : 1;
      if (aReachable !== bReachable) return aReachable - bReachable;
      return a.distanceSq - b.distanceSq;
    });
    return candidates;
  }

  async _walkTo(point, radius) {
    const tickMs = this.options.movement.tickMs;
    const walkSpeed = 4.317;  // Vanilla walk speed blocks/sec — NO sprint
    const initialDist = Math.sqrt(distanceSq(this.state.player.position, point));
    const maxTicks = Math.ceil((initialDist / Math.max(walkSpeed * 0.5, 0.1)) * 25) + 400;

    // Smooth movement state
    let currentYaw = this.state.player?.rotation?.yaw ?? 0;
    let currentPitch = this.state.player?.rotation?.pitch ?? 0;
    let accelFactor = 0;     // 0 = stopped, 1 = full walk speed
    let stableTicks = 0;     // ticks spent within arrival radius

    for (let tick = 0; tick < maxTicks; tick++) {
      if (this._stopRequested) throw new Error('Task stopped');

      // Always read server-corrected position — this is ground truth
      const current = this.state.player?.position || { x: 0, y: 0, z: 0 };
      const dx = point.x - current.x;
      const dz = point.z - current.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);

      // ── Arrival check with stability requirement ──
      if (horizDist <= radius) {
        stableTicks++;
        // Send idle input
        this.protocol.setGameplayInputState?.({
          position: current,
          yaw: currentYaw,
          pitch: currentPitch,
          moveVector: { x: 0, z: 0 },
          inputData: {},
        });
        // Need 3 stable ticks to confirm arrival (prevents oscillation)
        if (stableTicks >= 3) return;
        await sleep(tickMs);
        continue;
      }
      stableTicks = 0;
      accelFactor = Math.min(1, accelFactor + 0.1); // ~10 ticks to full speed

      // ── Smooth head rotation ──
      const targetRot = yawPitchTo(
        { x: current.x, y: current.y + 1.62, z: current.z },
        { x: point.x, y: (point.y ?? current.y) + 0.5, z: point.z }
      );
      // Max 10°/tick for yaw = ~200°/s (natural mouse movement)
      const maxYawRate = 10;
      let yawDiff = targetRot.yaw - currentYaw;
      while (yawDiff > 180) yawDiff -= 360;
      while (yawDiff < -180) yawDiff += 360;
      currentYaw += Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), maxYawRate);
      while (currentYaw > 180) currentYaw -= 360;
      while (currentYaw < -180) currentYaw += 360;

      // Pitch: smoother, max 7°/tick
      let pitchDiff = targetRot.pitch - currentPitch;
      currentPitch += Math.sign(pitchDiff) * Math.min(Math.abs(pitchDiff), 7);
      currentPitch = Math.max(-90, Math.min(90, currentPitch));

      // ── Position prediction (vanilla walk physics) ──
      const isTurning = Math.abs(yawDiff) > 20;
      const speed = isTurning ? walkSpeed * 0.5 * accelFactor : walkSpeed * accelFactor;
      const step = Math.min(speed * (tickMs / 1000), horizDist);

      // Add tiny noise to avoid perfect straight-line movement
      const noise = () => (Math.random() - 0.5) * 0.005;
      const nx = current.x + (dx / horizDist) * step + noise();
      const nz = current.z + (dz / horizDist) * step + noise();
      // Y: follow server — don't override. Let server physics handle gravity/jumps.
      const ny = current.y;

      const next = { x: nx, y: ny, z: nz };
      const delta = { x: next.x - current.x, y: next.y - current.y, z: next.z - current.z };

      // ── Input data — walk only, no sprint ──
      const inputData = { up: true };
      const moveVec = { x: 0, z: accelFactor > 0.05 ? 1 : 0 };

      this.state.setPosition(next.x, next.y, next.z);
      this.state.setRotation(currentYaw, currentPitch);
      this.protocol.setGameplayInputState?.({
        position: next,
        yaw: currentYaw,
        pitch: currentPitch,
        moveVector: moveVec,
        rawMoveVector: moveVec,
        delta,
        inputData,
      });

      // Random tick jitter: 47-53ms instead of exact 50ms
      const jitter = tickMs + Math.floor(Math.random() * 7) - 3;
      await sleep(jitter);
    }

    throw new Error(`Could not reach ${this._fmt(point)} within movement budget; current position is ${this._fmt(this.state.player?.position || {})}`);
  }

  _standPositionFor(block, options = {}) {
    const player = this.state.player?.position || { x: 0, y: block.y, z: 0 };
    const playerY = Math.floor(player.y);
    const offsets = options.yOffsets || this.options.pull.standYOffsets || [0, -1, -2, 1];
    const requireFloor = options.requireFloor !== false;
    const maxReach = this.options.pull.interactRange || 4.5;
    const candidates = [];
    for (const yOffset of offsets) {
      const y = block.y + yOffset;
      candidates.push(
        { x: block.x + 1, y, z: block.z },
        { x: block.x - 1, y, z: block.z },
        { x: block.x, y, z: block.z + 1 },
        { x: block.x, y, z: block.z - 1 },
      );
    }

    const valid = candidates.filter((pos) => {
      // Must be passable
      if (!this.world.isPassable(pos)) return false;
      if (!this.world.isPassable({ x: pos.x, y: pos.y + 1, z: pos.z })) return false;
      if (requireFloor && !this.world.hasFloor(pos)) return false;
      // Must be Y-reachable from current position (within ±2 blocks — walkable without pillar/ladder)
      if (Math.abs(pos.y - playerY) > 2) return false;
      // Must be within interaction range of the target block
      const eye = { x: pos.x + 0.5, y: pos.y + 1.62, z: pos.z + 0.5 };
      const blockCenter = { x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.5 };
      if (Math.sqrt(distanceSq(eye, blockCenter)) > maxReach) return false;
      return true;
    });

    // Sort by Y proximity to player first, then XZ distance
    const list = valid.length ? valid : [];
    if (!list.length && options.allowFallback !== false) {
      // Fallback: use player's current Y level next to the block
      list.push({ x: block.x + 1, y: playerY, z: block.z });
    }
    if (!list.length) return null;
    list.sort((a, b) => {
      const aYDist = Math.abs(a.y - playerY);
      const bYDist = Math.abs(b.y - playerY);
      if (aYDist !== bYDist) return aYDist - bYDist;
      return distanceSq(a, player) - distanceSq(b, player);
    });
    return centerOf(blockPos(list[0]));
  }

  _faceForStand(stand, block) {
    const sx = Math.floor(stand.x);
    const sy = Math.floor(stand.y);
    const sz = Math.floor(stand.z);
    if (sy < block.y) return 0;
    if (sy > block.y) return 1;
    if (sx > block.x) return 5;
    if (sx < block.x) return 4;
    if (sz > block.z) return 3;
    if (sz < block.z) return 2;
    return 1;
  }

  _canStandAt(pos) {
    return this.world.isPassable(pos) &&
      this.world.isPassable({ x: pos.x, y: pos.y + 1, z: pos.z }) &&
      this.world.hasFloor(pos);
  }

  _canMineFromCurrent(block) {
    return this._mineFaceFrom(this.state.player?.position, block) !== null;
  }

  _mineStandPositionFor(block, options = {}) {
    const player = this.state.player?.position || { x: 0, y: block.y, z: 0 };
    const offsets = options.yOffsets || this.options.mining.standYOffsets || [0, 1, -1, 2, -2];
    const candidates = [];
    for (const yOffset of offsets) {
      const y = block.y + yOffset;
      candidates.push(
        { x: block.x + 1, y, z: block.z },
        { x: block.x - 1, y, z: block.z },
        { x: block.x, y, z: block.z + 1 },
        { x: block.x, y, z: block.z - 1 },
      );
    }

    const valid = candidates.filter((pos) => (
      this.world.isPassable(pos) &&
      this.world.isPassable({ x: pos.x, y: pos.y + 1, z: pos.z }) &&
      this.world.hasFloor(pos) &&
      this._mineFaceFrom(centerOf(blockPos(pos)), block) !== null
    ));

    if (!valid.length && options.allowFallback !== false) {
      const fallback = this._standPositionFor(block, {
        yOffsets: offsets,
        requireFloor: true,
      });
      if (fallback && this._mineFaceFrom(fallback, block) !== null) return fallback;
    }
    if (!valid.length) return null;
    valid.sort((a, b) => distanceSq(a, player) - distanceSq(b, player));
    return centerOf(blockPos(valid[0]));
  }

  _mineFaceFrom(playerPosition, block) {
    const player = this.state.player?.position;
    const base = playerPosition || player;
    if (!base) return null;

    const eye = { x: base.x, y: base.y + 1.62, z: base.z };
    const maxRange = Number(this.options.mining.interactRange || 4.5);
    const faces = [
      { face: 0, neighbor: { x: block.x, y: block.y - 1, z: block.z }, point: { x: block.x + 0.5, y: block.y + 0.01, z: block.z + 0.5 } },
      { face: 1, neighbor: { x: block.x, y: block.y + 1, z: block.z }, point: { x: block.x + 0.5, y: block.y + 0.99, z: block.z + 0.5 } },
      { face: 2, neighbor: { x: block.x, y: block.y, z: block.z - 1 }, point: { x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.01 } },
      { face: 3, neighbor: { x: block.x, y: block.y, z: block.z + 1 }, point: { x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.99 } },
      { face: 4, neighbor: { x: block.x - 1, y: block.y, z: block.z }, point: { x: block.x + 0.01, y: block.y + 0.5, z: block.z + 0.5 } },
      { face: 5, neighbor: { x: block.x + 1, y: block.y, z: block.z }, point: { x: block.x + 0.99, y: block.y + 0.5, z: block.z + 0.5 } },
    ];

    // First pass: prefer faces with confirmed passable neighbors (ideal case)
    const withPassableNeighbor = faces
      .filter((entry) => this.world.isPassable(entry.neighbor))
      .filter((entry) => Math.sqrt(distanceSq(eye, entry.point)) <= maxRange)
      .filter((entry) => this._lineOfSightClear(eye, entry.point, block));
    if (withPassableNeighbor.length) {
      withPassableNeighbor.sort((a, b) => distanceSq(eye, a.point) - distanceSq(eye, b.point));
      return withPassableNeighbor[0].face;
    }

    // Second pass: pick closest face within range regardless of neighbor passability.
    // This handles mining into solid rock walls where you're standing in the only air pocket.
    const inRange = faces
      .filter((entry) => Math.sqrt(distanceSq(eye, entry.point)) <= maxRange);
    if (inRange.length) {
      inRange.sort((a, b) => distanceSq(eye, a.point) - distanceSq(eye, b.point));
      return inRange[0].face;
    }

    return null;
  }

  _lineOfSightClear(from, to, targetBlock) {
    const targetKey = keyOf(targetBlock);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const steps = Math.max(2, Math.ceil(Math.sqrt(dx * dx + dy * dy + dz * dz) * 8));

    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const pos = blockPos({
        x: from.x + dx * t,
        y: from.y + dy * t,
        z: from.z + dz * t,
      });
      if (keyOf(pos) === targetKey) continue;
      const entry = this.world.getBlock(pos);
      if (entry && !this.world.matcher.isAir(entry.block) && !this.world.isPassable(pos)) {
        return false;
      }
    }
    return true;
  }

  _breakDurationMs(block) {
    let hardness = Number(block?.hardness);
    // Try mcdata for hardness if not present on block
    if (!Number.isFinite(hardness) || hardness <= 0) {
      const mcdata = getMcData();
      const blockData = mcdata?.blocksByName?.[(block?.name || '').toLowerCase()];
      hardness = Number(blockData?.hardness);
    }
    if (!Number.isFinite(hardness) || hardness <= 0) return 500;

    // Base time: hardness * 1.5 seconds (bare hand)
    const bareHandMs = hardness * 1500;

    // Check held tool for speed multiplier
    const held = this._heldItem();
    const heldName = this._resolveItemName(held);
    const toolType = this._toolTypeForBlock(block);
    const hasCorrectTool = toolType && heldName.includes(toolType);

    let speedMultiplier = 1;
    if (hasCorrectTool) {
      const tier = this._toolTierScore(heldName);
      // Tool speed multipliers (approximate vanilla values)
      // wood=2, stone=4, iron=6, diamond=8, netherite=9, gold=12
      const tierSpeeds = [1, 2, 4, 12, 6, 8, 9]; // indexed by tier score
      speedMultiplier = tierSpeeds[tier] || 1;
    }

    const toolMs = bareHandMs / speedMultiplier;
    // Add 300ms network margin, clamp to [300, 30000]
    return Math.max(300, Math.min(30000, toolMs + 300));
  }

  _targetFromPosition(position, options = {}) {
    const pos = blockPos(position);
    const entry = this.world.getBlock(pos);
    const face = Number(options.face);
    return {
      ...options,
      position: pos,
      standPosition: options.standPosition ? centerOf(blockPos(options.standPosition)) : null,
      ...(Number.isFinite(face) ? { face } : {}),
      clickPos: options.clickPos || { x: 0.5, y: 0.5, z: 0.5 },
      block: entry?.block || options.block || { name: 'configured_trapdoor' },
      runtimeId: entry?.runtimeId ?? options.runtimeId ?? 0,
      configured: true,
    };
  }

  _waitForInteractionConfirmation(pos, before, timeoutMs) {
    const key = keyOf(pos);
    const beforeRuntime = Number(before?.runtimeId);
    return new Promise((resolve) => {
      const done = (ok, detail) => {
        clearTimeout(timer);
        this.world.removeListener('blockUpdate', onUpdate);
        this.world.removeListener('blockEvent', onEvent);
        resolve({ ok, ...detail });
      };
      const onUpdate = (entry) => {
        if (keyOf(entry.position) !== key) return;
        if (!Number.isFinite(beforeRuntime) || Number(entry.runtimeId) !== beforeRuntime) {
          done(true, { kind: 'block state change', detail: entry });
        }
      };
      const onEvent = (packet) => {
        if (keyOf(packet.position || {}) === key) done(true, { kind: 'block event', detail: packet });
      };
      const timer = setTimeout(() => done(false, { kind: 'timeout', detail: null }), timeoutMs);
      this.world.on('blockUpdate', onUpdate);
      this.world.on('blockEvent', onEvent);
    });
  }

  _waitForBlockMined(pos, target, timeoutMs) {
    const key = keyOf(pos);
    const originalRuntimeId = Number(target?.runtimeId);
    return new Promise((resolve) => {
      const done = (ok, detail) => {
        clearTimeout(timer);
        this.world.removeListener('blockUpdate', onUpdate);
        resolve({ ok, detail });
      };
      const onUpdate = (entry) => {
        if (keyOf(entry.position) !== key) return;
        if (this.world.matcher.isAir(entry.block)) return done(true, entry);
        if (target?.query && this.world.matcher.matches(entry.block, target.query)) return;
        if (Number.isFinite(originalRuntimeId) && Number(entry.runtimeId) !== originalRuntimeId) {
          return done(true, entry);
        }
      };
      const timer = setTimeout(() => done(false, null), timeoutMs);
      this.world.on('blockUpdate', onUpdate);
    });
  }

  async _exclusive(name, fn) {
    if (this._activeTask) {
      return { ok: false, message: `Cannot start ${name}; ${this._activeTask} is already running.` };
    }
    this._activeTask = name;
    try {
      return await fn();
    } catch (e) {
      return { ok: false, message: `${name} failed: ${e.message}` };
    } finally {
      this._activeTask = null;
      this.protocol?.clearGameplayInputState?.();
    }
  }

  _ensureReady() {
    if (!this.protocol?.isConnected?.()) throw new Error('Bot is not connected/playing.');
  }

  _waitForPositionReady() {
    const timeoutMs = Number(this.options.movement.positionReadyTimeout || 5000);
    if (timeoutMs <= 0) return Promise.resolve();
    if (!this.protocol?.getClient?.()) return Promise.resolve();
    // If we've already received at least one server move packet, position is ready
    if (this._serverMoveCount > 0) return Promise.resolve();

    // Wait for first server move/correction to ensure we have real coordinates
    console.log('[GAMEPLAY] Waiting for server to send real position...');
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.protocol.removeListener('move', onMove);
        this.protocol.removeListener('moveCorrection', onMove);
        const pos = this.state.player?.position;
        console.log(`[GAMEPLAY] Position ready: ${pos ? this._fmt(pos) : 'unknown'}`);
        resolve();
      };
      const onMove = () => done();
      const timer = setTimeout(done, timeoutMs);
      this.protocol.on('move', onMove);
      this.protocol.on('moveCorrection', onMove);
    });
  }

  _inventorySnapshot() {
    const slots = this.state.inventory?.slots || [];
    const byKey = new Map();
    let total = 0;
    let occupied = 0;

    for (let index = 0; index < slots.length; index++) {
      const item = slots[index];
      const count = itemCount(item);
      if (!count) continue;
      occupied++;
      total += count;
      const key = this._itemKey(item);
      byKey.set(key, (byKey.get(key) || 0) + count);
    }

    return { total, occupied, byKey };
  }

  async _ensureMiningHeldItem(block) {
    if (!this.options.mining.autoSelectTool) return;

    const slots = this.state.inventory?.slots || [];
    const currentSlot = Number(this.state.inventory?.heldSlot || 0);
    const bestSlot = this._findBestToolSlot(block, slots);

    if (bestSlot !== null && bestSlot !== currentSlot) {
      console.log(`[MINE] Selecting tool in slot ${bestSlot}: ${this._resolveItemName(slots[bestSlot])}`);
      await this.protocol.selectHotbarSlot?.(bestSlot);
      await sleep(150);
      return;
    }

    if (bestSlot !== null) {
      console.log(`[MINE] Already holding best tool: ${this._resolveItemName(slots[currentSlot])}`);
    } else {
      const held = this._heldItem();
      console.log(`[MINE] No proper tool found for ${block?.name || 'block'}, using: ${this._resolveItemName(held) || 'empty hand'}`);
    }
  }

  /**
   * Find the best tool slot for mining a given block.
   * Uses minecraft-data registry to resolve network_id → item name.
   */
  _findBestToolSlot(block, slots) {
    const toolType = this._toolTypeForBlock(block);

    let bestSlot = null;
    let bestScore = -1;

    for (let slot = 0; slot < Math.min(9, slots.length); slot++) {
      const item = slots[slot];
      if (emptyItem(item)) continue;
      const name = this._resolveItemName(item);
      if (!name) continue;

      // Check if this item matches the needed tool type
      if (toolType && !name.includes(toolType)) continue;
      if (!toolType && !this._isToolItem(name)) continue;

      const tierScore = this._toolTierScore(name);
      if (tierScore > bestScore) {
        bestScore = tierScore;
        bestSlot = slot;
      }
    }

    // Fallback: if we need a specific tool but don't have it, try any tool
    if (bestSlot === null && toolType) {
      for (let slot = 0; slot < Math.min(9, slots.length); slot++) {
        const item = slots[slot];
        if (emptyItem(item)) continue;
        const name = this._resolveItemName(item);
        if (name && this._isToolItem(name)) {
          const tierScore = this._toolTierScore(name);
          if (tierScore > bestScore) {
            bestScore = tierScore;
            bestSlot = slot;
          }
        }
      }
    }

    return bestSlot;
  }

  /**
   * Determine required tool type using block.material from minecraft-data.
   * Falls back to block name matching.
   */
  _toolTypeForBlock(block) {
    const blockName = (block?.name || '').toLowerCase();

    // Try minecraft-data material field first (most reliable)
    const mcdata = getMcData();
    if (mcdata?.blocksByName) {
      const blockData = mcdata.blocksByName[blockName];
      if (blockData?.material) {
        const mat = blockData.material;
        if (mat.includes('pickaxe')) return 'pickaxe';
        if (mat.includes('axe')) return 'axe';
        if (mat.includes('shovel')) return 'shovel';
        if (mat.includes('hoe')) return 'hoe';
      }
    }

    // Fallback: match by block name
    const pickaxe = ['stone', 'cobblestone', 'deepslate', 'ore', 'obsidian', 'basalt',
      'blackstone', 'andesite', 'diorite', 'granite', 'sandstone', 'brick', 'terracotta',
      'concrete', 'netherrack', 'prismarine', 'purpur', 'end_stone', 'tuff', 'calcite',
      'amethyst', 'dripstone', 'furnace', 'anvil', 'hopper', 'rail', 'lantern', 'iron',
      'gold', 'diamond', 'emerald', 'lapis', 'redstone', 'copper', 'coal', 'quartz'];
    if (pickaxe.some(k => blockName.includes(k))) return 'pickaxe';

    const axe = ['log', 'wood', 'plank', 'fence', 'gate', 'sign', 'chest', 'barrel',
      'crafting_table', 'bookshelf', 'lectern', 'bamboo', 'pumpkin', 'melon'];
    if (axe.some(k => blockName.includes(k))) return 'axe';

    const shovel = ['dirt', 'grass', 'sand', 'gravel', 'clay', 'snow', 'soul', 'mud',
      'podzol', 'mycelium', 'farmland'];
    if (shovel.some(k => blockName.includes(k))) return 'shovel';

    return 'pickaxe'; // Default
  }

  _isToolItem(name) {
    return name.includes('pickaxe') || name.includes('_axe') || name.includes('shovel') ||
           name.includes('_hoe') || name.includes('sword') || name.includes('shears');
  }

  _toolTierScore(name) {
    if (name.includes('netherite')) return 6;
    if (name.includes('diamond')) return 5;
    if (name.includes('iron')) return 4;
    if (name.includes('golden')) return 3;
    if (name.includes('stone')) return 2;
    if (name.includes('wooden')) return 1;
    return 0;
  }

  /**
   * Resolve item name from network_id using minecraft-data registry.
   * This is the ONLY reliable way — bedrock-protocol inventory items
   * have network_id (numeric) but no name field.
   */
  _resolveItemName(item) {
    if (!item) return '';
    // Try direct name field first (may exist in some cases)
    if (item.name) return String(item.name);
    // Look up via minecraft-data registry
    const nid = Number(item.network_id ?? item.networkId ?? 0);
    if (nid <= 0) return '';
    const mcdata = getMcData();
    if (mcdata?.items?.[nid]) return mcdata.items[nid].name;
    return `item_${nid}`;
  }

  _heldItem() {
    const slots = this.state.inventory?.slots || [];
    const heldSlot = Number(this.state.inventory?.heldSlot || 0);
    return slots[heldSlot] || null;
  }

  _itemKey(item) {
    return [
      item.network_id ?? item.networkId ?? 'unknown',
      item.metadata ?? item.damage ?? 0,
      item.block_runtime_id ?? item.blockRuntimeId ?? 0,
      item.name ?? item.displayName ?? '',
    ].join(':');
  }

  _inventoryDelta(before, after) {
    const gained = [];
    for (const [key, count] of after.byKey.entries()) {
      const prev = before.byKey.get(key) || 0;
      if (count > prev) gained.push({ key, count: count - prev });
    }

    return {
      total: after.total - before.total,
      occupied: after.occupied - before.occupied,
      gained,
    };
  }

  _waitForInventoryGain(before, timeoutMs) {
    return new Promise((resolve) => {
      const done = (ok, after = this._inventorySnapshot()) => {
        clearTimeout(timer);
        this.state.removeListener('inventoryUpdate', onInventory);
        this.protocol?.removeListener?.('inventoryContent', onInventory);
        this.protocol?.removeListener?.('inventorySlot', onInventory);
        resolve({ ok, before, after, delta: this._inventoryDelta(before, after) });
      };

      const onInventory = () => {
        const after = this._inventorySnapshot();
        const delta = this._inventoryDelta(before, after);
        if (delta.total > 0 || delta.gained.length > 0) done(true, after);
      };

      const timer = setTimeout(() => done(false), timeoutMs);
      this.state.on('inventoryUpdate', onInventory);
      this.protocol?.on?.('inventoryContent', onInventory);
      this.protocol?.on?.('inventorySlot', onInventory);
      onInventory();
    });
  }

  _waitForItemStackResponse(requestId, timeoutMs) {
    return new Promise((resolve) => {
      const done = (response) => {
        clearTimeout(timer);
        this.protocol?.removeListener?.('itemStackResponse', onResponse);
        resolve(response);
      };

      const onResponse = (packet) => {
        for (const response of packet?.responses || []) {
          if (Number(response.request_id) !== Number(requestId)) continue;
          done({
            ok: response.status === 'ok',
            response,
            packet,
          });
          return;
        }
      };

      const timer = setTimeout(() => done(null), timeoutMs);
      this.protocol?.on?.('itemStackResponse', onResponse);
    });
  }

  _fmt(pos) {
    return `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`;
  }
}

module.exports = {
  GameplayController,
  yawPitchTo,
  emptyItem,
  itemCount,
};
