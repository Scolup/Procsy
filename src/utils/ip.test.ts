import { describe, expect, test } from 'bun:test'
import { generateRandomIP, stableSpoofedIP } from './ip'

const PREFIXES = ['80.12', '82.224', '176.128', '90.1']

function expectFrenchIPv4(ip: string): void {
  const parts = ip.split('.')
  expect(parts).toHaveLength(4)
  expect(PREFIXES).toContain(parts.slice(0, 2).join('.'))
  expect(Number(parts[2])).toBeGreaterThanOrEqual(0)
  expect(Number(parts[2])).toBeLessThan(256)
  expect(Number(parts[3])).toBeGreaterThanOrEqual(0)
  expect(Number(parts[3])).toBeLessThan(256)
}

describe('IP spoofing', () => {
  test('random addresses use a French provider prefix', () => {
    for (let index = 0; index < 20; index++) {
      expectFrenchIPv4(generateRandomIP())
    }
  })

  test('the same session always gets the same address', () => {
    const first = stableSpoofedIP('sid=abc')
    expect(stableSpoofedIP('sid=abc')).toBe(first)
    expectFrenchIPv4(first)
  })

  test('different sessions normally get different addresses', () => {
    const addresses = new Set(
      Array.from({ length: 50 }, (_, index) => stableSpoofedIP(`sid=${index}`)),
    )
    expect(addresses.size).toBeGreaterThan(1)
  })

  test('no session falls back to a random address', () => {
    expectFrenchIPv4(stableSpoofedIP(null))
    expectFrenchIPv4(stableSpoofedIP(undefined))
  })
})
