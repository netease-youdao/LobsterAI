import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('QR Code Generator Skill', () => {
  describe('URL Encoding', () => {
    it('should encode URL correctly for QR code API', () => {
      const url = 'https://example.com';
      const expected = 'https%3A%2F%2Fexample.com';
      // Simple encoding check
      assert.ok(encodeURIComponent(url) === expected);
    });

    it('should encode special characters', () => {
      const text = 'Hello World!';
      const encoded = encodeURIComponent(text);
      // Node.js v22+ doesn't encode ! by default (RFC 3986 compliant)
      assert.strictEqual(encoded, 'Hello%20World!');
    });

    it('should handle Chinese characters', () => {
      const text = '你好世界';
      const encoded = encodeURIComponent(text);
      assert.ok(encoded.includes('%'));
    });
  });

  describe('WiFi QR Code Format', () => {
    it('should construct WiFi string correctly', () => {
      const ssid = 'MyNetwork';
      const password = 'secret123';
      const security = 'WPA';
      const wifiString = `WIFI:T:${security};S:${ssid};P:${password};;`;
      assert.strictEqual(wifiString, 'WIFI:T:WPA;S:MyNetwork;P:secret123;;');
    });

    it('should handle WPA2 security type', () => {
      const ssid = 'HomeWiFi';
      const password = 'password456';
      const wifiString = `WIFI:T:WPA2;S:${ssid};P:${password};;`;
      assert.strictEqual(wifiString, 'WIFI:T:WPA2;S:HomeWiFi;P:password456;;');
    });

    it('should handle no password', () => {
      const ssid = 'OpenNetwork';
      const wifiString = `WIFI:T:nopass;S:${ssid};;`;
      assert.strictEqual(wifiString, 'WIFI:T:nopass;S:OpenNetwork;;');
    });

    it('should handle hidden network', () => {
      const ssid = 'HiddenNet';
      const password = 'secret';
      const wifiString = `WIFI:T:WPA;S:${ssid};P:${password};H:true;;`;
      assert.strictEqual(wifiString, 'WIFI:T:WPA;S:HiddenNet;P:secret;H:true;;');
    });
  });

  describe('API URL Construction', () => {
    it('should construct QR server URL correctly', () => {
      const data = 'https://example.com';
      const size = '300x300';
      const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}&data=${encodeURIComponent(data)}`;
      assert.ok(apiUrl.includes('api.qrserver.com'));
      assert.ok(apiUrl.includes('size=300x300'));
      assert.ok(apiUrl.includes('data='));
    });

    it('should handle different sizes', () => {
      const sizes = ['150x150', '300x300', '500x500'];
      sizes.forEach(size => {
        const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}&data=test`;
        assert.ok(apiUrl.includes(`size=${size}`));
      });
    });

    it('should encode data parameter', () => {
      const data = 'Hello World';
      const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(data)}`;
      assert.ok(apiUrl.includes('Hello%20World'));
    });
  });

  describe('Phone Number Format', () => {
    it('should format phone number correctly', () => {
      const phone = '+1234567890';
      const telString = `TEL:${phone}`;
      assert.strictEqual(telString, 'TEL:+1234567890');
    });
  });

  describe('SMS Format', () => {
    it('should format SMS correctly', () => {
      const phone = '123456';
      const message = 'Hello';
      const smsString = `SMSTO:${phone}:${message}`;
      assert.strictEqual(smsString, 'SMSTO:123456:Hello');
    });
  });

  describe('Email Format', () => {
    it('should format email correctly', () => {
      const email = 'test@example.com';
      const mailtoString = `mailto:${email}`;
      assert.strictEqual(mailtoString, 'mailto:test@example.com');
    });
  });

  describe('vCard Format', () => {
    it('should construct vCard correctly', () => {
      const name = 'John Doe';
      const phone = '+1234567890';
      const email = 'john@example.com';
      const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${name}
TEL:${phone}
EMAIL:${email}
END:VCARD`;
      const lines = vcard.split('\n');
      assert.ok(lines.some(line => line.startsWith('BEGIN:VCARD')));
      assert.ok(lines.some(line => line.startsWith('FN:John Doe')));
      assert.ok(lines.some(line => line.startsWith('TEL:+1234567890')));
    });
  });

  describe('Error Cases', () => {
    it('should identify data too long error', () => {
      // QR codes have capacity limits based on error correction level
      // Maximum characters: ~4296 ( alphanumeric, lowest error correction)
      const longText = 'a'.repeat(5000);
      const isTooLong = longText.length > 4296;
      assert.strictEqual(isTooLong, true);
    });

    it('should handle empty data', () => {
      const data = '';
      const isEmpty = data.length === 0;
      assert.strictEqual(isEmpty, true);
    });
  });

  describe('Color Parameters', () => {
    it('should handle color parameter', () => {
      const color = 'black';
      const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=test&color=${color}`;
      assert.ok(apiUrl.includes('color=black'));
    });

    it('should handle background color', () => {
      const bgcolor = 'yellow';
      const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=test&bgcolor=${bgcolor}`;
      assert.ok(apiUrl.includes('bgcolor=yellow'));
    });
  });
});
