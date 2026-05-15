'use strict';

/**
 * automation/actions/jump.js
 * Sends a MovePlayer packet with the player's current position + jump offset.
 */

const { MovementSerializer, MoveMode } = require('../../protocol/serializers/movement');

async function jumpExecute(state, protocol) {
  const profile = protocol.versionProfile;
  if (!profile) return;

  const pos = state.player.position;
  const rot = state.player.rotation;

  const payload = MovementSerializer.serialize({
    entityRuntimeId: 1n,
    position:        { x: pos.x, y: pos.y + 0.42, z: pos.z }, // jump offset
    pitch:           rot.pitch,
    yaw:             rot.yaw,
    headYaw:         rot.yaw,
    mode:            MoveMode.NORMAL,
    onGround:        false,
    tick:            BigInt(Date.now() & 0xFFFFFF),
  });

  try {
    const packetId = profile.getPacketId('MOVE_PLAYER');
    await protocol.sendPacket(packetId, { raw: payload });
  } catch (e) {
    console.warn('[Jump] Send failed:', e.message);
  }
}

function jumpCondition(state) {
  return state.isPlaying() && state.player.onGround !== false;
}

module.exports = { jumpCondition, jumpExecute };
