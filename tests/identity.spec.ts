import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('independent plugin identity', () => {
  it('uses unique package, bundle, mount, panel, and repository identities', () => {
    const packageJson = JSON.parse(text('package.json')) as {
      name: string
      repository: { url: string }
      dsh: { bundle: { patch: string } }
    }
    expect(packageJson.name).toBe('@dsh-session-ssh/ssh')
    expect(packageJson.repository.url).toBe('https://github.com/1321928757/dsh-ssh.git')
    expect(packageJson.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(text('cordis.patch.yml')).toContain('id: dsh-session-ssh')
    expect(text('src/index.ts')).toContain("mountOnce('dsh-session-ssh'")
    expect(text('src/client/panel/controller.ts')).toContain("'dsh-session-ssh-panel'")
    expect(text('src/client/session-selector.tsx')).toContain("'dsh-session-ssh-selector'")
  })

  it('does not carry legacy runtime identities or parent-workspace imports', () => {
    expect(text('src/index.ts')).not.toContain('@linxin666/dsh-ssh')
    expect(text('src/client/index.ts')).not.toContain('@linxin666/dsh-ssh')
    expect(text('src/client/panel/controller.ts')).not.toContain("'ssh'")
    expect(text('tsdown.config.ts')).not.toContain('../../shared/')
  })

  it('retains Apache-2.0 attribution and avoids real credential material', () => {
    expect(text('LICENSE')).toContain('Apache License')
    expect(text('NOTICE')).toContain('zhu1090093659/dsh-web/packages/dsh-ssh')
    expect(text('README.md')).toContain('Use a separate test profile')
    expect(text('tests/store.test.ts')).toContain("password: 'pw'")
  })
})
