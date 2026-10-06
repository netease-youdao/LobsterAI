'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_KEYFROM = 'official';
const KEYFROM_PATTERN = /^[a-z0-9_-]{1,64}$/;

function normalizeKeyfrom(value) {
  if (typeof value !== 'string') return DEFAULT_KEYFROM;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_KEYFROM;
  if (!KEYFROM_PATTERN.test(normalized)) return DEFAULT_KEYFROM;
  return normalized;
}

function readBuildKeyfrom() {
  if (process.env.KEYFROM !== undefined) {
    return normalizeKeyfrom(process.env.KEYFROM);
  }

  const buildInfoPath = path.join(__dirname, '..', '.keyfrom-build', 'keyfrom.json');
  try {
    if (!fs.existsSync(buildInfoPath)) {
      return DEFAULT_KEYFROM;
    }
    const parsed = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    return normalizeKeyfrom(parsed?.keyfrom);
  } catch (error) {
    console.warn('[Keyfrom] failed to read build keyfrom for artifact names, using official:', error);
    return DEFAULT_KEYFROM;
  }
}

module.exports = {
  DEFAULT_KEYFROM,
  normalizeKeyfrom,
  readBuildKeyfrom,
};
