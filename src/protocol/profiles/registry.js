'use strict';

/**
 * registry.js — Version Registry & Negotiator
 *
 * Rules:
 *   - Each known version family maps to a Profile class.
 *   - 'latest' resolves to the newest tested profile.
 *   - Unsupported version → throws, never silently falls back.
 *   - VersionNegotiator resolves a requested string to a concrete profile.
 */

const { V1_21_50_Profile } = require('./v1_21_50');
const { V1_21_80_Profile } = require('./v1_21_80');
const { LatestProfile }    = require('./latest');

// ── Version family → Profile class ──────────────────────────────────────────

/**
 * Maps "<major>.<minor>" family strings to Profile constructors.
 * Add new entries here as new versions are tested and confirmed.
 */
const VERSION_FAMILIES = {
  '1.21': V1_21_80_Profile,   // default for all 1.21.x
};

/**
 * Maps exact protocol versions to Profile classes.
 * Takes precedence over family lookup.
 */
const EXACT_PROTOCOL_MAP = {
  622: V1_21_50_Profile,
  649: V1_21_80_Profile,
};

/**
 * Maps exact version strings to Profile classes.
 * Allows pinning a specific patch release.
 */
const EXACT_VERSION_MAP = {
  '1.21.50': V1_21_50_Profile,
  '1.21.80': V1_21_80_Profile,
  'latest':  LatestProfile,
};

// ── VersionRegistry ──────────────────────────────────────────────────────────

class VersionRegistry {
  /**
   * Get a profile instance for a version string (e.g. '1.21.50', 'latest').
   * Throws if the version is genuinely unsupported.
   *
   * @param {string} versionString
   * @returns {V1_21_50_Profile}
   */
  static getProfile(versionString) {
    // Exact match (including 'latest')
    if (EXACT_VERSION_MAP[versionString]) {
      return new EXACT_VERSION_MAP[versionString]();
    }

    // Family match
    const family = this.getFamily(versionString);
    if (VERSION_FAMILIES[family]) {
      return new VERSION_FAMILIES[family]();
    }

    // Hard fail — do NOT silently fall back
    throw new Error(
      `Version "${versionString}" is not supported. ` +
      `Supported families: ${Object.keys(VERSION_FAMILIES).join(', ')}. ` +
      `Use 'latest' to select the newest tested profile.`
    );
  }

  /**
   * Get a profile by protocol version number.
   * @param {number} protocolVersion
   * @returns {V1_21_50_Profile}
   */
  static getProfileByProtocol(protocolVersion) {
    const ProfileClass = EXACT_PROTOCOL_MAP[protocolVersion];
    if (ProfileClass) return new ProfileClass();

    throw new Error(
      `Protocol version ${protocolVersion} has no mapped profile. ` +
      `Known protocols: ${Object.keys(EXACT_PROTOCOL_MAP).join(', ')}.`
    );
  }

  static getFamily(versionString) {
    const match = versionString.match(/^(\d+)\.(\d+)/);
    if (!match) throw new Error(`Invalid version format: "${versionString}"`);
    return `${match[1]}.${match[2]}`;
  }

  static isSupported(versionString) {
    if (EXACT_VERSION_MAP[versionString]) return true;
    try {
      const family = this.getFamily(versionString);
      return !!VERSION_FAMILIES[family];
    } catch {
      return false;
    }
  }

  static getSupportedFamilies() {
    return Object.keys(VERSION_FAMILIES);
  }

  static getSupportedVersions() {
    return Object.keys(EXACT_VERSION_MAP).filter((v) => v !== 'latest');
  }

  static getLatestProfile() {
    return new LatestProfile();
  }
}

// ── VersionNegotiator ────────────────────────────────────────────────────────

class VersionNegotiator {
  /**
   * Validate a version string. Throws a clear error if unsupported.
   * @param {string} versionString
   */
  static validateVersion(versionString) {
    if (!versionString || typeof versionString !== 'string') {
      throw new Error('Version must be a non-empty string (e.g. "1.21.50" or "latest")');
    }

    if (versionString === 'latest') return; // always valid

    // Check format
    const parts = versionString.split('.').map(Number);
    if (parts.length < 2 || parts.some(isNaN)) {
      throw new Error(`Invalid version format: "${versionString}". Expected "X.Y.Z" or "latest".`);
    }

    const [major, minor] = parts;

    // Hard lower bound
    if (major < 1 || (major === 1 && minor < 21)) {
      throw new Error(
        `Version "${versionString}" is below the minimum supported version (1.21.x). ` +
        `This client does not support older Bedrock versions.`
      );
    }

    // Check family is known
    if (!VersionRegistry.isSupported(versionString)) {
      throw new Error(
        `Version "${versionString}" is not supported. ` +
        `Supported: ${VersionRegistry.getSupportedVersions().join(', ')}, latest.`
      );
    }
  }

  /**
   * Resolve a version string to a concrete profile.
   * @param {string} requestedVersion
   * @returns {V1_21_50_Profile}
   */
  static resolve(requestedVersion) {
    this.validateVersion(requestedVersion);
    return VersionRegistry.getProfile(requestedVersion);
  }

  /**
   * Compare two version strings.
   * Returns: positive if a > b, negative if a < b, 0 if equal.
   */
  static compareVersions(a, b) {
    const ap = a.split('.').map(Number);
    const bp = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (ap[i] || 0) - (bp[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}

module.exports = {
  VersionRegistry,
  VersionNegotiator,
  VERSION_FAMILIES,
  EXACT_VERSION_MAP,
  EXACT_PROTOCOL_MAP,
};