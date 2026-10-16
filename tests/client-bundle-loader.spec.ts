import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

describe('browser bundle loader contract', () => {
  it('emits a classic ModuleLoader registration instead of ESM imports', () => {
    const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    expect(source.startsWith('window.__ModuleLoader__.load(')).toBe(true)
    expect(source).toContain('id: "@dsh-session-ssh/ssh"')
    expect(source).not.toMatch(/^import\s/m)
    expect(source).not.toMatch(/^export\s/m)
    expect(source).toContain('factory: (require) => {')
    expect(source).toContain('return module.exports;')
    expect(source).toContain('}\n});')
    expect(source).toContain('style[data-plugin-css=')
    expect(source).toContain('module.exports = {')
  })
})
