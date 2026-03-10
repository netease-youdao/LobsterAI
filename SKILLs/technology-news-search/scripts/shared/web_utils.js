#!/usr/bin/env node

/**
 * HTTP utility functions for fetching web content
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function makeRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      timeout = 10000,
      headers = {},
      method = 'GET',
      body = null
    } = options;

    const urlObj = new URL(urlStr);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const defaultHeaders = {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      ...headers
    };

    const requestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: defaultHeaders,
      timeout
    };

    const req = client.request(requestOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        resolve({
          status: res.statusCode,
          data,
          headers: res.headers
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function fetchUrl(urlStr, options = {}) {
  const {
    timeout = 10000,
    maxRetries = 3,
    userAgent = null
  } = options;

  const headers = userAgent ? { 'User-Agent': userAgent } : {};

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await makeRequest(urlStr, {
        timeout,
        headers
      });

      if (response.status >= 400) {
        if ([404, 403, 401].includes(response.status)) {
          return null; // Don't retry these
        }
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
          continue;
        }
        return null;
      }

      // Try to detect encoding
      let content = response.data;

      // If content is already a string, use it
      if (typeof content === 'string') {
        return content;
      }

      // Try to decode as UTF-8
      if (Buffer.isBuffer(content)) {
        return content.toString('utf-8');
      }

      return content;
    } catch (error) {
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      } else {
        console.error(`Error fetching ${urlStr}:`, error.message);
        return null;
      }
    }
  }

  return null;
}

async function fetchJson(urlStr, timeout = 10000) {
  try {
    const content = await fetchUrl(urlStr, { timeout });
    if (content) {
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`JSON parse error for ${urlStr}:`, error.message);
  }
  return null;
}

module.exports = {
  fetchUrl,
  fetchJson,
  makeRequest
};
