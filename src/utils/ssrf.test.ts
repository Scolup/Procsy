import { describe, expect, test } from 'bun:test'
import {
  BlockedTargetError,
  cachedLookup,
  createGuardedLookup,
  findInCauses,
  guardedLookup,
  isBlockedTargetError,
  isPrivateHost,
  parseIPv6Groups,
  resolvePublicAddresses,
  type LookupFn,
} from './ssrf'

describe('isPrivateHost', () => {
  test('blocks private, loopback, reserved IPv4', () => {
    for (const host of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '255.255.255.255',
      'localhost',
      'a.localhost',
      'LOCALHOST.',
    ]) {
      expect(isPrivateHost(host)).toBe(true)
    }
  })

  test('allows public IPv4 and names', () => {
    for (const host of [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '100.63.0.1',
      '192.0.32.8',
      '93.184.216.34',
      'example.com',
      'localhost.example.com',
    ]) {
      expect(isPrivateHost(host)).toBe(false)
    }
  })

  test('blocks private and embedded-private IPv6', () => {
    for (const host of [
      '[::1]',
      '::',
      '[::ffff:127.0.0.1]',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:0:192.168.0.1',
      '64:ff9b::7f00:1',
      '64:ff9b:1::1',
      '100::1',
      '2001::1',
      '2001:db8::1',
      '2002:7f00:1::1',
      '2002:0a00:0001::',
      '3fff::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'febf::1',
      'fec0::1',
      'ff02::1',
      '::127.0.0.1',
      'fe80::1%eth0',
    ]) {
      expect(isPrivateHost(host)).toBe(true)
    }
  })

  test('allows public IPv6, including public mapped/NAT64/6to4', () => {
    for (const host of [
      '2606:4700:4700::1111',
      '[2001:4860:4860::8888]',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
      '2002:0808:0808::1',
    ]) {
      expect(isPrivateHost(host)).toBe(false)
    }
  })

  test('fails closed on malformed IPv6', () => {
    for (const host of [
      '::g',
      '1:2:3',
      ':::',
      '1::2::3',
      '12345::1',
      '::1.2.3',
    ]) {
      expect(isPrivateHost(host)).toBe(true)
    }
  })
})

describe('parseIPv6Groups', () => {
  test('expands compressed, full and dotted forms strictly', () => {
    expect(parseIPv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIPv6Groups('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect(parseIPv6Groups('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(parseIPv6Groups('::ffff:1.2.3.4')).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x102, 0x304,
    ])
    expect(parseIPv6Groups('1:2:3:4:5:6:7::')).toEqual([1, 2, 3, 4, 5, 6, 7, 0])
    expect(parseIPv6Groups('fe80::1%eth0')).toBeNull()
    expect(parseIPv6Groups('127.0.0.1')).toBeNull()
    expect(parseIPv6Groups('1:2:3:4:5:6:7:8:9')).toBeNull()
  })
})

describe('resolvePublicAddresses', () => {
  const answer =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      }))

  test('literals are checked without a lookup', async () => {
    const never = async () => {
      throw new Error('should not be called')
    }
    expect(await resolvePublicAddresses('8.8.8.8', never)).toEqual([
      { address: '8.8.8.8', family: 4 },
    ])
    expect(await resolvePublicAddresses('[2606:4700::1]', never)).toEqual([
      { address: '2606:4700::1', family: 6 },
    ])
    await expect(
      resolvePublicAddresses('127.0.0.1', never),
    ).rejects.toBeInstanceOf(BlockedTargetError)
    await expect(resolvePublicAddresses('[::1]', never)).rejects.toBeInstanceOf(
      BlockedTargetError,
    )
    await expect(
      resolvePublicAddresses('localhost', never),
    ).rejects.toBeInstanceOf(BlockedTargetError)
  })

  test('names that resolve to a private address are blocked', async () => {
    await expect(
      resolvePublicAddresses('evil.example', answer('10.0.0.5')),
    ).rejects.toBeInstanceOf(BlockedTargetError)
    await expect(
      resolvePublicAddresses('evil.example', answer('::1')),
    ).rejects.toBeInstanceOf(BlockedTargetError)
  })

  test('a mixed public/private answer is blocked as a whole', async () => {
    await expect(
      resolvePublicAddresses(
        'rebind.example',
        answer('93.184.216.34', '127.0.0.1'),
      ),
    ).rejects.toBeInstanceOf(BlockedTargetError)
  })

  test('public answers pass; lookup failures propagate', async () => {
    expect(
      await resolvePublicAddresses('ok.example', answer('93.184.216.34')),
    ).toHaveLength(1)
    await expect(resolvePublicAddresses('x.example', answer())).rejects.toThrow(
      'no addresses',
    )
    await expect(
      resolvePublicAddresses('x.example', async () => {
        throw new Error('ENOTFOUND')
      }),
    ).rejects.toThrow('ENOTFOUND')
  })
})

