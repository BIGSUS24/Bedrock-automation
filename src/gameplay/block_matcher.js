'use strict';

const minecraftData = require('minecraft-data');

function normaliseName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_');
}

function loadMcData(version) {
  const requested = String(version || '1.26.20').replace(/^bedrock_/, '');
  try {
    return minecraftData(`bedrock_${requested}`);
  } catch {
    return minecraftData('bedrock_1.26.20');
  }
}

class BlockMatcher {
  constructor(version) {
    this.mcData = loadMcData(version);
  }

  getByStateId(stateId) {
    const id = Number(stateId);
    return this.mcData.blocksByStateId?.[id] || null;
  }

  getByName(name) {
    return this.mcData.blocksByName?.[normaliseName(name)] || null;
  }

  isAir(block) {
    return !block || block.name === 'air';
  }

  isTrapdoor(block) {
    return Boolean(block?.name && block.name.includes('trapdoor'));
  }

  isOre(block) {
    return Boolean(block?.name && /(^|_)ore$/.test(block.name));
  }

  isSolid(block) {
    if (!block || this.isAir(block)) return false;
    if (block.boundingBox === 'empty') return false;
    return block.transparent !== true;
  }

  nameMatches(block, queries) {
    if (!block) return false;
    const list = Array.isArray(queries) ? queries : [queries];
    const name = normaliseName(block.name);
    const display = normaliseName(block.displayName || '');

    return list.some((query) => {
      const q = normaliseName(query);
      if (!q) return false;
      if (q === 'trapdoor' || q === 'trapdoors') return this.isTrapdoor(block);
      if (q === 'ore' || q === 'ores' || q === 'all_ores') return this.isOre(block);
      return name === q || name.includes(q) || display.includes(q);
    });
  }

  matches(block, query) {
    if (!block) return false;
    const q = normaliseName(query);
    if (!q || q === 'block') return true;
    if (q === 'ore' || q === 'ores' || q === 'all_ores') return this.isOre(block);
    if (q === 'trapdoor' || q === 'trapdoors') return this.isTrapdoor(block);

    const exact = this.getByName(q) || this.getByName(`${q}_ore`);
    if (exact) return block.name === exact.name;

    const display = normaliseName(block.displayName || '');
    return block.name === q || block.name.includes(q) || display.includes(q);
  }
}

module.exports = {
  BlockMatcher,
  loadMcData,
  normaliseName,
};
