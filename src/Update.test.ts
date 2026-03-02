import { Update } from 'incur'

describe('compareVersions', () => {
  test('equal versions', () => {
    expect(Update.compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  test('major difference', () => {
    expect(Update.compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0)
    expect(Update.compareVersions('1.0.0', '2.0.0')).toBeLessThan(0)
  })

  test('minor difference', () => {
    expect(Update.compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0)
    expect(Update.compareVersions('1.1.0', '1.2.0')).toBeLessThan(0)
  })

  test('patch difference', () => {
    expect(Update.compareVersions('1.0.2', '1.0.1')).toBeGreaterThan(0)
    expect(Update.compareVersions('1.0.1', '1.0.2')).toBeLessThan(0)
  })

  test('strips v prefix', () => {
    expect(Update.compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(Update.compareVersions('v2.0.0', 'v1.0.0')).toBeGreaterThan(0)
  })

  test('different length', () => {
    expect(Update.compareVersions('1.0.0.1', '1.0.0')).toBeGreaterThan(0)
    expect(Update.compareVersions('1.0', '1.0.0')).toBe(0)
  })
})