describe('guardedLookup (connect-time check, defeats DNS rebinding)', () => {
  const call = (host: string, options: object | number) =>
    new Promise<{ error: Error | null; args: unknown[] }>((resolve) => {
      guardedLookup(
        host,
        options as never,
        ((error: Error | null, ...args: unknown[]) =>
          resolve({ error, args })) as never,
      )
    })

  test('refuses a name that resolves to loopback', async () => {
    const all = await call('localhost', { all: true })
    expect(isBlockedTargetError(all.error)).toBe(true)
    const single = await call('localhost', {})
    expect(isBlockedTargetError(single.error)).toBe(true)
    const legacy = await call('localhost', 4)
    expect(isBlockedTargetError(legacy.error)).toBe(true)
  })

  test('refuses a private IP literal; lookup errors pass through', async () => {
    expect(
      isBlockedTargetError((await call('10.0.0.1', { all: true })).error),
    ).toBe(true)
    const missing = await call('does-not-exist.invalid', { all: true })
    expect(missing.error).not.toBeNull()
    expect(isBlockedTargetError(missing.error)).toBe(false)
  })
})

describe('findInCauses', () => {
  test('finds a blocked error nested in fetch-style causes', () => {
    const error = new TypeError('fetch failed', {
      cause: new BlockedTargetError(),
    })
    expect(findInCauses(error, isBlockedTargetError)).toBeInstanceOf(
      BlockedTargetError,
    )
    expect(findInCauses(new Error('x'), isBlockedTargetError)).toBeUndefined()
  })
})

describe('cachedLookup', () => {
  const answer = [{ address: '93.184.216.34', family: 4 }]

  test('serves repeated lookups from memory until the TTL expires', async () => {
    let calls = 0
    let time = 0
    const lookup = cachedLookup(
      async () => (calls++, answer),
      1000,
      10,
      () => time,
    )
    await lookup('a.example')
    await lookup('A.example')
    expect(calls).toBe(1)
    time = 1001
    await lookup('a.example')
    expect(calls).toBe(2)
  })

  test('concurrent lookups for one name share a single resolution', async () => {
    let calls = 0
    const lookup = cachedLookup(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return answer
    })
    await Promise.all(Array.from({ length: 50 }, () => lookup('a.example')))
    expect(calls).toBe(1)
  })

  test('failures are not cached', async () => {
    let calls = 0
    const lookup = cachedLookup(async () => {
      if (calls++ === 0) throw new Error('ENOTFOUND')
      return answer
    })
    await expect(lookup('a.example')).rejects.toThrow('ENOTFOUND')
    expect(await lookup('a.example')).toEqual(answer)
  })

  test('is bounded', async () => {
    let calls = 0
    const lookup = cachedLookup(async () => (calls++, answer), 60_000, 2)
    for (const host of ['a', 'b', 'c', 'a']) await lookup(host)
    expect(calls).toBe(4) // 'a' was evicted by 'c'
  })
})

describe('createGuardedLookup', () => {
  const call = (lookup: LookupFn, options: object) =>
    new Promise<unknown[]>((resolve) =>
      createGuardedLookup(lookup)(
        'h.example',
        options as never,
        ((...args: unknown[]) => resolve(args)) as never,
      ),
    )
  const dual = async () => [
    { address: '2606:4700::1', family: 6 },
    { address: '93.184.216.34', family: 4 },
  ]

  test('returns all addresses, or one, in the shape the socket asked for', async () => {
    const [, all] = await call(dual, { all: true })
    expect(all).toHaveLength(2)
    expect(await call(dual, {})).toEqual([null, '2606:4700::1', 6])
  })

  test('honours the requested family', async () => {
    expect(await call(dual, { family: 4 })).toEqual([null, '93.184.216.34', 4])
    const [error] = await call(
      async () => [{ address: '93.184.216.34', family: 4 }],
      { family: 6 },
    )
    expect((error as Error).message).toContain('no addresses')
  })

  test('refuses if any address is private, naming it', async () => {
    const [error] = await call(
      async () => [{ address: '10.1.2.3', family: 4 }],
      { all: true },
    )
    expect(isBlockedTargetError(error)).toBe(true)
    expect((error as Error).message).toContain('10.1.2.3')
  })
})
