import assert from 'node:assert/strict';
import test from 'node:test';
import { _shouldRetryAcrossAddressesForTest } from '../../../../src/platforms/weixin/official/api.js';

test('Weixin API does not repeat non-idempotent POST requests after ambiguous network failures', () => {
  assert.equal(_shouldRetryAcrossAddressesForTest('POST', 'ETIMEDOUT'), false);
  assert.equal(_shouldRetryAcrossAddressesForTest('POST', 'ECONNRESET'), false);
  assert.equal(_shouldRetryAcrossAddressesForTest('POST', 'UND_ERR_HEADERS_TIMEOUT'), false);
});

test('Weixin API retains safe address rotation for reads and pre-connect POST failures', () => {
  assert.equal(_shouldRetryAcrossAddressesForTest('GET', 'ETIMEDOUT'), true);
  assert.equal(_shouldRetryAcrossAddressesForTest('POST', 'ECONNREFUSED'), true);
  assert.equal(_shouldRetryAcrossAddressesForTest('POST', 'EHOSTUNREACH'), true);
  assert.equal(_shouldRetryAcrossAddressesForTest('POST', 'ENETUNREACH'), true);
  assert.equal(_shouldRetryAcrossAddressesForTest('POST', 'UND_ERR_CONNECT_TIMEOUT'), true);
});
