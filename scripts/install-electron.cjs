#!/usr/bin/env node
const { spawnSync } = require('node:child_process')

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
}

const result = spawnSync(process.execPath, ['node_modules/electron/install.js'], {
  stdio: 'inherit',
  env,
})

process.exit(result.status ?? 1)
