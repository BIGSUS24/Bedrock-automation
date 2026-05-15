'use strict';

const { UDPSocket, RAKNET_MAX_PACKET_SIZE, RAKNET_MTU_SIZE } = require('./udp_socket');
const { RakNetSession, ConnectionState, Reliability, RakNetPacketIDs, RAKNET_PROTOCOL_VERSION, RAKNET_MAGIC } = require('./raknet_session');
const { EncryptionSession } = require('./encryption');
const { ReliabilitySystem, readUInt24LE, writeUInt24LE } = require('./reliability');
const { FragmentationSystem } = require('./fragmentation');
const { PacketRouter, readVarint, writeVarint } = require('./packet_router');



module.exports = {
  // UDP
  UDPSocket,
  RAKNET_MAX_PACKET_SIZE,
  RAKNET_MTU_SIZE,

  // Session
  RakNetSession,
  ConnectionState,
  Reliability,
  RakNetPacketIDs,
  RAKNET_PROTOCOL_VERSION,
  RAKNET_MAGIC,

  // Encryption
  EncryptionSession,

  // Reliability
  ReliabilitySystem,
  readUInt24LE,
  writeUInt24LE,

  // Fragmentation
  FragmentationSystem,

  // Packet router
  PacketRouter,
  readVarint,
  writeVarint,
};